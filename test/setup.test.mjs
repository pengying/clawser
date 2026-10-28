import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runClawser, ARTIFACTS } from '../src/setup.mjs';

const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const imageId = `sha256:${'a'.repeat(64)}`;
function merge(base, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) merge(base[key] ??= {}, value);
    else base[key] = structuredClone(value);
  }
  return base;
}

async function harness(t, config = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'clawser-setup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'private state');
  const packageDir = join(root, 'package "quoted" % $value');
  for (const name of ['bin', 'runtime/desktop']) await fs.mkdir(join(packageDir, name), { recursive: true });
  for (const name of ['index.mjs', 'bin/desktop-controller.mjs', 'runtime/desktop/Dockerfile', 'runtime/desktop/chromium-seccomp.json']) await fs.writeFile(join(packageDir, name), 'fixture');
  const archiveRoot = join(root, 'archive');
  await fs.mkdir(join(archiveRoot, 'noVNC-1.7.0/core'), { recursive: true });
  await fs.writeFile(join(archiveRoot, 'noVNC-1.7.0/core/rfb.js'), 'export default class RFB {}');
  const archivePath = join(root, 'novnc.tgz');
  await execute('tar', ['-czf', archivePath, '-C', archiveRoot, 'noVNC-1.7.0']);
  const binary = Buffer.from('verified cloudflared fixture');
  const archive = await fs.readFile(archivePath);
  const artifacts = {
    cloudflared: { ...ARTIFACTS.cloudflared, sha256: digest(binary) },
    noVnc: { ...ARTIFACTS.noVnc, sha256: digest(archive) },
  };
  const calls = [], logs = [];
  let serviceActive = false, servicePath = '', failChecksum = false, busyPorts = [], dockerResources = {};
  const deps = {
    fs, artifacts, packageDir, env: { XDG_CONFIG_HOME: join(root, 'config') }, homeDir: root,
    platform: 'linux', arch: 'x64', nodeVersion: '24.18.0', execPath: '/node "quoted" % $PATH',
    log: message => logs.push(message), isPortFree: async port => !busyPorts.includes(port),
    controllerHealth: async () => ({ ready: true, profile: 'handoff', cdpUrl: 'http://127.0.0.1:18812', recoveryRequired: false }),
    fetch: async url => {
      calls.push({ command: 'fetch', args: [url] });
      return new Response(failChecksum ? 'corrupt' : url === artifacts.cloudflared.url ? binary : archive);
    },
    run: async (command, args, options = {}) => {
      calls.push({ command, args, input: options.input, timeoutMs: options.timeoutMs });
      if (command === 'tar' && args.includes('-xzf')) return (await execute(command, args)).stdout;
      if (command === 'tar' && args.includes('-tzf')) return (await execute(command, args)).stdout;
      if (command === 'openclaw') {
        if (args[0] === '--version') return 'OpenClaw 2026.10.4';
        if (args[0] === 'config' && args[1] === 'get') return JSON.stringify(config[args[2]] ?? {});
        if (args[0] === 'config' && args[1] === 'patch') { if (!args.includes('--dry-run')) merge(config, JSON.parse(options.input)); return ''; }
        if (args[0] === 'plugins' && args[1] === 'reload') { assert.equal(serviceActive, true); return ''; }
      }
      if (command === 'docker') {
        const rest = args.filter(arg => !arg.startsWith('--host='));
        if (rest[0] === 'inspect' || ['network', 'volume'].includes(rest[0])) {
          const key = rest.at(-1);
          if (dockerResources[key]) return JSON.stringify([dockerResources[key]]);
          throw new Error('No such object');
        }
        if (rest[0] === 'image') return imageId;
        if (rest[0] === 'build') return imageId;
        return '27.0.0';
      }
      if (command === 'systemctl') {
        if (args.includes('show')) return `LoadState=${servicePath ? 'loaded' : 'not-found'}\nFragmentPath=${servicePath}\nActiveState=${serviceActive ? 'active' : 'inactive'}\n`;
        if (args.includes('enable')) { serviceActive = true; servicePath = join(root, 'config/systemd/user', args.at(-1)); }
        return '';
      }
      return '';
    },
  };
  return {
    root, stateDir, packageDir, config, deps, calls, logs,
    args: ['setup', '--state-dir', stateDir],
    corrupt: () => { failChecksum = true; },
    busy: ports => { busyPorts = ports; },
    resource: (name, value) => { dockerResources[name] = value; },
    unmanagedService: () => { servicePath = '/unmanaged/existing.service'; },
  };
}

test('pins verified upstream downloads', () => {
  assert.equal(ARTIFACTS.cloudflared.sha256, 'ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42');
  assert.equal(ARTIFACTS.noVnc.sha256, 'b1003a11b6e6e8d8f7f5e5586daae7f8ca651d8aee0aa155ff9ac841c48f52c6');
  assert.match(ARTIFACTS.noVnc.url, /\/refs\/tags\/v1\.7\.0$/);
});

test('dry-run checks readiness and plans without downloads, writes, builds or config changes', async t => {
  const h = await harness(t);
  const result = await runClawser([...h.args, '--dry-run'], h.deps);
  assert.equal(result.dryRun, true);
  await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
  assert.equal(h.calls.some(c => c.command === 'fetch' || c.args.includes('build') || c.args.includes('patch') || c.args.includes('enable')), false);
  assert.deepEqual(h.config, {});
});

test('coercible container names keep string-hint Docker resource identities', async t => {
  const h = await harness(t);
  const hints = [];
  const containerName = {
    startsWith() { return false; },
    [Symbol.toPrimitive](hint) { hints.push(hint); return hint === 'string' ? 'desktop' : 'different'; },
  };
  const result = await runClawser([...h.args, '--container-name', containerName, '--dry-run'], h.deps);
  assert.equal(result.dryRun, true);
  const inspections = h.calls.filter(call => call.command === 'docker' && call.args.includes('inspect'));
  assert.equal(inspections[0].args.at(-1), containerName);
  assert.deepEqual(inspections.slice(1).map(call => call.args.slice(-3)), [
    ['network', 'inspect', 'desktop-net'], ['volume', 'inspect', 'desktop-profile'],
  ]);
  assert.ok(hints.length >= 4);
  assert.ok(hints.every(hint => hint === 'string'));
  await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
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
  assert.ok(patches.every(call => JSON.parse(call.options.input).browser.profiles.handoff));
  assert.ok(bound.some(call => call.args[1] === 'plugins' && call.args[2] === 'reload' && call.options.timeoutMs > 0 && call.options.timeoutMs <= 180_000));
  assert.equal(invocations.some(call => ['/bin/sh', 'sh', 'bash'].includes(call.executable)), false);
  assert.ok(invocations.some(call => call.executable === 'docker' && call.args.includes('build') && call.options.timeoutMs === 45 * 60_000));
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
    for (const relative of ['src/setup.mjs', 'src/desktop-rpc.mjs', 'runtime/desktop/index.mjs']) await fs.copyFile(new URL(`../${relative}`, import.meta.url), join(capture, relative));
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
  const receipt = JSON.parse(await fs.readFile(join(h.stateDir, 'setup.json'), 'utf8'));
  assert.equal(receipt.options.packageDir, stableRoot);
  const service = await fs.readFile(first.servicePath, 'utf8');
  assert.ok(service.includes(`${stableRoot}/bin/desktop-controller.mjs`));
  assert.equal(captures.some(capture => service.includes(capture)), false);
  dependencies.packageDir = stableRoot;
  h.calls.length = 0;
  assert.equal((await secondModule.runClawser(h.args, dependencies)).ok, true);
  assert.equal((await secondModule.runClawser(['doctor', '--state-dir', h.stateDir], dependencies)).ok, true);
  assert.equal(h.calls.some(call => call.command === 'fetch' || call.args.includes('build') || call.args.includes('restart')), false);
  assert.equal(await fs.readFile(first.servicePath, 'utf8'), service);
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
  assert.equal(h.calls.some(call => call.command === 'fetch' || call.args.includes('patch') || call.args.includes('build')), false);
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
      assert.equal(h.calls.some(call => call.command === 'fetch' || call.args.includes('patch') || call.args.includes('build')), false);
    } else {
      assert.equal(h.config.browser.profiles.handoff.cdpUrl, 'http://127.0.0.1:18812');
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
  assert.equal(h.calls.some(call => call.command === 'fetch' || call.args.includes('patch') || call.args.includes('build')), false);
});

test('checksum failure cannot build, install a service, or configure OpenClaw', async t => {
  const h = await harness(t); h.corrupt();
  await assert.rejects(runClawser(h.args, h.deps), /checksum/i);
  assert.equal(h.calls.some(c => c.args.includes('build') || c.args.includes('enable') || (c.args.includes('patch') && !c.args.includes('--dry-run'))), false);
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
  assert.equal(h.calls.find(call => call.command === 'docker' && call.args.includes('build')).timeoutMs, 45 * 60_000);
  assert.equal(h.config.browser.profiles.personal.cdpUrl, 'http://127.0.0.1:9222');
  assert.deepEqual(h.config.tools, { allow: ['read', 'browser', 'browser_handoff'], deny: ['dangerous'] });
  assert.deepEqual(h.config.plugins.allow, ['other', 'browser-handoff']);
  assert.equal(h.config.plugins.entries.other.enabled, true);
  assert.equal(h.config.plugins.entries['browser-handoff'].config.funnel.enabled, false);
  assert.equal(h.config.plugins.entries['browser-handoff'].config.profiles.old, 'http://127.0.0.1:9222');
  assert.equal(h.config.browser.defaultProfile, 'handoff');
  const patchIndex = h.calls.findIndex(c => c.args.includes('patch') && !c.args.includes('--dry-run'));
  const enableIndex = h.calls.findIndex(c => c.command === 'systemctl' && c.args.includes('enable'));
  const reloadIndex = h.calls.findIndex(c => c.args.includes('reload'));
  assert.ok(enableIndex < patchIndex && patchIndex < reloadIndex);
  const controller = JSON.parse(await fs.readFile(join(h.stateDir, 'controller.json'), 'utf8'));
  assert.equal(controller.runtime.image, imageId);
  assert.equal(controller.transport.startupTimeoutMs, 90_000);
  for (const path of [h.stateDir, join(h.stateDir, 'setup.json'), join(h.stateDir, 'controller.json')]) assert.equal((await fs.lstat(path)).mode & 0o077, 0);
  const service = await fs.readFile(result.servicePath, 'utf8');
  assert.match(service, /ExecStart="\/node \\"quoted\\" %% \$\$PATH"/);
  assert.equal(service.includes('/bin/sh'), false);
  assert.match(service, /TimeoutStopSec=180\n/);
});

test('repeated owned setup preserves profile and skips downloads, image rebuild and controller restart', async t => {
  const h = await harness(t);
  const first = await runClawser(h.args, h.deps);
  const marker = await fs.readFile(join(h.stateDir, 'setup.json'), 'utf8');
  await fs.writeFile(join(h.stateDir, 'profile-sentinel'), 'cookies stay');
  h.calls.length = 0;
  const second = await runClawser(h.args, h.deps);
  assert.equal(first.serviceUnit, second.serviceUnit);
  assert.equal(await fs.readFile(join(h.stateDir, 'profile-sentinel'), 'utf8'), 'cookies stay');
  assert.equal(await fs.readFile(join(h.stateDir, 'setup.json'), 'utf8'), marker);
  assert.equal(h.calls.some(c => c.command === 'fetch' || c.args.includes('build') || c.args.includes('restart')), false);
});

for (const kind of ['state path', 'profile', 'desktop config', 'service', 'port', 'container', 'volume']) {
  test(`refuses an unowned ${kind} before mutating`, async t => {
    const h = await harness(t);
    if (kind === 'state path') await fs.mkdir(h.stateDir, { mode: 0o700 });
    if (kind === 'profile') h.config.browser = { profiles: { handoff: { cdpUrl: 'http://127.0.0.1:18812' } } };
    if (kind === 'desktop config') h.config.plugins = { entries: { 'browser-handoff': { config: { desktop: { enabled: true, socketPath: '/someone/else.sock', profile: 'handoff' } } } } };
    if (kind === 'service') h.unmanagedService();
    if (kind === 'port') h.busy([19410]);
    if (kind === 'container') h.resource('openclaw-handoff-desktop', { Id: 'unmanaged', Config: { Labels: {} } });
    if (kind === 'volume') h.resource('openclaw-handoff-desktop-profile', { Labels: {} });
    await assert.rejects(runClawser(h.args, h.deps), /unowned|unmanaged|conflict|in use|exists/i);
    assert.equal(h.calls.some(c => c.command === 'fetch' || c.args.includes('build') || c.args.includes('enable') || (c.args.includes('patch') && !c.args.includes('--dry-run'))), false);
  });
}

test('refuses changed owned controller config and changed setup arguments', async t => {
  const h = await harness(t);
  await runClawser(h.args, h.deps);
  await assert.rejects(runClawser([...h.args, '--port', '19411'], h.deps), /conflict|differs/i);
  await fs.writeFile(join(h.stateDir, 'controller.json'), '{}', { mode: 0o600 });
  await assert.rejects(runClawser(h.args, h.deps), /changed|conflict/i);
});

test('doctor reports missing setup without changing the machine', async t => {
  const h = await harness(t);
  const result = await runClawser(['doctor', '--state-dir', h.stateDir], h.deps);
  assert.equal(result.ok, false);
  assert.ok(result.checks.some(c => c.name === 'installation' && !c.ok));
  await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
  assert.equal(h.calls.some(c => c.command === 'fetch' || c.args.includes('patch') || c.args.includes('enable')), false);
});

test('doctor validates an owned installation without downloads or mutations', async t => {
  const h = await harness(t);
  await runClawser(h.args, h.deps);
  h.calls.length = 0;
  const result = await runClawser(['doctor', '--state-dir', h.stateDir], h.deps);
  assert.equal(result.ok, true);
  assert.equal(h.calls.some(c => c.command === 'fetch' || c.args.includes('patch') || c.args.includes('enable')), false);
});

test('doctor uses saved custom setup options when only a state directory is supplied', async t => {
  const h = await harness(t);
  const originalHealth = h.deps.controllerHealth;
  h.deps.controllerHealth = async () => ({ ...await originalHealth(), profile: 'dedicated', cdpUrl: 'http://127.0.0.1:28812' });
  await runClawser([...h.args, '--browser-profile', 'dedicated', '--port', '29410', '--cdp-port', '28812', '--vnc-port', '59093', '--container-name', 'isolated-desktop', '--no-default-profile'], h.deps);
  const result = await runClawser(['doctor', '--state-dir', h.stateDir], h.deps);
  assert.equal(result.ok, true);
  assert.ok(h.logs.at(-1).includes('isolated-desktop'));
});

test('setup inherits owned custom settings when rerun with only its state directory', async t => {
  const h = await harness(t);
  h.deps.controllerHealth = async () => ({ ready: true, profile: 'custom', cdpUrl: 'http://127.0.0.1:28812', recoveryRequired: false });
  await runClawser([...h.args, '--browser-profile', 'custom', '--port', '29410', '--cdp-port', '28812', '--vnc-port', '59093', '--container-name', 'custom-desktop', '--no-default-profile'], h.deps);
  h.calls.length = 0;
  const result = await runClawser(h.args, h.deps);
  assert.equal(result.ok, true);
  assert.equal(h.config.browser.profiles.custom.cdpUrl, 'http://127.0.0.1:28812');
  assert.equal(h.calls.some(c => c.command === 'fetch' || c.args.includes('build') || c.args.includes('restart')), false);
});

test('doctor fails when the installed desktop configuration was removed', async t => {
  const h = await harness(t);
  await runClawser(h.args, h.deps);
  delete h.config.plugins.entries['browser-handoff'].config.desktop;
  const result = await runClawser(['doctor', '--state-dir', h.stateDir], h.deps);
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
  const profile = structuredClone(h.config.browser.profiles.handoff);
  h.deps.run = run;
  await runClawser(h.args, h.deps);
  assert.deepEqual(h.config.browser.profiles.handoff, profile);
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
  assert.equal(h.calls.filter(call => call.command === 'docker' && call.args.includes('build')).length, 1);
  assert.equal(h.calls.filter(call => call.command === 'openclaw' && call.args.includes('patch') && !call.args.includes('--dry-run')).length, 1);
  assert.deepEqual(Object.keys(h.config.browser.profiles), ['handoff']);
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
  assert.equal(h.calls.filter(call => call.command === 'docker' && call.args.includes('build')).length, 1);
  assert.equal(h.calls.filter(call => call.command === 'openclaw' && call.args.includes('patch') && !call.args.includes('--dry-run')).length, 1);
});

test('owned runtime ports and the persistent Docker profile survive repeated setup', async t => {
  const h = await harness(t);
  await runClawser(h.args, h.deps);
  const name = 'openclaw-handoff-desktop', ownerId = 'runtime-owner', network = `${name}-net`, volume = `${name}-profile`;
  const label = { 'openclaw.browser-handoff.desktop': ownerId };
  const ports = { '9223/tcp': [{ HostIp: '127.0.0.1', HostPort: '18812' }], '5900/tcp': [{ HostIp: '127.0.0.1', HostPort: '59092' }] };
  await fs.writeFile(join(h.stateDir, 'state/runtime/ownership.json'), JSON.stringify({ name, ownerId, containerId: 'owned-container', network, networkId: 'owned-network', volume, cdpPort: 18812, vncPort: 59092 }), { mode: 0o600 });
  h.resource(name, { Id: 'owned-container', Name: `/${name}`, State: { Running: true }, Config: { Labels: label }, HostConfig: { PortBindings: ports, NetworkMode: network }, NetworkSettings: { Ports: ports, Networks: { [network]: { NetworkID: 'owned-network' } } }, Mounts: [{ Type: 'volume', Name: volume, Destination: '/profile', RW: true }] });
  h.resource(network, { Id: 'owned-network', Labels: label });
  h.resource(volume, { Name: volume, Labels: label });
  h.busy([19410, 18812, 59092]);
  h.calls.length = 0;
  await runClawser(h.args, h.deps);
  assert.equal(h.calls.some(call => call.command === 'docker' && call.args.some(arg => ['stop', 'rm', 'create', 'start'].includes(arg))), false);
  assert.equal((await fs.lstat(join(h.stateDir, 'state/runtime/ownership.json'))).mode & 0o077, 0);
});

test('rereads allowlists after a long Docker build before merging configuration', async t => {
  const h = await harness(t, { tools: { alsoAllow: ['read'] }, plugins: { allow: ['existing'] } });
  const run = h.deps.run;
  h.deps.run = (command, args, options) => {
    if (command === 'docker' && args.includes('build')) { h.config.tools.alsoAllow.push('new-during-build'); h.config.plugins.allow.push('another-plugin'); }
    return run(command, args, options);
  };
  await runClawser(h.args, h.deps);
  assert.deepEqual(h.config.tools.alsoAllow, ['read', 'new-during-build', 'browser_handoff']);
  assert.deepEqual(h.config.plugins.allow, ['existing', 'another-plugin', 'browser-handoff']);
});

test('an old OpenClaw version fails before downloads or setup writes', async t => {
  const h = await harness(t);
  const run = h.deps.run;
  h.deps.run = (command, args, options) => command === 'openclaw' && args[0] === '--version' ? 'OpenClaw 2026.9.28' : run(command, args, options);
  await assert.rejects(runClawser(h.args, h.deps), /2026\.10\.4/);
  await assert.rejects(fs.lstat(h.stateDir), { code: 'ENOENT' });
  assert.equal(h.calls.some(c => c.command === 'fetch' || c.args.includes('patch')), false);
});

test('no-default-profile preserves the current default and state env selects default state path', async t => {
  const h = await harness(t, { browser: { defaultProfile: 'personal' } });
  h.deps.env.OPENCLAW_STATE_DIR = join(h.root, 'openclaw-state');
  const result = await runClawser(['setup', '--no-default-profile'], h.deps);
  assert.equal(result.stateDir, join(h.root, 'openclaw-state/clawser'));
  assert.equal(h.config.browser.defaultProfile, 'personal');
});

test('unsupported platforms, versions and invalid flags fail before mutation', async t => {
  const h = await harness(t);
  for (const args of [['--port', '19410junk'], ['--cdp-port', '19410'], ['--browser-profile', '../escape'], ['--profile', 'host-profile'], ['--unknown']]) {
    await assert.rejects(runClawser([...h.args, ...args], h.deps), /invalid|unknown|differ/i);
  }
  await assert.rejects(runClawser(h.args, { ...h.deps, arch: 'arm64' }), /x86_64/);
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
