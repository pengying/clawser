import test from 'node:test';
import assert from 'node:assert/strict';
import * as realFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  classifyOwner, cookieEncryption, displayServices, findBrowserBinary, isSnapBrowser, listenerProcess, processInfo, unitMainPid,
} from '../src/host-browser.mjs';

const UID = 1000;
const SNAP = "Snap Chromium can't use the hidden folder where Clawser keeps its files. Install Google Chrome, or a Chromium that isn't a snap, then rerun setup.";
const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
const row = (address, port, inode, st = '0A') =>
  `   0: ${address}:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0 100 0\n`;
const NUL = (...parts) => parts.join('\0') + '\0';

async function tempRoot(t) {
  const root = await realFs.realpath(await realFs.mkdtemp(join(tmpdir(), 'clawser-host-browser-')));
  t.after(() => realFs.rm(root, { recursive: true, force: true }));
  return root;
}

async function proc(root, pid, { exe = '/opt/google/chrome/chrome', argv = ['/opt/google/chrome/chrome'], env = [], cgroup = '0::/', sockets = [] } = {}) {
  const dir = join(root, 'proc', String(pid));
  await realFs.mkdir(join(dir, 'fd'), { recursive: true });
  await realFs.symlink(exe, join(dir, 'exe'));
  await realFs.writeFile(join(dir, 'cmdline'), NUL(...argv));
  await realFs.writeFile(join(dir, 'environ'), NUL(...env));
  await realFs.writeFile(join(dir, 'cgroup'), cgroup + '\n');
  for (const [i, inode] of sockets.entries()) await realFs.symlink(`socket:[${inode}]`, join(dir, 'fd', String(i + 3)));
}

async function net(root, tcp = '', tcp6 = '') {
  await realFs.mkdir(join(root, 'proc/net'), { recursive: true });
  await realFs.writeFile(join(root, 'proc/net/tcp'), HEADER + tcp);
  await realFs.writeFile(join(root, 'proc/net/tcp6'), HEADER + tcp6);
}

const ownedBy = (owner, root) => ({ ...realFs, stat: async path => {
  const info = await realFs.stat(path);
  return String(path).startsWith(join(root, 'proc/')) && !String(path).includes('/net/') ? Object.assign(Object.create(info), { uid: owner(path) }) : info;
} });
const deps = (root, extra = {}) => ({ fs: ownedBy(() => UID, root), run: async () => '', env: {}, uid: UID, procRoot: join(root, 'proc'), ...extra });


test('the Chrome listening on the port is found through its socket inode, not its renderers', async t => {
  const root = await tempRoot(t);
  await net(root, row('0100007F', 9333, 123));
  await proc(root, 50, { argv: ['/opt/google/chrome/chrome', '--type=renderer'], sockets: [123] });
  await proc(root, 60, { argv: ['/opt/google/chrome/chrome', '--remote-debugging-port=9333'], sockets: [123, 999] });
  await proc(root, 70, { exe: '/usr/bin/python3', argv: ['python3'], sockets: [456] });
  assert.deepEqual(await listenerProcess(9333, deps(root)), { pid: 60, address: '127.0.0.1' });
  assert.equal(await listenerProcess(9444, deps(root)), undefined);
});

test('tcp6 loopback and IPv4-mapped loopback both report friendly addresses', async t => {
  const root = await tempRoot(t);
  await net(root, '', row('00000000000000000000000001000000', 9333, 1) + row('0000000000000000FFFF00000100007F', 9334, 2));
  await proc(root, 60, { sockets: [1, 2] });
  assert.equal((await listenerProcess(9333, deps(root))).address, '::1');
  assert.equal((await listenerProcess(9334, deps(root))).address, '127.0.0.1');
});

test('a non-listening socket on the port is ignored', async t => {
  const root = await tempRoot(t);
  await net(root, row('0100007F', 9333, 123, '01'));
  await proc(root, 60, { sockets: [123] });
  assert.equal(await listenerProcess(9333, deps(root)), undefined);
});

test('a listener owned by another user is ignored', async t => {
  const root = await tempRoot(t);
  await net(root, row('0100007F', 9333, 123));
  await proc(root, 60, { sockets: [123] });
  assert.equal(await listenerProcess(9333, deps(root, { fs: ownedBy(() => 0, root) })), undefined);
  assert.equal((await listenerProcess(9333, deps(root, { fs: ownedBy(() => UID, root) }))).pid, 60);
});

test('a 0.0.0.0 listener reports its address so setup can refuse it', async t => {
  const root = await tempRoot(t);
  await net(root, row('00000000', 9333, 123));
  await proc(root, 60, { sockets: [123] });
  assert.equal((await listenerProcess(9333, deps(root))).address, '0.0.0.0');
});

test('a process that vanishes mid-scan is skipped', async t => {
  const root = await tempRoot(t);
  await net(root, row('0100007F', 9333, 123));
  await realFs.mkdir(join(root, 'proc/40'), { recursive: true });
  await proc(root, 60, { sockets: [123] });
  assert.equal((await listenerProcess(9333, deps(root))).pid, 60);
});

test('processInfo reads exe, argv, env and the unified cgroup', async t => {
  const root = await tempRoot(t);
  await proc(root, 60, { argv: ['chrome', '--flag=a b'], env: ['DISPLAY=:7', 'EMPTY=', 'X=a=b'], cgroup: '0::/user.slice/x.scope' });
  const info = await processInfo(60, deps(root));
  assert.equal(info.exe, '/opt/google/chrome/chrome');
  assert.deepEqual(info.argv, ['chrome', '--flag=a b']);
  assert.equal(info.env.get('DISPLAY'), ':7');
  assert.equal(info.env.get('X'), 'a=b');
  assert.equal(info.cgroup, '/user.slice/x.scope');
});

test('owners are classified as user units, sessions or unknown', () => {
  const base = '/user.slice/user-1000.slice/user@1000.service';
  assert.deepEqual(classifyOwner(`${base}/app.slice/my-chrome.service`, UID), { kind: 'user-unit', unit: 'my-chrome.service' });
  assert.deepEqual(classifyOwner(`${base}/chrome.service`, UID), { kind: 'user-unit', unit: 'chrome.service' });
  assert.deepEqual(classifyOwner(`${base}/app.slice/app-gnome-chrome-4242.scope`, UID), { kind: 'session' });
  assert.deepEqual(classifyOwner('/user.slice/user-1000.slice/session-3.scope', UID), { kind: 'session' });
  assert.deepEqual(classifyOwner('/system.slice/chrome.service', UID), { kind: 'unknown', detail: '/system.slice/chrome.service' });
  assert.equal(classifyOwner('/user.slice/user-1001.slice/user@1001.service/app.slice/c.service', UID).kind, 'unknown');
});

test('unitMainPid asks systemd for the unit main PID', async () => {
  const calls = [];
  const pid = await unitMainPid('my-chrome.service', { run: async (...call) => { calls.push(call); return '4242\n'; } });
  assert.equal(pid, 4242);
  assert.deepEqual(calls[0].slice(0, 2), ['systemctl', ['--user', 'show', '-p', 'MainPID', '--value', 'my-chrome.service']]);
});

test('display services are found by display number', async t => {
  const root = await tempRoot(t);
  await proc(root, 10, { exe: '/usr/bin/Xvfb', argv: ['/usr/bin/Xvfb', ':7', '-screen', '0', '1280x800x24'] });
  await proc(root, 11, { exe: '/usr/bin/Xvfb', argv: ['/usr/bin/Xvfb', ':8'] });
  await proc(root, 12, { exe: '/usr/bin/openbox', argv: ['openbox'], env: ['DISPLAY=:7'] });
  await proc(root, 13, { exe: '/usr/bin/openbox', argv: ['openbox'], env: ['DISPLAY=:8'] });
  const found = await displayServices('7', deps(root));
  assert.equal(found.xvfb.pid, 10);
  assert.equal(found.windowManager.pid, 12);
  assert.deepEqual(await displayServices(9, deps(root)), {});
});

test('cookie encryption counts version prefixes without reading values', async t => {
  const root = await tempRoot(t);
  const { DatabaseSync } = await import('node:sqlite');
  const path = join(root, 'Cookies');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE cookies (name TEXT, encrypted_value BLOB)');
  const insert = db.prepare('INSERT INTO cookies VALUES (?, ?)');
  for (let i = 0; i < 2; i++) insert.run('a' + i, Buffer.from('v10secret' + i));
  for (let i = 0; i < 3; i++) insert.run('b' + i, Buffer.from('v11secret' + i));
  insert.run('plain', Buffer.alloc(0));
  db.close();
  const sql = [], urls = [];
  const openDatabase = async (url, options) => {
    urls.push([url, options]);
    const inner = new DatabaseSync(url, options);
    return { prepare: text => { sql.push(text); return inner.prepare(text); }, close: () => inner.close() };
  };
  assert.deepEqual(await cookieEncryption(path, deps(root, { openDatabase })), { total: 6, v10: 2, v11: 3, other: 1 });
  assert.match(sql.join('\n'), /substr\(encrypted_value,1,3\)/);
  assert.doesNotMatch(sql.join('\n'), /SELECT\s+(?:\*|encrypted_value\b)/i);
  assert.deepEqual(urls[0], [pathToFileURL(path).href + '?immutable=1', { readOnly: true }]);
  assert.deepEqual(await cookieEncryption(join(root, 'missing'), deps(root)), { total: 0, v10: 0, v11: 0, other: 0 });
});

test('snap browsers are refused', async t => {
  assert.equal(isSnapBrowser('/snap/chromium/123/usr/lib/chromium-browser/chrome', ''), true);
  assert.equal(isSnapBrowser('/usr/bin/chromium-browser', '#!/bin/sh\nexec /snap/bin/chromium "$@"'), true);
  assert.equal(isSnapBrowser('/usr/bin/chromium-browser', '#!/bin/sh\nsnap run chromium'), true);
  assert.equal(isSnapBrowser('/opt/google/chrome/chrome', '\x7fELF'), false);
  const root = await tempRoot(t);
  await realFs.mkdir(join(root, 'bin'));
  await realFs.writeFile(join(root, 'bin/chromium-browser'), '#!/bin/sh\nexec /snap/bin/chromium "$@"\n', { mode: 0o755 });
  await assert.rejects(findBrowserBinary(deps(root, { env: { PATH: join(root, 'bin') }, optChrome: join(root, 'no-opt-chrome') })), { message: SNAP });
});

test('findBrowserBinary prefers google-chrome-stable and resolves symlinks', async t => {
  const root = await tempRoot(t);
  await realFs.mkdir(join(root, 'bin')); await realFs.mkdir(join(root, 'opt'));
  await realFs.writeFile(join(root, 'opt/chrome'), '\x7fELF', { mode: 0o755 });
  await realFs.writeFile(join(root, 'bin/chromium'), '\x7fELF', { mode: 0o755 });
  await realFs.symlink(join(root, 'opt/chrome'), join(root, 'bin/google-chrome-stable'));
  const d = deps(root, { env: { PATH: join(root, 'bin') }, optChrome: join(root, 'no-opt-chrome') });
  assert.deepEqual(await findBrowserBinary(d), { path: join(root, 'opt/chrome'), brand: 'chrome' });
  await realFs.rm(join(root, 'bin/google-chrome-stable'));
  assert.deepEqual(await findBrowserBinary(d), { path: join(root, 'bin/chromium'), brand: 'chromium' });
  await realFs.rm(join(root, 'bin/chromium'));
  await assert.rejects(findBrowserBinary(d), { message: 'No Google Chrome or Chromium found. Install Google Chrome, then rerun setup.' });
});

test('the /opt/google/chrome install is found after PATH misses', async t => {
  const root = await tempRoot(t);
  await realFs.mkdir(join(root, 'opt'));
  await realFs.writeFile(join(root, 'opt/chrome'), '\x7fELF', { mode: 0o755 });
  assert.deepEqual(await findBrowserBinary(deps(root, { env: { PATH: '' }, optChrome: join(root, 'opt/chrome') })), { path: join(root, 'opt/chrome'), brand: 'chrome' });
});

async function cookieDb(path, rows) {
  const { DatabaseSync } = await import('node:sqlite');
  await realFs.mkdir(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE cookies (name TEXT, encrypted_value BLOB)');
  const insert = db.prepare('INSERT INTO cookies VALUES (?, ?)');
  rows.forEach((value, i) => insert.run('c' + i, Buffer.from(value)));
  db.close();
}

test('a cookie path with a space and a hash is counted through a real sqlite open', async t => {
  const root = await tempRoot(t);
  const path = join(root, 'pro file#1', 'Cookies');
  await cookieDb(path, ['v10a', 'v10b', 'v11a', 'v11b', 'v11c']);
  assert.deepEqual(await cookieEncryption(path, deps(root)), { total: 5, v10: 2, v11: 3, other: 0 });
});

test('an unreadable cookie store throws instead of looking empty', async t => {
  const root = await tempRoot(t);
  const garbage = join(root, 'Garbage');
  await realFs.writeFile(garbage, Buffer.from('this is not a sqlite database at all, just bytes'.repeat(20)));
  await assert.rejects(cookieEncryption(garbage, deps(root)), /Could not read the cookie store at .*Garbage: /);
  const { DatabaseSync } = await import('node:sqlite');
  const bare = join(root, 'NoTable');
  const db = new DatabaseSync(bare);
  db.exec('CREATE TABLE other (a)');
  db.close();
  await assert.rejects(cookieEncryption(bare, deps(root)), /Could not read the cookie store/);
});
