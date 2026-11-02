import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runClawser } from '../src/setup.mjs';
import { hostWorld, movePackage } from './host-fixture.mjs';
import { applyWorld, cookieDirs, cookieStore, exportsThree } from './host-existing-fixture.mjs';

const HOST_ROWS = ['installation', 'ownership', 'configuration', 'pinned assets', 'host dependencies', 'services', 'display', 'browser window',
  'CDP origin', 'profile directory', 'linger', 'units current', 'controller health', 'Gateway activation'];
const LINGER = 'Linger is off, so these services stop when you log out. Run: loginctl enable-linger';
const KEYRING = n => `${n} cookies are still encrypted with the desktop keyring, which Clawser's browser can't read; sign in again to sites that ask.`;
const EXPORT = folders => `An earlier setup run saved cookies in ${folders.join(', ')}; rerun openclaw clawser setup to move them over and remove it.`;

// Doctor may read: systemctl show, loginctl show-user, xproof clients, openclaw config get, and the version probes of its prerequisites.
const readOnly = call => (call.command === 'systemctl' && ['show', 'show-environment'].includes(call.args[1]))
  || (call.command === 'loginctl' && call.args[0] === 'show-user')
  || (String(call.args[0]).endsWith('/runtime/desktop/xproof.py') && call.args[1] === 'clients' && call.args.length === 2)
  || (call.command === 'openclaw' && (call.args[0] === '--version' || (call.args[0] === 'config' && call.args[1] === 'get')))
  || (['tar', '/usr/bin/flock'].includes(call.command) && call.args[0] === '--version');

// An option A install that setup finished, with its calls and logs cleared.
async function installed(t, options) {
  const w = await hostWorld(t, options);
  const result = await runClawser([...w.args, '--yes'], w.deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  return w;
}

async function doctor(w) {
  w.calls.length = 0;
  w.logs.length = 0;
  const result = await runClawser(['doctor', '--state-dir', w.stateDir], w.deps);
  assert.deepEqual(w.mutations(), [], 'doctor changes nothing');
  assert.deepEqual(w.calls.filter(call => !readOnly(call)), [], 'doctor only reads');
  return result;
}

const hostRows = result => result.checks.slice(result.checks.findIndex(row => row.name === 'installation'));
const row = (result, name) => result.checks.find(item => item.name === name);
const failed = result => hostRows(result).filter(item => !item.ok).map(item => item.name);
const show = (w, name) => w.calls.some(call => call.command === 'systemctl' && call.args.join(' ') === `--user show ${name} --property=ActiveState,SubState,MainPID --no-pager`);
const xproofCalls = w => w.calls.filter(call => String(call.args[0]).endsWith('/runtime/desktop/xproof.py'));

test('doctor passes on a healthy install and changes nothing', async t => {
  const w = await installed(t);
  const receipt = await fs.readFile(join(w.stateDir, 'setup.json'), 'utf8');
  w.deps.env.WAYLAND_DISPLAY = 'wayland-0';
  const result = await doctor(w);
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.deepEqual(hostRows(result).map(item => item.name), HOST_ROWS);
  assert.ok(result.checks.every(item => item.ok && !item.warning && !item.pending), JSON.stringify(result.checks));
  const units = Object.values(w.names);
  assert.deepEqual(result.units, units);
  for (const name of units) assert.ok(show(w, name), 'reads ' + name);
  assert.ok(w.calls.some(call => call.command === 'loginctl' && call.args.join(' ') === `show-user ${w.deps.uid} -p Linger --value`));
  const [xproof, ...more] = xproofCalls(w);
  assert.deepEqual(more, []);
  assert.equal(xproof.command, '/usr/bin/python3');
  assert.deepEqual(xproof.args, [join(w.packageDir, 'runtime/desktop/xproof.py'), 'clients']);
  assert.equal(xproof.timeoutMs, 10_000);
  assert.equal(xproof.env.DISPLAY, ':20');
  assert.equal(xproof.env.XAUTHORITY, join(w.stateDir, 'xauthority'));
  assert.equal(xproof.env.XDG_CONFIG_HOME, w.deps.env.XDG_CONFIG_HOME);
  assert.equal(Object.hasOwn(xproof.env, 'WAYLAND_DISPLAY'), false, 'xproof talks to the X display only');
  assert.equal(w.deps.env.WAYLAND_DISPLAY, 'wayland-0', 'doctor leaves its own environment alone');
  assert.equal(await fs.readFile(join(w.stateDir, 'setup.json'), 'utf8'), receipt);
  for (const name of HOST_ROWS) assert.ok(w.logs.includes('OK ' + name), name);
  assert.deepEqual(w.logs.slice(-(units.length + 2)), [...units.map(name => 'Unit: ' + name), 'State: ' + w.stateDir, 'Display: :20']);
});

test('an inactive service fails doctor', async t => {
  const w = await installed(t);
  w.units.set(w.names.browser, 'inactive');
  w.pids.delete(w.names.browser);
  let result = await doctor(w);
  assert.equal(result.ok, false);
  assert.equal(row(result, 'services').message, `${w.names.browser} is inactive/dead; inspect it with journalctl --user -u ${w.names.browser}`);
  assert.equal(row(result, 'browser window'), undefined, 'the window check needs running services');
  assert.deepEqual(failed(result), ['services']);
  // The first inactive unit is named, and the rest are counted.
  w.units.set(w.names.browser, 'active');
  w.pids.set(w.names.browser, 7000);
  w.units.set(w.names.supervisor, 'failed');
  w.units.set(w.names.controller, 'inactive');
  result = await doctor(w);
  assert.equal(row(result, 'services').message, `${w.names.supervisor} is failed/failed; inspect it with journalctl --user -u ${w.names.supervisor} (and 1 more)`);
  for (const name of Object.values(w.names)) assert.ok(show(w, name), 'reads ' + name);
});

test('a missing display socket fails doctor', async t => {
  const w = await installed(t);
  const socket = join(w.x11SocketDir, 'X20');
  assert.ok((await fs.lstat(socket)).isSocket());
  await fs.rm(socket);
  const message = `Display :20 has no X socket; inspect ${w.names.display} with journalctl --user -u ${w.names.display}`;
  let result = await doctor(w);
  assert.equal(result.ok, false);
  assert.equal(row(result, 'display').message, message);
  assert.equal(row(result, 'browser window'), undefined, 'the window check needs the display');
  assert.deepEqual(xproofCalls(w), []);
  assert.deepEqual(failed(result), ['display']);
  // A plain file where the socket belongs is not an X server.
  await fs.writeFile(socket, '');
  result = await doctor(w);
  assert.equal(row(result, 'display').message, message);
});

test('a browser window off the shared screen fails doctor', async t => {
  const w = await installed(t);
  const pid = w.pids.get(w.names.browser);
  assert.ok(pid > 0);
  w.xproof = () => [{ clientId: 1, pid: 4321 }, { clientId: 2, pid: 4322 }];
  let result = await doctor(w);
  assert.equal(result.ok, false);
  assert.equal(row(result, 'browser window').message, `Chrome (pid ${pid}) has no window on display :20; restart ${w.names.browser}`);
  assert.deepEqual(failed(result), ['browser window']);
  // xproof itself failing is its own message, with the first line of its error.
  w.xproof = () => { throw new Error('/usr/bin/python3 failed (1): local X display unavailable\nsecond line'); };
  result = await doctor(w);
  assert.equal(row(result, 'browser window').message, 'Could not list the windows on display :20 (/usr/bin/python3 failed (1): local X display unavailable)');
  assert.deepEqual(failed(result), ['browser window']);
});

test('a group-readable profile directory fails doctor', async t => {
  const w = await installed(t);
  const dir = (await w.receipt()).userDataDir;
  assert.equal(dir, join(w.stateDir, 'browser/profile'));
  await fs.chmod(dir, 0o750);
  let result = await doctor(w);
  assert.equal(result.ok, false);
  assert.equal(row(result, 'profile directory').message, `${dir} is readable by other users; run: chmod 700 ${dir}`);
  assert.deepEqual(failed(result), ['profile directory']);
  assert.equal(((await fs.stat(dir)).mode & 0o777), 0o750, 'doctor reports and never fixes');
  await fs.rm(dir, { recursive: true });
  result = await doctor(w);
  assert.equal(row(result, 'profile directory').message, `${dir} is missing`);
});

test('linger off prints the enable-linger command', async t => {
  const w = await installed(t);
  w.linger = 'no\n';
  const result = await doctor(w);
  assert.equal(result.ok, false);
  assert.deepEqual(row(result, 'linger'), { name: 'linger', ok: false, message: LINGER });
  assert.deepEqual(failed(result), ['linger']);
  assert.ok(w.logs.includes('FAIL linger: ' + LINGER), w.logs.join('\n'));
});

test('a moved plugin directory says to rerun setup', async t => {
  const w = await installed(t);
  await movePackage(w);
  let result = await doctor(w);
  assert.equal(result.ok, false);
  assert.equal(row(result, 'units current').message, 'the plugin moved; rerun openclaw clawser setup');
  assert.deepEqual(failed(result), ['units current']);
  // A Node upgrade moves the controller's interpreter the same way.
  const node = await installed(t);
  node.deps.execPath = '/usr/local/bin/node';
  result = await doctor(node);
  assert.equal(row(result, 'units current').message, 'the plugin moved; rerun openclaw clawser setup');
  // Setup rewrites the units for the new folder, and doctor passes again.
  assert.equal((await runClawser(w.args, w.deps)).ok, true);
  result = await doctor(w);
  assert.equal(result.ok, true, JSON.stringify(result.checks));
});

test('a Docker-era receipt says to rerun setup', async t => {
  for (const imageId of ['sha256:' + 'a'.repeat(64), undefined]) {
    const w = await hostWorld(t, { config: { plugins: { entries: { 'browser-handoff': { enabled: true, config: { desktop: { enabled: true, socketPath: '/old/desktop.sock', profile: 'handoff' } } } } } } });
    await fs.mkdir(w.stateDir, { mode: 0o700 });
    await fs.writeFile(join(w.stateDir, 'setup.json'), JSON.stringify({ identity: 'clawser-setup-v1', uid: w.deps.uid, ownerId: randomUUID(), ...imageId ? { imageId } : {} }) + '\n', { mode: 0o600 });
    const result = await doctor(w);
    assert.equal(result.ok, false);
    assert.equal(result.backend, 'novnc');
    assert.deepEqual(hostRows(result), [{ name: 'installation', ok: false, message: 'This is a Docker desktop install from an older Clawser; rerun openclaw clawser setup' }]);
    assert.equal(w.calls.some(call => call.command === 'loginctl' || (call.command === 'systemctl' && call.args[1] === 'show') || xproofCalls(w).includes(call)), false);
    assert.equal(w.logs.at(-1), 'State: ' + w.stateDir);
  }
});

test('keyring cookies are a warning, not a failure', async t => {
  const w = await applyWorld(t);
  await cookieStore(w.udd, ['v11a', 'v11b', 'v11c', 'v10a'], { legacy: true });
  assert.equal((await runClawser([...w.yes, '--no-migrate-cookies'], w.deps)).ok, true);
  assert.equal(Object.hasOwn(await w.receipt(), 'cookieMigration'), false);
  const result = await doctor(w);
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.deepEqual(row(result, 'cookie store'), { name: 'cookie store', ok: true, warning: true, message: KEYRING(3) });
  assert.ok(w.logs.includes('WARN cookie store: ' + KEYRING(3)), w.logs.join('\n'));
  assert.deepEqual(hostRows(result).map(item => item.name), [...HOST_ROWS, 'cookie store']);
  // Option A's profile is Clawser's own, so it has no keyring cookies to warn about.
  const a = await installed(t);
  await cookieStore(join(a.stateDir, 'browser/profile'), ['v11a']);
  assert.equal(row(await doctor(a), 'cookie store'), undefined);
});

test('a hand-edited unit file says to rerun setup', async t => {
  const w = await installed(t);
  const browser = join(w.unitDir, w.names.browser), original = await fs.readFile(browser, 'utf8');
  await fs.writeFile(browser, original + 'Environment="EDITED=1"\n');
  let result = await doctor(w);
  assert.equal(result.ok, false);
  assert.equal(row(result, 'units current').message, `${w.names.browser} differs from what setup would write; rerun openclaw clawser setup`);
  assert.deepEqual(failed(result), ['units current']);
  await fs.writeFile(browser, original);
  assert.equal((await doctor(w)).ok, true);
  // Setup refuses a unit file other users can write, so doctor reports it the way setup would.
  await fs.chmod(browser, 0o664);
  result = await doctor(w);
  assert.equal(row(result, 'units current').message, 'Refusing unowned or non-private file: ' + browser);
  await fs.chmod(browser, 0o600);
  await fs.rm(join(w.unitDir, w.names.controller));
  result = await doctor(w);
  assert.equal(row(result, 'units current').message, `${w.names.controller} differs from what setup would write; rerun openclaw clawser setup`);
});

test('a profile pointing at another port fails the CDP origin check', async t => {
  const w = await installed(t);
  assert.equal((await w.receipt()).cdpPort, 18820);
  w.config.browser.profiles.clawser.cdpUrl = 'http://127.0.0.1:18821';
  let result = await doctor(w);
  assert.equal(result.ok, false);
  assert.equal(row(result, 'CDP origin').message, 'Browser profile clawser points at http://127.0.0.1:18821, not http://127.0.0.1:18820; rerun openclaw clawser setup');
  w.config.browser.profiles.clawser.cdpUrl = 'http://127.0.0.1:18820';
  w.config.browser.profiles.clawser.attachOnly = false;
  result = await doctor(w);
  assert.equal(row(result, 'CDP origin').message, 'Browser profile requires attachOnly=true; browser launch is unsupported');
});

test('a saved cookie export is a warning that says to rerun setup', async t => {
  const w = await applyWorld(t);
  assert.equal((await runClawser(w.yes, w.deps)).ok, true);
  const folders = [];
  for (const name of ['cookies-a', 'cookies-b', 'cookies-empty']) {
    const dir = join(w.stateDir, name);
    await fs.mkdir(dir, { mode: 0o700 });
    if (name !== 'cookies-empty') { await fs.writeFile(join(dir, 'cookies.json'), '[{"name":"sid"}]', { mode: 0o600 }); folders.push(dir); }
  }
  const result = await doctor(w);
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.deepEqual(row(result, 'cookie export'), { name: 'cookie export', ok: true, warning: true, message: EXPORT(folders) });
  assert.equal(hostRows(result).at(-1).name, 'cookie export');
  assert.ok(w.logs.includes('WARN cookie export: ' + EXPORT(folders)), w.logs.join('\n'));
  assert.doesNotMatch(JSON.stringify(result) + w.logs.join('\n'), /"sid"/);
  // A rerun moves the export over and removes it, and the warning goes with it. Clawser's own browser holds the port now.
  await fs.writeFile(join(w.root, 'proc/400/cgroup'), `0::/user.slice/user-${w.deps.uid}.slice/user@${w.deps.uid}.service/app.slice/${w.names.browser}\n`);
  Object.assign(w.cookies, { importCookies: async () => ({ count: 1 }), countCookies: async () => 1 });
  const rerun = await runClawser([...w.args, '--yes'], w.deps);
  assert.equal(rerun.ok, true, JSON.stringify(rerun));
  assert.deepEqual(await cookieDirs(w), []);
  assert.equal(row(await doctor(w), 'cookie export'), undefined);
});

test('an option B install checks its own profile directory and warns about keyring cookies left behind', async t => {
  const w = await applyWorld(t);
  await cookieStore(w.udd, ['v11a', 'v11b', 'v11c']);
  Object.assign(w.cookies, { exportCookies: exportsThree, importCookies: async () => { throw new Error('nope'); } });
  assert.equal((await runClawser(w.yes, w.deps)).ok, true);
  const saved = await w.receipt();
  assert.equal(saved.cookieMigration.failed, true);
  assert.equal(saved.userDataDir, w.udd);
  const [kept] = await cookieDirs(w);
  let result = await doctor(w);
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(row(result, 'profile directory').ok, true);
  assert.deepEqual(row(result, 'cookie store'), { name: 'cookie store', ok: true, warning: true, message: KEYRING(3) });
  assert.deepEqual(row(result, 'cookie export'), { name: 'cookie export', ok: true, warning: true, message: EXPORT([join(w.stateDir, kept)]) });
  assert.deepEqual(hostRows(result).map(item => item.name), [...HOST_ROWS, 'cookie store', 'cookie export']);
  // The person's own profile folder is checked, and doctor never tightens it.
  await fs.chmod(w.udd, 0o755);
  result = await doctor(w);
  assert.equal(row(result, 'profile directory').message, `${w.udd} is readable by other users; run: chmod 700 ${w.udd}`);
  assert.deepEqual(failed(result), ['profile directory']);
  assert.equal((await fs.stat(w.udd)).mode & 0o777, 0o755);
  // Cookies that moved over need no warning, even though the old store still holds them.
  const moved = await applyWorld(t);
  await cookieStore(moved.udd, ['v11a', 'v11b', 'v11c']);
  Object.assign(moved.cookies, { exportCookies: exportsThree, importCookies: async () => ({ count: 3 }), countCookies: async () => 3 });
  assert.equal((await runClawser(moved.yes, moved.deps)).ok, true);
  assert.equal((await moved.receipt()).cookieMigration.imported, 3);
  result = await doctor(moved);
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(row(result, 'cookie store'), undefined);
  assert.equal(row(result, 'cookie export'), undefined);
});
