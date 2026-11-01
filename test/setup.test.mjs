import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runClawser, ARTIFACTS, setupHelpers } from '../src/setup.mjs';
import { hostLocations } from '../src/host-setup.mjs';
import { unitNames } from '../src/host-units.mjs';
import { digest, hostWorld, isPatch, systemctl } from './host-fixture.mjs';

const harness = (t, config = {}) => hostWorld(t, { config, stateName: 'private state', packageName: 'package "quoted" % $value', deps: { execPath: '/node "quoted" % $PATH' } });
const enabled = calls => systemctl(calls, 'enable');
const personal = () => ({ browser: { defaultProfile: 'personal', profiles: { personal: { attachOnly: true, cdpUrl: 'http://127.0.0.1:9333' } } } });
const containerName = 'openclaw-handoff-desktop', imageId = 'sha256:' + 'a'.repeat(64);
const leftovers = [`docker rm -f ${containerName}`, `docker network rm ${containerName}-net`, `docker volume rm ${containerName}-profile`, `docker image rm ${imageId}`];

// A finished Docker-era install: v1 receipt, controller config and unit, pinned assets, and its desktop config.
async function seedDockerEra(h) {
  const p = hostLocations({ stateDir: h.stateDir }, h.deps), servicePath = join(h.unitDir, h.names.controller);
  for (const dir of [h.stateDir, p.state, p.runtime, dirname(p.binary), join(p.assets, 'core'), h.unitDir]) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(p.binary, 'verified cloudflared fixture', { mode: 0o700 });
  await fs.writeFile(join(p.assets, 'core/rfb.js'), 'export default class RFB {}', { mode: 0o600 });
  const oldConfig = JSON.stringify({ stateDir: p.state, profile: 'handoff', port: 19410, runtime: { name: containerName, image: imageId } }) + '\n';
  const oldUnit = '# Managed by Clawser\n[Unit]\nAfter=network-online.target docker.service\n';
  await fs.writeFile(p.config, oldConfig, { mode: 0o600 });
  await fs.writeFile(servicePath, oldUnit, { mode: 0o600 });
  const v1 = { identity: 'clawser-setup-v1', uid: h.deps.uid, ownerId: randomUUID(), imageId, serviceUnit: h.names.controller,
    options: { stateDir: h.stateDir, profile: 'handoff', port: 19410, cdpPort: 18812, vncPort: 59092, containerName, defaultProfile: true, packageDir: h.packageDir, execPath: h.deps.execPath, servicePath },
    configDigest: digest(oldConfig), serviceDigest: digest(oldUnit), assetsDigest: await setupHelpers.treeDigest(p.assets, h.deps) };
  await fs.writeFile(p.marker, JSON.stringify(v1, null, 2) + '\n', { mode: 0o600 });
  h.config.browser = { defaultProfile: 'handoff', profiles: { handoff: { cdpUrl: 'http://127.0.0.1:18812', driver: 'openclaw', engine: 'chromium', attachOnly: true } } };
  h.config.plugins = { entries: { 'browser-handoff': { enabled: true, config: { desktop: { enabled: true, socketPath: p.socket, profile: 'handoff' }, cloudflare: { enabled: false } } } } };
  h.units.set(h.names.controller, 'active');
  return { v1, servicePath };
}

test('pins verified upstream downloads', () => {
  assert.equal(ARTIFACTS.cloudflared.sha256, 'ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42');
  assert.equal(ARTIFACTS.noVnc.sha256, 'b1003a11b6e6e8d8f7f5e5586daae7f8ca651d8aee0aa155ff9ac841c48f52c6');
  assert.match(ARTIFACTS.noVnc.url, /\/refs\/tags\/v1\.7\.0$/);
});

test('noVNC setup waits for Gateway activation and doctor does not mistake controller readiness for activation', async t => {
  const h = await harness(t);
  await runClawser(h.args, h.deps);
  h.activation.diagnostic = { ...h.activation.diagnostic, phase: 'awaiting-commit' };
  const doctor = await runClawser(['doctor', '--state-dir', h.stateDir], h.deps);
  assert.equal(doctor.ok, false);
  assert.equal(doctor.pending, true);
  assert.equal(doctor.backend, 'novnc');
  assert.equal(doctor.activation.phase, 'awaiting-commit');
  assert.equal(doctor.display, 20);
  assert.ok(doctor.units.includes(h.names.browser));
  let time = 0;
  h.deps.now = () => time;
  h.deps.sleep = async ms => { time += ms; };
  h.deps.readActivationDiagnostic = async () => undefined;
  h.logs.length = 0;
  await assert.rejects(runClawser(h.args, h.deps), /activation is pending/);
  assert.equal(h.logs.some(line => line.startsWith('Clawser is configured')), false);
});

test('host noVNC to CDP and back reuses the original receipt, socket and browser profile', async t => {
  const h = await harness(t, personal());
  await runClawser(h.args, h.deps);
  const original = await fs.readFile(join(h.stateDir, 'setup.json'), 'utf8');
  const desktop = structuredClone(h.config.plugins.entries['browser-handoff'].config.desktop);
  const profile = structuredClone(h.config.browser.profiles.clawser);
  assert.equal((await runClawser(['setup', '--cdp'], h.deps)).backend, 'cdp');
  assert.equal(h.config.plugins.entries['browser-handoff'].config.desktop.enabled, false);
  assert.equal(await fs.readFile(join(h.stateDir, 'setup.json'), 'utf8'), original);
  h.calls.length = 0;
  // The host receipt outranks the CDP receipt. This is a rerun, not a takeover.
  const result = await runClawser(['setup', '--novnc', '--state-dir', h.stateDir], h.deps);
  assert.equal(result.backend, 'novnc');
  assert.deepEqual(h.config.plugins.entries['browser-handoff'].config.desktop, desktop);
  assert.deepEqual(h.config.browser.profiles.clawser, profile);
  assert.equal(await fs.readFile(join(h.stateDir, 'setup.json'), 'utf8'), original);
  assert.deepEqual(h.mutations().filter(call => !isPatch(call) && call.args[1] !== 'reload' && !String(call.args[1]).endsWith('/setup.lock')), []);
  assert.equal((await runClawser(['doctor', '--state-dir', h.stateDir], h.deps)).ok, true);
});

test('first noVNC setup can replace inert CDP desktop disable config but cannot adopt identity fields', async t => {
  for (const desktop of [{ enabled: false }, { enabled: false, socketPath: '/unowned/socket' }, { enabled: false, profile: 'unowned' }]) {
    const h = await harness(t, { plugins: { entries: { 'browser-handoff': { config: { desktop } } } } });
    if (Object.keys(desktop).length === 1) assert.equal((await runClawser(h.args, h.deps)).ok, true);
    else {
      await assert.rejects(runClawser(h.args, h.deps), /unowned/);
      await assert.rejects(fs.stat(h.stateDir), { code: 'ENOENT' });
    }
  }
});

test('owned desktop reenable rejects a non-boolean enable flag even when identity matches', async t => {
  const h = await harness(t);
  await runClawser(h.args, h.deps);
  h.config.plugins.entries['browser-handoff'].config.desktop.enabled = 'false';
  await assert.rejects(runClawser(h.args, h.deps), /conflicts/);
  h.config.plugins.entries['browser-handoff'].config.desktop = { enabled: false };
  await assert.rejects(runClawser(h.args, h.deps), /conflicts/);
});

test('--browser-profile and an unmarked CDP install route to the takeover planner', async t => {
  const h = await harness(t, personal());
  const nobody = /^Error: Nothing is listening on http:\/\/127\.0\.0\.1:9333\. Start that browser, then rerun setup\.$/;
  await assert.rejects(runClawser([...h.args, '--browser-profile', 'personal'], h.deps), nobody);
  const cdp = await runClawser(['setup', '--cdp'], h.deps);
  const receiptPath = join(cdp.stateDir, 'setup.json');
  // A CDP install from before the explicit mark existed.
  const { explicitCdp, ...unmarked } = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(explicitCdp, true);
  await fs.writeFile(receiptPath, JSON.stringify(unmarked) + '\n', { mode: 0o600 });
  const receipt = await fs.readFile(receiptPath, 'utf8'), config = structuredClone(h.config);
  h.calls.length = 0;
  await assert.rejects(runClawser(h.args, h.deps), nobody);
  assert.deepEqual(h.mutations(), []);
  assert.deepEqual(h.config, config);
  assert.equal(await fs.readFile(receiptPath, 'utf8'), receipt);
  await assert.rejects(fs.stat(h.stateDir), { code: 'ENOENT' });
  // An explicit CDP install stays out of the takeover path.
  await fs.writeFile(receiptPath, JSON.stringify({ ...unmarked, explicitCdp: true }) + '\n', { mode: 0o600 });
  assert.equal((await runClawser([...h.args, '--dry-run'], h.deps)).ok, true);
});

test('dry-run checks readiness and plans without downloads, writes or config changes', async t => {
  const h = await harness(t, { browser: { defaultProfile: 'handoff' } });
  const result = await runClawser([...h.args, '--dry-run'], h.deps);
  assert.deepEqual(Object.keys(result).sort(), ['command', 'dryRun', 'ok', 'patch', 'plan', 'stateDir', 'units']);
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.units, [h.names.display, h.names.windowManager, h.names.browser, h.names.supervisor, h.names.controller]);
  assert.ok(result.plan.includes('Display: :20'));
  assert.ok(result.plan.includes('Default browser profile: handoff → clawser'));
  assert.equal(result.patch.browser.defaultProfile, 'clawser');
  assert.deepEqual(h.logs, [...result.plan, 'No files, downloads, services, or configuration were changed.']);
  await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
  assert.deepEqual(h.mutations(), []);
  assert.deepEqual(h.config, { browser: { defaultProfile: 'handoff' } });
});

test('removed Docker flags explain they are gone', async t => {
  const h = await harness(t);
  for (const flag of ['--cdp-port', '--vnc-port', '--container-name', '--no-default-profile']) {
    await assert.rejects(runClawser([...h.args, flag, ...flag === '--no-default-profile' ? [] : ['1']], h.deps), error => {
      assert.match(error.message, /was removed in 0\.7\.0 along with the Docker desktop/);
      assert.ok(error.message.startsWith(flag + ' '), error.message);
      return true;
    });
  }
  assert.equal(h.calls.length, 0);
});

test('--novnc is accepted and --novnc with --cdp is refused', async t => {
  const h = await harness(t);
  h.deps.env.OPENCLAW_STATE_DIR = join(h.root, 'openclaw-state');
  const stateDir = join(h.root, 'openclaw-state/clawser');
  const result = await runClawser(['setup', '--novnc', '--dry-run'], h.deps);
  assert.equal(result.ok, true);
  assert.equal(result.stateDir, stateDir);
  assert.ok(result.units.includes(unitNames(stateDir).browser));
  h.calls.length = 0;
  for (const args of [['setup', '--novnc', '--cdp'], ['setup', '--cdp', '--novnc'], ['doctor', '--novnc', '--cdp']]) {
    await assert.rejects(runClawser(args, h.deps), error => error.message === '--novnc and --cdp cannot be used together');
  }
  assert.equal(h.calls.length, 0);
});

test('a disruptive rerun without --yes prints the plan and changes nothing', async t => {
  const h = await harness(t);
  await runClawser(h.args, h.deps);
  h.deps.findBrowserBinary = async () => ({ path: '/opt/google/chrome/chrome', brand: 'chrome' });
  h.calls.length = 0; h.logs.length = 0;
  const refused = await runClawser(h.args, h.deps);
  assert.deepEqual(Object.keys(refused).sort(), ['command', 'ok', 'plan']);
  assert.equal(refused.ok, false);
  assert.ok(refused.plan.includes('Restart ' + h.names.browser), refused.plan.join('\n'));
  assert.equal(h.logs.at(-1), "This closes the agent's browser. Rerun with --yes to go ahead.");
  assert.deepEqual(h.mutations(), []);
  assert.doesNotMatch(await h.unit(h.names.browser), /\/opt\/google/);
  const applied = await runClawser([...h.args, '--yes'], h.deps);
  assert.equal(applied.ok, true);
  assert.deepEqual(systemctl(h.calls, 'restart'), [h.names.browser]);
  assert.match(await h.unit(h.names.browser), /\/opt\/google\/chrome\/chrome/);
  assert.deepEqual((await h.receipt()).browser, { path: '/opt/google/chrome/chrome', existingArgs: [], env: [] });
});

test('setup prints that the agent browser starts with no logins', async t => {
  const h = await harness(t);
  const result = await runClawser(h.args, h.deps);
  assert.deepEqual(Object.keys(result).sort(), ['activation', 'backend', 'command', 'display', 'dryRun', 'ok', 'stateDir', 'units', 'warnings']);
  assert.deepEqual(result.warnings, []);
  const text = h.logs.join('\n');
  assert.match(text, /starts with no logins/);
  assert.ok(h.logs.includes('Clawser is configured.'));
  assert.ok(h.logs.includes('State: ' + h.stateDir));
  assert.ok(h.logs.includes('Display: :20'));
  for (const name of result.units) assert.ok(text.includes(name), name);
});

test('a Docker-era install converts through runClawser and prints its leftovers', async t => {
  const h = await harness(t);
  const { v1, servicePath } = await seedDockerEra(h);
  const dry = await runClawser([...h.args, '--dry-run'], h.deps);
  for (const command of leftovers) assert.ok(dry.plan.includes('Run yourself afterwards: ' + command), command);
  assert.deepEqual(h.mutations(), []);
  h.logs.length = 0;
  const result = await runClawser(h.args, h.deps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.dockerLeftovers, leftovers);
  const text = h.logs.join('\n');
  for (const command of leftovers) assert.ok(text.includes(command), command);
  assert.equal(h.calls.some(call => call.command === 'docker'), false);
  assert.deepEqual(systemctl(h.calls, 'stop'), [h.names.controller]);
  const saved = await h.receipt();
  assert.equal(saved.identity, 'clawser-setup-v2');
  assert.equal(saved.ownerId, v1.ownerId);
  assert.equal(h.config.plugins.entries['browser-handoff'].config.desktop.profile, 'clawser');
  assert.doesNotMatch(await fs.readFile(servicePath, 'utf8'), /docker/);
});

test('a Docker-era install that followed a CDP install converts instead of taking over', async t => {
  const h = await harness(t);
  await seedDockerEra(h);
  const cdpDir = join(h.root, 'openclaw-state/clawser-cdp');
  h.deps.env.OPENCLAW_STATE_DIR = join(h.root, 'openclaw-state');
  await fs.mkdir(cdpDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(join(cdpDir, 'setup.json'), JSON.stringify({ identity: 'clawser-cdp-setup-v1', uid: h.deps.uid, ownerId: randomUUID(), stateDir: cdpDir, binaryDigest: h.artifacts.cloudflared.sha256 }) + '\n', { mode: 0o600 });
  const result = await runClawser([...h.args, '--dry-run'], h.deps);
  assert.equal(result.ok, true);
  assert.ok(result.plan.includes('Stop the Docker-era controller ' + h.names.controller), result.plan.join('\n'));
  for (const command of leftovers) assert.ok(result.plan.includes('Run yourself afterwards: ' + command), command);
  assert.equal(result.patch.plugins.entries['browser-handoff'].config.desktop.profile, 'clawser');
  assert.deepEqual(h.mutations(), []);
});

test('doctor on a Docker-era receipt says to rerun setup', async t => {
  const h = await harness(t);
  await seedDockerEra(h);
  const result = await runClawser(['doctor', '--state-dir', h.stateDir], h.deps);
  assert.equal(result.ok, false);
  assert.equal(result.backend, 'novnc');
  assert.equal(result.checks.find(row => row.name === 'installation').message, 'This is a Docker desktop install from an older Clawser; rerun openclaw clawser setup');
  assert.deepEqual(h.mutations(), []);
});

test('binds every nested OpenClaw command to the trusted current host entrypoint', async t => {
  const h = await harness(t);
  const command = '/trusted node/bin/node', entrypoint = '/trusted OpenClaw "host"/openclaw.mjs';
  h.deps.openclawInvocation = { command, prefixArgs: [entrypoint] };
  const run = h.deps.run, invocations = [];
  h.deps.run = (executable, args, options) => {
    invocations.push({ executable, args, options });
    assert.notEqual(executable, 'openclaw', 'nested commands must not resolve OpenClaw from PATH');
    if (executable === command) {
      assert.equal(args[0], entrypoint);
      return run('openclaw', args.slice(1), options);
    }
    return run(executable, args, options);
  };
  const result = await runClawser(h.args, h.deps);
  assert.equal(result.ok, true);
  const bound = invocations.filter(call => call.executable === command);
  assert.ok(bound.some(call => call.args[1] === '--version'));
  for (const section of ['browser', 'plugins', 'tools']) assert.ok(bound.some(call => call.args[1] === 'config' && call.args[2] === 'get' && call.args[3] === section));
  const patches = bound.filter(call => call.args[1] === 'config' && call.args[2] === 'patch');
  assert.equal(patches.length, 2);
  assert.ok(patches.every(call => JSON.parse(call.options.input).browser.profiles.clawser));
  assert.ok(bound.some(call => call.args[1] === 'plugins' && call.args[2] === 'reload' && call.options.timeoutMs > 0 && call.options.timeoutMs <= 180_000));
  assert.equal(invocations.some(call => ['/bin/sh', 'sh', 'bash'].includes(call.executable)), false);
  assert.ok(invocations.some(call => call.executable === 'systemctl' && call.args[1] === 'enable'));
});

test('rejects invalid trusted OpenClaw invocations before executing commands', async t => {
  const h = await harness(t);
  for (const openclawInvocation of [
    null, {}, { command: 'node', prefixArgs: ['/trusted/openclaw.mjs'] },
    { command: '/usr/bin/node', prefixArgs: ['relative.mjs'] },
    { command: '/usr/bin/node', prefixArgs: [] },
    { command: '/usr/bin/node', prefixArgs: ['/trusted/openclaw.mjs', '--eval'] },
    { command: '/usr/bin/node\n', prefixArgs: ['/trusted/openclaw.mjs'] },
    { command: '/usr/bin/node', prefixArgs: ['/trusted/openclaw.mjs\0'] },
  ]) {
    await assert.rejects(runClawser([...h.args, '--dry-run'], { ...h.deps, openclawInvocation }), /invalid.*OpenClaw invocation/i);
    assert.equal(h.calls.length, 0);
  }
  await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
});

test('different execution captures preserve the trusted stable installation in receipts and service paths', async t => {
  const h = await harness(t);
  const stableRoot = join(h.root, 'stable-installed-plugin');
  await fs.cp(h.packageDir, stableRoot, { recursive: true });
  const captures = [join(h.root, 'capture-one'), join(h.root, 'capture-two')];
  for (const capture of captures) {
    await fs.mkdir(join(capture, 'src'), { recursive: true });
    await fs.mkdir(join(capture, 'runtime/desktop'), { recursive: true });
    for (const relative of ['src/setup.mjs', 'src/setup-activation.mjs', 'src/host-units.mjs', 'src/browser-activation.mjs', 'src/browser-policy.mjs', 'src/browser-config.mjs', 'src/authorization.mjs', 'openclaw.plugin.json', 'src/desktop-rpc.mjs', 'runtime/desktop/index.mjs',
      'src/host-setup.mjs', 'src/host-takeover.mjs', 'src/host-browser.mjs', 'src/host-deps.mjs', 'src/host-display.mjs']) await fs.copyFile(new URL(`../${relative}`, import.meta.url), join(capture, relative));
  }
  const firstModule = await import(pathToFileURL(join(captures[0], 'src/setup.mjs')).href);
  const secondModule = await import(pathToFileURL(join(captures[1], 'src/setup.mjs')).href);
  const run = h.deps.run;
  const dependencies = {
    ...h.deps, packageDir: `${stableRoot}/.`,
    openclawInvocation: { command: '/trusted/node', prefixArgs: ['/trusted/openclaw.mjs'] },
    run: (command, args, options) => command === '/trusted/node' ? run('openclaw', args.slice(1), options) : run(command, args, options),
  };
  const first = await firstModule.runClawser(h.args, dependencies);
  assert.equal(first.ok, true);
  const receipt = await h.receipt();
  assert.equal(receipt.packageDir, stableRoot);
  const service = await h.unit(h.names.controller), supervisor = await h.unit(h.names.supervisor);
  assert.ok(service.includes(`${stableRoot}/bin/desktop-controller.mjs`));
  assert.ok(supervisor.includes(`${stableRoot}/runtime/desktop/supervisor.py`));
  for (const name of first.units) { const text = await h.unit(name); assert.equal(captures.some(capture => text.includes(capture)), false, name); }
  dependencies.packageDir = stableRoot;
  h.calls.length = 0;
  assert.equal((await secondModule.runClawser(h.args, dependencies)).ok, true);
  assert.equal((await secondModule.runClawser(['doctor', '--state-dir', h.stateDir], dependencies)).ok, true);
  assert.equal(h.calls.some(call => call.command === 'fetch' || call.args.includes('restart') || call.args.includes('enable')), false);
  assert.equal(await h.unit(h.names.controller), service);
});

test('rejects invalid trusted package roots and requires one for plugin CLI execution', async t => {
  const h = await harness(t);
  for (const packageDir of ['', 'relative/package', null, '/tmp/package\npath', '/tmp/package\0path']) {
    await assert.rejects(runClawser([...h.args, '--dry-run'], { ...h.deps, packageDir }), /invalid.*package directory/i);
    assert.equal(h.calls.length, 0);
  }
  const { packageDir, ...withoutPackage } = h.deps;
  await assert.rejects(runClawser([...h.args, '--dry-run'], { ...withoutPackage, openclawInvocation: { command: '/trusted/node', prefixArgs: ['/trusted/openclaw.mjs'] } }), /trusted.*package directory/i);
  assert.equal(h.calls.length, 0);
  await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
});

test('a trusted package root cannot adopt an existing unowned state directory', async t => {
  const h = await harness(t);
  await fs.mkdir(h.stateDir, { mode: 0o700 });
  await assert.rejects(runClawser([...h.args, '--dry-run'], { ...h.deps, packageDir: `${h.packageDir}/.` }), /exists without Clawser ownership/i);
  await assert.rejects(fs.lstat(join(h.stateDir, 'setup.json')), { code: 'ENOENT' });
  assert.deepEqual(h.mutations(), []);
});

function unsetSectionMessage(name) {
  return `Config path is valid but unset: ${name}. The runtime default applies until you set an authored value with openclaw config set ${name} <value>.`;
}

for (const dryRun of [true, false]) {
  test(`first setup handles official unset browser/tools JSON errors${dryRun ? ' during dry-run' : ''}`, async t => {
    const h = await harness(t);
    const run = h.deps.run;
    h.deps.run = (command, args, options) => {
      const name = args[2];
      if (command === 'openclaw' && args[0] === 'config' && args[1] === 'get' && ['browser', 'tools'].includes(name) && !Object.hasOwn(h.config, name)) {
        throw Object.assign(new Error('openclaw failed (1): '), { code: 1, stderr: '', stdout: JSON.stringify({ ok: false, error: { type: 'cli_error', message: unsetSectionMessage(name) } }) });
      }
      return run(command, args, options);
    };
    const result = await runClawser([...h.args, ...(dryRun ? ['--dry-run'] : [])], h.deps);
    assert.equal(result.ok, true);
    if (dryRun) {
      await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
      assert.deepEqual(h.config, {});
      assert.deepEqual(h.mutations(), []);
    } else {
      assert.equal(h.config.browser.profiles.clawser.cdpUrl, 'http://127.0.0.1:18820');
      assert.deepEqual(h.config.tools.alsoAllow, ['browser_handoff']);
    }
  });
}

test('unrelated or malformed config error envelopes remain failures before mutations', async t => {
  const h = await harness(t);
  const run = h.deps.run;
  const envelope = (message, type = 'cli_error') => JSON.stringify({ ok: false, error: { type, message } });
  const failures = [
    { stdout: envelope(unsetSectionMessage('tools')) },
    { stdout: envelope(unsetSectionMessage('browser'), 'config_error') },
    { stdout: envelope('Permission denied reading configuration; token=do-not-print') },
    { stdout: envelope('Unknown configuration path: browser'), message: 'Config path not found: browser' },
    { stdout: '{malformed JSON' },
    { stdout: envelope(unsetSectionMessage('browser')), code: 2 },
    { stdout: envelope(unsetSectionMessage('browser')), stderr: 'permission denied' },
  ];
  for (const failure of failures) {
    h.deps.run = (command, args, options) => {
      if (command === 'openclaw' && args[0] === 'config' && args[1] === 'get' && args[2] === 'browser') {
        throw Object.assign(new Error(failure.message || 'openclaw failed (1): '), { code: 1, stderr: '', ...failure });
      }
      return run(command, args, options);
    };
    await assert.rejects(runClawser([...h.args, '--dry-run'], h.deps), error => {
      assert.equal(error.message.includes('do-not-print'), false);
      return true;
    });
  }
  await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
  assert.deepEqual(h.mutations(), []);
});

test('checksum failure cannot install a service or configure OpenClaw', async t => {
  const h = await harness(t); h.corrupt = true;
  await assert.rejects(runClawser(h.args, h.deps), /checksum/i);
  assert.deepEqual(enabled(h.calls), []);
  assert.equal(h.calls.some(isPatch), false);
  await assert.rejects(fs.lstat(h.unitDir), { code: 'ENOENT' });
  assert.deepEqual(h.config, {});
});

test('setup preserves other profiles, plugin configuration and allowlists', async t => {
  const h = await harness(t, {
    browser: { defaultProfile: 'personal', profiles: { personal: { cdpUrl: 'http://127.0.0.1:9222', attachOnly: true } } },
    plugins: { allow: ['other'], entries: { other: { enabled: true }, 'browser-handoff': { config: { funnel: { enabled: false }, profiles: { old: 'http://127.0.0.1:9222' } } } } },
    tools: { allow: ['read', 'browser'], deny: ['dangerous'] },
  });
  const result = await runClawser(h.args, h.deps);
  assert.equal(result.ok, true);
  assert.equal(h.config.browser.profiles.personal.cdpUrl, 'http://127.0.0.1:9222');
  assert.deepEqual(h.config.tools, { allow: ['read', 'browser', 'browser_handoff'], deny: ['dangerous'] });
  assert.deepEqual(h.config.plugins.allow, ['other', 'browser-handoff']);
  assert.equal(h.config.plugins.entries.other.enabled, true);
  assert.equal(h.config.plugins.entries['browser-handoff'].config.funnel.enabled, false);
  assert.equal(h.config.plugins.entries['browser-handoff'].config.profiles.old, 'http://127.0.0.1:9222');
  assert.equal(h.config.browser.defaultProfile, 'clawser');
  assert.equal((await h.receipt()).previousDefaultProfile, 'personal');
  const patchIndex = h.calls.findIndex(isPatch);
  const enableIndex = h.calls.findIndex(c => c.command === 'systemctl' && c.args.includes('enable'));
  const reloadIndex = h.calls.findIndex(c => c.args.includes('reload'));
  assert.ok(enableIndex < patchIndex && patchIndex < reloadIndex);
  const controller = JSON.parse(await fs.readFile(join(h.stateDir, 'controller.json'), 'utf8'));
  assert.equal(controller.runtime.cdpUrl, 'http://127.0.0.1:18820');
  assert.equal(controller.transport.startupTimeoutMs, 90_000);
  for (const path of [h.stateDir, join(h.stateDir, 'setup.json'), join(h.stateDir, 'controller.json'), join(h.stateDir, 'xauthority'), join(h.stateDir, 'browser/profile')]) assert.equal((await fs.lstat(path)).mode & 0o077, 0, path);
  const service = await h.unit(h.names.controller);
  assert.match(service, /ExecStart="\/node \\"quoted\\" %% \$\$PATH"/);
  assert.match(service, /"[^"]*package \\"quoted\\" %% \$\$value\/bin\/desktop-controller\.mjs"/);
  assert.equal(service.includes('/bin/sh'), false);
  assert.match(service, /^KillMode=mixed$/m, 'initial stop signals must preserve the controller’s child authority lock');
  assert.match(service, /TimeoutStopSec=180\n/);
});

for (const kind of ['state path', 'profile', 'desktop config', 'service', 'port']) {
  test(`refuses an unowned ${kind} before mutating`, async t => {
    const h = await harness(t);
    if (kind === 'state path') await fs.mkdir(h.stateDir, { mode: 0o700 });
    if (kind === 'profile') h.config.browser = { profiles: { clawser: { cdpUrl: 'http://127.0.0.1:18820' } } };
    if (kind === 'desktop config') h.config.plugins = { entries: { 'browser-handoff': { config: { desktop: { enabled: true, socketPath: '/someone/else.sock', profile: 'clawser' } } } } };
    if (kind === 'service') { h.units.set(h.names.display, 'active'); h.fragments[h.names.display] = '/unmanaged/existing.service'; }
    if (kind === 'port') h.busy([19420]);
    await assert.rejects(runClawser(h.args, h.deps), /unowned|unmanaged|conflict|in use|exists/i);
    assert.deepEqual(h.mutations(), []);
  });
}

test('refuses changed owned controller config and changed setup arguments', async t => {
  const h = await harness(t);
  await runClawser(h.args, h.deps);
  await assert.rejects(runClawser([...h.args, '--port', '19411'], h.deps), /conflict/i);
  await fs.writeFile(join(h.stateDir, 'controller.json'), '{}', { mode: 0o600 });
  await assert.rejects(runClawser(h.args, h.deps), /changed outside Clawser/);
});

test('doctor reports missing setup without changing the machine', async t => {
  const h = await harness(t);
  const result = await runClawser(['doctor', '--novnc', '--state-dir', h.stateDir], h.deps);
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(c => c.name === 'installation').message, 'No owned Clawser setup found; run openclaw clawser setup');
  await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
  assert.deepEqual(h.mutations(), []);
});

test('doctor validates an owned installation without downloads or mutations', async t => {
  const h = await harness(t);
  await runClawser(h.args, h.deps);
  h.calls.length = 0;
  const result = await runClawser(['doctor', '--state-dir', h.stateDir], h.deps);
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.deepEqual(Object.keys(result).sort(), ['activation', 'backend', 'checks', 'command', 'display', 'ok', 'pending', 'stateDir', 'units']);
  assert.deepEqual(result.checks.map(row => row.name).slice(-6), ['installation', 'configuration', 'pinned assets', 'host dependencies', 'controller health', 'Gateway activation']);
  assert.deepEqual(h.mutations(), []);
  assert.equal(h.calls.some(call => call.command === 'fetch'), false);
});

test('doctor checks a custom-port install from its state directory alone', async t => {
  const h = await harness(t);
  await runClawser([...h.args, '--port', '29410'], h.deps);
  assert.equal((await h.receipt()).port, 29410);
  assert.equal(JSON.parse(await fs.readFile(join(h.stateDir, 'controller.json'), 'utf8')).port, 29410);
  h.logs.length = 0;
  const result = await runClawser(['doctor', '--state-dir', h.stateDir], h.deps);
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.ok(h.logs.includes('State: ' + h.stateDir));
  assert.ok(h.logs.includes('Display: :20'));
});

test('setup inherits owned custom settings when rerun with only its state directory', async t => {
  const h = await harness(t);
  await runClawser([...h.args, '--port', '29410'], h.deps);
  h.calls.length = 0;
  const result = await runClawser(h.args, h.deps);
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(await fs.readFile(join(h.stateDir, 'controller.json'), 'utf8')).port, 29410);
  assert.equal(h.calls.some(c => c.command === 'fetch' || c.args.includes('restart') || c.args.includes('enable')), false);
});

test('doctor fails when the installed desktop configuration was removed', async t => {
  const h = await harness(t);
  await runClawser(h.args, h.deps);
  delete h.config.plugins.entries['browser-handoff'].config.desktop;
  const result = await runClawser(['doctor', '--novnc', '--state-dir', h.stateDir], h.deps);
  assert.equal(result.ok, false);
  assert.ok(result.checks.some(row => row.name === 'configuration' && !row.ok));
});

test('refuses symlinked state and modified pinned assets', async t => {
  const h = await harness(t);
  await fs.symlink(h.packageDir, h.stateDir);
  await assert.rejects(runClawser(h.args, h.deps), /symlink/i);
  await fs.unlink(h.stateDir);
  await runClawser(h.args, h.deps);
  await fs.writeFile(join(h.stateDir, 'vendor/novnc-1.7.0/core/rfb.js'), 'changed');
  await assert.rejects(runClawser(h.args, h.deps), /changed|checksum/i);
});

test('an interrupted reload can be retried without replacing the owned browser profile', async t => {
  const h = await harness(t);
  const run = h.deps.run;
  h.deps.run = (command, args, options) => {
    if (command === 'openclaw' && args.includes('reload')) throw new Error('Gateway unavailable');
    return run(command, args, options);
  };
  await assert.rejects(runClawser(h.args, h.deps), /Gateway unavailable/);
  const profile = structuredClone(h.config.browser.profiles.clawser);
  h.deps.run = run;
  await runClawser(h.args, h.deps);
  assert.deepEqual(h.config.browser.profiles.clawser, profile);
});

test('retries only final reload across a Gateway restart without repeating setup mutations', async t => {
  const h = await harness(t);
  const run = h.deps.run, sleeps = [], reloads = [];
  let time = 0;
  h.deps.now = () => time;
  h.deps.sleep = async milliseconds => { sleeps.push(milliseconds); time += milliseconds; };
  h.deps.run = (command, args, options) => {
    if (command === 'openclaw' && args[0] === 'plugins' && args[1] === 'reload') {
      reloads.push(options);
      if (reloads.length <= 2) throw Object.assign(new Error('openclaw failed (1)'), { code: 1, stderr: reloads.length === 1 ? "Couldn't connect to OpenClaw. Check the Control UI or run openclaw gateway status." : 'Gateway is restarting; try again shortly.' });
    }
    return run(command, args, options);
  };
  assert.equal((await runClawser(h.args, h.deps)).ok, true);
  assert.equal(reloads.length, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.deepEqual(reloads.map(options => options.timeoutMs), [180_000, 179_000, 177_000]);
  assert.equal(h.logs.filter(message => message.includes('Waiting for OpenClaw')).length, 1);
  assert.equal(enabled(h.calls).length, 5);
  assert.equal(h.calls.filter(isPatch).length, 1);
  assert.deepEqual(Object.keys(h.config.browser.profiles), ['clawser']);
  assert.deepEqual(h.config.tools.alsoAllow, ['browser_handoff']);
});

test('permission, capability, schema and uncertain timeout reload errors fail without retrying', async t => {
  for (const stderr of [
    "Couldn't connect to OpenClaw. Permission denied (EACCES).",
    'Gateway is restarting; capability approval required.',
    'Gateway is restarting; schema validation failed.',
    "Couldn't connect to OpenClaw. Request timed out; outcome is unknown.",
    'Gateway unavailable',
  ]) {
    await t.test(stderr, async subtest => {
      const h = await harness(subtest);
      const run = h.deps.run;
      let attempts = 0, sleeps = 0;
      h.deps.sleep = async () => { sleeps++; };
      h.deps.run = (command, args, options) => {
        if (command === 'openclaw' && args[0] === 'plugins' && args[1] === 'reload') { attempts++; throw Object.assign(new Error(stderr), { code: 1, stderr }); }
        return run(command, args, options);
      };
      await assert.rejects(runClawser(h.args, h.deps), error => error.message === stderr);
      assert.equal(attempts, 1);
      assert.equal(sleeps, 0);
    });
  }
});

test('transient final reload failures exhaust a bounded shared deadline', async t => {
  const h = await harness(t);
  const run = h.deps.run, timeouts = [];
  let time = 0, sleeps = 0;
  h.deps.now = () => time;
  h.deps.sleep = async milliseconds => { assert.ok(milliseconds > 0 && milliseconds <= 2000); sleeps++; time += milliseconds; };
  h.deps.run = (command, args, options) => {
    if (command === 'openclaw' && args[0] === 'plugins' && args[1] === 'reload') {
      timeouts.push(options.timeoutMs);
      throw Object.assign(new Error('connection failed'), { code: 1, stderr: "Couldn't connect to OpenClaw. Check the Control UI or run openclaw gateway status." });
    }
    return run(command, args, options);
  };
  await assert.rejects(runClawser(h.args, h.deps), /reload.*unavailable|unavailable.*reload|reload.*ready/i);
  assert.ok(timeouts.length > 1 && timeouts.length <= 90);
  assert.equal(sleeps, timeouts.length - 1);
  assert.ok(time <= 180_000);
  assert.ok(timeouts.every((value, index) => value > 0 && value <= 180_000 && (index === 0 || value < timeouts[index - 1])));
  assert.equal(h.logs.filter(message => message.includes('Waiting for OpenClaw')).length, 1);
  assert.equal(enabled(h.calls).length, 5);
  assert.equal(h.calls.filter(isPatch).length, 1);
});

test('rereads allowlists after starting services before merging configuration', async t => {
  const h = await harness(t, { tools: { alsoAllow: ['read'] }, plugins: { allow: ['existing'] } });
  const run = h.deps.run;
  h.deps.run = (command, args, options) => {
    if (command === 'systemctl' && args[1] === 'enable' && args.at(-1) === h.names.controller) { h.config.tools.alsoAllow.push('new-during-start'); h.config.plugins.allow.push('another-plugin'); }
    return run(command, args, options);
  };
  await runClawser(h.args, h.deps);
  assert.deepEqual(h.config.tools.alsoAllow, ['read', 'new-during-start', 'browser_handoff']);
  assert.deepEqual(h.config.plugins.allow, ['existing', 'another-plugin', 'browser-handoff']);
});

test('an old OpenClaw version fails before downloads or setup writes', async t => {
  const h = await harness(t);
  const run = h.deps.run;
  h.deps.run = (command, args, options) => command === 'openclaw' && args[0] === '--version' ? 'OpenClaw 2026.9.28' : run(command, args, options);
  await assert.rejects(runClawser(h.args, h.deps), /2026\.10\.4/);
  await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
  assert.deepEqual(h.mutations(), []);
});

test('unsupported platforms, versions and invalid flags fail before mutation', async t => {
  const h = await harness(t);
  for (const args of [['--port', '19410junk'], ['--cdp-port', '19410'], ['--browser-profile', '../escape'], ['--profile', 'host-profile'], ['--unknown'], ['--yes', '--yes']]) {
    await assert.rejects(runClawser([...h.args, ...args], h.deps), /invalid|unknown|removed/i);
  }
  await assert.rejects(runClawser(h.args, { ...h.deps, arch: 'arm64' }), /^Error: platform: Clawser setup requires Linux x86_64 with systemd user services$/);
  await assert.rejects(runClawser(h.args, { ...h.deps, nodeVersion: '20.0.0' }), /Node 24\.16/);
  assert.equal(h.calls.length, 0);
});

test('rejects unsupported Node versions before running external commands', async t => {
  const h = await harness(t);
  for (const nodeVersion of ['22.20.0', '23.11.0', '24.15.99', '25.0.0', '25.99.0', '26.0.99', '24.16.0-rc.1', 'invalid']) {
    await assert.rejects(runClawser([...h.args, '--dry-run'], { ...h.deps, nodeVersion }), /Node 24\.16/, nodeVersion);
    assert.equal(h.calls.length, 0, `${nodeVersion} ran an external command`);
  }
  await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
});

test('accepts the supported Node release boundaries and later majors', async t => {
  const h = await harness(t);
  for (const nodeVersion of ['24.16.0', '24.18.0', '24.99.0', '26.1.0', '26.9.0', '27.0.0', '28.0.0']) {
    const result = await runClawser([...h.args, '--dry-run'], { ...h.deps, nodeVersion });
    assert.equal(result.ok, true, nodeVersion);
    assert.equal(result.dryRun, true, nodeVersion);
  }
  await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
});

test('setup checks host prerequisites and never asks for docker', async t => {
  const h = await harness(t);
  await runClawser([...h.args, '--dry-run'], h.deps);
  const external = h.calls.filter(call => call.command !== 'fs' && call.command !== 'fetch').map(call => [call.command, ...call.args.slice(0, 2)].join(' '));
  for (const want of ['tar --version', '/usr/bin/flock --version', 'systemctl --user show-environment', 'openclaw --version']) assert.ok(external.includes(want), want);
  await fs.rm(join(h.packageDir, 'runtime/desktop/xproof.py'));
  h.calls.length = 0;
  await assert.rejects(runClawser(h.args, h.deps), /source paths: Installed package is missing runtime\/desktop\/xproof\.py/);
  assert.equal(h.calls.length, 0);
});
