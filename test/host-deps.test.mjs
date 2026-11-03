import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runClawser, ARTIFACTS } from '../src/setup.mjs';
import { hostWorld } from './host-fixture.mjs';
import { HOST_DEPS, installHostDeps, planHostDeps, smokeHostDeps, verifyHostDeps } from '../src/host-deps.mjs';
import { activationFixture } from './setup-activation-fixture.mjs';

const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const debian = 'ID=ubuntu\nID_LIKE=debian\n', fedora = 'ID="fedora"\n';
const probes = { x11vnc: '-version', openbox: '--version', Xvfb: '-help', python3: '--version' };
const packageFor = { x11vnc: 'x11vnc', openbox: 'openbox', Xvfb: 'xvfb', python3: 'python3' };
const all = ['x11vnc', 'Xvfb', 'openbox', 'python3'];
const cellarVersions = { 'xorg-server': '21.1.21', x11vnc: '0.9.17_1', python3: '3.13.1' };
const dpkgVersions = { x11vnc: '0.9.17-2', openbox: '3.6.1-12', python3: '3.11.2-1+b1', xvfb: '2:21.1.7-3+deb12u10' };
const helpers = {
  stat: async (path, d) => { try { return await d.fs.lstat(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } },
  noSymlinks: async () => {},
};

async function world(t, { system = [], brew = [], os = debian, smoke = {}, missingLibs = [] } = {}) {
  // A /tmp root keeps setup's socket paths under 107 bytes on macOS too.
  const root = await fs.realpath(await fs.mkdtemp('/tmp/clawser-host-deps-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const systemBin = join(root, 'usr/bin'), brewBin = join(root, 'brew/bin'), cellar = join(root, 'brew/Cellar');
  await fs.mkdir(systemBin, { recursive: true });
  for (const name of system) await fs.writeFile(join(systemBin, name), `${name} system`, { mode: 0o755 });
  for (const item of brew) {
    const bin = join(cellar, item, cellarVersions[item], 'bin'), name = item === 'xorg-server' ? 'Xvfb' : item;
    await fs.mkdir(bin, { recursive: true }); await fs.mkdir(brewBin, { recursive: true });
    await fs.writeFile(join(bin, name), `${item} bottle`, { mode: 0o755 });
    await fs.symlink(join(bin, name), join(brewBin, name));
  }
  await fs.writeFile(join(root, 'os-release'), os);
  const calls = [], smokes = [];
  const run = async (command, args = [], options = {}) => {
    calls.push({ command, args, options });
    const name = basename(command);
    // The X library check prints the libraries ctypes could not load.
    if (name === 'python3' && args[0] === '-c' && command.startsWith(root)) return args.slice(2).filter(soname => missingLibs.includes(soname)).join(' ');
    if (probes[name] && command.startsWith(root)) {
      if (name === 'Xvfb' && args[0] !== '-help') throw Object.assign(new Error(`Xvfb failed (1): Unrecognized option: ${args[0]}\nuse: X [:<display>] [option]`), { code: 1 });
      if (args[0] !== probes[name]) throw Object.assign(new Error(`${name} failed (1): unknown option ${args[0]}`), { code: 1 });
      return name === 'Xvfb' ? 'use: X [:<display>] [option]\n-a #  default pointer acceleration' : `${name} version ${name === 'x11vnc' ? '0.9.17' : name === 'python3' ? '3.11.2' : '3.6.1'}`;
    }
    if (command === 'dpkg-query') {
      if (args[0] === '-S' && args[1].startsWith(systemBin + '/')) return `${packageFor[basename(args[1])]}: ${args[1]}`;
      if (args[0] === '-S') throw Object.assign(new Error(`dpkg-query failed (1): no path found matching pattern ${args[1]}`), { code: 1 });
      if (args[0] === '-W') return dpkgVersions[args.at(-1)] ?? '';
    }
    throw new Error('Unexpected command: ' + command + ' ' + args.join(' '));
  };
  const hostSmoke = async binaries => { smokes.push(structuredClone(binaries)); return smoke; };
  const d = { fs, run, env: { PATH: [systemBin, ...(brew.length ? [brewBin] : [])].join(':') }, homeDir: root, hostPaths: [], osReleasePath: join(root, 'os-release'), hostSmoke };
  const resolve = async recorded => installHostDeps(await planHostDeps(recorded, d, helpers), d, { previous: recorded });
  return { root, systemBin, cellar, d, calls, smokes, resolve };
}

function assertNoSudo(calls) {
  for (const call of calls) {
    assert.equal([call.command, ...call.args].some(part => /(?:^|\/)sudo$/.test(String(part)) || String(part).includes('sudo ')), false, 'sudo invoked: ' + call.command + ' ' + call.args.join(' '));
    assert.equal(/(?:^|\/)(?:apt|apt-get|dpkg|dnf|yum|pacman|zypper|apk)$/.test(call.command), false, 'system package manager invoked: ' + call.command);
  }
}

test('already installed binaries are recorded with path, sha256 and package version without installing', async t => {
  const w = await world(t, { system: all });
  const { record, warnings } = await w.resolve();
  assert.deepEqual(warnings, []);
  assert.deepEqual(Object.keys(record), ['binaries']);
  for (const dep of HOST_DEPS.filter(dep => !dep.library)) {
    const path = join(w.systemBin, dep.name);
    assert.deepEqual(record.binaries[dep.name], { path, sha256: digest(await fs.readFile(path)), source: 'system', version: dpkgVersions[packageFor[dep.name]] });
  }
  assert.ok(w.calls.some(call => call.command.endsWith('/Xvfb') && call.args[0] === '-help'));
  assert.equal(w.calls.some(call => call.command.endsWith('/Xvfb') && call.args[0] === '-version'), false);
  assert.ok(w.calls.some(call => call.command === 'dpkg-query' && call.args.join(' ') === '-W -f ${Version} xvfb'));
  assert.equal(w.smokes.length, 1, 'a newly recorded set must pass the smoke test');
  assertNoSudo(w.calls);
});

test('an Xvfb version unknown to the package manager is recorded as unknown, not an error', async t => {
  const w = await world(t, { system: all, os: fedora });
  const { record } = await w.resolve();
  assert.equal(record.binaries.Xvfb.version, 'unknown');
  assert.equal(record.binaries.x11vnc.version, '0.9.17');
  assert.equal(w.calls.some(call => call.command === 'dpkg-query'), false);
});

test('a Homebrew binary that is already installed is found and recorded with its Cellar version, and brew is never run', async t => {
  const w = await world(t, { brew: ['xorg-server', 'x11vnc', 'python3'] });
  const plan = await planHostDeps(undefined, w.d, helpers);
  assert.match(plan.warnings.join('\n'), /^openbox is unavailable.*without a window manager.*sudo apt install openbox$/);
  const { record } = await installHostDeps(plan, w.d);
  const xvfb = join(w.cellar, 'xorg-server/21.1.21/bin/Xvfb');
  assert.deepEqual(record.binaries.Xvfb, { path: xvfb, sha256: digest(await fs.readFile(xvfb)), source: 'brew', version: '21.1.21' });
  assert.equal(record.binaries.x11vnc.version, '0.9.17_1');
  assert.deepEqual(Object.keys(record.binaries), ['Xvfb', 'x11vnc', 'python3']);
  assert.equal(w.calls.some(call => /^(?:brew|install)$/.test(basename(call.command)) || call.args.includes('install')), false);
  assertNoSudo(w.calls);
});

test('a missing required binary fails with the distro command and runs no installer', async t => {
  for (const [os, command] of [[debian, 'sudo apt install xvfb x11vnc openbox python3'], [fedora, 'sudo dnf install xorg-x11-server-Xvfb x11vnc openbox python3']]) {
    const w = await world(t, { os });
    await assert.rejects(w.resolve(), error => {
      assert.match(error.message, /^Missing Xvfb, x11vnc, python3\. /);
      assert.ok(error.message.endsWith('Ask the owner to install them, then rerun setup: ' + command), error.message);
      assert.doesNotMatch(error.message, /xclip|brew/i);
      return true;
    });
    assert.deepEqual(w.calls, []);
    assert.equal(w.smokes.length, 0);
  }
  const w = await world(t, { system: ['x11vnc', 'Xvfb', 'openbox'] });
  await assert.rejects(w.resolve(), /sudo apt install .*python3/);
  assert.equal(w.calls.some(call => /brew/.test(call.command)), false);
  const arch = await world(t, { system: ['x11vnc', 'Xvfb'], os: 'ID=arch\n' });
  await assert.rejects(arch.resolve(), /sudo pacman -S openbox python$/);
  const unknown = await world(t, { os: 'ID=plan9\n' });
  await assert.rejects(unknown.resolve(), /Ask the owner to install Xvfb, x11vnc, openbox, python3 with the system package manager/);
  const one = await world(t, { system: ['x11vnc', 'python3'] });
  await assert.rejects(one.resolve(), /^Error: Missing Xvfb\. .*: sudo apt install xvfb openbox$/);
});

test('a missing X client library is a required dependency with its distro package', async t => {
  const suse = 'ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n';
  for (const [os, command] of [[debian, 'sudo apt install libxres1'], [fedora, 'sudo dnf install libXres'], ['ID=arch\n', 'sudo pacman -S libxres'],
    [suse, 'sudo zypper install libXRes1'], ['ID=alpine\n', 'sudo apk add libxres']]) {
    const w = await world(t, { system: all, os, missingLibs: ['libXRes.so.1'] });
    await assert.rejects(w.resolve(), { message: 'Missing libXRes.so.1. Ask the owner to install them, then rerun setup: ' + command });
    const [check, ...more] = w.calls.filter(call => call.args[0] === '-c');
    assert.deepEqual(more, [], 'one library check');
    assert.equal(check.command, join(w.systemBin, 'python3'));
    assert.deepEqual(check.args.slice(2), ['libX11.so.6', 'libXRes.so.1', 'libXtst.so.6', 'libXi.so.6']);
    assert.equal(w.smokes.length, 0);
    assertNoSudo(w.calls);
  }
  // Every missing library is named at once, after any missing binary.
  const both = await world(t, { system: ['x11vnc', 'openbox', 'python3'], missingLibs: ['libX11.so.6', 'libXi.so.6'] });
  await assert.rejects(both.resolve(), { message: 'Missing Xvfb, libX11.so.6, libXi.so.6. Ask the owner to install them, then rerun setup: sudo apt install xvfb libx11-6 libxi6' });
  const plan = await planHostDeps(undefined, (await world(t, { system: all })).d, helpers);
  assert.deepEqual(Object.keys(plan.binaries), ['Xvfb', 'x11vnc', 'openbox', 'python3'], 'libraries are checked, never recorded');
});

test('partial availability: system x11vnc and python3, Homebrew Xvfb and a missing openbox only warns', async t => {
  const w = await world(t, { system: ['x11vnc', 'python3'], brew: ['xorg-server'], os: fedora });
  const plan = await planHostDeps(undefined, w.d, helpers);
  const { record, warnings } = await installHostDeps(plan, w.d);
  assert.equal(record.binaries.x11vnc.source, 'system');
  assert.equal(record.binaries.Xvfb.source, 'brew');
  assert.equal(record.binaries.openbox, undefined);
  assert.deepEqual(warnings, []);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /openbox is unavailable.*sudo dnf install openbox/);
  assert.equal((await verifyHostDeps(record, w.d, helpers)).length, 1);
  assertNoSudo(w.calls);
});

test('a failed smoke test of a required binary records nothing; a failed window manager is dropped with a warning', async t => {
  const broken = await world(t, { system: all, smoke: { x11vnc: 'exited (1): cannot open display' } });
  await assert.rejects(broken.resolve(), /smoke test failed.*x11vnc exited \(1\): cannot open display.*rerun `openclaw clawser setup`/);
  const wm = await world(t, { system: all, smoke: { openbox: 'exited (1): unable to find a valid menu file' } });
  const { record, warnings } = await wm.resolve();
  assert.deepEqual(Object.keys(record.binaries), ['Xvfb', 'x11vnc', 'python3']);
  assert.match(warnings.join('\n'), /openbox is unavailable.*failed the setup smoke test: exited \(1\): unable to find a valid menu file/);
});

test('an unchanged recorded set is reused without binary probes, installs or another smoke test', async t => {
  const w = await world(t, { system: all });
  const { record } = await w.resolve();
  w.calls.length = 0; w.smokes.length = 0;
  const again = await w.resolve(record);
  assert.deepEqual(again.record, record);
  // The X libraries are not recorded, so only their check runs again.
  assert.deepEqual(w.calls.map(call => [call.command, call.args[0]]), [[join(w.systemBin, 'python3'), '-c']]);
  assert.equal(w.smokes.length, 0);
});

test('doctor reports an upgraded system binary as re-recordable and setup re-resolves and smoke-tests it', async t => {
  const w = await world(t, { system: all });
  const { record } = await w.resolve();
  assert.deepEqual(await verifyHostDeps(record, w.d, helpers), []);
  await fs.writeFile(join(w.systemBin, 'Xvfb'), 'Xvfb after apt upgrade', { mode: 0o755 });
  w.calls.length = 0; w.smokes.length = 0;
  await assert.rejects(verifyHostDeps(record, w.d, helpers), error => {
    assert.equal(error.message, 'Xvfb at ' + join(w.systemBin, 'Xvfb') + ' is missing or changed since setup; rerun `openclaw clawser setup` to re-check and re-record it');
    return true;
  });
  assert.deepEqual(w.calls, [], 'doctor never probes or reinstalls');
  const again = await w.resolve(record);
  assert.equal(again.record.binaries.Xvfb.sha256, digest('Xvfb after apt upgrade'));
  assert.deepEqual(again.record.binaries.x11vnc, record.binaries.x11vnc);
  assert.equal(w.calls.some(call => call.command.endsWith('/x11vnc')), false, 'unchanged binaries are not re-probed');
  assert.equal(w.smokes.length, 1);
  assert.deepEqual(await verifyHostDeps(again.record, w.d, helpers), []);
});

test('a Homebrew upgrade with brew cleanup re-resolves to the new Cellar path through the prefix bin', async t => {
  const w = await world(t, { system: ['x11vnc', 'openbox', 'python3'], brew: ['xorg-server'] });
  const { record } = await w.resolve();
  const old = record.binaries.Xvfb.path;
  const fresh = join(w.cellar, 'xorg-server/21.1.25/bin/Xvfb');
  await fs.mkdir(join(w.cellar, 'xorg-server/21.1.25/bin'), { recursive: true });
  await fs.writeFile(fresh, 'xorg-server 21.1.25 bottle', { mode: 0o755 });
  const link = join(w.root, 'brew/bin/Xvfb');
  await fs.rm(link); await fs.symlink(fresh, link);
  await fs.rm(join(w.cellar, 'xorg-server/21.1.21'), { recursive: true });
  await assert.rejects(verifyHostDeps(record, w.d, helpers), error => error.message === 'Xvfb at ' + old + ' is missing or changed since setup; rerun `openclaw clawser setup` to re-check and re-record it');
  const again = await w.resolve(record);
  assert.deepEqual(again.record.binaries.Xvfb, { path: fresh, sha256: digest('xorg-server 21.1.25 bottle'), source: 'brew', version: '21.1.25' });
});

test('a malformed receipt entry fails without suggesting a new state directory', async t => {
  const w = await world(t, { system: ['x11vnc', 'Xvfb'] });
  for (const recorded of [{ binaries: [] }, { binaries: { Xvfb: { path: 'Xvfb', sha256: 'x', source: 'system', version: '1' } } }, { binaries: { Xvfb: { path: '/usr/bin/Xvfb', sha256: 'a'.repeat(64), source: 'extracted', version: '1' } } }]) {
    for (const attempt of [planHostDeps, verifyHostDeps]) {
      await assert.rejects(attempt(recorded, w.d, helpers), error => /(?:malformed; restore setup\.json, or delete its hostDeps entry|not recorded); rerun|and rerun `openclaw clawser setup`/.test(error.message) && !error.message.includes('new state directory'));
    }
  }
});

const hasProc = process.platform === 'linux';
const listeningInodes = async () => {
  const rows = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) for (const line of (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols[3] === '0A') rows.push(cols[9]);
  }
  return rows;
};
const socketInodes = async pid => {
  const out = [];
  for (const fd of await fs.readdir(`/proc/${pid}/fd`)) {
    const target = await fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
    const match = target.match(/^socket:\[(\d+)\]$/);
    if (match) out.push(match[1]);
  }
  return out;
};

async function smokeFixture(t, { python = `process.exit(0)` } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'clawser-host-smoke-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const log = join(root, 'log');
  const script = (name, body) => {
    const path = join(root, name);
    return fs.writeFile(path, `#!${process.execPath}\nconst fs = require('node:fs'), net = require('node:net');\nconst log = m => fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + ' ' + m + '\\n');\nlog(JSON.stringify({ args: process.argv.slice(2), display: process.env.DISPLAY ?? null, xauthority: process.env.XAUTHORITY ?? null }));\nprocess.on('SIGTERM', () => { log('SIGTERM'); process.exit(0); });\n${body}\n`, { mode: 0o755 }).then(() => path);
  };
  const xvfb = await script('Xvfb', "fs.writeSync(Number(process.argv[process.argv.indexOf('-displayfd') + 1]), '77\\n'); setInterval(() => {}, 1000);");
  const openbox = await script('openbox', 'setInterval(() => {}, 1000);');
  const x11vnc = await script('x11vnc', "net.createServer(socket => socket.end('RFB 003.008\\n')).listen(process.argv[process.argv.indexOf('-unixsock') + 1]); setInterval(() => {}, 1000);");
  const python3 = await script('python3', python);
  const entry = path => ({ path, sha256: 'x'.repeat(64), source: 'system', version: 'unknown' });
  const packageDir = join(root, 'package');
  return { root, log, packageDir, binaries: { Xvfb: entry(xvfb), x11vnc: entry(x11vnc), openbox: entry(openbox), python3: entry(python3) } };
}

test('the real smoke test serves x11vnc over a private socket, authenticates with a cookie, runs the X proof and stops everything', async t => {
  const f = await smokeFixture(t);
  const seen = [];
  const d = { env: { PATH: process.env.PATH, DISPLAY: ':0' }, packageDir: f.packageDir, onSmokeVnc: pid => seen.push(pid) };
  const failed = await smokeHostDeps(f.binaries, d, { settleMs: 200 });
  assert.deepEqual(failed, {});
  assert.equal(seen.length, 1);
  const lines = (await fs.readFile(f.log, 'utf8')).trim().split('\n');
  const started = Object.fromEntries(lines.filter(line => line.includes(' {')).map(line => [line.split(' ')[0], JSON.parse(line.slice(line.indexOf(' ') + 1))]));
  assert.deepEqual(started.Xvfb.args.slice(0, 2), ['-displayfd', '3']);
  for (const flag of ['-nolisten', '-auth']) assert.ok(started.Xvfb.args.includes(flag));
  assert.equal(started.Xvfb.display, null, 'the operator DISPLAY must not leak into the private server');
  assert.equal(started.openbox.display, ':77');
  assert.equal(started.x11vnc.display, ':77');
  assert.ok(started.x11vnc.xauthority);
  const args = started.x11vnc.args, at = flag => args[args.indexOf(flag) + 1];
  assert.deepEqual(args.slice(0, 2), ['-display', ':77']);
  assert.ok(args.includes('-noxrecord'));
  assert.equal(args.includes('-localhost'), false);
  assert.equal(at('-rfbport'), '0'); assert.equal(at('-rfbportv6'), '-1'); assert.ok(args.includes('-no6'));
  assert.ok(at('-unixsock').endsWith('/vnc.sock'));
  assert.deepEqual(started.python3.args, [join(f.packageDir, 'runtime/desktop/xproof.py'), 'clients']);
  assert.equal(started.python3.display, ':77');
  assert.equal(started.python3.xauthority, started.x11vnc.xauthority);
  await assert.rejects(fs.lstat(at('-unixsock')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(started.x11vnc.xauthority), { code: 'ENOENT' }, 'the temp cookie directory is removed');
  assert.deepEqual(lines.filter(line => line.endsWith('SIGTERM')).map(line => line.split(' ')[0]).sort(), ['Xvfb', 'openbox', 'x11vnc']);
});

test('the real smoke test leaves x11vnc without a TCP listener', { skip: !hasProc && 'needs /proc' }, async t => {
  const f = await smokeFixture(t);
  let owned = [], listening = [];
  const d = { env: { PATH: process.env.PATH }, packageDir: f.packageDir, onSmokeVnc: async pid => { owned = await socketInodes(pid); listening = await listeningInodes(); } };
  assert.deepEqual(await smokeHostDeps(f.binaries, d, { settleMs: 100 }), {});
  assert.ok(owned.length > 0, 'x11vnc held at least its Unix socket');
  assert.deepEqual(owned.filter(inode => listening.includes(inode)), []);
});

test('the smoke test reports python3 when the X proof helper fails', async t => {
  const f = await smokeFixture(t, { python: "console.error('cannot open display'); process.exit(1);" });
  const failed = await smokeHostDeps(f.binaries, { env: {}, packageDir: f.packageDir }, { settleMs: 100 });
  assert.deepEqual(Object.keys(failed), ['python3']);
  assert.match(failed.python3, /^exited \(1\): cannot open display/);
});

test('the real smoke test reports a binary that exits instead of serving', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'clawser-host-smoke-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name, body) => { const path = join(root, name); await fs.writeFile(path, `#!${process.execPath}\n${body}\n`, { mode: 0o755 }); return path; };
  const entry = path => ({ path, sha256: 'x'.repeat(64), source: 'system', version: 'unknown' });
  const xvfb = await write('Xvfb', "require('node:fs').writeSync(3, '78\\n'); setInterval(() => {}, 1000);");
  const vnc = await write('x11vnc', "console.error('XOpenDisplay failed'); process.exit(1);");
  const failed = await smokeHostDeps({ Xvfb: entry(xvfb), x11vnc: entry(vnc) }, { env: {} }, { settleMs: 100 });
  assert.match(failed.x11vnc, /^exited \(1\): XOpenDisplay failed/);
  const dead = await write('Xvfb-dead', "console.error('XKB: Failed to compile keymap'); process.exit(1);");
  const early = await smokeHostDeps({ Xvfb: entry(dead), x11vnc: entry(vnc) }, { env: {} }, { settleMs: 100 });
  assert.deepEqual(Object.keys(early), ['Xvfb']);
  assert.match(early.Xvfb, /XKB: Failed to compile keymap/);
});


// Host mode through runClawser with the real resolver over this world's binaries.
async function setupHarness(t, options) {
  const w = await world(t, options);
  const h = await hostWorld(t, { root: w.root, stateName: 'clawser', run: w.d.run, calls: w.calls, deps: {
    hostResolver: undefined, env: { ...w.d.env, XDG_CONFIG_HOME: join(w.root, 'config') },
    hostPaths: w.d.hostPaths, osReleasePath: w.d.osReleasePath, hostSmoke: w.d.hostSmoke,
  } });
  return { ...w, ...h, doctor: ['doctor', '--state-dir', h.stateDir] };
}

test('host setup always resolves host dependencies', async t => {
  const h = await setupHarness(t, { system: all, os: fedora });
  const dry = await runClawser([...h.args, '--dry-run'], h.deps);
  assert.equal(dry.ok, true);
  assert.ok(h.calls.some(call => call.command === join(h.systemBin, 'Xvfb') && call.args[0] === '-help'), 'dry-run probes the host binaries');
  assert.equal(h.smokes.length, 0, 'dry-run must not start processes');
  assert.equal((await runClawser(h.args, h.deps)).ok, true);
  const receipt = JSON.parse(await fs.readFile(join(h.stateDir, 'setup.json'), 'utf8'));
  assert.deepEqual(Object.keys(receipt.hostDeps.binaries), ['Xvfb', 'x11vnc', 'openbox', 'python3']);
  assert.equal(h.smokes.length, 1);
  assert.match(await fs.readFile(join(h.unitDir, h.names.display), 'utf8'), new RegExp(`ExecStart="${join(h.systemBin, 'Xvfb')}"`));
  assert.equal(JSON.parse(await fs.readFile(join(h.stateDir, 'state/runtime/supervisor.json'), 'utf8')).x11vnc, join(h.systemBin, 'x11vnc'));
  const doctor = await runClawser(h.doctor, h.deps);
  assert.equal(doctor.ok, true, JSON.stringify(doctor.checks));
  assert.ok(doctor.checks.some(row => row.name === 'host dependencies' && row.ok));
  assertNoSudo(h.calls);
});

test('setup records host dependencies in its private receipt before starting services, and doctor re-checks them', async t => {
  const h = await setupHarness(t, { system: ['x11vnc', 'python3'], brew: ['xorg-server'], os: fedora });
  const dry = await runClawser([...h.args, '--dry-run'], h.deps);
  assert.match(dry.plan.join('\n'), /Warning: openbox is unavailable.*sudo dnf install openbox/);
  assert.equal(h.calls.some(call => call.args[0] === 'install'), false, 'dry-run must not install');
  assert.equal(h.smokes.length, 0, 'dry-run must not start processes');
  await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
  const run = h.deps.run;
  let recordedAtFirstStart;
  h.deps.run = async (command, args, options) => {
    if (command === 'systemctl' && args[1] === 'enable' && !recordedAtFirstStart) recordedAtFirstStart = JSON.parse(await fs.readFile(join(h.stateDir, 'setup.json'), 'utf8')).hostDeps ?? null;
    return run(command, args, options);
  };
  const result = await runClawser(h.args, h.deps);
  h.deps.run = run;
  assert.equal(result.ok, true);
  assert.match(result.warnings.join('\n'), /openbox is unavailable/);
  assert.equal(result.units.includes(h.names.windowManager), false);
  const receipt = JSON.parse(await fs.readFile(join(h.stateDir, 'setup.json'), 'utf8'));
  assert.deepEqual(Object.keys(receipt.hostDeps), ['binaries']);
  assert.deepEqual(Object.keys(receipt.hostDeps.binaries), ['Xvfb', 'x11vnc', 'python3']);
  assert.equal(receipt.hostDeps.binaries.Xvfb.source, 'brew');
  assert.equal(h.smokes.length, 1);
  assert.deepEqual(recordedAtFirstStart, receipt.hostDeps, 'host dependencies are recorded before any service starts');
  h.calls.length = 0;
  assert.equal((await runClawser(h.args, h.deps)).ok, true);
  assert.equal(h.calls.some(call => call.command.endsWith('/brew')), false, 'rerun must reuse the recorded binaries');
  assert.equal(h.smokes.length, 1, 'an unchanged set is not smoke-tested again');
  let doctor = await runClawser(h.doctor, h.deps);
  assert.equal(doctor.ok, true, JSON.stringify(doctor.checks));
  assert.ok(doctor.checks.some(row => row.name === 'host dependencies' && row.ok));
  assert.ok(h.logs.some(line => /^WARN window manager: openbox is unavailable/.test(line)));
  await fs.writeFile(receipt.hostDeps.binaries.Xvfb.path, 'xorg-server rebuilt bottle', { mode: 0o755 });
  h.calls.length = 0;
  doctor = await runClawser(h.doctor, h.deps);
  assert.equal(doctor.ok, false);
  assert.match(doctor.checks.find(row => row.name === 'host dependencies').message, /changed since setup; rerun `openclaw clawser setup` to re-check and re-record it/);
  assert.equal(h.calls.some(call => call.command.endsWith('/brew') || call.command.endsWith('/Xvfb')), false);
  assert.equal(h.smokes.length, 1, 'doctor never starts processes');
  h.calls.length = 0;
  assert.equal((await runClawser(h.args, h.deps)).ok, true);
  assert.equal(h.calls.some(call => call.args[0] === 'install'), false, 'an upgraded Homebrew binary is re-resolved, not reinstalled');
  assert.equal(h.smokes.length, 2);
  assert.equal(JSON.parse(await fs.readFile(join(h.stateDir, 'setup.json'), 'utf8')).hostDeps.binaries.Xvfb.sha256, digest('xorg-server rebuilt bottle'));
  assert.equal((await runClawser(h.doctor, h.deps)).ok, true);
  assertNoSudo(h.calls);
});

test('a missing required binary fails host setup before any state, download or service', async t => {
  const h = await setupHarness(t, { os: debian });
  await assert.rejects(runClawser(h.args, h.deps), /^Error: Missing Xvfb, x11vnc, python3\. .*: sudo apt install xvfb x11vnc openbox python3$/);
  await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
  assert.deepEqual(h.mutations(), []);
  assertNoSudo(h.calls);
});

test('--cdp setup and doctor never call the host dependency resolver', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'clawser-host-cdp-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { browser: { defaultProfile: 'personal', profiles: { personal: { cdpUrl: 'http://127.0.0.1:9333', attachOnly: true, driver: 'openclaw', engine: 'chromium' } } } };
  const binary = Buffer.from('cloudflared'), commands = [];
  const forbidden = () => { throw new Error('CDP setup called the host dependency resolver'); };
  const deps = {
    fs, homeDir: root, env: { OPENCLAW_STATE_DIR: join(root, 'openclaw') }, packageDir: root, platform: 'linux', arch: 'x64', nodeVersion: '24.18.0', log: () => {},
    artifacts: { ...ARTIFACTS, cloudflared: { ...ARTIFACTS.cloudflared, sha256: digest(binary) } }, isPortFree: async () => true,
    hostResolver: { plan: forbidden, install: forbidden, verify: forbidden, describe: forbidden }, hostSmoke: forbidden,
    fetch: async url => {
      if (url === ARTIFACTS.cloudflared.url) return new Response(binary);
      if (url.endsWith('/json/version')) return Response.json({ Browser: 'Chrome/149', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/test' });
      return new Response('body {}', { headers: { 'content-type': 'text/css' } });
    },
    run: async (command, args, options = {}) => {
      commands.push([command, ...args]);
      assert.equal(command, 'openclaw');
      if (args[0] === '--version') return 'OpenClaw 2026.10.4';
      if (args[1] === 'get') return JSON.stringify(config[args[2]] ?? {});
      if (args[1] === 'patch') { if (!args.includes('--dry-run')) { const patch = JSON.parse(options.input); config.plugins = patch.plugins; config.tools = patch.tools; } return ''; }
      if (args[0] === 'plugins') {
        const directory = join(root, 'openclaw/browser-handoff/cloudflare');
        await fs.mkdir(directory, { mode: 0o700, recursive: true });
        await fs.writeFile(join(directory, 'transport.json'), JSON.stringify({ origin: 'https://fixture.trycloudflare.com', port: 18796, pid: 9999 }), { mode: 0o600 });
        await activation.publish(); return '';
      }
      throw new Error('Unexpected CLI request');
    },
  };
  const activation = activationFixture(config, deps);
  assert.equal((await runClawser(['setup', '--cdp', '--dry-run'], deps)).backend, 'cdp');
  assert.equal((await runClawser(['setup', '--cdp'], deps)).ok, true);
  const doctor = await runClawser(['doctor'], deps);
  assert.equal(doctor.backend, 'cdp');
  assert.equal(doctor.checks.some(row => row.name === 'host dependencies'), false);
  assert.equal(commands.some(command => /x11vnc|Xvfb|openbox|brew|dpkg/.test(command.join(' '))), false);
  assert.deepEqual((await fs.readdir(join(root, 'openclaw/clawser-cdp'))).sort(), ['bin', 'setup.json']);
});
