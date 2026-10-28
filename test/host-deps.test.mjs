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
const versions = { x11vnc: '0.9.17', openbox: '3.6.1' };
const probes = { x11vnc: '-version', openbox: '--version', Xvfb: '-help' };
const aptTree = {
  x11vnc: ['libvncserver1', 'libc6'], openbox: ['libobt2v5|libobt-legacy', 'libc6'], xvfb: ['<xserver-common-virtual>', 'libgl1|libc6'],
  libvncserver1: ['libvncclient1', 'libc6'], libvncclient1: ['libc6'], 'xserver-common': [], libobt2v5: [],
};
const providers = { 'xserver-common-virtual': ['xserver-common'] };
const packageFor = { x11vnc: 'x11vnc', openbox: 'openbox', Xvfb: 'xvfb' };
const cellarVersions = { 'xorg-server': '21.1.21', x11vnc: '0.9.17_1' };
const dpkgVersions = { x11vnc: '0.9.17-2', openbox: '3.6.1-12', xvfb: '2:21.1.7-3+deb12u10' };
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

async function world(t, { system = [], brew = false, os = debian, installed = ['libc6'], aptFail = false, smoke = {} } = {}) {
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
    if (probes[name] && command.startsWith(root)) {
      if (command.includes('/clawser-novnc/')) assert.ok(options.env?.LD_LIBRARY_PATH?.includes('/clawser-novnc/'), 'extracted binaries must run with their extracted libraries');
      if (name === 'Xvfb' && args[0] !== '-help') throw Object.assign(new Error(`Xvfb failed (1): Unrecognized option: ${args[0]}\nuse: X [:<display>] [option]`), { code: 1 });
      if (args[0] !== probes[name]) throw Object.assign(new Error(`${name} failed (1): unknown option ${args[0]}`), { code: 1 });
      return name === 'Xvfb' ? 'use: X [:<display>] [option]\n-a #  default pointer acceleration' : `${name} version ${versions[name]}`;
    }
    if (command === 'dpkg-query') {
      if (args[0] === '-S') { const owner = Object.entries(dpkgOwners).find(([path]) => path === args[1])?.[1]; if (owner) return `${owner}: ${args[1]}`; throw Object.assign(new Error(`dpkg-query failed (1): no path found matching pattern ${args[1]}`), { code: 1 }); }
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
        await execute('tar', ['-cf', join(options.cwd, `${pkg}_${pkg === 'xvfb' ? '2%3a21.1.7-3+deb12u10' : '1.0'}_amd64.deb`), '-C', tree, '.']);
      }
      return '';
    }
    if (command === 'dpkg' && args[0] === '-x') { await execute('tar', ['-xf', args[1], '-C', args[2]]); return ''; }
    throw new Error('Unexpected command: ' + command + ' ' + args.join(' '));
  };
  const dpkgOwners = Object.fromEntries(system.map(name => [join(systemBin, name), packageFor[name]]));
  const smokes = [];
  const hostSmoke = async binaries => { smokes.push(structuredClone(binaries)); return typeof smoke === 'function' ? smoke(binaries) : smoke; };
  const d = { fs, run, env: { PATH: [systemBin, ...(brew ? [brewBin] : [])].join(':') }, homeDir: root, hostPaths: [], osReleasePath: join(root, 'os-release'), uid: process.getuid(), hostSmoke };
  const p = { hostDeps: join(stateDir, 'clawser-novnc'), hostRoot: join(stateDir, 'clawser-novnc/root') };
  const resolve = async (recorded) => {
    const plan = await planHostDeps(recorded, p, d, helpers);
    let intent;
    const result = await installHostDeps(plan, p, d, helpers, { intend: async value => { intent = value; }, previous: recorded });
    return { plan, intent, ...result };
  };
  return { root, systemBin, cellar, stateDir, d, p, calls, smokes, resolve };
}

function assertNoSudo(calls) {
  for (const call of calls) assert.equal([call.command, ...call.args].some(part => /(?:^|\/)sudo$/.test(String(part)) || String(part).includes('sudo ')), false, 'sudo invoked: ' + call.command + ' ' + call.args.join(' '));
}

test('already installed binaries are recorded with path, sha256, package version and launch env without installing', async t => {
  const w = await world(t, { system: ['x11vnc', 'Xvfb', 'openbox'], brew: true });
  const { record, warnings } = await w.resolve();
  assert.deepEqual(warnings, []);
  for (const dep of HOST_DEPS) {
    const path = join(w.systemBin, dep.name);
    assert.deepEqual(record.binaries[dep.name], { path, sha256: digest(await fs.readFile(path)), source: 'system', version: dpkgVersions[packageFor[dep.name]], env: {} });
  }
  assert.ok(w.calls.some(call => call.command.endsWith('/Xvfb') && call.args[0] === '-help'));
  assert.equal(w.calls.some(call => call.command.endsWith('/Xvfb') && call.args[0] === '-version'), false);
  assert.ok(w.calls.some(call => call.command === 'dpkg-query' && call.args.join(' ') === '-W -f ${Version} xvfb'));
  assert.equal(w.calls.some(call => call.command.endsWith('/brew') || call.command.startsWith('apt') || call.command === 'dpkg'), false);
  assert.equal(w.smokes.length, 1, 'a newly recorded set must pass the smoke test');
  assert.equal(record.root, undefined);
  await assert.rejects(fs.lstat(w.p.hostDeps), { code: 'ENOENT' });
  assertNoSudo(w.calls);
});

test('an Xvfb version unknown to the package manager is recorded as unknown, not an error', async t => {
  const w = await world(t, { system: ['x11vnc', 'Xvfb', 'openbox'], os: fedora });
  const { record } = await w.resolve();
  assert.equal(record.binaries.Xvfb.version, 'unknown');
  assert.equal(record.binaries.x11vnc.version, '0.9.17');
  assert.equal(w.calls.some(call => call.command === 'dpkg-query'), false);
});

test('Homebrew installs x11vnc and xorg-server and takes Xvfb version from its Cellar path; openbox falls back to rootless apt', async t => {
  const w = await world(t, { brew: true });
  const { record, plan, warnings } = await w.resolve();
  assert.deepEqual(warnings, []);
  assert.deepEqual(w.calls.find(call => call.command.endsWith('/brew') && call.args[0] === 'install').args, ['install', 'x11vnc', 'xorg-server']);
  assert.deepEqual(record.binaries.Xvfb, { path: join(w.cellar, 'xorg-server/21.1.21/bin/Xvfb'), sha256: digest(await fs.readFile(join(w.cellar, 'xorg-server/21.1.21/bin/Xvfb'))), source: 'brew', version: '21.1.21', env: {} });
  assert.equal(record.binaries.x11vnc.version, '0.9.17_1');
  assert.deepEqual(plan.apt.packages, ['openbox', 'libobt2v5']);
  assert.equal(record.binaries.openbox.source, 'extracted');
  assertNoSudo(w.calls);
});

test('Debian without root downloads the computed closure, extracts it into the state dir and records each launch env', async t => {
  const w = await world(t);
  const { record, plan, intent, warnings } = await w.resolve();
  assert.deepEqual(warnings, []);
  // dpkg -s reports libc6 installed, which also satisfies libgl1|libc6; a virtual dependency resolves to its provider.
  assert.deepEqual(plan.apt.packages, ['x11vnc', 'xvfb', 'libvncserver1', 'xserver-common', 'libvncclient1', 'openbox', 'libobt2v5']);
  const download = w.calls.find(call => call.command === 'apt-get');
  assert.deepEqual(download.args, ['download', ...plan.apt.packages]);
  assert.ok(download.options.cwd.startsWith(w.p.hostDeps + '/'));
  assert.ok(w.calls.filter(call => call.command === 'dpkg' && call.args[0] === '-x').every(call => call.args[2].startsWith(w.p.hostDeps + '/')));
  for (const name of ['x11vnc', 'Xvfb', 'openbox']) {
    const entry = record.binaries[name];
    assert.equal(entry.source, 'extracted');
    assert.equal(entry.path, join(w.p.hostRoot, 'usr/bin', name));
    assert.equal(entry.sha256, digest(await fs.readFile(entry.path)));
    assert.deepEqual(entry.env, { LD_LIBRARY_PATH: join(w.p.hostRoot, 'usr/lib/x86_64-linux-gnu') });
  }
  assert.equal(record.binaries.Xvfb.version, '2:21.1.7-3+deb12u10', 'the extracted Xvfb version comes from its .deb name');
  assert.equal(record.root, w.p.hostRoot);
  assert.match(record.rootDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(intent, record, 'extraction intent must be persisted before the root is published');
  assert.ok(w.smokes[0].Xvfb.path.startsWith(w.p.hostRoot + '/'), 'the smoke test runs the published extraction');
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
  for (const calls of [w.calls, unknown.calls]) { assert.equal(calls.length, 0); assertNoSudo(calls); }
  assert.equal(w.smokes.length + unknown.smokes.length, 0);
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
  assert.equal((await verifyHostDeps(record, w.p, w.d, helpers)).length, 1);
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
  assert.equal(w.smokes.length, 0);
  assertNoSudo(w.calls);
});

test('a window manager that apt cannot resolve warns while required binaries still install', async t => {
  const w = await world(t, { system: ['x11vnc', 'Xvfb'] });
  aptTree.openbox.push('libmissing');
  t.after(() => aptTree.openbox.pop());
  const { record, plan } = await w.resolve();
  assert.equal(plan.apt, undefined);
  assert.equal(record.binaries.openbox, undefined);
  assert.match(plan.warnings[0], /openbox is unavailable.*apt could not resolve it.*sudo apt install openbox/);
  assertNoSudo(w.calls);
});

test('a failed smoke test of a required binary records nothing; a failed window manager is dropped with a warning', async t => {
  const broken = await world(t, { system: ['x11vnc', 'Xvfb', 'openbox'], smoke: { x11vnc: 'exited (1): cannot open display' } });
  await assert.rejects(broken.resolve(), /smoke test failed.*x11vnc exited \(1\): cannot open display.*rerun `clawser setup --novnc`/);
  const wm = await world(t, { system: ['x11vnc', 'Xvfb', 'openbox'], smoke: { openbox: 'exited (1): unable to find a valid menu file' } });
  const { record, warnings } = await wm.resolve();
  assert.deepEqual(Object.keys(record.binaries), ['x11vnc', 'Xvfb']);
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
  assert.deepEqual(await verifyHostDeps(record, w.p, w.d, helpers), []);
  await fs.writeFile(join(w.systemBin, 'Xvfb'), 'Xvfb after apt upgrade', { mode: 0o755 });
  w.calls.length = 0; w.smokes.length = 0;
  await assert.rejects(verifyHostDeps(record, w.p, w.d, helpers), error => {
    assert.equal(error.message, 'Xvfb at ' + join(w.systemBin, 'Xvfb') + ' is missing or changed since setup; rerun `clawser setup --novnc` to re-check and re-record it');
    assert.equal(error.message.includes('new state directory'), false);
    return true;
  });
  assert.deepEqual(w.calls, [], 'doctor never probes or reinstalls');
  const again = await w.resolve(record);
  assert.equal(again.record.binaries.Xvfb.sha256, digest('Xvfb after apt upgrade'));
  assert.deepEqual(again.record.binaries.x11vnc, record.binaries.x11vnc);
  assert.ok(w.calls.some(call => call.command.endsWith('/Xvfb') && call.args[0] === '-help'));
  assert.equal(w.calls.some(call => call.command.endsWith('/x11vnc')), false, 'unchanged binaries are not re-probed');
  assert.equal(w.smokes.length, 1);
  assert.deepEqual(await verifyHostDeps(again.record, w.p, w.d, helpers), []);
});

test('a Homebrew upgrade with brew cleanup re-resolves to the new Cellar path without reinstalling', async t => {
  const w = await world(t, { system: ['x11vnc', 'openbox'], brew: true });
  const { record } = await w.resolve();
  const old = record.binaries.Xvfb.path;
  await fs.mkdir(join(w.cellar, 'xorg-server/21.1.25/bin'), { recursive: true });
  await fs.writeFile(join(w.cellar, 'xorg-server/21.1.25/bin/Xvfb'), 'xorg-server 21.1.25 bottle', { mode: 0o755 });
  await fs.rm(join(w.cellar, 'xorg-server/21.1.21'), { recursive: true });
  await assert.rejects(verifyHostDeps(record, w.p, w.d, helpers), error => error.message === 'Xvfb at ' + old + ' is missing or changed since setup; rerun `clawser setup --novnc` to re-check and re-record it');
  w.calls.length = 0;
  const again = await w.resolve(record);
  assert.deepEqual(again.record.binaries.Xvfb, { path: join(w.cellar, 'xorg-server/21.1.25/bin/Xvfb'), sha256: digest('xorg-server 21.1.25 bottle'), source: 'brew', version: '21.1.25', env: {} });
  assert.equal(w.calls.some(call => call.args[0] === 'install'), false);
});

test('a changed extracted root is a hard failure that tells the operator to remove it', async t => {
  const w = await world(t);
  const { record } = await w.resolve();
  await fs.writeFile(join(w.p.hostRoot, 'usr/lib/x86_64-linux-gnu/libvncclient1.so'), 'tampered');
  for (const attempt of [verifyHostDeps, planHostDeps]) {
    await assert.rejects(attempt(record, w.p, w.d, helpers), error => {
      assert.equal(error.message, 'Extracted host root ' + w.p.hostRoot + ' is missing or changed since setup. Clawser owns the extracted root and never repairs it in place; remove ' + w.p.hostRoot + ' and rerun `clawser setup --novnc`');
      assert.equal(error.message.includes('new state directory'), false);
      return true;
    });
  }
  w.calls.length = 0;
  await assert.rejects(planHostDeps(record, w.p, w.d, helpers));
  assert.equal(w.calls.some(call => call.command === 'apt-get' || call.command === 'dpkg'), false, 'a changed extraction is never re-extracted');
});

test('the real smoke test starts Xvfb on a displayfd display, then openbox and loopback x11vnc, and stops all three', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'clawser-host-smoke-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const log = join(root, 'log');
  const script = (name, body) => {
    const path = join(root, name);
    return fs.writeFile(path, `#!${process.execPath}\nconst fs = require('node:fs'), net = require('node:net');\nconst log = m => fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + ' ' + m + '\\n');\nlog(JSON.stringify({ args: process.argv.slice(2), display: process.env.DISPLAY ?? null, lib: process.env.LD_LIBRARY_PATH ?? null }));\nprocess.on('SIGTERM', () => { log('SIGTERM'); process.exit(0); });\n${body}\n`, { mode: 0o755 }).then(() => path);
  };
  const xvfb = await script('Xvfb', "fs.writeSync(Number(process.argv[process.argv.indexOf('-displayfd') + 1]), '77\\n'); setInterval(() => {}, 1000);");
  const openbox = await script('openbox', 'setInterval(() => {}, 1000);');
  const x11vnc = await script('x11vnc', "const port = Number(process.argv[process.argv.indexOf('-rfbport') + 1]); net.createServer(socket => socket.end('RFB 003.008\\n')).listen(port, '127.0.0.1'); setInterval(() => {}, 1000);");
  const entry = (path, env = {}) => ({ path, sha256: 'x'.repeat(64), source: 'system', version: 'unknown', env });
  const failed = await smokeHostDeps({ x11vnc: entry(x11vnc), openbox: entry(openbox), Xvfb: entry(xvfb, { LD_LIBRARY_PATH: '/fixture/lib' }) }, { env: { PATH: process.env.PATH, DISPLAY: ':0' } }, { settleMs: 200 });
  assert.deepEqual(failed, {});
  const lines = (await fs.readFile(log, 'utf8')).trim().split('\n');
  const started = Object.fromEntries(lines.filter(line => line.includes(' {')).map(line => [line.split(' ')[0], JSON.parse(line.slice(line.indexOf(' ') + 1))]));
  assert.deepEqual(started.Xvfb.args.slice(0, 2), ['-displayfd', '3']);
  assert.equal(started.Xvfb.display, null, 'the operator DISPLAY must not leak into the private server');
  assert.equal(started.Xvfb.lib, '/fixture/lib', 'each binary runs with its recorded launch env');
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
  const entry = path => ({ path, sha256: 'x'.repeat(64), source: 'system', version: 'unknown', env: {} });
  const xvfb = await write('Xvfb', "require('node:fs').writeSync(3, '78\\n'); setInterval(() => {}, 1000);");
  const vnc = await write('x11vnc', "console.error('XOpenDisplay failed'); process.exit(1);");
  const failed = await smokeHostDeps({ x11vnc: entry(vnc), Xvfb: entry(xvfb) }, { env: {} }, { settleMs: 100 });
  assert.match(failed.x11vnc, /^exited \(1\): XOpenDisplay failed/);
  const dead = await write('Xvfb-dead', "console.error('XKB: Failed to compile keymap'); process.exit(1);");
  const early = await smokeHostDeps({ x11vnc: entry(vnc), Xvfb: entry(dead) }, { env: {} }, { settleMs: 100 });
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
  const receipt = JSON.parse(await fs.readFile(join(h.stateDir, 'setup.json'), 'utf8'));
  assert.equal('hostDeps' in receipt || 'pendingHostDeps' in receipt, false);
  const doctor = await runClawser(h.doctor, h.deps);
  assert.equal(doctor.ok, true, JSON.stringify(doctor.checks));
  assert.equal(doctor.checks.some(row => row.name === 'host dependencies' || row.name === 'window manager'), false);
  assert.equal(h.calls.some(call => /x11vnc|Xvfb|openbox|brew|apt|dpkg/.test(call.command)), false);
  assert.equal(h.smokes.length, 0);
  await assert.rejects(fs.lstat(join(h.stateDir, 'clawser-novnc')), { code: 'ENOENT' });
});

test('with host dependencies on, setup records them in its private receipt before building, and doctor re-checks them', async t => {
  const h = await setupHarness(t, { system: ['x11vnc'], brew: true, os: fedora });
  const dry = await runClawser([...h.args, '--dry-run'], h.deps);
  assert.ok(dry.hostDependencies.includes('Xvfb: brew install xorg-server'));
  assert.match(dry.warnings.join('\n'), /openbox is unavailable/);
  assert.equal(h.calls.some(call => call.args[0] === 'install'), false, 'dry-run must not install');
  assert.equal(h.smokes.length, 0, 'dry-run must not start processes');
  await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
  const result = await runClawser(h.args, h.deps);
  assert.equal(result.ok, true);
  assert.match(result.warnings.join('\n'), /openbox is unavailable/);
  const receipt = JSON.parse(await fs.readFile(join(h.stateDir, 'setup.json'), 'utf8'));
  assert.deepEqual(Object.keys(receipt.hostDeps.binaries), ['x11vnc', 'Xvfb']);
  assert.equal(receipt.hostDeps.binaries.Xvfb.source, 'brew');
  assert.deepEqual(receipt.hostDeps.binaries.Xvfb.env, {});
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
  assert.equal(h.calls.some(call => call.command.endsWith('/brew') || call.command.startsWith('apt') || call.command.endsWith('/Xvfb')), false);
  assert.equal(h.smokes.length, 1, 'doctor never starts processes');
  h.calls.length = 0;
  assert.equal((await runClawser(h.args, h.deps)).ok, true);
  assert.equal(h.calls.some(call => call.args[0] === 'install'), false, 'an upgraded Homebrew binary is re-resolved, not reinstalled');
  assert.equal(h.smokes.length, 2);
  const rerecorded = JSON.parse(await fs.readFile(join(h.stateDir, 'setup.json'), 'utf8'));
  assert.equal(rerecorded.hostDeps.binaries.Xvfb.sha256, digest('xorg-server rebuilt bottle'));
  assert.equal((await runClawser(h.doctor, h.deps)).ok, true);
  assertNoSudo(h.calls);
});

test('with host dependencies on, a missing required binary fails noVNC setup before any state, download or build', async t => {
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
  assert.equal(h.smokes.length, 1, 'the adopted extraction is smoke-tested before it is recorded');
  assert.equal((await runClawser(h.doctor, h.deps)).ok, true);
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
  assert.equal(commands.some(command => /x11vnc|Xvfb|openbox|brew|apt|dpkg/.test(command.join(' '))), false);
  assert.deepEqual((await fs.readdir(join(root, 'openclaw/clawser-cdp'))).sort(), ['bin', 'setup.json']);
});
