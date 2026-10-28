import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runClawser, ARTIFACTS } from '../src/setup.mjs';
import { HOST_DEPS, installHostDeps, planHostDeps, smokeHostDeps, verifyHostDeps } from '../src/host-deps.mjs';
import { activationFixture } from './setup-activation-fixture.mjs';

const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const debian = 'ID=ubuntu\nID_LIKE=debian\n', fedora = 'ID="fedora"\n';
const probes = { x11vnc: '-version', openbox: '--version', Xvfb: '-help' };
const packageFor = { x11vnc: 'x11vnc', openbox: 'openbox', Xvfb: 'xvfb' };
const cellarVersions = { 'xorg-server': '21.1.21', x11vnc: '0.9.17_1' };
const dpkgVersions = { x11vnc: '0.9.17-2', openbox: '3.6.1-12', xvfb: '2:21.1.7-3+deb12u10' };
const helpers = {
  stat: async (path, d) => { try { return await d.fs.lstat(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } },
  noSymlinks: async () => {},
};

async function world(t, { system = [], brew = false, os = debian, smoke = {} } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'clawser-host-deps-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const systemBin = join(root, 'usr/bin'), brewBin = join(root, 'brew/bin'), cellar = join(root, 'brew/Cellar');
  await fs.mkdir(systemBin, { recursive: true });
  for (const name of system) await fs.writeFile(join(systemBin, name), `${name} system`, { mode: 0o755 });
  if (brew) { await fs.mkdir(brewBin, { recursive: true }); await fs.writeFile(join(brewBin, 'brew'), 'brew', { mode: 0o755 }); }
  await fs.writeFile(join(root, 'os-release'), os);
  const calls = [], smokes = [];
  const run = async (command, args = [], options = {}) => {
    calls.push({ command, args, options });
    const name = basename(command);
    if (probes[name] && command.startsWith(root)) {
      if (name === 'Xvfb' && args[0] !== '-help') throw Object.assign(new Error(`Xvfb failed (1): Unrecognized option: ${args[0]}\nuse: X [:<display>] [option]`), { code: 1 });
      if (args[0] !== probes[name]) throw Object.assign(new Error(`${name} failed (1): unknown option ${args[0]}`), { code: 1 });
      return name === 'Xvfb' ? 'use: X [:<display>] [option]\n-a #  default pointer acceleration' : `${name} version ${name === 'x11vnc' ? '0.9.17' : '3.6.1'}`;
    }
    if (command === 'dpkg-query') {
      if (args[0] === '-S' && args[1].startsWith(systemBin + '/')) return `${packageFor[basename(args[1])]}: ${args[1]}`;
      if (args[0] === '-S') throw Object.assign(new Error(`dpkg-query failed (1): no path found matching pattern ${args[1]}`), { code: 1 });
      if (args[0] === '-W') return dpkgVersions[args.at(-1)] ?? '';
    }
    if (command === join(brewBin, 'brew')) {
      const formula = args.at(-1);
      if (args[0] === '--prefix') return join(cellar, formula, (await fs.readdir(join(cellar, formula)).catch(() => [cellarVersions[formula]])).sort().at(-1)) + '\n';
      for (const item of args.slice(1)) {
        const bin = join(cellar, item, cellarVersions[item], 'bin');
        await fs.mkdir(bin, { recursive: true });
        await fs.writeFile(join(bin, item === 'xorg-server' ? 'Xvfb' : item), `${item} bottle`, { mode: 0o755 });
      }
      return '';
    }
    throw new Error('Unexpected command: ' + command + ' ' + args.join(' '));
  };
  const hostSmoke = async binaries => { smokes.push(structuredClone(binaries)); return smoke; };
  const d = { fs, run, env: { PATH: [systemBin, ...(brew ? [brewBin] : [])].join(':') }, homeDir: root, hostPaths: [], osReleasePath: join(root, 'os-release'), hostSmoke };
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
  const w = await world(t, { system: ['x11vnc', 'Xvfb', 'openbox'], brew: true });
  const { record, warnings } = await w.resolve();
  assert.deepEqual(warnings, []);
  assert.deepEqual(Object.keys(record), ['binaries']);
  for (const dep of HOST_DEPS) {
    const path = join(w.systemBin, dep.name);
    assert.deepEqual(record.binaries[dep.name], { path, sha256: digest(await fs.readFile(path)), source: 'system', version: dpkgVersions[packageFor[dep.name]] });
  }
  assert.ok(w.calls.some(call => call.command.endsWith('/Xvfb') && call.args[0] === '-help'));
  assert.equal(w.calls.some(call => call.command.endsWith('/Xvfb') && call.args[0] === '-version'), false);
  assert.ok(w.calls.some(call => call.command === 'dpkg-query' && call.args.join(' ') === '-W -f ${Version} xvfb'));
  assert.equal(w.calls.some(call => call.command.endsWith('/brew')), false);
  assert.equal(w.smokes.length, 1, 'a newly recorded set must pass the smoke test');
  assertNoSudo(w.calls);
});

test('an Xvfb version unknown to the package manager is recorded as unknown, not an error', async t => {
  const w = await world(t, { system: ['x11vnc', 'Xvfb', 'openbox'], os: fedora });
  const { record } = await w.resolve();
  assert.equal(record.binaries.Xvfb.version, 'unknown');
  assert.equal(record.binaries.x11vnc.version, '0.9.17');
  assert.equal(w.calls.some(call => call.command === 'dpkg-query'), false);
});

test('Homebrew installs x11vnc and xorg-server, takes the Xvfb version from its Cellar path and warns for openbox with its install line', async t => {
  const w = await world(t, { brew: true });
  const plan = await planHostDeps(undefined, w.d, helpers);
  assert.match(plan.warnings.join('\n'), /^openbox is unavailable.*without a window manager.*sudo apt install openbox$/);
  const { record } = await installHostDeps(plan, w.d);
  assert.deepEqual(w.calls.find(call => call.args[0] === 'install').args, ['install', 'xorg-server', 'x11vnc']);
  const xvfb = join(w.cellar, 'xorg-server/21.1.21/bin/Xvfb');
  assert.deepEqual(record.binaries.Xvfb, { path: xvfb, sha256: digest(await fs.readFile(xvfb)), source: 'brew', version: '21.1.21' });
  assert.equal(record.binaries.x11vnc.version, '0.9.17_1');
  assert.deepEqual(Object.keys(record.binaries), ['Xvfb', 'x11vnc']);
  assertNoSudo(w.calls);
});

test('without Homebrew, a missing required binary fails with the exact distro install command', async t => {
  for (const [os, command] of [[debian, 'sudo apt install xvfb x11vnc openbox'], [fedora, 'sudo dnf install xorg-x11-server-Xvfb x11vnc openbox']]) {
    const w = await world(t, { os });
    await assert.rejects(w.resolve(), error => {
      assert.match(error.message, /^Missing Xvfb, x11vnc, and Homebrew is not available to install them\./);
      assert.ok(error.message.endsWith('Ask the owner to install them, then rerun setup: ' + command), error.message);
      return true;
    });
    assert.deepEqual(w.calls, []);
    assert.equal(w.smokes.length, 0);
  }
  const unknown = await world(t, { os: 'ID=plan9\n' });
  await assert.rejects(unknown.resolve(), /Ask the owner to install Xvfb, x11vnc, openbox with the system package manager/);
  const one = await world(t, { system: ['x11vnc'] });
  await assert.rejects(one.resolve(), /^Error: Missing Xvfb, and Homebrew is not available to install it\. .*: sudo apt install xvfb openbox$/);
});

test('partial availability: system x11vnc, brew Xvfb and a missing openbox only warns', async t => {
  const w = await world(t, { system: ['x11vnc'], brew: true, os: fedora });
  const plan = await planHostDeps(undefined, w.d, helpers);
  const { record, warnings } = await installHostDeps(plan, w.d);
  assert.equal(record.binaries.x11vnc.source, 'system');
  assert.equal(record.binaries.Xvfb.source, 'brew');
  assert.equal(record.binaries.openbox, undefined);
  assert.deepEqual(w.calls.find(call => call.args[0] === 'install').args, ['install', 'xorg-server']);
  assert.deepEqual(warnings, []);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /openbox is unavailable.*sudo dnf install openbox/);
  assert.equal((await verifyHostDeps(record, w.d, helpers)).length, 1);
  assertNoSudo(w.calls);
});

test('a failed smoke test of a required binary records nothing; a failed window manager is dropped with a warning', async t => {
  const broken = await world(t, { system: ['x11vnc', 'Xvfb', 'openbox'], smoke: { x11vnc: 'exited (1): cannot open display' } });
  await assert.rejects(broken.resolve(), /smoke test failed.*x11vnc exited \(1\): cannot open display.*rerun `clawser setup --novnc`/);
  const wm = await world(t, { system: ['x11vnc', 'Xvfb', 'openbox'], smoke: { openbox: 'exited (1): unable to find a valid menu file' } });
  const { record, warnings } = await wm.resolve();
  assert.deepEqual(Object.keys(record.binaries), ['Xvfb', 'x11vnc']);
  assert.match(warnings.join('\n'), /openbox is unavailable.*failed the setup smoke test: exited \(1\): unable to find a valid menu file/);
});

test('an unchanged recorded set is reused without probes, installs or another smoke test', async t => {
  const w = await world(t, { system: ['x11vnc', 'Xvfb', 'openbox'], brew: true });
  const { record } = await w.resolve();
  w.calls.length = 0; w.smokes.length = 0;
  const again = await w.resolve(record);
  assert.deepEqual(again.record, record);
  assert.deepEqual(w.calls, []);
  assert.equal(w.smokes.length, 0);
});

test('doctor reports an upgraded system binary as re-recordable and setup re-resolves and smoke-tests it', async t => {
  const w = await world(t, { system: ['x11vnc', 'Xvfb', 'openbox'] });
  const { record } = await w.resolve();
  assert.deepEqual(await verifyHostDeps(record, w.d, helpers), []);
  await fs.writeFile(join(w.systemBin, 'Xvfb'), 'Xvfb after apt upgrade', { mode: 0o755 });
  w.calls.length = 0; w.smokes.length = 0;
  await assert.rejects(verifyHostDeps(record, w.d, helpers), error => {
    assert.equal(error.message, 'Xvfb at ' + join(w.systemBin, 'Xvfb') + ' is missing or changed since setup; rerun `clawser setup --novnc` to re-check and re-record it');
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

test('a Homebrew upgrade with brew cleanup re-resolves to the new Cellar path without reinstalling', async t => {
  const w = await world(t, { system: ['x11vnc', 'openbox'], brew: true });
  const { record } = await w.resolve();
  const old = record.binaries.Xvfb.path;
  await fs.mkdir(join(w.cellar, 'xorg-server/21.1.25/bin'), { recursive: true });
  await fs.writeFile(join(w.cellar, 'xorg-server/21.1.25/bin/Xvfb'), 'xorg-server 21.1.25 bottle', { mode: 0o755 });
  await fs.rm(join(w.cellar, 'xorg-server/21.1.21'), { recursive: true });
  await assert.rejects(verifyHostDeps(record, w.d, helpers), error => error.message === 'Xvfb at ' + old + ' is missing or changed since setup; rerun `clawser setup --novnc` to re-check and re-record it');
  w.calls.length = 0;
  const again = await w.resolve(record);
  assert.deepEqual(again.record.binaries.Xvfb, { path: join(w.cellar, 'xorg-server/21.1.25/bin/Xvfb'), sha256: digest('xorg-server 21.1.25 bottle'), source: 'brew', version: '21.1.25' });
  assert.equal(w.calls.some(call => call.args[0] === 'install'), false);
});

test('a malformed receipt entry fails without suggesting a new state directory', async t => {
  const w = await world(t, { system: ['x11vnc', 'Xvfb'] });
  for (const recorded of [{ binaries: [] }, { binaries: { Xvfb: { path: 'Xvfb', sha256: 'x', source: 'system', version: '1' } } }, { binaries: { Xvfb: { path: '/usr/bin/Xvfb', sha256: 'a'.repeat(64), source: 'extracted', version: '1' } } }]) {
    for (const attempt of [planHostDeps, verifyHostDeps]) {
      await assert.rejects(attempt(recorded, w.d, helpers), error => /(?:malformed; restore setup\.json, or delete its hostDeps entry|not recorded); rerun|and rerun `clawser setup --novnc`/.test(error.message) && !error.message.includes('new state directory'));
    }
  }
});

test('the real smoke test starts Xvfb on a displayfd display, then openbox and loopback x11vnc, and stops all three', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'clawser-host-smoke-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const log = join(root, 'log');
  const script = (name, body) => {
    const path = join(root, name);
    return fs.writeFile(path, `#!${process.execPath}\nconst fs = require('node:fs'), net = require('node:net');\nconst log = m => fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + ' ' + m + '\\n');\nlog(JSON.stringify({ args: process.argv.slice(2), display: process.env.DISPLAY ?? null }));\nprocess.on('SIGTERM', () => { log('SIGTERM'); process.exit(0); });\n${body}\n`, { mode: 0o755 }).then(() => path);
  };
  const xvfb = await script('Xvfb', "fs.writeSync(Number(process.argv[process.argv.indexOf('-displayfd') + 1]), '77\\n'); setInterval(() => {}, 1000);");
  const openbox = await script('openbox', 'setInterval(() => {}, 1000);');
  const x11vnc = await script('x11vnc', "const port = Number(process.argv[process.argv.indexOf('-rfbport') + 1]); net.createServer(socket => socket.end('RFB 003.008\\n')).listen(port, '127.0.0.1'); setInterval(() => {}, 1000);");
  const entry = path => ({ path, sha256: 'x'.repeat(64), source: 'system', version: 'unknown' });
  const failed = await smokeHostDeps({ Xvfb: entry(xvfb), x11vnc: entry(x11vnc), openbox: entry(openbox) }, { env: { PATH: process.env.PATH, DISPLAY: ':0' } }, { settleMs: 200 });
  assert.deepEqual(failed, {});
  const lines = (await fs.readFile(log, 'utf8')).trim().split('\n');
  const started = Object.fromEntries(lines.filter(line => line.includes(' {')).map(line => [line.split(' ')[0], JSON.parse(line.slice(line.indexOf(' ') + 1))]));
  assert.deepEqual(started.Xvfb.args.slice(0, 2), ['-displayfd', '3']);
  assert.equal(started.Xvfb.display, null, 'the operator DISPLAY must not leak into the private server');
  assert.equal(started.openbox.display, ':77');
  assert.equal(started.x11vnc.display, ':77');
  for (const flag of ['-localhost', '-noxrecord']) assert.ok(started.x11vnc.args.includes(flag));
  assert.deepEqual(started.x11vnc.args.slice(0, 2), ['-display', ':77']);
  assert.deepEqual(lines.filter(line => line.endsWith('SIGTERM')).map(line => line.split(' ')[0]).sort(), ['Xvfb', 'openbox', 'x11vnc']);
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

async function setupHarness(t, options) {
  const w = await world(t, options);
  const root = w.root, stateDir = join(root, 'clawser'), packageDir = join(root, 'package');
  for (const name of ['bin', 'runtime/desktop']) await fs.mkdir(join(packageDir, name), { recursive: true });
  for (const name of ['index.mjs', 'bin/desktop-controller.mjs', 'runtime/desktop/Dockerfile', 'runtime/desktop/chromium-seccomp.json']) await fs.writeFile(join(packageDir, name), 'fixture');
  await fs.mkdir(join(root, 'archive/noVNC-1.7.0/core'), { recursive: true });
  await fs.writeFile(join(root, 'archive/noVNC-1.7.0/core/rfb.js'), 'export default class RFB {}');
  await execute('tar', ['-czf', join(root, 'novnc.tgz'), '-C', join(root, 'archive'), 'noVNC-1.7.0']);
  const binary = Buffer.from('cloudflared'), archive = await fs.readFile(join(root, 'novnc.tgz'));
  const config = {}, logs = [];
  let serviceActive = false, servicePath = '';
  const hostRun = w.d.run;
  const deps = {
    ...w.d, packageDir, platform: 'linux', arch: 'x64', nodeVersion: '24.18.0', execPath: '/usr/bin/node', hostDependencies: true,
    env: { ...w.d.env, XDG_CONFIG_HOME: join(root, 'config') },
    artifacts: { cloudflared: { ...ARTIFACTS.cloudflared, sha256: digest(binary) }, noVnc: { ...ARTIFACTS.noVnc, sha256: digest(archive) } },
    log: message => logs.push(message), isPortFree: async () => true, sleep: async () => {},
    controllerHealth: async () => ({ ready: true, profile: 'handoff', cdpUrl: 'http://127.0.0.1:18812', recoveryRequired: false }),
    fetch: async url => new Response(url === ARTIFACTS.cloudflared.url ? binary : archive),
    run: async (command, args, opts = {}) => {
      if (command === 'tar') { w.calls.push({ command, args, options: opts }); return (await execute(command, args)).stdout; }
      if (command === 'openclaw') {
        w.calls.push({ command, args, options: opts });
        if (args[0] === '--version') return 'OpenClaw 2026.10.4';
        if (args[1] === 'get') return JSON.stringify(config[args[2]] ?? {});
        if (args[1] === 'patch') { if (!args.includes('--dry-run')) Object.assign(config, structuredClone({ ...config, ...JSON.parse(opts.input) })); return ''; }
        if (args[0] === 'plugins') { await activation.publish(); return ''; }
      }
      if (command === 'docker') { w.calls.push({ command, args, options: opts }); if (args.includes('inspect') && !args.includes('image')) throw new Error('No such object'); return args.includes('image') ? 'sha256:' + 'a'.repeat(64) : '27.0.0'; }
      if (command === 'systemctl' || command === '/usr/bin/flock') {
        w.calls.push({ command, args, options: opts });
        if (args.includes('show')) return `LoadState=${servicePath ? 'loaded' : 'not-found'}\nFragmentPath=${servicePath}\nActiveState=${serviceActive ? 'active' : 'inactive'}\n`;
        if (args.includes('enable')) { serviceActive = true; servicePath = join(root, 'config/systemd/user', args.at(-1)); }
        return '';
      }
      return hostRun(command, args, opts);
    },
  };
  const activation = activationFixture(config, deps);
  return { ...w, stateDir, deps, logs, args: ['setup', '--novnc', '--state-dir', stateDir], doctor: ['doctor', '--novnc', '--state-dir', stateDir] };
}

test('noVNC setup leaves host dependencies off by default: no resolver, receipt entry or doctor check', async t => {
  const h = await setupHarness(t, { os: fedora });
  delete h.deps.hostDependencies;
  h.deps.hostResolver = { plan: () => assert.fail('resolver planned'), install: () => assert.fail('resolver installed'), verify: () => assert.fail('resolver verified'), describe: () => assert.fail('resolver described') };
  assert.equal((await runClawser([...h.args, '--dry-run'], h.deps)).hostDependencies, undefined);
  assert.equal((await runClawser(h.args, h.deps)).ok, true, 'a host with no display binaries still installs the Docker desktop');
  assert.equal('hostDeps' in JSON.parse(await fs.readFile(join(h.stateDir, 'setup.json'), 'utf8')), false);
  const doctor = await runClawser(h.doctor, h.deps);
  assert.equal(doctor.ok, true, JSON.stringify(doctor.checks));
  assert.equal(doctor.checks.some(row => row.name === 'host dependencies' || row.name === 'window manager'), false);
  assert.equal(h.calls.some(call => /x11vnc|Xvfb|openbox|brew|dpkg/.test(call.command)), false);
  assert.equal(h.smokes.length, 0);
});

test('with host dependencies on, setup records them in its private receipt before building, and doctor re-checks them', async t => {
  const h = await setupHarness(t, { system: ['x11vnc'], brew: true, os: fedora });
  const dry = await runClawser([...h.args, '--dry-run'], h.deps);
  assert.ok(dry.hostDependencies.includes('Xvfb: brew install xorg-server'));
  assert.match(dry.warnings.join('\n'), /openbox is unavailable.*sudo dnf install openbox/);
  assert.equal(h.calls.some(call => call.args[0] === 'install'), false, 'dry-run must not install');
  assert.equal(h.smokes.length, 0, 'dry-run must not start processes');
  await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
  const result = await runClawser(h.args, h.deps);
  assert.equal(result.ok, true);
  assert.match(result.warnings.join('\n'), /openbox is unavailable/);
  const receipt = JSON.parse(await fs.readFile(join(h.stateDir, 'setup.json'), 'utf8'));
  assert.deepEqual(Object.keys(receipt.hostDeps), ['binaries']);
  assert.deepEqual(Object.keys(receipt.hostDeps.binaries), ['Xvfb', 'x11vnc']);
  assert.equal(receipt.hostDeps.binaries.Xvfb.source, 'brew');
  const install = h.calls.findIndex(call => call.args[0] === 'install'), build = h.calls.findIndex(call => call.command === 'docker' && call.args.includes('build'));
  assert.ok(install >= 0 && install < build);
  assert.equal(h.smokes.length, 1);
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
  assert.match(doctor.checks.find(row => row.name === 'host dependencies').message, /changed since setup; rerun `clawser setup --novnc` to re-check and re-record it/);
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

test('with host dependencies on, a missing required binary fails noVNC setup before any state, download or build', async t => {
  const h = await setupHarness(t, { os: debian });
  await assert.rejects(runClawser(h.args, h.deps), /host dependencies: Missing Xvfb, x11vnc, .*: sudo apt install xvfb x11vnc openbox$/);
  await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
  assert.equal(h.calls.some(call => call.command === 'docker' && call.args.includes('build')), false);
  assertNoSudo(h.calls);
});

test('default CDP setup and doctor never call the host dependency resolver, even with host dependencies on', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'clawser-host-cdp-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { browser: { defaultProfile: 'personal', profiles: { personal: { cdpUrl: 'http://127.0.0.1:9333', attachOnly: true, driver: 'openclaw', engine: 'chromium' } } } };
  const binary = Buffer.from('cloudflared'), commands = [];
  const forbidden = () => { throw new Error('CDP setup called the host dependency resolver'); };
  const deps = {
    fs, homeDir: root, env: { OPENCLAW_STATE_DIR: join(root, 'openclaw') }, packageDir: root, platform: 'linux', arch: 'x64', nodeVersion: '24.18.0', log: () => {},
    artifacts: { ...ARTIFACTS, cloudflared: { ...ARTIFACTS.cloudflared, sha256: digest(binary) } }, isPortFree: async () => true,
    hostDependencies: true, hostResolver: { plan: forbidden, install: forbidden, verify: forbidden, describe: forbidden }, hostSmoke: forbidden,
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
  assert.equal((await runClawser(['setup', '--dry-run'], deps)).backend, 'cdp');
  assert.equal((await runClawser(['setup'], deps)).ok, true);
  const doctor = await runClawser(['doctor'], deps);
  assert.equal(doctor.backend, 'cdp');
  assert.equal(doctor.checks.some(row => row.name === 'host dependencies'), false);
  assert.equal(commands.some(command => /x11vnc|Xvfb|openbox|brew|dpkg/.test(command.join(' '))), false);
  assert.deepEqual((await fs.readdir(join(root, 'openclaw/clawser-cdp'))).sort(), ['bin', 'setup.json']);
});
