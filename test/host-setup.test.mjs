import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ARTIFACTS, setupHelpers as h } from '../src/setup.mjs';
import { applyHost, describeHost, hostLocations, planHost } from '../src/host-setup.mjs';
import { unitNames } from '../src/host-units.mjs';
import { xauthorityEntry } from '../src/host-display.mjs';
import { SNAP_MESSAGE } from '../src/host-browser.mjs';
import { activationFixture } from './setup-activation-fixture.mjs';

const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = path => fs.lstat(path).then(() => true, () => false);
const mode = async path => (await fs.stat(path)).mode & 0o777;
const cookie = Buffer.alloc(16, 7);
const entry = path => ({ path, source: 'system', version: '1', sha256: 'b'.repeat(64) });
const isPatch = call => call.command === 'openclaw' && call.args[1] === 'patch' && !call.args.includes('--dry-run');
const systemctl = (calls, verb) => calls.filter(call => call.command === 'systemctl' && call.args[1] === verb).map(call => call.args.at(-1));
const fsWrites = calls => calls.filter(call => call.command === 'fs');
function merge(base, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) merge(base[key] ??= {}, value);
    else base[key] = structuredClone(value);
  }
  return base;
}

async function harness(t, { config = {}, openbox = true, stateName = 'state' } = {}) {
  // macOS tmpdir() is long and behind a symlink; sockets under it would exceed 107 bytes.
  const root = await fs.realpath(await fs.mkdtemp('/tmp/clawser-hs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = join(root, stateName), unitDir = join(root, 'config/systemd/user');
  const pkg = async name => {
    const dir = join(root, name);
    for (const file of ['runtime/desktop/supervisor.py', 'runtime/desktop/openbox_config.py', 'bin/desktop-controller.mjs']) {
      await fs.mkdir(dirname(join(dir, file)), { recursive: true });
      await fs.writeFile(join(dir, file), 'fixture');
    }
    return dir;
  };
  const archiveRoot = join(root, 'archive');
  await fs.mkdir(join(archiveRoot, 'noVNC-1.7.0/core'), { recursive: true });
  await fs.writeFile(join(archiveRoot, 'noVNC-1.7.0/core/rfb.js'), 'export default class RFB {}');
  await execute('tar', ['-czf', join(root, 'novnc.tgz'), '-C', archiveRoot, 'noVNC-1.7.0']);
  const binary = Buffer.from('verified cloudflared fixture'), archive = await fs.readFile(join(root, 'novnc.tgz'));
  const artifacts = { cloudflared: { ...ARTIFACTS.cloudflared, sha256: digest(binary) }, noVnc: { ...ARTIFACTS.noVnc, sha256: digest(archive) } };
  const rc = join(root, 'rc.xml');
  await fs.writeFile(rc, '<openbox_config/>\n');
  const binaries = { Xvfb: entry('/usr/bin/Xvfb'), x11vnc: entry('/home/linuxbrew/.linuxbrew/bin/x11vnc'), python3: entry('/usr/bin/python3'), ...(openbox ? { openbox: entry('/usr/bin/openbox') } : {}) };
  const calls = [], units = new Map(), holders = {};
  let busy = [];
  const track = (name, real, writes = () => true) => async (...args) => { if (writes(...args)) calls.push({ command: 'fs', args: [name, args.at(name === 'rename' ? 1 : 0)] }); return real(...args); };
  const trackedFs = { ...fs, writeFile: track('writeFile', fs.writeFile), open: track('open', fs.open, (path, flags = 'r') => /[wa]/.test(flags)),
    rename: track('rename', fs.rename), mkdir: track('mkdir', fs.mkdir), rm: track('rm', fs.rm), chmod: track('chmod', fs.chmod) };
  const d = {
    fs: trackedFs, artifacts, packageDir: await pkg('pkg-a'), env: { XDG_CONFIG_HOME: join(root, 'config') }, homeDir: root, uid: process.getuid(),
    execPath: '/usr/bin/node', now: Date.now, sleep: async () => {}, log: () => {}, readProcessStartTicks: async () => '4242',
    findBrowserBinary: async () => ({ path: '/usr/bin/google-chrome-stable', brand: 'chrome' }),
    freeDisplay: async () => 20, randomBytes: () => Buffer.from(cookie),
    hostResolver: {
      plan: async () => ({ binaries: structuredClone(binaries), warnings: [] }),
      install: async plan => ({ record: { binaries: structuredClone(plan.binaries) }, warnings: [] }),
      verify: async () => [], describe: () => [],
    },
    openboxRcPaths: [join(root, 'missing-rc.xml'), rc],
    isPortFree: async port => !busy.includes(port), portHolder: async port => holders[port],
    controllerHealth: async () => ({ ready: true, profile: 'clawser', cdpUrl: 'http://127.0.0.1:18820', recoveryRequired: false }),
    fetch: async url => { calls.push({ command: 'fetch', args: [url] }); return new Response(url === artifacts.cloudflared.url ? binary : archive); },
    run: async (command, args, options = {}) => {
      calls.push({ command, args, input: options.input });
      if (command === 'docker') assert.fail('setup must never run docker: ' + args.join(' '));
      if (command === 'tar') return (await execute(command, args)).stdout;
      if (command === 'loginctl') return 'yes\n';
      if (command === 'systemctl') {
        const verb = args[1], name = args.at(-1);
        if (verb === 'show') {
          const state = units.get(args[2]);
          return `LoadState=${state ? 'loaded' : 'not-found'}\nFragmentPath=${state ? join(unitDir, args[2]) : ''}\nActiveState=${state ?? 'inactive'}\n`;
        }
        if (verb === 'enable' || verb === 'restart') units.set(name, 'active');
        if (verb === 'stop') units.set(name, 'inactive');
        return '';
      }
      if (command === 'openclaw') {
        if (args[0] === 'config' && args[1] === 'get') return JSON.stringify(config[args[2]] ?? {});
        if (args[0] === 'config' && args[1] === 'patch') { if (!args.includes('--dry-run')) merge(config, JSON.parse(options.input)); return ''; }
        if (args[0] === 'plugins' && args[1] === 'reload') { await activation.publish(); return ''; }
      }
      if (command === binaries.python3.path) {
        const [script, source, dest] = args;
        assert.equal(script, join(d.packageDir, 'runtime/desktop/openbox_config.py'));
        await fs.writeFile(dest, '<!-- rendered -->' + await fs.readFile(source, 'utf8'), { mode: 0o600 });
        return '';
      }
      throw new Error('unexpected command: ' + command + ' ' + args.join(' '));
    },
  };
  const activation = activationFixture(config, d);
  const o = { command: 'setup', stateDir, port: 19420, option: 'new', profile: 'clawser', yes: false, dryRun: false, migrateCookies: true, specified: [] };
  return {
    root, stateDir, unitDir, config, d, o, calls, units, holders, binaries, artifacts, pkg,
    names: unitNames(stateDir), p: hostLocations(o, d),
    busy: ports => { busy = ports; },
    plan: () => planHost(o, d, h),
    install: async () => applyHost(await planHost(o, d, h), o, d, h),
    receipt: async () => JSON.parse(await fs.readFile(join(stateDir, 'setup.json'), 'utf8')),
  };
}

const ordered = x => [x.names.display, x.names.windowManager, x.names.browser, x.names.supervisor, x.names.controller];

test('option A dry run lists the profile, display, units and default-profile change and changes nothing', async t => {
  const x = await harness(t, { config: { browser: { defaultProfile: 'handoff' } } });
  const plan = await x.plan();
  const lines = describeHost(plan);
  assert.equal(await exists(x.stateDir), false);
  assert.equal(await exists(x.unitDir), false);
  assert.deepEqual(fsWrites(x.calls), []);
  assert.deepEqual([...systemctl(x.calls, 'enable'), ...systemctl(x.calls, 'daemon-reload')], []);
  assert.equal(x.calls.some(isPatch), false);
  const text = lines.join('\n');
  for (const want of ['clawser', ':20', 'handoff → clawser', ...ordered(x)]) assert.ok(text.includes(want), want);
});

test('option A creates a private profile, a cookie and five owned units, then makes clawser the default', async t => {
  const x = await harness(t, { config: { browser: { defaultProfile: 'handoff' } } });
  await x.install();
  assert.equal(await mode(x.p.profileDir), 0o700);
  assert.equal(await mode(x.p.xauthority), 0o600);
  const auth = await fs.readFile(x.p.xauthority);
  assert.equal(auth.length, 46);
  assert.deepEqual(auth, xauthorityEntry(20, cookie));
  assert.equal(x.p.unitDir, x.unitDir);
  const saved = await x.receipt();
  for (const name of ordered(x)) {
    const path = join(x.unitDir, name);
    assert.equal(await mode(path), 0o600, name);
    assert.equal(saved.units[name], digest(await fs.readFile(path)), name);
  }
  assert.deepEqual(Object.keys(saved.units).sort(), ordered(x).sort());
  assert.deepEqual(systemctl(x.calls, 'enable'), ordered(x));
  assert.equal(x.calls.filter(call => call.command === 'systemctl' && call.args[1] === 'enable').every(call => call.args[2] === '--now'), true);
  const patch = JSON.parse(x.calls.find(isPatch).input);
  assert.deepEqual(patch, {
    browser: { profiles: { clawser: { cdpUrl: 'http://127.0.0.1:18820', driver: 'openclaw', engine: 'chromium', attachOnly: true } }, defaultProfile: 'clawser' },
    plugins: { entries: { 'browser-handoff': { enabled: true, config: { desktop: { enabled: true, socketPath: x.p.socket, profile: 'clawser' }, cloudflare: { enabled: false } } } } },
    tools: { alsoAllow: ['browser_handoff'] },
  });
  assert.equal(x.config.browser.defaultProfile, 'clawser');
  assert.equal(saved.identity, 'clawser-setup-v2');
  assert.equal(saved.option, 'new');
  assert.equal(saved.profile, 'clawser');
  assert.equal(saved.display, 20);
  assert.equal(saved.cdpPort, 18820);
  assert.equal(saved.port, 19420);
  assert.equal(saved.previousDefaultProfile, 'handoff');
  assert.equal(saved.packageDir, x.d.packageDir);
  assert.equal(saved.unitDir, x.unitDir);
  assert.equal(saved.userDataDir, x.p.profileDir);
  assert.deepEqual(saved.browser, { path: '/usr/bin/google-chrome-stable', existingArgs: [], env: [] });
  assert.deepEqual(saved.replaced, []);
  assert.match(saved.ownerId, /^[a-f0-9-]{36}$/);
  assert.equal(saved.configDigest, digest(await fs.readFile(x.p.config)));
  assert.equal(saved.supervisorConfigDigest, digest(await fs.readFile(x.p.supervisorConfig)));
  assert.equal(saved.openboxDigest, digest(await fs.readFile(x.p.openboxConfig)));
  assert.match(saved.assetsDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(saved.hostDeps, { binaries: x.binaries });
  const supervisor = JSON.parse(await fs.readFile(x.p.supervisorConfig, 'utf8'));
  assert.deepEqual(supervisor, { display: 20, xauthority: x.p.xauthority, controlSocket: x.p.control, vncDir: x.p.vncDir, cdpUrl: 'http://127.0.0.1:18820', x11vnc: x.binaries.x11vnc.path });
  const controller = JSON.parse(await fs.readFile(x.p.config, 'utf8'));
  assert.equal(controller.profile, 'clawser');
  assert.deepEqual(controller.runtime, { stateDir: x.p.runtime, controlSocket: x.p.control, cdpUrl: 'http://127.0.0.1:18820' });
  assert.equal(await exists(join(x.stateDir, 'setup.lock')), false);
});

test('without openbox setup warns and writes four units', async t => {
  const x = await harness(t, { openbox: false });
  const plan = await x.plan();
  assert.match(plan.warnings.join('\n'), /openbox/);
  assert.equal(Object.keys(plan.units).length, 4);
  await applyHost(plan, x.o, x.d, h);
  assert.deepEqual((await fs.readdir(x.unitDir)).sort(), [x.names.display, x.names.browser, x.names.supervisor, x.names.controller].sort());
  assert.equal(await exists(x.p.openboxConfig), false);
  assert.equal((await x.receipt()).openboxDigest, undefined);
});

test('a rerun with the same inputs restarts nothing', async t => {
  const x = await harness(t);
  await x.install();
  const plan = await x.plan();
  assert.deepEqual([plan.start, plan.restart, plan.stop, plan.writes, plan.disruptive], [[], [], [], [], false]);
  x.calls.length = 0;
  await applyHost(plan, x.o, x.d, h);
  assert.deepEqual([...systemctl(x.calls, 'daemon-reload'), ...systemctl(x.calls, 'enable'), ...systemctl(x.calls, 'restart')], []);
});

test('a rerun after the package directory moved rewrites only the supervisor and controller units and restarts only them', async t => {
  const x = await harness(t);
  await x.install();
  x.d.packageDir = await x.pkg('pkg-b');
  const plan = await x.plan();
  assert.deepEqual(plan.restart, [x.names.supervisor, x.names.controller]);
  assert.deepEqual(plan.start, []);
  assert.equal(plan.disruptive, false);
  x.calls.length = 0;
  await applyHost(plan, x.o, x.d, h);
  const renamed = fsWrites(x.calls).filter(call => call.args[0] === 'rename' && dirname(call.args[1]) === x.unitDir).map(call => call.args[1]);
  assert.deepEqual(renamed, [join(x.unitDir, x.names.supervisor), join(x.unitDir, x.names.controller)]);
  assert.equal(systemctl(x.calls, 'daemon-reload').length, 1);
  assert.deepEqual(systemctl(x.calls, 'restart'), [x.names.supervisor, x.names.controller]);
  assert.deepEqual(systemctl(x.calls, 'enable'), []);
  const saved = await x.receipt();
  assert.equal(saved.packageDir, x.d.packageDir);
  assert.match(await fs.readFile(join(x.unitDir, x.names.controller), 'utf8'), /pkg-b/);
});

test('state directories whose sockets exceed 107 bytes are refused before anything is written', async t => {
  const x = await harness(t, { stateName: 'a-long-state-directory-name-'.repeat(3) });
  const error = await x.plan().then(() => assert.fail('planned'), error => error);
  assert.match(error.message, /longer than 107 bytes/);
  assert.ok(error.message.includes(x.stateDir), error.message);
  assert.equal(await exists(x.stateDir), false);
  assert.equal(x.calls.some(call => call.command === 'systemctl'), false);
});

test('snap Chromium is refused before anything is written', async t => {
  const x = await harness(t);
  x.d.findBrowserBinary = async () => { throw new Error(SNAP_MESSAGE); };
  await assert.rejects(x.plan(), error => error.message === SNAP_MESSAGE);
  assert.equal(await exists(x.stateDir), false);
  assert.equal(await exists(x.unitDir), false);
  assert.deepEqual(fsWrites(x.calls), []);
});

test('a unit changed outside Clawser is refused', async t => {
  const x = await harness(t);
  await x.install();
  await fs.appendFile(join(x.unitDir, x.names.browser), 'Environment=EXTRA=1\n');
  await assert.rejects(x.plan(), /changed outside Clawser/);
});

test('an existing unit file Clawser does not own is refused', async t => {
  const x = await harness(t);
  await fs.mkdir(x.unitDir, { recursive: true });
  await fs.writeFile(join(x.unitDir, x.names.display), '[Service]\nExecStart=/bin/true\n');
  await assert.rejects(x.plan(), /does not own it/);
  assert.equal(await exists(x.stateDir), false);
});

test('a port held by another program is refused and names it', async t => {
  const x = await harness(t);
  x.busy(Array.from({ length: 10 }, (_, i) => 18820 + i));
  await assert.rejects(x.plan(), /No free CDP port between 18820 and 18829/);
  x.busy([19420]);
  x.holders[19420] = { pid: 77, exe: '/usr/bin/nc', cgroup: '0::/user.slice/user-1000.slice/session-2.scope' };
  await assert.rejects(x.plan(), error => error.message.includes('port 19420 is in use by /usr/bin/nc (pid 77)'));
  delete x.holders[19420];
  await assert.rejects(x.plan(), /port 19420 is in use$/);
  assert.equal(await exists(x.stateDir), false);
});

const handoffBrowser = { browser: { defaultProfile: 'handoff', profiles: { handoff: { cdpUrl: 'http://127.0.0.1:18812', driver: 'openclaw', engine: 'chromium', attachOnly: true } } } };
const containerName = 'openclaw-handoff-desktop', imageId = 'sha256:' + 'a'.repeat(64);
const leftovers = [`docker rm -f ${containerName}`, `docker network rm ${containerName}-net`, `docker volume rm ${containerName}-profile`, `docker image rm ${imageId}`];

async function seedV1(x, { withImage = true, serviceUnit = x.names.controller } = {}) {
  const ownerId = randomUUID(), servicePath = join(x.unitDir, x.names.controller);
  for (const dir of [x.stateDir, x.p.state, x.p.runtime, dirname(x.p.binary), dirname(x.p.assets), join(x.p.assets, 'core'), x.unitDir]) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(x.p.binary, 'verified cloudflared fixture', { mode: 0o700 });
  await fs.writeFile(join(x.p.assets, 'core/rfb.js'), 'export default class RFB {}', { mode: 0o600 });
  const oldConfig = JSON.stringify({ stateDir: x.p.state, profile: 'handoff', port: 19410, runtime: { name: containerName, image: imageId } }) + '\n';
  const oldUnit = '# Managed by Clawser\n[Unit]\nAfter=network-online.target docker.service\n';
  if (withImage) await fs.writeFile(x.p.config, oldConfig, { mode: 0o600 });
  if (withImage) await fs.writeFile(servicePath, oldUnit, { mode: 0o600 });
  const v1 = { identity: 'clawser-setup-v1', uid: x.d.uid, ownerId, ...withImage ? { imageId } : {}, serviceUnit,
    options: { stateDir: x.stateDir, profile: 'handoff', port: 19410, cdpPort: 18812, vncPort: 59092, containerName, defaultProfile: true, packageDir: x.d.packageDir, execPath: x.d.execPath, servicePath },
    ...withImage ? { configDigest: digest(oldConfig), serviceDigest: digest(oldUnit) } : {}, assetsDigest: await h.treeDigest(x.p.assets, x.d) };
  await fs.writeFile(x.p.marker, JSON.stringify(v1, null, 2) + '\n', { mode: 0o600 });
  if (!withImage) return { v1, ownerId, servicePath };
  x.config.plugins = { entries: { 'browser-handoff': { enabled: true, config: { desktop: { enabled: true, socketPath: x.p.socket, profile: 'handoff' }, cloudflare: { enabled: false } } } } };
  x.units.set(x.names.controller, 'active');
  return { v1, ownerId, servicePath };
}

test('a Docker-era install converts to option A and prints its leftovers without running docker', async t => {
  const x = await harness(t, { config: structuredClone(handoffBrowser) });
  const { v1, ownerId, servicePath } = await seedV1(x);
  const plan = await x.plan();
  assert.deepEqual(plan.stop, [{ kind: 'unit', unit: x.names.controller }]);
  assert.deepEqual(plan.dockerLeftovers, leftovers);
  assert.equal(plan.disruptive, false);
  assert.ok(plan.start.includes(x.names.controller));
  const lines = describeHost(plan).join('\n');
  assert.ok(lines.includes('Stop the Docker-era controller ' + x.names.controller));
  assert.ok(lines.includes('Run yourself afterwards: docker volume rm ' + containerName + '-profile'));
  x.calls.length = 0;
  await applyHost(plan, x.o, x.d, h);
  const at = predicate => x.calls.findIndex(predicate);
  const stop = at(call => call.command === 'systemctl' && call.args[1] === 'stop');
  const disable = at(call => call.command === 'systemctl' && call.args[1] === 'disable');
  const write = at(call => call.command === 'fs' && ['writeFile', 'open', 'rename'].includes(call.args[0]));
  assert.ok(stop >= 0 && stop < disable && disable < write, JSON.stringify({ stop, disable, write }));
  assert.equal(x.calls.some(call => call.command === 'docker'), false);
  assert.equal(x.calls.some(call => call.command === 'fetch' && call.args[0] === x.artifacts.cloudflared.url), false);
  const saved = await x.receipt();
  assert.equal(saved.identity, 'clawser-setup-v2');
  assert.equal(saved.ownerId, ownerId);
  assert.equal(saved.assetsDigest, v1.assetsDigest);
  assert.equal(saved.previousDefaultProfile, 'handoff');
  assert.equal(x.config.plugins.entries['browser-handoff'].config.desktop.profile, 'clawser');
  assert.deepEqual(x.config.browser.profiles.handoff, { cdpUrl: 'http://127.0.0.1:18812', driver: 'openclaw', engine: 'chromium', attachOnly: true });
  assert.doesNotMatch(await fs.readFile(servicePath, 'utf8'), /docker/);
});

test('a v2 option B receipt stops at the stub before touching anything', async t => {
  const stub = { message: 'Taking over an existing browser is not implemented yet' };
  const x = await harness(t);
  await x.install();
  await rewriteReceipt(x, saved => Object.assign(saved, { option: 'existing', profile: 'user' }));
  Object.assign(x.o, { option: 'existing', profile: 'user' });
  x.calls.length = 0;
  await assert.rejects(x.plan(), stub);
  assert.deepEqual(fsWrites(x.calls), []);
  assert.deepEqual(x.calls.filter(call => call.command === 'systemctl' && call.args[1] !== 'show'), []);
});

const changedOutside = path => path + ' was changed outside Clawser; restore it or remove it, then rerun setup';
const healthy = async () => ({ ready: true, profile: 'clawser', cdpUrl: 'http://127.0.0.1:18820', recoveryRequired: false });
const rewriteReceipt = async (x, change) => { const saved = await x.receipt(); change(saved); await fs.writeFile(x.p.marker, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 }); };

test('a conversion that fails after the stop can be rerun and still prints the leftovers', async t => {
  const x = await harness(t, { config: structuredClone(handoffBrowser) });
  const { ownerId } = await seedV1(x);
  x.d.controllerHealth = async () => ({ ready: false });
  await assert.rejects(x.install(), /Controller health/);
  assert.equal(x.config.plugins.entries['browser-handoff'].config.desktop.profile, 'handoff');
  assert.deepEqual((await x.receipt()).convertedFrom, { profile: 'handoff', containerName, imageId });
  x.d.controllerHealth = healthy;
  x.calls.length = 0;
  const plan = await x.plan();
  assert.deepEqual(plan.dockerLeftovers, leftovers);
  assert.deepEqual(plan.stop, []);
  const lines = describeHost(plan);
  for (const command of leftovers) assert.ok(lines.includes('Run yourself afterwards: ' + command), command);
  await applyHost(plan, x.o, x.d, h);
  assert.equal(x.calls.some(call => call.command === 'docker'), false);
  assert.equal(x.config.plugins.entries['browser-handoff'].config.desktop.profile, 'clawser');
  const saved = await x.receipt();
  assert.equal(saved.identity, 'clawser-setup-v2');
  assert.equal(saved.ownerId, ownerId);
  assert.equal(Object.hasOwn(saved, 'convertedFrom'), false);
  assert.equal((await x.plan()).dockerLeftovers, undefined);
});

test('a rerun where only the x11vnc path changed rewrites supervisor.json and restarts only the supervisor', async t => {
  const x = await harness(t);
  await x.install();
  x.binaries.x11vnc = entry('/home/linuxbrew/.linuxbrew/Cellar/x11vnc/0.9.17/bin/x11vnc');
  const plan = await x.plan();
  assert.deepEqual(plan.writes.map(item => item.path), [x.p.supervisorConfig]);
  assert.deepEqual(plan.restart, [x.names.supervisor]);
  assert.deepEqual(plan.start, []);
  assert.equal(plan.disruptive, false);
  assert.deepEqual(describeHost(plan).filter(line => /^(Write|Start|Restart) /.test(line)), ['Write ' + x.p.supervisorConfig, 'Restart ' + x.names.supervisor]);
  x.calls.length = 0;
  await applyHost(plan, x.o, x.d, h);
  assert.deepEqual(systemctl(x.calls, 'restart'), [x.names.supervisor]);
  assert.deepEqual([...systemctl(x.calls, 'enable'), ...systemctl(x.calls, 'daemon-reload')], []);
  assert.equal(JSON.parse(await fs.readFile(x.p.supervisorConfig, 'utf8')).x11vnc, x.binaries.x11vnc.path);
  assert.equal((await x.receipt()).supervisorConfigDigest, digest(await fs.readFile(x.p.supervisorConfig)));
});

test('a deleted X cookie is rewritten and restarts the display, which closes the browser', async t => {
  const x = await harness(t);
  await x.install();
  await fs.rm(x.p.xauthority);
  const plan = await x.plan();
  assert.deepEqual(plan.writes.map(item => item.path), [x.p.xauthority]);
  assert.deepEqual(plan.restart, [x.names.display]);
  assert.equal(plan.disruptive, true);
});

test('a Docker-era receipt from a failed image build converts without a controller config to verify', async t => {
  const x = await harness(t, { config: structuredClone(handoffBrowser) });
  const { ownerId } = await seedV1(x, { withImage: false });
  const plan = await x.plan();
  assert.deepEqual(plan.stop, []);
  assert.deepEqual(plan.dockerLeftovers, leftovers.slice(0, 3));
  assert.ok(plan.writes.some(item => item.path === x.p.config));
  await applyHost(plan, x.o, x.d, h);
  assert.equal((await x.receipt()).ownerId, ownerId);
  const y = await harness(t);
  await seedV1(y, { withImage: false });
  await fs.writeFile(y.p.config, '{}\n', { mode: 0o600 });
  await assert.rejects(y.plan(), /controller\.json exists but Clawser does not own it/);
});

test('a Docker-era receipt naming another controller unit is refused', async t => {
  const x = await harness(t, { config: structuredClone(handoffBrowser) });
  await seedV1(x, { serviceUnit: 'clawser-desktop-000000000000.service' });
  await assert.rejects(x.plan(), error => error.message === changedOutside(x.p.marker));
  assert.equal(x.calls.some(call => call.command === 'systemctl' && call.args[1] !== 'show'), false);
});

test('openbox failing its smoke test during apply is refused before any state file is written', async t => {
  const x = await harness(t);
  const plan = await x.plan();
  assert.ok(plan.units[x.names.windowManager]);
  x.d.hostResolver.install = async host => {
    const binaries = structuredClone(host.binaries);
    delete binaries.openbox;
    return { record: { binaries }, warnings: ['openbox is unavailable; it failed the setup smoke test'] };
  };
  await assert.rejects(applyHost(plan, x.o, x.d, h), error => error.message === 'openbox is installed but fails to start; repair or remove it, then rerun setup');
  for (const path of [x.p.xauthority, x.p.openboxConfig, x.p.supervisorConfig, x.p.config, x.p.binary, x.unitDir]) assert.equal(await exists(path), false, path);
  assert.equal(x.calls.some(call => call.command === 'fetch'), false);
  assert.equal((await x.receipt()).hostDeps, undefined);
});

test('a file already matching the plan whose receipt digest is stale is current and the receipt adopts it', async t => {
  const x = await harness(t);
  await x.install();
  await rewriteReceipt(x, saved => { saved.supervisorConfigDigest = 'c'.repeat(64); });
  const plan = await x.plan();
  assert.deepEqual([plan.writes, plan.start, plan.restart], [[], [], []]);
  await applyHost(plan, x.o, x.d, h);
  assert.equal((await x.receipt()).supervisorConfigDigest, digest(await fs.readFile(x.p.supervisorConfig)));
});

test('a file already matching the plan with no receipt digest is current and the receipt adopts it', async t => {
  const x = await harness(t);
  await x.install();
  await rewriteReceipt(x, saved => { delete saved.units[x.names.browser]; });
  const plan = await x.plan();
  assert.deepEqual([plan.writes, plan.start, plan.restart], [[], [], []]);
  await applyHost(plan, x.o, x.d, h);
  assert.equal((await x.receipt()).units[x.names.browser], digest(await fs.readFile(join(x.unitDir, x.names.browser))));
});

test('an openbox config changed outside Clawser is refused by path', async t => {
  const x = await harness(t);
  await x.install();
  await fs.appendFile(x.p.openboxConfig, '<!-- edited -->\n');
  await assert.rejects(x.plan(), error => error.message === changedOutside(x.p.openboxConfig));
});
