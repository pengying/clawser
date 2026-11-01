import * as filesystem from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopRpcClient } from './desktop-rpc.mjs';
import { verifyHostDeps } from './host-deps.mjs';
import { applyHost, assertHealth, describeHost, hostConfigPatch, hostLocations, planHost, readHostReceipt } from './host-setup.mjs';
import { activationSummary, inspectSetupActivation, logSetupActivation, requireActiveActivation } from './setup-activation.mjs';
import { resolveHandoffBrowser } from './browser-config.mjs';

export const ARTIFACTS = Object.freeze({
  cloudflared: Object.freeze({
    url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-linux-amd64',
    sha256: 'ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42',
    maxBytes: 100_000_000,
  }),
  noVnc: Object.freeze({
    url: 'https://codeload.github.com/novnc/noVNC/tar.gz/refs/tags/v1.7.0',
    sha256: 'b1003a11b6e6e8d8f7f5e5586daae7f8ca651d8aee0aa155ff9ac841c48f52c6',
    maxBytes: 10_000_000,
  }),
});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const stateRoot = d => d.env.OPENCLAW_STATE_DIR || join(d.homeDir, '.openclaw');
const REMOVED_FLAGS = ['--cdp-port', '--vnc-port', '--container-name', '--no-default-profile'];

function execute(command, args, { input = '', timeoutMs = 30_000, combined = false } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', overflow = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', bytes => {
      stdout += bytes;
      if (stdout.length > 4_000_000) { overflow = true; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16_000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !overflow) accept((combined ? stdout + '\n' + stderr : stdout).trim());
      else {
        const error = new Error(`${command}` + ' failed (' + (signal || code) + '): ' + stderr.slice(-1000));
        Object.assign(error, { code, stdout, stderr }); reject(error);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function portFree(port) {
  return new Promise((accept, reject) => {
    const server = net.createServer();
    server.once('error', error => error.code === 'EADDRINUSE' ? accept(false) : reject(error));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => accept(true)));
  });
}

async function controllerHealth(socketPath) {
  const directory = await filesystem.lstat(dirname(socketPath));
  const socket = await filesystem.lstat(socketPath);
  if (!directory.isDirectory() || !socket.isSocket() || directory.uid !== process.getuid() || socket.uid !== process.getuid() || ((directory.mode | socket.mode) & 0o077)) throw new Error('Controller socket and directory must be owned and private');
  const client = new DesktopRpcClient(socketPath);
  try { return await client.request('health', {}, { timeoutMs: 5000 }); }
  finally { client.close(); }
}

function options(argv, d) {
  const command = argv[0] ?? 'help';
  if (['help', '--help', '-h'].includes(command)) return { command: 'help' };
  if (!['setup', 'doctor'].includes(command)) throw new Error('Unknown Clawser command: ' + `${command}`);
  const result = { command, stateDir: undefined, profile: undefined, port: undefined, dryRun: false, yes: false, cdp: false, migrateCookies: true };
  const values = { '--state-dir': 'stateDir', '--browser-profile': 'profile', '--port': 'port' };
  const switches = { '--dry-run': ['dryRun', true], '--yes': ['yes', true], '--cdp': ['cdp', true], '--novnc': [], '--no-migrate-cookies': ['migrateCookies', false] };
  const seen = new Set();
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { command: 'help' };
    if (REMOVED_FLAGS.includes(flag)) throw new Error(''.concat(flag) + ' was removed in 0.7.0 along with the Docker desktop');
    if (seen.has(flag)) throw new Error('Invalid repeated flag: ' + ''.concat(flag));
    seen.add(flag);
    if (Object.hasOwn(switches, flag)) { const [key, value] = switches[flag]; if (key) result[key] = value; continue; }
    if (!Object.hasOwn(values, flag)) throw new Error('Unknown Clawser flag: ' + ''.concat(flag));
    const value = argv[++i];
    if (!value || value.startsWith('--') || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid value for ' + ''.concat(flag));
    const key = values[flag];
    if (key === 'port') {
      if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error('Invalid port for ' + ''.concat(flag));
      result.port = Number(value);
    } else result[key] = value;
  }
  if (seen.has('--novnc') && result.cdp) throw new Error('--novnc and --cdp cannot be used together');
  result.stateDir ??= join(stateRoot(d), result.cdp ? 'clawser-cdp' : 'clawser');
  result.profile ??= result.cdp ? 'handoff' : 'clawser';
  result.port ??= result.cdp ? 19410 : 19420;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(result.profile)) throw new Error('Invalid browser profile name');
  result.specified = [...seen];
  result.stateDir = resolve(result.stateDir);
  if (result.stateDir === parse(result.stateDir).root || result.stateDir === resolve(d.homeDir)) throw new Error('Invalid state directory');
  return result;
}

async function stat(path, d) {
  try { return await d.fs.lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function noSymlinks(path, d) {
  let current = parse(resolve(path)).root;
  for (const part of resolve(path).slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    const info = await stat(current, d);
    if (!info) break;
    if (info.isSymbolicLink()) throw new Error('Refusing symlink path: ' + ''.concat(current));
  }
}

async function privatePath(path, kind, d) {
  const info = await stat(path, d);
  if (!info || !(kind === 'directory' ? info.isDirectory() : info.isFile()) || info.uid !== d.uid || (info.mode & 0o077)) throw new Error('Refusing unowned or non-private ' + ''.concat(kind) + ': ' + ''.concat(path));
  return info;
}

async function readJson(path, d) { return JSON.parse(await d.fs.readFile(path, 'utf8')); }

async function prerequisites(d, desktop = true) {
  const checks = [];
  const check = async (name, work) => {
    try { await work(); checks.push({ name, ok: true }); }
    catch (error) { checks.push({ name, ok: false, message: error.message }); }
  };
  await check('platform', async () => { if (d.platform !== 'linux' || d.arch !== 'x64') throw new Error('Clawser setup requires Linux x86_64' + (desktop ? ' with systemd user services' : ' for the pinned cloudflared binary')); });
  await check('node', async () => {
    const version = String(d.nodeVersion).match(/^v?(\d+)\.(\d+)\.(\d+)$/);
    const major = Number(version?.[1]), minor = Number(version?.[2]);
    if (!version || !((major === 24 && minor >= 16) || (major === 26 && minor >= 1) || major > 26)) throw new Error('Clawser requires Node 24.16+ on the 24.x line, or Node 26.1+ (including later majors); Node 25 is unsupported');
  });
  if (desktop) await check('source paths', async () => {
    for (const relative of ['index.mjs', 'bin/desktop-controller.mjs', 'runtime/desktop/supervisor.py', 'runtime/desktop/openbox_config.py', 'runtime/desktop/xproof.py', 'runtime/desktop/clipboard.py']) {
      const path = join(d.packageDir, relative);
      await noSymlinks(path, d);
      if (!(await stat(path, d))?.isFile()) throw new Error('Installed package is missing ' + ''.concat(relative));
    }
  });
  // Unsupported hosts should not run any external commands.
  if (checks.some(row => !row.ok)) return checks;
  if (desktop) {
    await check('tar', () => d.run('tar', ['--version']));
    await check('flock', () => d.run('/usr/bin/flock', ['--version']));
    await check('systemd user', () => d.run('systemctl', ['--user', 'show-environment']));
  }
  await check('openclaw', async () => {
    const version = (await d.run('openclaw', ['--version'])).match(/\b(\d{4})\.(\d+)\.(\d+)\b/);
    if (!version || Number(version[1]) < 2026 || (Number(version[1]) === 2026 && (Number(version[2]) < 10 || (Number(version[2]) === 10 && Number(version[3]) < 4)))) throw new Error('Clawser setup requires OpenClaw 2026.10.4 or newer');
  });
  return checks;
}

async function configSection(name, d) {
  let output;
  try { output = await d.run('openclaw', ['config', 'get', name, '--json']); }
  catch (error) {
    let envelope;
    try { envelope = JSON.parse(error.stdout); } catch {}
    const unset = 'Config path is valid but unset: ' + ''.concat(name) + '. The runtime default applies until you set an authored value with openclaw config set ' + ''.concat(name) + ' <value>.';
    if (error.code === 1 && typeof error.stderr === 'string' && !error.stderr.trim() && envelope?.ok === false && envelope.error?.type === 'cli_error' && envelope.error.message === unset) return {};
    // Unknown paths, malformed config and permission failures must never be
    // mistaken for empty sections. Do not echo arbitrary JSON error payloads:
    // validation messages can quote sensitive configuration values.
    throw error;
  }
  if (!output.trim()) return {};
  const value = JSON.parse(output);
  if (!object(value)) throw new Error('Conflicting non-object OpenClaw ' + ''.concat(name) + ' configuration');
  return value;
}

async function atomicPrivate(path, contents, d) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await d.fs.open(temporary, 'wx', 0o600);
  try { await file.writeFile(contents); await file.sync(); }
  finally { await file.close(); }
  await d.fs.rename(temporary, path);
}

async function saveMarker(saved, p, d) { await atomicPrivate(p.marker, JSON.stringify(saved, null, 2) + '\n', d); }

async function download(artifact, d) {
  const response = await d.fetch(artifact.url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error('Pinned download failed: HTTP ' + ''.concat(response.status));
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      bytes += result.value.length;
      if (bytes > artifact.maxBytes) throw new Error('Pinned download exceeds expected size limit');
      chunks.push(Buffer.from(result.value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  const contents = Buffer.concat(chunks);
  if (sha256(contents) !== artifact.sha256) throw new Error('Pinned download checksum verification failed; no downloaded code was executed');
  return contents;
}

async function treeDigest(path, d) {
  await privatePath(path, 'directory', d);
  const hash = createHash('sha256');
  const walk = async (directory, relative = '') => {
    for (const name of (await d.fs.readdir(directory)).sort()) {
      const file = join(directory, name), next = relative ? ''.concat(relative) + '/' + ''.concat(name) : name;
      const info = await d.fs.lstat(file);
      if (info.isDirectory()) await walk(file, next);
      else if (info.isFile()) { hash.update(next + '\0' + info.size + '\0'); hash.update(await d.fs.readFile(file)); }
      else throw new Error('Refusing unexpected file type in pinned noVNC assets: ' + ''.concat(next));
    }
  };
  await walk(path); return hash.digest('hex');
}

async function assets(p, saved, d) {
  if (await stat(p.binary, d)) {
    await privatePath(p.binary, 'file', d);
    if (sha256(await d.fs.readFile(p.binary)) !== d.artifacts.cloudflared.sha256) throw new Error('Installed cloudflared checksum changed; refusing to overwrite it');
  } else {
    const contents = await download(d.artifacts.cloudflared, d);
    await atomicPrivate(p.binary, contents, d);
    await d.fs.chmod(p.binary, 0o700);
  }
  if (await stat(p.assets, d)) {
    if (!saved.assetsDigest || await treeDigest(p.assets, d) !== saved.assetsDigest) throw new Error('Existing noVNC assets are unowned or changed; refusing to overwrite them');
  } else {
    const contents = await download(d.artifacts.noVnc, d);
    const archive = join(dirname(p.assets), 'novnc-' + randomUUID() + '.tar.gz');
    const staging = join(dirname(p.assets), 'novnc-' + randomUUID() + '.tmp');
    await atomicPrivate(archive, contents, d);
    await d.fs.mkdir(staging, { mode: 0o700 });
    try {
      const entries = (await d.run('tar', ['-tzf', archive])).split('\n').filter(Boolean);
      if (!entries.length || entries.some(name => !name.startsWith('noVNC-1.7.0/') || name.split('/').includes('..') || name.includes('\\'))) throw new Error('Pinned noVNC archive has unsafe paths');
      await d.run('tar', ['--no-same-owner', '--no-same-permissions', '--strip-components=1', '-xzf', archive, '-C', staging]);
      if (!(await stat(join(staging, 'core/rfb.js'), d))?.isFile()) throw new Error('Pinned noVNC archive is missing core/rfb.js');
      const checksum = await treeDigest(staging, d);
      await d.fs.rename(staging, p.assets);
      saved.assetsDigest = checksum;
      await saveMarker(saved, p, d);
    } finally {
      await d.fs.rm(archive, { force: true });
      await d.fs.rm(staging, { force: true, recursive: true });
    }
  }
}

async function reloadPlugin(d) {
  const deadline = d.now() + 180_000;
  let announced = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    const remaining = deadline - d.now();
    if (remaining <= 0) break;
    try {
      await d.run('openclaw', ['plugins', 'reload', 'browser-handoff', '--wait'], { timeoutMs: Math.min(180_000, remaining) });
      return;
    } catch (error) {
      const stderr = typeof error.stderr === 'string' ? error.stderr : '';
      const transient = /Couldn't connect to OpenClaw\.|\bGateway (?:is )?restarting\b|\bGateway restart (?:is )?in progress\b/i.test(stderr);
      const unsafe = /permission|EACCES|EPERM|capabilit|schema|invalid config|unauthoriz|forbidden|authentication|ETIMEDOUT|timeout|timed out|uncertain|unknown outcome|outcome (?:is )?unknown/i.test(''.concat(error.message) + '\n' + stderr);
      // Retry only failures known to precede a reload admission. A killed or
      // timed-out command may have applied a reload and is never retried here.
      if (error.code !== 1 || !transient || unsafe) throw error;
      const waitBudget = deadline - d.now();
      if (attempt === 89 || waitBudget <= 0) break;
      if (!announced) {
        d.log('Waiting for OpenClaw to finish restarting before reloading browser-handoff…');
        announced = true;
      }
      await d.sleep(Math.min(attempt === 0 ? 1000 : 2000, waitBudget));
    }
  }
  throw new Error('OpenClaw is still unavailable for plugin reload. Configuration is saved; rerun setup after the Gateway is ready.');
}

export const setupHelpers = { stat, noSymlinks, privatePath, readJson, atomicPrivate, download, treeDigest, assets, configSection, reloadPlugin };

const statusLine = row => (row.warning ? 'WARN' : row.ok ? 'OK' : 'FAIL') + ' ' + row.name + (row.message ? ': ' + row.message : '');

/** Read-only: it never writes, starts, stops, enables, downloads or patches. */
async function hostDoctor(o, d, checks) {
  const h = setupHelpers, p = hostLocations(o, d);
  let receipt, activation;
  const check = async (name, work) => {
    try { await work(); checks.push({ name, ok: true }); }
    catch (error) { checks.push({ name, ok: false, message: error.message, ...(error.pending ? { pending: true } : {}) }); }
  };
  await check('installation', async () => {
    receipt = await readHostReceipt(o, p, d, h);
    if (receipt.kind === 'v1') throw new Error('This is a Docker desktop install from an older Clawser; rerun openclaw clawser setup');
    if (receipt.kind === 'none') throw new Error('No owned Clawser setup found; run openclaw clawser setup');
  });
  const saved = receipt?.kind === 'v2' ? receipt.saved : undefined;
  if (saved) {
    await check('configuration', () => hostConfigPatch(o, p, saved, d, h, { requireConfigured: true, convertingFrom: saved.convertedFrom, profile: saved.profile, option: saved.option }));
    await check('pinned assets', async () => {
      await privatePath(p.binary, 'file', d);
      if (sha256(await d.fs.readFile(p.binary)) !== d.artifacts.cloudflared.sha256) throw new Error('Installed cloudflared checksum changed');
      if (!saved.assetsDigest || await treeDigest(p.assets, d) !== saved.assetsDigest) throw new Error('Installed noVNC assets checksum changed');
    });
    let warnings = [];
    await check('host dependencies', async () => { warnings = await (d.hostResolver?.verify ?? verifyHostDeps)(saved.hostDeps, d, { stat, noSymlinks }); });
    checks.push(...warnings.map(message => ({ name: 'window manager', ok: true, warning: true, message })));
    await check('controller health', async () => assertHealth(await d.controllerHealth(p.socket), saved.cdpPort, saved.profile));
    await check('Gateway activation', async () => {
      activation = await inspectSetupActivation({ browser: await configSection('browser', d), plugins: await configSection('plugins', d) }, d);
      if (activation.backend !== 'novnc') throw new Error('Gateway activation does not match the requested noVNC backend');
      requireActiveActivation(activation);
    });
  }
  const units = saved && Object.values(p.names).filter(name => saved.units?.[name]);
  logSetupActivation(activation, d);
  for (const row of checks) d.log(statusLine(row));
  for (const line of [...(units ?? []).map(name => 'Unit: ' + name), 'State: ' + o.stateDir, ...saved ? ['Display: :' + saved.display] : []]) d.log(line);
  return { ok: checks.every(row => row.ok), pending: checks.some(row => row.pending), command: 'doctor', backend: 'novnc', activation: activationSummary(activation), checks, stateDir: o.stateDir, ...saved ? { units, display: saved.display } : {} };
}

// An unmarked CDP install predates the noVNC default. Plain setup takes over its browser.
// An enabled Docker-era desktop outranks it: the active backend decides, and Docker converts.
async function unmarkedCdpReceipt(d) {
  const marker = join(stateRoot(d), 'clawser-cdp', 'setup.json');
  await noSymlinks(marker, d);
  if (!await stat(marker, d)) return undefined;
  await privatePath(marker, 'file', d);
  const saved = await readJson(marker, d);
  return saved?.identity === 'clawser-cdp-setup-v1' && saved.explicitCdp !== true ? saved : undefined;
}

async function selectHostOption(o, d) {
  if (o.specified.includes('--browser-profile')) { o.option = 'existing'; return; }
  const receipt = await readHostReceipt(o, hostLocations(o, d), d, setupHelpers);
  if (receipt.kind === 'v2') Object.assign(o, { option: receipt.saved.option, profile: receipt.saved.profile });
  else if (receipt.kind === 'v1' && (await configSection('plugins', d)).entries?.['browser-handoff']?.config?.desktop?.enabled === true) o.option = 'new';
  else if (!await unmarkedCdpReceipt(d)) o.option = 'new';
  else {
    // The takeover serves the profile the CDP viewer was bound to.
    const browser = await configSection('browser', d);
    let bound;
    try { bound = resolveHandoffBrowser({ config: { browser }, pluginConfig: {} }).profile; }
    catch (error) { throw new Error('The CDP install has no usable default browser profile (' + error.message + '). Rerun setup with --browser-profile <name>, or setup --cdp to keep the CDP viewer.'); }
    Object.assign(o, { option: 'existing', profile: bound });
  }
}

async function hostSetup(o, d) {
  const failed = (await prerequisites(d)).filter(row => !row.ok);
  if (failed.length) throw new Error(failed.map(row => row.name + ': ' + row.message).join('\n'));
  await selectHostOption(o, d);
  const plan = await planHost(o, d, setupHelpers);
  const lines = describeHost(plan), units = Object.keys(plan.units);
  if (o.dryRun) {
    for (const line of lines) d.log(line);
    d.log('No files, downloads, services, or configuration were changed.');
    return { ok: true, command: 'setup', dryRun: true, stateDir: o.stateDir, plan: lines, patch: plan.patch, units };
  }
  if (plan.disruptive && !o.yes) {
    for (const line of lines) d.log(line);
    d.log("This closes the agent's browser. Rerun with --yes to go ahead.");
    return { ok: false, command: 'setup', plan: lines };
  }
  // Validate with OpenClaw before downloading or writing anything. Config is
  // never edited directly; supported patch operations preserve its own backups.
  await d.run('openclaw', ['config', 'patch', '--stdin', '--dry-run'], { input: JSON.stringify(plan.patch) + '\n' });
  const activation = await applyHost(plan, o, d, setupHelpers);
  for (const line of ['Clawser is configured.', ...units.map(name => 'Unit: ' + name), 'State: ' + o.stateDir, 'Display: :' + plan.display,
    "The agent's browser starts with no logins. Sign in to sites from a handoff link when the agent needs them.",
    ...(plan.dockerLeftovers ?? []).map(command => 'Run yourself afterwards: ' + command), ...plan.warnings.map(message => 'Warning: ' + message)]) d.log(line);
  logSetupActivation(activation, d);
  return { ok: true, command: 'setup', backend: 'novnc', activation: activationSummary(activation), dryRun: false, stateDir: o.stateDir, units, display: plan.display, warnings: plan.warnings, ...(plan.dockerLeftovers ? { dockerLeftovers: plan.dockerLeftovers } : {}) };
}

/** Explicit local operator CLI only. Never expose setup as a chat tool. */
export async function runClawser(argv, deps = {}) {
  const d = {
    fs: filesystem, run: execute, fetch: globalThis.fetch, artifacts: ARTIFACTS,
    env: process.env, homeDir: homedir(), uid: process.getuid?.(), platform: process.platform,
    arch: process.arch, nodeVersion: process.versions.node, execPath: process.execPath,
    packageDir: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    isPortFree: portFree, controllerHealth, now: Date.now, sleep: ms => new Promise(accept => setTimeout(accept, ms)),
    log: message => process.stdout.write(`${message}\n`), ...deps,
  };
  // OpenClaw executes plugin modules from temporary captures. Only its trusted
  // installed root may become a durable controller or ownership-receipt path.
  if (deps.openclawInvocation !== undefined && deps.packageDir === undefined) throw new Error('Plugin CLI requires an explicit trusted installed package directory');
  if (typeof d.packageDir !== 'string' || !isAbsolute(d.packageDir) || /[\x00-\x1f\x7f]/.test(d.packageDir)) throw new Error('Invalid trusted package directory: an absolute path without control characters is required');
  d.packageDir = resolve(d.packageDir);
  if (deps.openclawInvocation !== undefined) {
    const invocation = deps.openclawInvocation;
    const validPath = value => typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
    if (!object(invocation) || !validPath(invocation.command) || !Array.isArray(invocation.prefixArgs) || invocation.prefixArgs.length !== 1 || !validPath(invocation.prefixArgs[0])) throw new Error('Invalid trusted OpenClaw invocation: absolute Node and CLI entrypoint paths are required');
    const rawRun = d.run, executable = invocation.command, prefixArgs = [...invocation.prefixArgs];
    // Plugin CLI execution stays on the current host entrypoint even when that
    // host changes PATH during startup. Standalone execution retains PATH lookup.
    d.run = (command, args, options) => command === 'openclaw'
      ? rawRun(executable, [...prefixArgs, ...args], options)
      : rawRun(command, args, options);
  }
  const o = options(argv, d);
  if (o.command === 'help') {
    d.log('Usage: clawser <setup|doctor> [--dry-run] [--yes] [--state-dir <path>] [--browser-profile <name>] [--port <n>] [--cdp] [--no-migrate-cookies]\nDefault setup gives the agent its own browser on a private virtual screen that you view over noVNC. --cdp keeps the one-tab CDP viewer.');
    return { ok: true, command: 'help' };
  }
  let cdp = o.cdp;
  if (o.command === 'doctor' && !cdp && !o.specified.includes('--novnc')) {
    try { cdp = (await configSection('plugins', d)).entries?.['browser-handoff']?.config?.desktop?.enabled !== true; }
    catch (error) {
      d.log('FAIL configuration: ' + error.message);
      return { ok: false, command: 'doctor', checks: [{ name: 'configuration', ok: false, message: error.message }] };
    }
  }
  if (cdp) {
    // A doctor routed here by configuration was parsed with the host defaults.
    if (!o.specified.includes('--state-dir')) o.stateDir = resolve(join(stateRoot(d), 'clawser-cdp'));
    if (!o.specified.includes('--browser-profile')) o.profile = 'handoff';
    if (!o.specified.includes('--port')) o.port = 19410;
    if (o.cdp) o.explicitCdp = true;
    const { runCdpSetup } = await import('./cdp-setup.mjs');
    return runCdpSetup(o, d, { prerequisites, configSection, stat, noSymlinks, privatePath, readJson, download, atomicPrivate, reloadPlugin });
  }
  if (o.command === 'doctor') return hostDoctor(o, d, await prerequisites(d));
  return hostSetup(o, d);
}
