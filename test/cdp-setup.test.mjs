import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClawser, ARTIFACTS } from '../src/setup.mjs';

function merge(base, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key];
    else if (value && typeof value === 'object' && !Array.isArray(value)) merge(base[key] ??= {}, value);
    else base[key] = structuredClone(value);
  }
}
async function harness(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'clawser-cdp-setup-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const config = { browser: { defaultProfile: 'personal', profiles: { personal: { cdpUrl: 'http://127.0.0.1:9333', attachOnly: true, driver: 'openclaw', engine: 'chromium' } } } };
  const calls = [], logs = [], binary = Buffer.from('cloudflared fixture');
  let serviceReady = false;
  const deps = {
    fs, homeDir: root, env: { OPENCLAW_STATE_DIR: join(root, 'openclaw') }, packageDir: root,
    platform: 'linux', arch: 'x64', nodeVersion: '24.18.0', log: value => logs.push(value),
    artifacts: { ...ARTIFACTS, cloudflared: { ...ARTIFACTS.cloudflared, sha256: createHash('sha256').update(binary).digest('hex') } },
    isPortFree: async () => true,
    fetch: async (url, options) => {
      calls.push({ command: 'fetch', args: [url], options });
      if (url === ARTIFACTS.cloudflared.url) return new Response(binary);
      if (url === 'http://127.0.0.1:9333/json/version') return Response.json({ Browser: 'Chrome/149', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/test' });
      if (serviceReady && (url === 'http://127.0.0.1:18796/assets/style.css' || url === 'https://fixture.trycloudflare.com/assets/style.css')) return new Response('body {}', { headers: { 'content-type': 'text/css' } });
      throw new Error('Unexpected network request: ' + url);
    },
    run: async (command, args, options = {}) => {
      calls.push({ command, args, ...options });
      assert.equal(command, 'openclaw', 'CDP must never invoke desktop prerequisites or launch a browser');
      if (args[0] === '--version') return 'OpenClaw 2026.10.4';
      if (args[0] === 'config' && args[1] === 'get') return JSON.stringify(config[args[2]] ?? {});
      if (args[0] === 'config' && args[1] === 'patch') { if (!args.includes('--dry-run')) merge(config, JSON.parse(options.input)); return ''; }
      if (args[0] === 'plugins' && args[1] === 'reload') {
        serviceReady = true;
        const directory = join(root, 'openclaw/browser-handoff/cloudflare');
        await fs.mkdir(directory, { mode: 0o700, recursive: true });
        await fs.writeFile(join(directory, 'transport.json'), JSON.stringify({ origin: 'https://fixture.trycloudflare.com', port: 18796, pid: 9999 }), { mode: 0o600 });
        return '';
      }
      throw new Error('Unexpected CLI request');
    },
  };
  return { root, config, calls, logs, deps, stateDir: join(root, 'openclaw/clawser-cdp') };
}

test('default setup reuses existing normal Chrome without desktop prerequisites or browser changes', async t => {
  const h = await harness(t), browser = structuredClone(h.config.browser);
  h.config.plugins = { entries: { 'browser-handoff': { config: { ownerGroupSessions: ['approved'], profiles: { stale: 'http://127.0.0.1:9999' }, desktop: { enabled: true, profile: 'handoff', socketPath: '/owned/desktop.sock' }, funnel: { enabled: true } } } } };
  h.config.tools = { alsoAllow: ['read'] };
  const result = await runClawser(['setup'], h.deps);
  assert.equal(result.backend, 'cdp');
  assert.equal(result.stateDir, h.stateDir);
  assert.deepEqual(h.config.browser, browser);
  const plugin = h.config.plugins.entries['browser-handoff'].config;
  assert.deepEqual(plugin.profiles, { personal: 'http://127.0.0.1:9333' });
  assert.equal(plugin.desktop.enabled, false);
  assert.equal(plugin.desktop.socketPath, '/owned/desktop.sock');
  assert.deepEqual(plugin.ownerGroupSessions, ['approved']);
  assert.equal(plugin.funnel.enabled, false);
  assert.equal(plugin.cloudflare.enabled, true);
  assert.equal(plugin.cloudflare.binaryPath, join(h.stateDir, 'bin/cloudflared'));
  assert.deepEqual(h.config.tools.alsoAllow, ['read', 'browser_handoff']);
  assert.deepEqual((await fs.readdir(h.stateDir)).sort(), ['bin', 'setup.json']);
  h.calls.length = 0;
  assert.equal((await runClawser(['setup'], h.deps)).ok, true);
  assert.equal(h.calls.filter(call => call.command === 'fetch' && call.args[0] === ARTIFACTS.cloudflared.url).length, 0);
});

test('CDP dry-run validates connection and plans without creating state or changing configuration', async t => {
  const h = await harness(t), before = structuredClone(h.config);
  const result = await runClawser(['setup', '--dry-run'], h.deps);
  assert.equal(result.backend, 'cdp');
  assert.deepEqual(h.config, before);
  await assert.rejects(fs.stat(h.stateDir), { code: 'ENOENT' });
  assert.equal(h.calls.some(call => call.args.includes('patch')), false);
});

test('missing, closed and incompatible default connections fail without launch, fallback or writes', async t => {
  for (const mutation of [h => { delete h.config.browser.defaultProfile; }, h => { h.config.browser.profiles.personal.attachOnly = false; }, h => { h.config.browser.profiles.personal.driver = 'extension'; }, h => { h.deps.fetch = async () => { throw new Error('ECONNREFUSED'); }; }]) {
    const h = await harness(t); mutation(h);
    await assert.rejects(runClawser(['setup'], h.deps), /browser|CDP|attachOnly|connection/i);
    await assert.rejects(fs.stat(h.stateDir), { code: 'ENOENT' });
    assert.equal(h.calls.some(call => call.args.includes('patch')), false);
  }
});

test('explicit existing profile changes only connection default and rejects absent profiles', async t => {
  const h = await harness(t);
  h.config.browser.profiles.other = structuredClone(h.config.browser.profiles.personal);
  await runClawser(['setup', '--browser-profile', 'other'], h.deps);
  assert.equal(h.config.browser.defaultProfile, 'other');
  assert.deepEqual(Object.keys(h.config.browser.profiles), ['personal', 'other']);
  await assert.rejects(runClawser(['setup', '--browser-profile', 'absent'], h.deps), /existing browser profile/);
});

test('CDP rejects desktop flags and unowned state paths before making changes', async t => {
  const h = await harness(t);
  for (const args of [['--cdp-port', '9222'], ['--vnc-port', '5901'], ['--container-name', 'desktop'], ['--no-default-profile']]) await assert.rejects(runClawser(['setup', ...args], h.deps), /--novnc/);
  await fs.mkdir(h.stateDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(join(h.stateDir, 'setup.json'), JSON.stringify({ identity: 'clawser-setup-v1' }), { mode: 0o600 });
  await assert.rejects(runClawser(['setup'], h.deps), /unowned|ownership|receipt/);
  assert.equal(h.calls.some(call => call.args.includes('patch')), false);
});

test('CDP doctor is read only and checks actual mapping and endpoint without Docker or state creation', async t => {
  const h = await harness(t);
  let result = await runClawser(['doctor'], h.deps);
  assert.equal(result.backend, 'cdp');
  assert.equal(result.ok, false);
  await assert.rejects(fs.stat(h.stateDir), { code: 'ENOENT' });
  await runClawser(['setup'], h.deps);
  h.calls.length = 0;
  result = await runClawser(['doctor'], h.deps);
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.ok(result.checks.some(row => row.name === 'viewer service' && row.ok));
  assert.ok(result.checks.some(row => row.name === 'public transport' && row.ok));
  assert.equal(h.calls.some(call => call.args.includes('patch') || call.args.includes('reload')), false);
  h.config.browser.profiles.personal.cdpUrl = 'http://127.0.0.1:9444';
  result = await runClawser(['doctor'], h.deps);
  assert.equal(result.ok, false);
});

test('CDP doctor detects stopped viewer and invalid public transport without creating state', async t => {
  const h = await harness(t);
  await runClawser(['setup'], h.deps);
  const fetch = h.deps.fetch;
  h.deps.fetch = (url, options) => url.includes('/assets/') ? Promise.reject(new Error('ECONNREFUSED')) : fetch(url, options);
  const result = await runClawser(['doctor'], h.deps);
  assert.equal(result.ok, false);
  assert.ok(result.checks.some(row => row.name === 'viewer service' && !row.ok));
  assert.ok(result.checks.some(row => row.name === 'public transport' && !row.ok));
});

test('CDP policy arrays and download failures preserve existing config and fail before install', async t => {
  for (const mutate of [h => { h.config.tools = { allow: 'bad' }; }, h => { h.config.tools = { deny: ['browser_handoff'] }; }, h => { h.config.plugins = { allow: [7] }; }, h => { const fetch = h.deps.fetch; h.deps.fetch = (url, options) => url === ARTIFACTS.cloudflared.url ? new Response('corrupt') : fetch(url, options); }]) {
    const h = await harness(t); mutate(h);
    const before = structuredClone(h.config);
    await assert.rejects(runClawser(['setup'], h.deps), /allowlist|policy|checksum/);
    assert.deepEqual(h.config, before);
    await assert.rejects(fs.stat(h.stateDir), { code: 'ENOENT' });
  }
});

test('CDP uses trusted current host invocation for reads, patch and reload', async t => {
  const h = await harness(t), run = h.deps.run;
  h.deps.openclawInvocation = { command: '/trusted/node', prefixArgs: ['/trusted/openclaw.mjs'] };
  h.deps.run = (command, args, options) => {
    assert.equal(command, '/trusted/node');
    assert.equal(args[0], '/trusted/openclaw.mjs');
    return run('openclaw', args.slice(1), options);
  };
  assert.equal((await runClawser(['setup'], h.deps)).ok, true);
  assert.equal(h.calls.filter(call => call.args.includes('patch')).length, 2);
});

test('CDP refuses a changed or non-executable pinned binary without replacing it', async t => {
  const h = await harness(t);
  await runClawser(['setup'], h.deps);
  const path = join(h.stateDir, 'bin/cloudflared');
  await fs.chmod(path, 0o600);
  await assert.rejects(runClawser(['setup'], h.deps), /executable/);
  await fs.chmod(path, 0o700);
  await fs.writeFile(path, 'changed');
  await assert.rejects(runClawser(['setup'], h.deps), /changed/);
  assert.equal(await fs.readFile(path, 'utf8'), 'changed');
});

test('CDP viewer port validation does not reserve unused desktop default ports', async t => {
  const h = await harness(t);
  const result = await runClawser(['setup', '--dry-run', '--port', '18812'], h.deps);
  assert.equal(result.patch.plugins.entries['browser-handoff'].config.port, 18812);
});
