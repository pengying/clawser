import * as filesystem from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopRpcClient } from './desktop-rpc.mjs';
import { DesktopRuntime } from '../runtime/desktop/index.mjs';

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
const dockerHost = '--host=unix:///var/run/docker.sock';
const runtimeLabel = 'openclaw.browser-handoff.desktop';
const identity = 'clawser-setup-v1';
const own = (value, key) => Object.hasOwn(value ?? {}, key);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function execute(command, args, { input = '', timeoutMs = 30_000 } = {}) {
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
      if (code === 0 && !overflow) accept(stdout.trim());
      else {
        const error = new Error(`${command} failed (${signal || code}): ${stderr.slice(-1000)}`);
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
  if (!['setup', 'doctor'].includes(command)) throw new Error(`Unknown Clawser command: ${command}`);
  const result = { command, stateDir: join(d.env.OPENCLAW_STATE_DIR || join(d.homeDir, '.openclaw'), 'clawser'), profile: 'handoff', port: 19410, cdpPort: 18812, vncPort: 59092, containerName: 'openclaw-handoff-desktop', defaultProfile: true, dryRun: false };
  const values = { '--state-dir': 'stateDir', '--browser-profile': 'profile', '--port': 'port', '--cdp-port': 'cdpPort', '--vnc-port': 'vncPort', '--container-name': 'containerName' };
  const seen = new Set();
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { command: 'help' };
    if (seen.has(flag)) throw new Error(`Invalid repeated flag: ${flag}`);
    seen.add(flag);
    if (flag === '--dry-run') { result.dryRun = true; continue; }
    if (flag === '--no-default-profile') { result.defaultProfile = false; continue; }
    if (!values[flag]) throw new Error(`Unknown Clawser flag: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith('--') || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid value for ${flag}`);
    const key = values[flag];
    if (['port', 'cdpPort', 'vncPort'].includes(key)) {
      if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error(`Invalid port for ${flag}`);
      result[key] = Number(value);
    } else result[key] = value;
  }
  if (new Set([result.port, result.cdpPort, result.vncPort]).size !== 3) throw new Error('Controller, CDP and VNC ports must differ');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(result.profile)) throw new Error('Invalid browser profile name');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(result.containerName)) throw new Error('Invalid container name');
  result.specified = [...seen];
  result.stateDir = resolve(result.stateDir);
  if (result.stateDir === parse(result.stateDir).root || result.stateDir === resolve(d.homeDir)) throw new Error('Invalid state directory');
  return result;
}

function locations(o, d) {
  const serviceUnit = `clawser-desktop-${sha256(o.stateDir).slice(0, 12)}.service`;
  const state = join(o.stateDir, 'state');
  const configRoot = d.env.XDG_CONFIG_HOME || join(d.homeDir, '.config');
  if (!isAbsolute(configRoot)) throw new Error('XDG_CONFIG_HOME must be absolute');
  return {
    marker: join(o.stateDir, 'setup.json'), config: join(o.stateDir, 'controller.json'), state,
    runtime: join(state, 'runtime'), socket: join(state, 'desktop.sock'),
    binary: join(o.stateDir, 'bin/cloudflared'), assets: join(o.stateDir, 'vendor/novnc-1.7.0'),
    serviceUnit, servicePath: join(configRoot, 'systemd/user', serviceUnit),
    controllerScript: join(d.packageDir, 'bin/desktop-controller.mjs'),
  };
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
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink path: ${current}`);
  }
}

async function privatePath(path, kind, d) {
  const info = await stat(path, d);
  if (!info || !(kind === 'directory' ? info.isDirectory() : info.isFile()) || info.uid !== d.uid || (info.mode & 0o077)) throw new Error(`Refusing unowned or non-private ${kind}: ${path}`);
  return info;
}

async function readJson(path, d) { return JSON.parse(await d.fs.readFile(path, 'utf8')); }

async function marker(o, p, d) {
  await noSymlinks(o.stateDir, d);
  if (!await stat(o.stateDir, d)) return undefined;
  await privatePath(o.stateDir, 'directory', d);
  if (!await stat(p.marker, d)) throw new Error(`State path exists without Clawser ownership: ${o.stateDir}`);
  await privatePath(p.marker, 'file', d);
  const saved = await readJson(p.marker, d);
  if (saved.identity !== identity || saved.uid !== d.uid || !/^[a-f0-9-]{36}$/.test(saved.ownerId || '')) throw new Error('Refusing unowned Clawser setup receipt');
  // Repeat setup and doctor need only the selected installation directory.
  // Explicit overrides still have to agree with its ownership receipt.
  for (const [flag, key] of Object.entries({ '--browser-profile': 'profile', '--port': 'port', '--cdp-port': 'cdpPort', '--vnc-port': 'vncPort', '--container-name': 'containerName', '--no-default-profile': 'defaultProfile' })) {
    if (!o.specified.includes(flag)) o[key] = saved.options?.[key];
  }
  const expected = { stateDir: o.stateDir, profile: o.profile, port: o.port, cdpPort: o.cdpPort, vncPort: o.vncPort, containerName: o.containerName, defaultProfile: o.defaultProfile, packageDir: d.packageDir, execPath: d.execPath, servicePath: p.servicePath };
  if (!same(saved.options, expected)) throw new Error('Setup arguments or installed package path conflict with the owned installation; use the original arguments or a new state directory');
  return saved;
}

async function prerequisites(d) {
  const checks = [];
  const check = async (name, work) => {
    try { await work(); checks.push({ name, ok: true }); }
    catch (error) { checks.push({ name, ok: false, message: error.message }); }
  };
  await check('platform', async () => { if (d.platform !== 'linux' || d.arch !== 'x64') throw new Error('Clawser setup requires Linux x86_64 with Docker and systemd user services'); });
  await check('node', async () => {
    const version = String(d.nodeVersion).match(/^v?(\d+)\.(\d+)\.(\d+)$/);
    const major = Number(version?.[1]), minor = Number(version?.[2]);
    if (!version || !((major === 24 && minor >= 16) || (major === 26 && minor >= 1) || major > 26)) throw new Error('Clawser requires Node 24.16+ on the 24.x line, or Node 26.1+ (including later majors); Node 25 is unsupported');
  });
  await check('source paths', async () => {
    for (const relative of ['index.mjs', 'bin/desktop-controller.mjs', 'runtime/desktop/Dockerfile', 'runtime/desktop/chromium-seccomp.json']) {
      const path = join(d.packageDir, relative);
      await noSymlinks(path, d);
      if (!(await stat(path, d))?.isFile()) throw new Error(`Installed package is missing ${relative}`);
    }
  });
  // Unsupported hosts should not run any external commands.
  if (checks.some(row => !row.ok)) return checks;
  await check('docker', () => d.run('docker', [dockerHost, 'info', '--format', '{{.ServerVersion}}']));
  await check('tar', () => d.run('tar', ['--version']));
  await check('flock', () => d.run('/usr/bin/flock', ['--version']));
  await check('systemd user', () => d.run('systemctl', ['--user', 'show-environment']));
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
    const unset = `Config path is valid but unset: ${name}. The runtime default applies until you set an authored value with openclaw config set ${name} <value>.`;
    if (error.code === 1 && typeof error.stderr === 'string' && !error.stderr.trim() && envelope?.ok === false && envelope.error?.type === 'cli_error' && envelope.error.message === unset) return {};
    // Unknown paths, malformed config and permission failures must never be
    // mistaken for empty sections. Do not echo arbitrary JSON error payloads:
    // validation messages can quote sensitive configuration values.
    throw error;
  }
  if (!output.trim()) return {};
  const value = JSON.parse(output);
  if (!object(value)) throw new Error(`Conflicting non-object OpenClaw ${name} configuration`);
  return value;
}

const profileConfig = o => ({ cdpUrl: `http://127.0.0.1:${o.cdpPort}`, driver: 'openclaw', engine: 'chromium', attachOnly: true });
const desktopConfig = (o, p) => ({ enabled: true, socketPath: p.socket, profile: o.profile });
const fieldsMatch = (current, wanted) => object(current) && Object.entries(wanted).every(([key, value]) => current[key] === value) && Object.keys(current).every(key => own(wanted, key));

async function configPatch(o, p, saved, d, requireConfigured = false) {
  const browser = await configSection('browser', d);
  const plugins = await configSection('plugins', d);
  const tools = await configSection('tools', d);
  const profile = browser.profiles?.[o.profile];
  const desktop = plugins.entries?.['browser-handoff']?.config?.desktop;
  if (profile !== undefined && (!saved || !fieldsMatch(profile, profileConfig(o)))) throw new Error(`Browser profile ${o.profile} is unowned or conflicts with Clawser`);
  if (desktop !== undefined && (!saved || !fieldsMatch(desktop, desktopConfig(o, p)))) throw new Error('Existing browser-handoff desktop config is unowned or conflicts with Clawser');
  for (const [name, value] of [['browser.profiles', browser.profiles], ['plugins.entries', plugins.entries], ['plugin config', plugins.entries?.['browser-handoff']?.config]]) {
    if (value !== undefined && !object(value)) throw new Error(`Conflicting ${name} configuration`);
  }
  const list = (value, name) => { if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`Conflicting ${name} allowlist`); return value; };
  if (plugins.deny?.includes('browser-handoff') || tools.deny?.includes('browser_handoff')) throw new Error('Existing deny policy conflicts with Clawser; resolve it explicitly before setup');
  const patch = {
    browser: { profiles: { [o.profile]: profileConfig(o) }, ...(o.defaultProfile ? { defaultProfile: o.profile } : {}) },
    plugins: { entries: { 'browser-handoff': { enabled: true, config: { desktop: desktopConfig(o, p) } } } },
    tools: {},
  };
  if (plugins.allow !== undefined) patch.plugins.allow = [...new Set([...list(plugins.allow, 'plugins.allow'), 'browser-handoff'])];
  const toolKey = Array.isArray(tools.allow) && tools.allow.length ? 'allow' : 'alsoAllow';
  if (tools.allow !== undefined) list(tools.allow, 'tools.allow');
  if (tools.alsoAllow !== undefined) list(tools.alsoAllow, 'tools.alsoAllow');
  patch.tools[toolKey] = [...new Set([...(tools[toolKey] || []), 'browser_handoff'])];
  if (requireConfigured && (!fieldsMatch(profile, profileConfig(o)) || !fieldsMatch(desktop, desktopConfig(o, p)) || plugins.entries?.['browser-handoff']?.enabled !== true || !tools[toolKey]?.includes('browser_handoff') || (plugins.allow && !plugins.allow.includes('browser-handoff')) || (o.defaultProfile && browser.defaultProfile !== o.profile))) throw new Error('Owned OpenClaw browser/profile/plugin/tool configuration is incomplete; rerun setup with its original options');
  return patch;
}

async function serviceStatus(p, d) {
  const output = await d.run('systemctl', ['--user', 'show', p.serviceUnit, '--property=LoadState,FragmentPath,ActiveState', '--no-pager']);
  return Object.fromEntries(output.split('\n').filter(Boolean).map(row => [row.slice(0, row.indexOf('=')), row.slice(row.indexOf('=') + 1)]));
}

async function inspectDocker(args, d) {
  try { const value = JSON.parse(await d.run('docker', [dockerHost, ...args])); if (!Array.isArray(value) || value.length !== 1) throw new Error('Invalid Docker inspect response'); return value[0]; }
  catch (error) { if (/No such (?:object|container|network|volume)|network [^\n]+ not found/i.test(error.message)) return undefined; throw error; }
}

async function resources(o, p, saved, d) {
  let receipt;
  const receiptPath = join(p.runtime, 'ownership.json');
  if (await stat(receiptPath, d)) { await privatePath(receiptPath, 'file', d); receipt = await readJson(receiptPath, d); }
  const container = await inspectDocker(['inspect', o.containerName], d);
  for (const [kind, name] of [['network', `${o.containerName}-net`], ['volume', `${o.containerName}-profile`]]) {
    const item = await inspectDocker([kind, 'inspect', name], d);
    if (item && (!saved || !receipt?.ownerId || item.Labels?.[runtimeLabel] !== receipt.ownerId)) throw new Error(`Refusing unowned Docker ${kind}: ${name}`);
  }
  if (container) {
    if (!saved || !receipt?.ownerId) throw new Error(`Refusing unowned Docker container: ${o.containerName}`);
    const runtime = new DesktopRuntime({ name: o.containerName, stateDir: p.runtime, cdpPort: o.cdpPort, vncPort: o.vncPort, run: args => d.run('docker', [dockerHost, ...args]) });
    await runtime.owned();
  }
  return container;
}

async function ownedFiles(p, saved, d) {
  for (const [path, checksum, name] of [[p.config, saved?.configDigest, 'controller config'], [p.servicePath, saved?.serviceDigest, 'user service']]) {
    const info = await stat(path, d);
    if (info) {
      await privatePath(path, 'file', d);
      if (!checksum || sha256(await d.fs.readFile(path)) !== checksum) throw new Error(`Refusing unowned or changed ${name}: ${path}`);
    } else if (checksum) throw new Error(`Owned ${name} is missing: ${path}`);
  }
  for (const path of [p.state, p.runtime, dirname(p.binary), dirname(p.assets)]) {
    if (await stat(path, d)) await privatePath(path, 'directory', d);
  }
}

function assertHealth(health, o) {
  if (health?.ready !== true || health.recoveryRequired === true || health.profile !== o.profile || health.cdpUrl !== `http://127.0.0.1:${o.cdpPort}`) throw new Error('Controller health or profile identity is not ready; inspect its user-service journal before retrying');
}

async function audit(o, p, saved, d) {
  await noSymlinks(p.servicePath, d);
  await ownedFiles(p, saved, d);
  const service = await serviceStatus(p, d);
  if (service.LoadState !== 'not-found' && service.FragmentPath !== p.servicePath) throw new Error(`Refusing unmanaged conflicting user service: ${p.serviceUnit}`);
  if (service.FragmentPath && (!saved?.serviceDigest || !await stat(p.servicePath, d))) throw new Error(`Refusing unmanaged user service: ${p.serviceUnit}`);
  const container = await resources(o, p, saved, d);
  if (!await d.isPortFree(o.port)) {
    if (!saved?.serviceDigest || service.ActiveState !== 'active') throw new Error(`Controller port ${o.port} is in use by an unowned service`);
    assertHealth(await d.controllerHealth(p.socket), o);
  }
  for (const port of [o.cdpPort, o.vncPort]) if (!await d.isPortFree(port) && !container?.State?.Running) throw new Error(`Desktop port ${port} is in use by an unowned process`);
  return service;
}

async function atomicPrivate(path, contents, d) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await d.fs.open(temporary, 'wx', 0o600);
  try { await file.writeFile(contents); await file.sync(); }
  finally { await file.close(); }
  await d.fs.rename(temporary, path);
}

async function saveMarker(saved, p, d) { await atomicPrivate(p.marker, `${JSON.stringify(saved, null, 2)}\n`, d); }

async function download(artifact, d) {
  const response = await d.fetch(artifact.url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Pinned download failed: HTTP ${response.status}`);
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
      const file = join(directory, name), next = relative ? `${relative}/${name}` : name;
      const info = await d.fs.lstat(file);
      if (info.isDirectory()) await walk(file, next);
      else if (info.isFile()) { hash.update(`${next}\0${info.size}\0`); hash.update(await d.fs.readFile(file)); }
      else throw new Error(`Refusing unexpected file type in pinned noVNC assets: ${next}`);
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
    const archive = join(dirname(p.assets), `novnc-${randomUUID()}.tar.gz`);
    const staging = join(dirname(p.assets), `novnc-${randomUUID()}.tmp`);
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

function systemdArgument(value) {
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Service command paths must be absolute and contain no control characters');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, () => '$$')}"`;
}

function unit(p, d) {
  return `# Managed by Clawser; ownership is recorded in ${p.marker.replace(/%/g, '%%')}\n[Unit]\nDescription=Clawser private browser handoff controller\nAfter=network-online.target docker.service\n\n[Service]\nType=simple\nExecStart=${[d.execPath, p.controllerScript, p.config].map(systemdArgument).join(' ')}\nUMask=0077\nNoNewPrivileges=true\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=180\n\n[Install]\nWantedBy=default.target\n`;
}

async function install(o, p, saved, service, d) {
  if (!saved) {
    await d.fs.mkdir(dirname(o.stateDir), { recursive: true, mode: 0o700 });
    await noSymlinks(o.stateDir, d);
    // The final directory must be created exclusively. Never adopt an unowned
    // directory that appeared between preflight and installation.
    await d.fs.mkdir(o.stateDir, { mode: 0o700 });
    await privatePath(o.stateDir, 'directory', d);
    saved = { identity, uid: d.uid, ownerId: randomUUID(), options: { stateDir: o.stateDir, profile: o.profile, port: o.port, cdpPort: o.cdpPort, vncPort: o.vncPort, containerName: o.containerName, defaultProfile: o.defaultProfile, packageDir: d.packageDir, execPath: d.execPath, servicePath: p.servicePath }, serviceUnit: p.serviceUnit };
    await d.fs.writeFile(p.marker, `${JSON.stringify(saved, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  const lock = join(o.stateDir, 'setup.lock');
  try { await d.fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Clawser setup is already locked; inspect the existing setup process before retrying'); throw error; }
  try {
    for (const path of [p.state, p.runtime, dirname(p.binary), dirname(p.assets)]) await d.fs.mkdir(path, { recursive: true, mode: 0o700 });
    await assets(p, saved, d);
    if (saved.imageId) {
      const current = await d.run('docker', [dockerHost, 'image', 'inspect', '--format', '{{.Id}}', saved.imageId]);
      if (current.trim() !== saved.imageId) throw new Error('Owned desktop image digest changed');
    } else {
      const tag = `clawser-desktop:${saved.ownerId}`;
      d.log('Building the pinned Chromium desktop image (the first build can take several minutes)…');
      await d.run('docker', [dockerHost, 'build', '--quiet', '--tag', tag, join(d.packageDir, 'runtime/desktop')], { timeoutMs: 45 * 60_000 });
      const imageId = (await d.run('docker', [dockerHost, 'image', 'inspect', '--format', '{{.Id}}', tag])).trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Docker did not return a pinned desktop image digest');
      saved.imageId = imageId; await saveMarker(saved, p, d);
    }
    if (!saved.configDigest) {
      const config = { stateDir: p.state, profile: o.profile, port: o.port, socketPath: p.socket, noVncAssetsDir: p.assets, runtime: { stateDir: p.runtime, name: o.containerName, cdpPort: o.cdpPort, vncPort: o.vncPort, image: saved.imageId }, transport: { binaryPath: p.binary, startupTimeoutMs: 90_000 } };
      const contents = `${JSON.stringify(config, null, 2)}\n`;
      await d.fs.writeFile(p.config, contents, { flag: 'wx', mode: 0o600 });
      saved.configDigest = sha256(contents); await saveMarker(saved, p, d);
    }
    if (!saved.serviceDigest) {
      const contents = unit(p, d);
      await noSymlinks(p.servicePath, d);
      await d.fs.mkdir(dirname(p.servicePath), { recursive: true, mode: 0o700 });
      await d.fs.writeFile(p.servicePath, contents, { flag: 'wx', mode: 0o600 });
      saved.serviceDigest = sha256(contents); await saveMarker(saved, p, d);
      await d.run('systemctl', ['--user', 'daemon-reload']);
    }
    if (service.ActiveState !== 'active') await d.run('systemctl', ['--user', 'enable', '--now', p.serviceUnit]);
    // Enabling desktop mode is the final configuration step: a live, matching
    // private controller must exist before the Gateway can admit browser work.
    let healthError;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { assertHealth(await d.controllerHealth(p.socket), o); healthError = undefined; break; }
      catch (error) { healthError = error; if (attempt !== 39) await d.sleep(250); }
    }
    if (healthError) throw healthError;
    // Re-read arrays immediately before the validated merge so unrelated
    // changes made during a long Docker build are preserved.
    const patch = await configPatch(o, p, saved, d);
    await d.run('openclaw', ['config', 'patch', '--stdin'], { input: `${JSON.stringify(patch)}\n` });
    await d.run('openclaw', ['plugins', 'reload', 'browser-handoff', '--wait'], { timeoutMs: 180_000 });
    return saved;
  } finally { await d.fs.rm(lock, { recursive: true }); }
}

async function diagnose(o, p, saved, d, checks) {
  const check = async (name, work) => {
    try { await work(); checks.push({ name, ok: true }); }
    catch (error) { checks.push({ name, ok: false, message: error.message }); }
  };
  await check('installation', async () => { if (!saved) throw new Error('No owned Clawser setup found; run clawser setup'); });
  if (saved) {
    await check('ownership and ports', () => audit(o, p, saved, d));
    await check('configuration', () => configPatch(o, p, saved, d, true));
    await check('pinned assets', async () => {
      await privatePath(p.binary, 'file', d);
      if (sha256(await d.fs.readFile(p.binary)) !== d.artifacts.cloudflared.sha256) throw new Error('Installed cloudflared checksum changed');
      if (!saved.assetsDigest || await treeDigest(p.assets, d) !== saved.assetsDigest) throw new Error('Installed noVNC assets checksum changed');
    });
    await check('desktop image', async () => {
      if (!saved.imageId || (await d.run('docker', [dockerHost, 'image', 'inspect', '--format', '{{.Id}}', saved.imageId])).trim() !== saved.imageId) throw new Error('Owned desktop image is missing or changed');
    });
    await check('controller health', async () => { assertHealth(await d.controllerHealth(p.socket), o); });
  }
  return checks;
}

/** Explicit local operator CLI only. Never expose setup as a chat tool. */
export async function runClawser(argv, deps = {}) {
  const d = {
    fs: filesystem, run: execute, fetch: globalThis.fetch, artifacts: ARTIFACTS,
    env: process.env, homeDir: homedir(), uid: process.getuid?.(), platform: process.platform,
    arch: process.arch, nodeVersion: process.versions.node, execPath: process.execPath,
    packageDir: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    isPortFree: portFree, controllerHealth, sleep: ms => new Promise(accept => setTimeout(accept, ms)),
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
    d.log('Usage: clawser <setup|doctor> [--dry-run] [--state-dir <path>] [--browser-profile <name>] [--port <n>] [--cdp-port <n>] [--vnc-port <n>] [--container-name <name>] [--no-default-profile]');
    return { ok: true, command: 'help' };
  }
  const p = locations(o, d);
  const checks = await prerequisites(d);
  if (o.command === 'doctor') {
    let saved;
    try { saved = await marker(o, p, d); }
    catch (error) { checks.push({ name: 'ownership', ok: false, message: error.message }); }
    await diagnose(o, p, saved, d, checks);
    for (const row of checks) d.log(`${row.ok ? 'OK' : 'FAIL'} ${row.name}${row.message ? `: ${row.message}` : ''}`);
    d.log(`Controller unit: ${p.serviceUnit}\nState: ${o.stateDir}\nContainer: ${o.containerName} (profile volume is retained)`);
    return { ok: checks.every(row => row.ok), command: o.command, checks, stateDir: o.stateDir, serviceUnit: p.serviceUnit, servicePath: p.servicePath };
  }
  const failed = checks.filter(row => !row.ok);
  if (failed.length) throw new Error(failed.map(row => `${row.name}: ${row.message}`).join('\n'));
  const saved = await marker(o, p, d);
  const patch = await configPatch(o, p, saved, d);
  const service = await audit(o, p, saved, d);
  if (o.dryRun) {
    d.log(`Dry run: verify pinned cloudflared/noVNC, build the Chromium image, start ${p.serviceUnit}, merge the ${o.profile} profile, and reload browser-handoff.\nState: ${o.stateDir}\nNo files, downloads, services, or configuration were changed.`);
    return { ok: true, command: o.command, dryRun: true, stateDir: o.stateDir, serviceUnit: p.serviceUnit, servicePath: p.servicePath, patch };
  }
  // Validate with OpenClaw before downloading or writing anything. Config is
  // never edited directly; supported patch operations preserve its own backups.
  await d.run('openclaw', ['config', 'patch', '--stdin', '--dry-run'], { input: `${JSON.stringify(patch)}\n` });
  await install(o, p, saved, service, d);
  d.log(`Clawser is configured. Controller unit: ${p.serviceUnit}\nState: ${o.stateDir}\nContainer: ${o.containerName}; its browser profile is retained across reruns.\nBefore browser work, ask the owner session to run browser_handoff action=tabs to verify the active plugin connection.`);
  return { ok: true, command: o.command, dryRun: false, stateDir: o.stateDir, serviceUnit: p.serviceUnit, servicePath: p.servicePath };
}
