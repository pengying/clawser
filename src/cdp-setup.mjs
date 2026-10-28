import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { resolveHandoffBrowser } from './browser-config.mjs';
import { activationSummary, captureSetupActivation, inspectSetupActivation, logSetupActivation, requireActiveActivation, waitForSetupActivation } from './setup-activation.mjs';

const identity = 'clawser-cdp-setup-v1';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function syncPath(path, d) {
  const file = await d.fs.open(path, 'r');
  try { await file.sync(); } finally { await file.close(); }
}

async function current(d, h) {
  const browser = await h.configSection('browser', d);
  const plugins = await h.configSection('plugins', d);
  const tools = await h.configSection('tools', d);
  if (plugins.entries !== undefined && !object(plugins.entries)) throw new Error('Conflicting plugins.entries configuration');
  const entry = plugins.entries?.['browser-handoff'];
  if (entry !== undefined && !object(entry)) throw new Error('Conflicting browser-handoff plugin entry');
  const plugin = entry?.config ?? {};
  if (!object(plugin)) throw new Error('Conflicting browser-handoff plugin configuration');
  return { browser, plugins, tools, plugin };
}

function binding(config, o, configured = false) {
  try {
    // Setup replaces share mappings with precisely the selected existing node.
    // Old mappings cannot expand the shareable set or block switching backends.
    return resolveHandoffBrowser({ config, pluginConfig: configured ? config.plugin : {}, profile: o.specified.includes('--browser-profile') ? o.profile : undefined });
  } catch (error) {
    throw new Error('Existing browser CDP connection is incompatible: ' + error.message + '. Configure an existing attachOnly Chromium CDP connection and keep that browser open, then retry; use --novnc for a dedicated desktop.');
  }
}

async function browserReady(connection, d) {
  try {
    const response = await d.fetch(connection.cdpUrl + '/json/version', { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const value = await response.json();
    const socket = new URL(value.webSocketDebuggerUrl);
    const origin = new URL(connection.cdpUrl);
    if (!/^(?:HeadlessChrome|Chrome|Chromium)\//.test(value.Browser) || socket.protocol !== 'ws:' ||
        !['localhost', '127.0.0.1', '[::1]'].includes(socket.hostname) || socket.port !== origin.port ||
        socket.username || socket.password || socket.search || socket.hash || !/^\/devtools\/browser\/[^/]+$/.test(socket.pathname)) throw new Error('Invalid Chromium browser endpoint');
  } catch {
    throw new Error('Existing browser CDP endpoint is unavailable or incompatible. Keep the configured browser open with its existing loopback CDP connection and retry; setup never launches a browser.');
  }
}

async function receipt(o, p, d, h) {
  await h.noSymlinks(o.stateDir, d);
  if (!await h.stat(o.stateDir, d)) return;
  await h.privatePath(o.stateDir, 'directory', d);
  if (!await h.stat(p.marker, d)) throw new Error('State path exists without CDP setup ownership');
  await h.privatePath(p.marker, 'file', d);
  const saved = await h.readJson(p.marker, d);
  if (saved.identity !== identity || saved.uid !== d.uid || !/^[a-f0-9-]{36}$/.test(saved.ownerId || '') || saved.stateDir !== o.stateDir || saved.packageDir !== d.packageDir) throw new Error('Refusing unowned or incompatible CDP setup receipt');
  return saved;
}

async function binary(p, saved, d, h, required = false) {
  const pending = saved?.binaryDigest === undefined && saved?.pendingBinaryDigest === d.artifacts.cloudflared.sha256;
  await h.noSymlinks(p.binary, d);
  if (await h.stat(dirname(p.binary), d)) await h.privatePath(dirname(p.binary), 'directory', d);
  if (!await h.stat(p.binary, d)) {
    if (saved?.binaryDigest || required) throw new Error('Owned pinned cloudflared binary is missing; restore it before retrying');
    return false;
  }
  const info = await h.privatePath(p.binary, 'file', d);
  if (!saved || (saved.binaryDigest !== d.artifacts.cloudflared.sha256 && !pending) || digest(await d.fs.readFile(p.binary)) !== d.artifacts.cloudflared.sha256) throw new Error('Existing cloudflared binary is unowned or changed; refusing to overwrite it');
  if (pending) {
    if (required) throw new Error('Pinned cloudflared installation is incomplete; rerun setup');
    return 'pending';
  }
  if (!(info.mode & 0o100)) throw new Error('Pinned cloudflared binary must be executable by its owner');
  return 'installed';
}

function patch(config, connection, port, p, o) {
  const { plugins, tools, plugin } = config;
  const list = (value, name) => { if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Conflicting ' + name + ' allowlist'); return value; };
  for (const [value, name] of [[plugins.allow, 'plugins.allow'], [plugins.deny, 'plugins.deny'], [tools.allow, 'tools.allow'], [tools.alsoAllow, 'tools.alsoAllow'], [tools.deny, 'tools.deny']]) if (value !== undefined) list(value, name);
  if (plugins.deny?.includes('browser-handoff') || tools.deny?.includes('browser_handoff')) throw new Error('Existing deny policy conflicts with Clawser; resolve it explicitly before setup');
  if (plugin.profiles !== undefined && !object(plugin.profiles)) throw new Error('Conflicting browser-handoff profiles configuration');
  for (const name of ['desktop', 'funnel', 'cloudflare']) if (plugin[name] !== undefined && !object(plugin[name])) throw new Error('Conflicting browser-handoff ' + name + ' configuration');
  // Native config patch treats null as a deletion. Delete only stale mapping
  // keys, preserving unrelated plugin settings and desktop receipt identity.
  const profiles = Object.fromEntries(Object.keys(plugin.profiles ?? {}).filter(name => name !== connection.profile).map(name => [name, null]));
  profiles[connection.profile] = connection.cdpUrl;
  const result = {
    plugins: { entries: { 'browser-handoff': { enabled: true, config: {
      desktop: { enabled: false }, funnel: { enabled: false }, profiles, port,
      cloudflare: { enabled: true, binaryPath: p.binary, startupTimeoutMs: 90_000 },
    } } } }, tools: {},
  };
  if (o.specified.includes('--browser-profile')) result.browser = { defaultProfile: connection.profile };
  if (plugins.allow !== undefined) result.plugins.allow = [...new Set([...plugins.allow, 'browser-handoff'])];
  const toolKey = tools.allow?.length ? 'allow' : 'alsoAllow';
  result.tools[toolKey] = [...new Set([...(tools[toolKey] ?? []), 'browser_handoff'])];
  return result;
}

function configured(config, connection, port, p) {
  const { plugins, tools, plugin } = config;
  if (plugins.entries?.['browser-handoff']?.enabled !== true || plugin.desktop?.enabled === true || plugin.funnel?.enabled === true ||
      plugin.cloudflare?.enabled !== true || plugin.cloudflare.binaryPath !== p.binary || plugin.port !== port ||
      config.browser.defaultProfile !== connection.profile || Object.keys(plugin.profiles ?? {}).length !== 1 || plugin.profiles[connection.profile] !== connection.cdpUrl ||
      (plugins.allow !== undefined && !plugins.allow.includes('browser-handoff')) ||
      !(tools.allow?.length ? tools.allow : tools.alsoAllow)?.includes('browser_handoff')) throw new Error('CDP plugin configuration is incomplete or differs from the current default browser; rerun setup');
}

async function viewerReady(origin, d) {
  const response = await d.fetch(origin + '/assets/style.css', { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok || !/^text\/css(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('Authenticated viewer service is unavailable; inspect browser-handoff plugin status and reload it');
}

async function publicReady(port, d, h) {
  const path = join(d.env.OPENCLAW_STATE_DIR || join(d.homeDir, '.openclaw'), 'browser-handoff/cloudflare/transport.json');
  await h.noSymlinks(path, d);
  await h.privatePath(path, 'file', d);
  const transport = await h.readJson(path, d);
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(transport.origin) || transport.port !== port || !Number.isInteger(transport.pid) || transport.pid < 1) throw new Error('Cloudflare transport receipt is incomplete or does not match the configured viewer');
  await viewerReady(transport.origin, d);
}

async function viewerPort(config, port, p, o, saved, installed, d) {
  if (await d.isPortFree(port)) return;
  try {
    if (!saved || installed !== 'installed') throw new Error('No completed owned CDP setup');
    const active = binding(config, { ...o, specified: [] }, true);
    configured(config, active, port, p);
    await viewerReady('http://127.0.0.1:' + port, d);
  } catch {
    throw new Error('Viewer port ' + port + ' is in use by an unowned or unready service; stop that listener or select a free --port before setup');
  }
}

/** Attach-only operator setup. This module never launches or provisions Chrome. */
export async function runCdpSetup(o, d, h) {
  const p = { marker: join(o.stateDir, 'setup.json'), binary: join(o.stateDir, 'bin/cloudflared') };
  const checks = await h.prerequisites(d, false);
  const check = async (name, work) => {
    try { return await work(); }
    catch (error) { checks.push({ name, ok: false, message: error.message, ...(error.pending ? { pending: true } : {}) }); return undefined; }
    finally { if (!checks.some(row => row.name === name)) checks.push({ name, ok: true }); }
  };
  if (o.command === 'doctor') {
    let connection, activation;
    const config = await check('configuration', () => current(d, h));
    const saved = await check('ownership', async () => { const value = await receipt(o, p, d, h); if (!value) throw new Error('No managed CDP setup receipt; run clawser setup'); return value; });
    if (config) {
      connection = await check('browser connection', async () => binding(config, o));
      const port = o.specified.includes('--port') ? o.port : config.plugin.port ?? 18796;
      if (connection) {
        await check('CDP endpoint', () => browserReady(connection, d));
        await check('plugin configuration', async () => { patch(config, connection, port, p, o); configured(config, connection, port, p); });
        await check('Gateway activation', async () => { activation = await inspectSetupActivation(config, d); requireActiveActivation(activation); });
        await check('viewer service', () => viewerReady('http://127.0.0.1:' + port, d));
        if (activation?.publicTransport === 'warming') checks.push({ name: 'public transport', ok: false, pending: true, message: 'Cloudflare transport is warming; public readiness continues in the background' });
        else if (activation?.publicTransport === 'failed') checks.push({ name: 'public transport', ok: false, message: 'Cloudflare transport failed; inspect browser-handoff service health' });
        else await check('public transport', () => publicReady(port, d, h));
      }
    }
    if (saved) await check('pinned cloudflared', () => binary(p, saved, d, h, true));
    if (connection) d.log('Browser connection: ' + connection.profile + '\nCDP: ' + connection.cdpUrl);
    logSetupActivation(activation, d);
    for (const row of checks) d.log((row.ok ? 'OK ' : 'FAIL ') + row.name + (row.message ? ': ' + row.message : ''));
    return { ok: checks.every(row => row.ok), pending: checks.some(row => row.pending), command: o.command, backend: 'cdp', checks, stateDir: o.stateDir, activation: activationSummary(activation), ...(connection ? { profile: connection.profile, cdpUrl: connection.cdpUrl } : {}) };
  }
  const failed = checks.filter(row => !row.ok);
  if (failed.length) throw new Error(failed.map(row => row.name + ': ' + row.message).join('\n'));
  let config = await current(d, h);
  const connection = binding(config, o);
  await browserReady(connection, d);
  let saved = await receipt(o, p, d, h);
  const installed = await binary(p, saved, d, h);
  const port = o.specified.includes('--port') ? o.port : config.plugin.port ?? 18796;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid configured viewer port');
  const proposed = patch(config, connection, port, p, o);
  await viewerPort(config, port, p, o, saved, installed, d);
  if (o.dryRun) {
    d.log('Dry run: reuse existing browser connection ' + connection.profile + ', verify pinned cloudflared, configure its authenticated CDP viewer and reload browser-handoff.\nState: ' + o.stateDir + '\nNo files, downloads, services, or configuration were changed.');
    return { ok: true, command: o.command, backend: 'cdp', dryRun: true, stateDir: o.stateDir, patch: proposed };
  }
  await d.run('openclaw', ['config', 'patch', '--stdin', '--dry-run'], { input: JSON.stringify(proposed) + '\n' });
  // Download and verify before claiming a new installation directory.
  const contents = installed ? undefined : await h.download(d.artifacts.cloudflared, d);
  if (!saved) {
    await d.fs.mkdir(dirname(o.stateDir), { recursive: true, mode: 0o700 });
    await h.noSymlinks(o.stateDir, d);
    await d.fs.mkdir(o.stateDir, { mode: 0o700 });
    await h.privatePath(o.stateDir, 'directory', d);
    saved = { identity, uid: d.uid, ownerId: randomUUID(), stateDir: o.stateDir, packageDir: d.packageDir, pendingBinaryDigest: d.artifacts.cloudflared.sha256 };
    const file = await d.fs.open(p.marker, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(saved) + '\n'); await file.sync(); }
    finally { await file.close(); }
  }
  const lock = join(o.stateDir, 'setup.lock');
  try { await d.fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('CDP setup is already locked; inspect the current setup process'); throw error; }
  let activation;
  try {
    // Re-read under the installation lock. Publication may have completed
    // between preflight and admission of a concurrent setup invocation.
    saved = await receipt(o, p, d, h);
    const binaryState = await binary(p, saved, d, h);
    if (binaryState !== 'installed') {
      // Persist the intended checksum before the binary can appear. A retry
      // may repair only this owned, pinned pending installation, never adopt
      // an unexplained file left beside a receipt without installation intent.
      if (saved.pendingBinaryDigest !== d.artifacts.cloudflared.sha256) {
        saved.pendingBinaryDigest = d.artifacts.cloudflared.sha256;
        await h.atomicPrivate(p.marker, JSON.stringify(saved) + '\n', d);
      }
      await d.fs.mkdir(dirname(p.binary), { recursive: true, mode: 0o700 });
      await h.privatePath(dirname(p.binary), 'directory', d);
      await syncPath(o.stateDir, d);
      if (!binaryState) await h.atomicPrivate(p.binary, contents, d);
      await d.fs.chmod(p.binary, 0o700);
      await syncPath(p.binary, d);
      await syncPath(dirname(p.binary), d);
      saved.binaryDigest = d.artifacts.cloudflared.sha256;
      delete saved.pendingBinaryDigest;
      await h.atomicPrivate(p.marker, JSON.stringify(saved) + '\n', d);
      await syncPath(o.stateDir, d);
    }
    config = await current(d, h);
    const latest = binding(config, o);
    if (latest.profile !== connection.profile || latest.cdpUrl !== connection.cdpUrl) throw new Error('Current browser connection changed during setup; rerun setup');
    const finalPatch = patch(config, latest, port, p, o);
    await viewerPort(config, port, p, o, saved, 'installed', d);
    const expectedActivation = await captureSetupActivation(config, finalPatch, d);
    await d.run('openclaw', ['config', 'patch', '--stdin'], { input: JSON.stringify(finalPatch) + '\n' });
    await h.reloadPlugin(d);
    activation = await waitForSetupActivation(expectedActivation, d, () => viewerReady('http://127.0.0.1:' + port, d));
  } finally { await d.fs.rm(lock, { recursive: true }); }
  d.log('Clawser is configured for existing browser connection ' + connection.profile + '.\nState: ' + o.stateDir + '\nRun browser_handoff action=tabs from the owner session to verify the active connection.');
  logSetupActivation(activation, d);
  return { ok: true, command: o.command, backend: 'cdp', dryRun: false, stateDir: o.stateDir, activation: activationSummary(activation) };
}
