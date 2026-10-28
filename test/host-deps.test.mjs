import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runClawser, ARTIFACTS } from '../src/setup.mjs';
import { HOST_DEPS, installHostDeps, planHostDeps, verifyHostDeps } from '../src/host-deps.mjs';
import { activationFixture } from './setup-activation-fixture.mjs';

const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const debian = 'ID=ubuntu\nID_LIKE=debian\n', fedora = 'ID="fedora"\n';
const versions = { x11vnc: '0.9.17', Xvfb: '21.1.25', openbox: '3.6.1' };
const aptTree = {
  x11vnc: ['libvncserver1', 'libc6'], openbox: ['libobt2v5|libobt-legacy', 'libc6'], xvfb: ['<xserver-common-virtual>', 'libgl1|libc6'],
  libvncserver1: ['libvncclient1', 'libc6'], libvncclient1: ['libc6'], 'xserver-common': [], libobt2v5: [],
};
const providers = { 'xserver-common-virtual': ['xserver-common'] };
const helpers = {
  stat: async (path, d) => { try { return await d.fs.lstat(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } },
  noSymlinks: async () => {},
  privatePath: async (path, kind, d) => { const info = await d.fs.lstat(path); if (!(kind === 'directory' ? info.isDirectory() : info.isFile()) || (info.mode & 0o077)) throw new Error('non-private ' + path); return info; },
};

function dependsOutput(packages) {
  return packages.map(name => name + '\n' + (aptTree[name] ?? []).flatMap(spec => {
    const alternatives = spec.split('|');
    return alternatives.flatMap((alt, index) => {
      const line = ' ' + (index < alternatives.length - 1 ? '|' : ' ') + 'Depends: ' + alt;
      return alt.startsWith('<') ? [line, ...providers[alt.slice(1, -1)].map(provider => '    ' + provider)] : [line + ' (>= 1.0)'];
    });
  }).join('\n')).join('\n');
}

async function world(t, { system = [], brew = false, os = debian, installed = ['libc6'], aptFail = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'clawser-host-deps-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const systemBin = join(root, 'usr/bin'), brewBin = join(root, 'brew/bin'), cellar = join(root, 'brew/Cellar'), stateDir = join(root, 'state');
  await fs.mkdir(systemBin, { recursive: true });
  for (const name of system) await fs.writeFile(join(systemBin, name), `${name} system`, { mode: 0o755 });
  if (brew) { await fs.mkdir(brewBin, { recursive: true }); await fs.writeFile(join(brewBin, 'brew'), 'brew', { mode: 0o755 }); }
  await fs.writeFile(join(root, 'os-release'), os);
  await fs.mkdir(stateDir, { mode: 0o700 });
  const calls = [], debs = join(root, 'debs');
  const run = async (command, args = [], options = {}) => {
    calls.push({ command, args, options });
    const name = basename(command);
    if (versions[name] && command.startsWith(root)) {
      if (name === 'Xvfb' && command.includes('/clawser-novnc/')) assert.ok(options.env?.LD_LIBRARY_PATH?.includes('/clawser-novnc/'), 'extracted binaries must run with their extracted libraries');
      return name === 'Xvfb' ? `\nX.Org X Server ${versions[name]}\nX Protocol Version 11` : `${name} version ${versions[name]}`;
    }
    if (command === join(brewBin, 'brew')) {
      const formula = args.at(-1);
      if (args[0] === '--prefix') return join(cellar, formula, '1.0') + '\n';
      for (const item of args.slice(1)) {
        const bin = join(cellar, item, '1.0/bin');
        await fs.mkdir(bin, { recursive: true });
        await fs.writeFile(join(bin, item === 'xorg-server' ? 'Xvfb' : item), `${item} bottle`, { mode: 0o755 });
      }
      return '';
    }
    if (command === 'apt-cache') {
      const packages = args.filter(arg => !arg.startsWith('-')).slice(1);
      if (packages.some(name => !aptTree[name])) throw Object.assign(new Error('apt-cache failed (100): E: No packages found'), { code: 100 });
      return dependsOutput(packages);
    }
    if (command === 'dpkg' && args[0] === '-s') {
      const stanzas = args.slice(1).filter(name => installed.includes(name)).map(name => `Package: ${name}\nStatus: install ok installed\n`);
      if (stanzas.length === args.length - 1) return stanzas.join('\n');
      throw Object.assign(new Error('dpkg-query: package is not installed'), { code: 1, stdout: stanzas.join('\n') });
    }
    if (command === 'apt-get' && args[0] === 'download') {
      if (aptFail) throw Object.assign(new Error('apt-get failed (100): E: Failed to fetch http://archive.ubuntu.com/x11vnc_0.9.17.deb  Temporary failure resolving'), { code: 100 });
      for (const pkg of args.slice(1)) {
        const tree = join(debs, pkg);
        const bin = { x11vnc: 'x11vnc', openbox: 'openbox', xvfb: 'Xvfb' }[pkg];
        await fs.mkdir(join(tree, bin ? 'usr/bin' : 'usr/lib/x86_64-linux-gnu'), { recursive: true });
        await fs.writeFile(bin ? join(tree, 'usr/bin', bin) : join(tree, 'usr/lib/x86_64-linux-gnu', pkg + '.so'), pkg + ' deb', { mode: 0o755 });
        await execute('tar', ['-cf', join(options.cwd, `${pkg}_1.0_amd64.deb`), '-C', tree, '.']);
      }
      return '';
    }
    if (command === 'dpkg' && args[0] === '-x') { await execute('tar', ['-xf', args[1], '-C', args[2]]); return ''; }
    throw new Error('Unexpected command: ' + command + ' ' + args.join(' '));
  };
  const d = { fs, run, env: { PATH: [systemBin, ...(brew ? [brewBin] : [])].join(':') }, homeDir: root, hostPaths: [], osReleasePath: join(root, 'os-release'), uid: process.getuid() };
  const p = { hostDeps: join(stateDir, 'clawser-novnc'), hostRoot: join(stateDir, 'clawser-novnc/root') };
  const resolve = async (recorded) => {
    const plan = await planHostDeps(recorded, p, d, helpers);
    let intent;
    const result = await installHostDeps(plan, p, d, helpers, async value => { intent = value; });
    return { plan, intent, ...result };
  };
  return { root, systemBin, cellar, stateDir, d, p, calls, resolve };
}

function assertNoSudo(calls) {
  for (const call of calls) assert.equal([call.command, ...call.args].some(part => /(?:^|\/)sudo$/.test(String(part)) || String(part).includes('sudo ')), false, 'sudo invoked: ' + call.command + ' ' + call.args.join(' '));
}

test('already installed binaries are recorded by absolute path, sha256 and probed version without installing anything', async t => {
  const w = await world(t, { system: ['x11vnc', 'Xvfb', 'openbox'], brew: true });
  const { record, warnings } = await w.resolve();
  assert.deepEqual(warnings, []);
  for (const dep of HOST_DEPS) {
    const entry = record.binaries[dep.name], path = join(w.systemBin, dep.name);
    assert.deepEqual(entry, { path: await fs.realpath(path), sha256: digest(await fs.readFile(path)), source: 'system', version: versions[dep.name] });
  }
  assert.equal(w.calls.some(call => call.command.endsWith('/brew') || call.command.startsWith('apt') || call.command === 'dpkg'), false);
  assert.ok(w.calls.some(call => call.command.endsWith('/Xvfb') && call.args[0] === '-version'));
  assert.ok(w.calls.some(call => call.command.endsWith('/openbox') && call.args[0] === '--version'));
  assert.equal(record.root, undefined);
  await assert.rejects(fs.lstat(w.p.hostDeps), { code: 'ENOENT' });
  assertNoSudo(w.calls);
});

test('Homebrew installs x11vnc and xorg-server when present; openbox falls back to rootless apt', async t => {
  const w = await world(t, { brew: true });
  const { record, plan, warnings } = await w.resolve();
  assert.deepEqual(warnings, []);
  const install = w.calls.find(call => call.command.endsWith('/brew') && call.args[0] === 'install');
  assert.deepEqual(install.args, ['install', 'x11vnc', 'xorg-server']);
  assert.equal(record.binaries.x11vnc.source, 'brew');
  assert.equal(record.binaries.Xvfb.source, 'brew');
  assert.equal(record.binaries.Xvfb.path, join(w.cellar, 'xorg-server/1.0/bin/Xvfb'));
  assert.equal(record.binaries.Xvfb.version, '21.1.25');
  assert.deepEqual(plan.apt.packages, ['openbox', 'libobt2v5']);
  assert.equal(record.binaries.openbox.source, 'extracted');
  assertNoSudo(w.calls);
});

test('Debian without root downloads the computed closure, extracts it into the state dir and records library dirs', async t => {
  const w = await world(t);
  const { record, plan, intent, warnings } = await w.resolve();
  assert.deepEqual(warnings, []);
  // dpkg -s reports libc6 installed, which also satisfies libgl1|libc6; a virtual dependency resolves to its provider.
  assert.deepEqual(plan.apt.packages, ['x11vnc', 'xvfb', 'libvncserver1', 'xserver-common', 'libvncclient1', 'openbox', 'libobt2v5']);
  const download = w.calls.find(call => call.command === 'apt-get');
  assert.deepEqual(download.args, ['download', ...plan.apt.packages]);
  assert.ok(download.options.cwd.startsWith(w.p.hostDeps + '/'));
  assert.ok(w.calls.filter(call => call.command === 'dpkg' && call.args[0] === '-x').every(call => call.args[2].startsWith(w.p.hostDeps + '/')));
  assert.ok(w.calls.some(call => call.command === 'dpkg' && call.args[0] === '-s' && call.args.includes('libc6')));
  for (const name of ['x11vnc', 'Xvfb', 'openbox']) {
    assert.equal(record.binaries[name].source, 'extracted');
    assert.equal(record.binaries[name].path, join(w.p.hostRoot, 'usr/bin', name));
    assert.equal(record.binaries[name].sha256, digest(await fs.readFile(record.binaries[name].path)));
  }
  assert.equal(record.root, w.p.hostRoot);
  assert.deepEqual(record.libraryPath, [join(w.p.hostRoot, 'usr/lib/x86_64-linux-gnu')]);
  assert.deepEqual(intent, record, 'extraction intent must be persisted before the root is published');
  assert.deepEqual((await fs.readdir(w.p.hostDeps)).sort(), ['root']);
  assert.equal((await fs.lstat(w.p.hostRoot)).mode & 0o077, 0);
  assert.deepEqual(await verifyHostDeps(record, w.p, w.d, helpers), []);
  assertNoSudo(w.calls);
});

test('without Homebrew or Debian apt, setup fails with the exact distro install command', async t => {
  const w = await world(t, { os: fedora });
  await assert.rejects(w.resolve(), error => {
    assert.match(error.message, /Missing x11vnc, openbox, Xvfb/);
    assert.ok(error.message.includes('sudo dnf install x11vnc openbox xorg-x11-server-Xvfb'), error.message);
    return true;
  });
  const unknown = await world(t, { os: 'ID=plan9\n' });
  await assert.rejects(unknown.resolve(), /Install x11vnc, openbox, Xvfb with the system package manager/);
  for (const calls of [w.calls, unknown.calls]) {
    assert.equal(calls.length, 0);
    assertNoSudo(calls);
  }
  await assert.rejects(fs.lstat(w.p.hostDeps), { code: 'ENOENT' });
});

test('partial availability: system x11vnc, brew Xvfb and a missing openbox only warns', async t => {
  const w = await world(t, { system: ['x11vnc'], brew: true, os: fedora });
  const { record, plan, warnings } = await w.resolve();
  assert.equal(record.binaries.x11vnc.source, 'system');
  assert.equal(record.binaries.Xvfb.source, 'brew');
  assert.equal(record.binaries.openbox, undefined);
  assert.deepEqual(w.calls.find(call => call.args[0] === 'install').args, ['install', 'xorg-server']);
  assert.equal(plan.apt, undefined);
  assert.equal(warnings.length + plan.warnings.length, 1);
  assert.match(plan.warnings[0], /openbox is unavailable.*without a window manager.*sudo dnf install openbox/);
  assert.deepEqual((await verifyHostDeps(record, w.p, w.d, helpers)).length, 1);
  assertNoSudo(w.calls);
});

test('an apt download failure is a clear error that extracts nothing', async t => {
  const w = await world(t, { aptFail: true });
  await assert.rejects(w.resolve(), error => {
    assert.match(error.message, /^apt-get download failed for x11vnc xvfb .*Temporary failure resolving.*Nothing was extracted.*sudo apt install x11vnc openbox xvfb/s);
    return true;
  });
  await assert.rejects(fs.lstat(w.p.hostRoot), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(w.p.hostDeps), []);
  assertNoSudo(w.calls);
});

test('a window manager that cannot be resolved by apt warns while required binaries still install', async t => {
  const w = await world(t, { system: ['x11vnc', 'Xvfb'] });
  aptTree.openbox.push('libmissing');
  t.after(() => aptTree.openbox.pop());
  const { record, plan } = await w.resolve();
  assert.equal(plan.apt, undefined);
  assert.equal(record.binaries.openbox, undefined);
  assert.match(plan.warnings[0], /openbox is unavailable.*apt could not resolve it.*sudo apt install openbox/);
  assertNoSudo(w.calls);
});

test('doctor fails a recorded hash mismatch and never reinstalls or probes', async t => {
  const w = await world(t, { system: ['x11vnc', 'Xvfb', 'openbox'] });
  const { record } = await w.resolve();
  assert.deepEqual(await verifyHostDeps(record, w.p, w.d, helpers), []);
  await fs.writeFile(join(w.systemBin, 'Xvfb'), 'replaced', { mode: 0o755 });
  w.calls.length = 0;
  await assert.rejects(verifyHostDeps(record, w.p, w.d, helpers), /Xvfb at .* changed since setup recorded its sha256.*never reinstalls/);
  await assert.rejects(planHostDeps(record, w.p, w.d, helpers), /Xvfb at .* changed/);
  assert.deepEqual(w.calls, []);
  assert.equal(await fs.readFile(join(w.systemBin, 'Xvfb'), 'utf8'), 'replaced');
});

test('doctor fails a changed extracted library tree', async t => {
  const w = await world(t);
  const { record } = await w.resolve();
  await fs.writeFile(join(w.p.hostRoot, 'usr/lib/x86_64-linux-gnu/libvncclient1.so'), 'tampered');
  await assert.rejects(verifyHostDeps(record, w.p, w.d, helpers), /Extracted host root .* changed/);
});

test('a recorded set never reinstalls a missing required binary and only adopts a newly installed window manager', async t => {
  const w = await world(t, { system: ['x11vnc', 'Xvfb'], brew: true, os: fedora });
  const { record } = await w.resolve();
  await fs.writeFile(join(w.systemBin, 'openbox'), 'openbox system', { mode: 0o755 });
  w.calls.length = 0;
  const again = await w.resolve(record);
  assert.equal(again.record.binaries.openbox.source, 'system');
  assert.deepEqual(again.record.binaries.Xvfb, record.binaries.Xvfb);
  assert.equal(w.calls.some(call => call.command.endsWith('/brew')), false);
  await assert.rejects(w.resolve({ binaries: { x11vnc: record.binaries.x11vnc } }), /Xvfb is not recorded; use a new state directory/);
  assertNoSudo(w.calls);
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
    ...w.d, packageDir, platform: 'linux', arch: 'x64', nodeVersion: '24.18.0', execPath: '/usr/bin/node',
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

test('setup --novnc records host dependencies in its private receipt before building, and doctor re-checks them', async t => {
  const h = await setupHarness(t, { system: ['x11vnc'], brew: true, os: fedora });
  const dry = await runClawser([...h.args, '--dry-run'], h.deps);
  assert.ok(dry.hostDependencies.includes('Xvfb: brew install xorg-server'));
  assert.match(dry.warnings.join('\n'), /openbox is unavailable/);
  assert.equal(h.calls.some(call => call.args[0] === 'install'), false, 'dry-run must not install');
  await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
  const result = await runClawser(h.args, h.deps);
  assert.equal(result.ok, true);
  assert.match(result.warnings.join('\n'), /openbox is unavailable/);
  const receipt = JSON.parse(await fs.readFile(join(h.stateDir, 'setup.json'), 'utf8'));
  assert.deepEqual(Object.keys(receipt.hostDeps.binaries), ['x11vnc', 'Xvfb']);
  assert.equal(receipt.hostDeps.binaries.Xvfb.source, 'brew');
  const install = h.calls.findIndex(call => call.args[0] === 'install'), build = h.calls.findIndex(call => call.command === 'docker' && call.args.includes('build'));
  assert.ok(install >= 0 && install < build);
  h.calls.length = 0;
  assert.equal((await runClawser(h.args, h.deps)).ok, true);
  assert.equal(h.calls.some(call => call.command.endsWith('/brew')), false, 'rerun must reuse the recorded binaries');
  let doctor = await runClawser(h.doctor, h.deps);
  assert.equal(doctor.ok, true, JSON.stringify(doctor.checks));
  assert.ok(doctor.checks.some(row => row.name === 'host dependencies' && row.ok));
  assert.ok(h.logs.some(line => /^WARN window manager: openbox is unavailable/.test(line)));
  await fs.writeFile(receipt.hostDeps.binaries.Xvfb.path, 'changed', { mode: 0o755 });
  h.calls.length = 0;
  doctor = await runClawser(h.doctor, h.deps);
  assert.equal(doctor.ok, false);
  assert.match(doctor.checks.find(row => row.name === 'host dependencies').message, /changed since setup recorded its sha256/);
  assert.equal(h.calls.some(call => call.command.endsWith('/brew') || call.command.startsWith('apt') || call.command.endsWith('/Xvfb')), false);
  await assert.rejects(runClawser(h.args, h.deps), /host dependencies: Xvfb at .* changed/);
  assert.equal(h.calls.some(call => call.command.endsWith('/brew')), false);
  assertNoSudo(h.calls);
});

test('a missing required host binary fails noVNC setup before any state, download or build', async t => {
  const h = await setupHarness(t, { os: fedora });
  await assert.rejects(runClawser(h.args, h.deps), /host dependencies: Missing x11vnc, openbox, Xvfb.*sudo dnf install x11vnc openbox xorg-x11-server-Xvfb/);
  await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
  assert.equal(h.calls.some(call => call.command === 'docker' && call.args.includes('build')), false);
});

test('an interrupted Debian extraction is adopted only from its durable intent', async t => {
  const h = await setupHarness(t, { system: ['Xvfb', 'openbox'] });
  const rename = fs.rename;
  h.deps.fs = { ...fs, rename: async (source, target) => { await rename(source, target); if (target.endsWith('/clawser-novnc/root')) throw Object.assign(new Error('injected EIO after root publication'), { code: 'EIO' }); } };
  await assert.rejects(runClawser(h.args, h.deps), /injected EIO/);
  const pending = JSON.parse(await fs.readFile(join(h.stateDir, 'setup.json'), 'utf8'));
  assert.equal(pending.hostDeps, undefined);
  assert.equal(pending.pendingHostDeps.binaries.x11vnc.source, 'extracted');
  h.deps.fs = fs;
  h.calls.length = 0;
  assert.equal((await runClawser(h.args, h.deps)).ok, true);
  assert.equal(h.calls.some(call => call.command === 'apt-get'), false);
  const saved = JSON.parse(await fs.readFile(join(h.stateDir, 'setup.json'), 'utf8'));
  assert.deepEqual(saved.hostDeps, pending.pendingHostDeps);
  assert.equal(saved.pendingHostDeps, undefined);
  assert.equal((await runClawser(h.doctor, h.deps)).ok, true);
  assertNoSudo(h.calls);
});

test('default CDP setup and doctor never call the host dependency resolver', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'clawser-host-cdp-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { browser: { defaultProfile: 'personal', profiles: { personal: { cdpUrl: 'http://127.0.0.1:9333', attachOnly: true, driver: 'openclaw', engine: 'chromium' } } } };
  const binary = Buffer.from('cloudflared'), commands = [];
  const forbidden = () => { throw new Error('CDP setup called the host dependency resolver'); };
  const deps = {
    fs, homeDir: root, env: { OPENCLAW_STATE_DIR: join(root, 'openclaw') }, packageDir: root, platform: 'linux', arch: 'x64', nodeVersion: '24.18.0', log: () => {},
    artifacts: { ...ARTIFACTS, cloudflared: { ...ARTIFACTS.cloudflared, sha256: digest(binary) } }, isPortFree: async () => true,
    hostResolver: { plan: forbidden, install: forbidden, verify: forbidden },
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
  assert.equal(commands.some(command => /x11vnc|Xvfb|openbox|brew|apt|dpkg/.test(command.join(' '))), false);
  assert.deepEqual((await fs.readdir(join(root, 'openclaw/clawser-cdp'))).sort(), ['bin', 'setup.json']);
});
