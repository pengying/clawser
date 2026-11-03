import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { xauthorityEntry } from './host-display.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const delay = ms => new Promise(accept => setTimeout(accept, ms));
const managers = [
  [/\b(?:debian|ubuntu)\b/, 'apt', 'sudo apt install'], [/\b(?:fedora|rhel|centos)\b/, 'dnf', 'sudo dnf install'],
  [/\barch\b/, 'pacman', 'sudo pacman -S'], [/\bsuse\b/, 'zypper', 'sudo zypper install'], [/\balpine\b/, 'apk', 'sudo apk add'],
];

// Xvfb has no version flag: -version prints usage and exits 1, so -help is its liveness probe.
export const HOST_DEPS = Object.freeze([
  Object.freeze({ name: 'Xvfb', probe: '-help', required: true, packages: Object.freeze({ apt: 'xvfb', dnf: 'xorg-x11-server-Xvfb', pacman: 'xorg-server-xvfb', zypper: 'xorg-x11-server-Xvfb', apk: 'xvfb' }) }),
  Object.freeze({ name: 'x11vnc', probe: '-version', required: true, }),
  Object.freeze({ name: 'openbox', probe: '--version', required: false }),
  Object.freeze({ name: 'python3', probe: '--version', required: true, packages: Object.freeze({ apt: 'python3', dnf: 'python3', pacman: 'python', zypper: 'python3', apk: 'python3' }) }),
  // xproof loads these through ctypes. A host can have Xvfb and python3 without them, so python3 checks them; they are never recorded.
  Object.freeze({ name: 'libX11.so.6', library: true, required: true, packages: Object.freeze({ apt: 'libx11-6', dnf: 'libX11', pacman: 'libx11', zypper: 'libX11-6', apk: 'libx11' }) }),
  Object.freeze({ name: 'libXRes.so.1', library: true, required: true, packages: Object.freeze({ apt: 'libxres1', dnf: 'libXres', pacman: 'libxres', zypper: 'libXRes1', apk: 'libxres' }) }),
  Object.freeze({ name: 'libXtst.so.6', library: true, required: true, packages: Object.freeze({ apt: 'libxtst6', dnf: 'libXtst', pacman: 'libxtst', zypper: 'libXtst6', apk: 'libxtst' }) }),
  Object.freeze({ name: 'libXi.so.6', library: true, required: true, packages: Object.freeze({ apt: 'libxi6', dnf: 'libXi', pacman: 'libxi', zypper: 'libXi6', apk: 'libxi' }) }),
]);
const BINARIES = HOST_DEPS.filter(dep => !dep.library), LIBRARIES = HOST_DEPS.filter(dep => dep.library);
// ctypes raises OSError for a library the loader can't find. The check prints each one it can't load.
const LIBRARY_CHECK = 'import ctypes,sys\nfor n in sys.argv[1:]:\n try:ctypes.CDLL(n)\n except OSError:print(n)';

const rerun = '`openclaw clawser setup`';
const packageName = (dep, manager) => dep.packages?.[manager] ?? dep.name;
const names = deps => deps.map(dep => dep.name).join(', ');
const reason = error => String(error?.message ?? error).trim();
const unavailable = (dep, detail = '') => dep.name + ' is unavailable; the desktop runs without a window manager, so Chrome popups and dialogs open at 0,0 without stacking.' + detail;
const changed = (dep, path) => dep.name + ' at ' + path + ' is missing or changed since setup; rerun ' + rerun + ' to re-check and re-record it';
const searchPaths = d => [...new Set([...String(d.env.PATH ?? '').split(':'), ...(d.hostPaths ?? ['/usr/local/bin', '/usr/bin', '/bin', '/home/linuxbrew/.linuxbrew/bin', join(d.homeDir, '.linuxbrew/bin')])])].filter(dir => isAbsolute(dir));
const ordered = binaries => Object.fromEntries(HOST_DEPS.filter(dep => binaries[dep.name]).map(dep => [dep.name, binaries[dep.name]]));

async function executable(path, d) {
  try { const info = await d.fs.stat(path); return info.isFile() && (info.mode & 0o111) !== 0; }
  catch { return false; }
}

async function packageVersion(path, source, manager, d) {
  if (source === 'brew') return path.match(/\/Cellar\/[^/]+\/([^/]+)\//)?.[1];
  if (manager !== 'apt') return;
  try {
    const owner = String(await d.run('dpkg-query', ['-S', path])).match(/^([a-z0-9][a-z0-9+.-]+)(?::[\w-]+)?: /)?.[1];
    if (owner) return String(await d.run('dpkg-query', ['-W', '-f', '${Version}', owner])).trim() || undefined;
  } catch {}
}

// Hash the resolved file before probing it; never record a PATH name.
async function probe(path, dep, d, { source, manager } = {}) {
  const real = await d.fs.realpath(path);
  if (!await executable(real, d)) throw new Error(dep.name + ' at ' + real + ' is not an executable file');
  const sha256 = digest(await d.fs.readFile(real));
  let output;
  try { output = await d.run(real, [dep.probe], { timeoutMs: 10_000, combined: true }); }
  catch (error) { throw new Error(dep.name + ' at ' + real + ' failed ' + dep.probe + ': ' + reason(error)); }
  const kind = source ?? (real.includes('/Cellar/') ? 'brew' : 'system');
  const found = await packageVersion(real, kind, manager, d) ?? (dep.probe === '-help' ? undefined : String(output).match(/\d+(?:\.\d+)+/)?.[0]);
  return { path: real, sha256, source: kind, version: found ?? 'unknown' };
}

async function existing(dep, plan, d, manager) {
  for (const dir of searchPaths(d)) {
    if (!await executable(join(dir, dep.name), d)) continue;
    try { return await probe(join(dir, dep.name), dep, d, { manager }); }
    catch (error) { plan.warnings.push('Ignored ' + reason(error)); }
  }
}

function validate(recorded) {
  const malformed = what => new Error('Recorded ' + what + ' in the setup receipt is malformed; restore setup.json, or delete its hostDeps entry and rerun ' + rerun);
  if (!object(recorded?.binaries)) throw malformed('host dependencies');
  for (const dep of BINARIES) {
    const entry = recorded.binaries[dep.name];
    if (entry !== undefined && (!object(entry) || !['system', 'brew'].includes(entry.source) || typeof entry.path !== 'string' || !isAbsolute(entry.path) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '') || typeof entry.version !== 'string')) throw malformed(dep.name);
  }
}

async function intact(entry, d, h) {
  await h.noSymlinks(entry.path, d);
  const info = await h.stat(entry.path, d);
  return !!info?.isFile() && !!(info.mode & 0o111) && digest(await d.fs.readFile(entry.path)) === entry.sha256;
}

async function distro(d) {
  const text = await d.fs.readFile(d.osReleasePath ?? '/etc/os-release', 'utf8').catch(() => '');
  const field = key => text.match(new RegExp('^' + key + '=["\']?([^"\'\\n]*)', 'm'))?.[1] ?? '';
  const [, manager, command] = managers.find(([pattern]) => pattern.test((field('ID') + ' ' + field('ID_LIKE')).toLowerCase())) ?? [];
  return { manager, hint: deps => command ? ' Ask the owner to install them, then rerun setup: ' + command + ' ' + deps.map(dep => packageName(dep, manager)).join(' ')
    : ' Ask the owner to install ' + names(deps) + ' with the system package manager, then rerun setup.' };
}

async function missingLibraries(python, d) {
  let output;
  try { output = await d.run(python.path, ['-I', '-c', LIBRARY_CHECK, ...LIBRARIES.map(dep => dep.name)], { timeoutMs: 10_000 }); }
  catch (error) { throw new Error('python3 at ' + python.path + ' could not check the X client libraries: ' + reason(error)); }
  const failed = new Set(String(output).split(/\s+/));
  return LIBRARIES.filter(dep => failed.has(dep.name));
}

/** Read-only. A changed binary is re-resolved. Throws the distro install command when a required binary is missing; it never installs anything. */
export async function planHostDeps(recorded, d, h) {
  if (recorded !== undefined) validate(recorded);
  const { manager, hint } = await distro(d);
  const plan = { binaries: {}, warnings: [] };
  const missing = [];
  for (const dep of BINARIES) {
    const entry = recorded?.binaries[dep.name];
    if (entry && await intact(entry, d, h).catch(() => false)) { plan.binaries[dep.name] = entry; continue; }
    const found = await existing(dep, plan, d, manager);
    if (found) plan.binaries[dep.name] = found; else missing.push(dep);
  }
  if (plan.binaries.python3) missing.push(...await missingLibraries(plan.binaries.python3, d));
  const required = missing.filter(dep => dep.required);
  if (required.length) throw new Error('Missing ' + names(required) + '.' + hint(missing));
  for (const dep of missing) plan.warnings.push(unavailable(dep, hint([dep])));
  return plan;
}

/** Installs nothing. A set that differs from `previous` must pass the smoke test before it is returned. */
export async function installHostDeps(plan, d, { previous } = {}) {
  const binaries = { ...plan.binaries }, warnings = [];
  const record = { binaries: ordered(binaries) };
  if (same(record, previous)) return { record, warnings };
  const failed = await (d.hostSmoke ?? smokeHostDeps)(record.binaries, d);
  const broken = HOST_DEPS.filter(dep => dep.required && failed[dep.name]);
  if (broken.length) throw new Error('Host display smoke test failed, so setup did not record these host dependencies. ' + broken.map(dep => dep.name + ' ' + failed[dep.name]).join('; ') + '. Fix it and rerun ' + rerun + '.');
  for (const dep of HOST_DEPS) if (!dep.required && failed[dep.name]) { warnings.push(unavailable(dep, ' It failed the setup smoke test: ' + failed[dep.name])); delete record.binaries[dep.name]; }
  return { record, warnings };
}

/** Never probes, starts, installs or repairs. */
export async function verifyHostDeps(recorded, d, h) {
  if (!object(recorded?.binaries)) throw new Error('Host dependencies are not recorded; rerun ' + rerun);
  validate(recorded);
  const warnings = [];
  for (const dep of BINARIES) {
    const entry = recorded.binaries[dep.name];
    if (entry === undefined) {
      if (dep.required) throw new Error(dep.name + ' is not recorded; rerun ' + rerun);
      warnings.push(unavailable(dep));
    } else if (!await intact(entry, d, h).catch(() => false)) throw new Error(changed(dep, entry.path));
  }
  return warnings;
}

function launch(children, entry, args, env, extraFd = false) {
  const child = spawn(entry.path, args, { stdio: ['pipe', 'pipe', 'pipe', ...(extraFd ? ['pipe'] : [])], env });
  child.stdin.end();
  let output = '';
  const collect = bytes => { output = (output + bytes).slice(-4000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const closed = new Promise(accept => child.once('close', accept));
  child.exited = new Promise(accept => {
    child.once('error', error => accept('could not start: ' + error.message));
    child.once('exit', async (code, signal) => { await Promise.race([closed, delay(250)]); accept('exited (' + (signal || code) + ')' + (output.trim() ? ': ' + output.trim().slice(-400) : '')); });
  });
  child.exited.then(() => { child.done = true; });
  children.push(child);
  return child;
}

function firstLine(stream, child, timeoutMs) {
  return new Promise((accept, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('did not report a display within ' + timeoutMs + ' ms')), timeoutMs);
    stream.on('data', bytes => { text += bytes; const match = text.match(/^(\d+)\n/); if (match) { clearTimeout(timer); accept(match[1]); } });
    child.exited.then(status => { clearTimeout(timer); reject(new Error(status)); });
  });
}

const rfbBanner = path => new Promise(accept => {
  const socket = net.connect({ path });
  let text = '';
  const done = value => { socket.destroy(); accept(value); };
  socket.setTimeout(1000, () => done(false));
  socket.once('error', () => done(false));
  socket.on('data', bytes => { text += bytes; if (text.length >= 12) done(/^RFB \d{3}\.\d{3}\n/.test(text)); });
});

function xproof(entry, packageDir, env, timeoutMs) {
  return new Promise(accept => {
    const child = spawn(entry.path, [join(packageDir, 'runtime/desktop/xproof.py'), 'clients'], { stdio: ['ignore', 'ignore', 'pipe'], env });
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); accept('did not finish within ' + timeoutMs + ' ms'); }, timeoutMs);
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4000); });
    child.once('error', error => { clearTimeout(timer); accept('could not start: ' + error.message); });
    child.once('close', (code, signal) => { clearTimeout(timer); accept(code === 0 ? undefined : 'exited (' + (signal || code) + ')' + (stderr.trim() ? ': ' + stderr.trim().slice(-400) : '')); });
  });
}

/** Mirrors the production desktop launch, then stops it. Returns failure messages by binary name. */
export async function smokeHostDeps(binaries, d, { timeoutMs = 15_000, settleMs = 1500 } = {}) {
  const children = [], failed = {};
  const base = { ...d.env };
  delete base.DISPLAY; delete base.WAYLAND_DISPLAY; delete base.XAUTHORITY;
  const dir = await fs.mkdtemp(join(tmpdir(), 'clawser-smoke-'));
  try {
    const cookie = randomBytes(16), serverAuth = join(dir, 'server.auth'), clientAuth = join(dir, 'client.auth'), socket = join(dir, 'vnc.sock');
    // The server loads every cookie in -auth whatever the display number; clients match the number, so that file waits for -displayfd.
    await fs.writeFile(serverAuth, xauthorityEntry(0, cookie), { mode: 0o600 });
    const xvfb = launch(children, binaries.Xvfb, ['-displayfd', '3', '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-auth', serverAuth], base, true);
    let number;
    try { number = await firstLine(xvfb.stdio[3], xvfb, timeoutMs); }
    catch (error) { failed.Xvfb = error.message; return failed; }
    const display = ':' + number, env = { ...base, DISPLAY: display, XAUTHORITY: clientAuth };
    await fs.writeFile(clientAuth, xauthorityEntry(number, cookie), { mode: 0o600 });
    const wm = binaries.openbox && launch(children, binaries.openbox, [], env);
    if (wm) await Promise.race([wm.exited, delay(settleMs)]);
    const vnc = launch(children, binaries.x11vnc, ['-display', display, '-noxrecord', '-unixsock', socket, '-rfbport', '0', '-no6', '-rfbportv6', '-1', '-nopw', '-forever', '-shared'], env);
    for (const deadline = Date.now() + timeoutMs; ;) {
      if (vnc.done) { failed.x11vnc = await vnc.exited; break; }
      if (await rfbBanner(socket)) { await d.onSmokeVnc?.(vnc.pid); break; }
      if (Date.now() > deadline) { failed.x11vnc = 'did not serve RFB on ' + socket + ' within ' + timeoutMs + ' ms'; break; }
      await delay(250);
    }
    if (xvfb.done) failed.Xvfb = await xvfb.exited;
    else if (binaries.python3 && !failed.x11vnc) { const problem = await xproof(binaries.python3, d.packageDir, env, timeoutMs); if (problem) failed.python3 = problem; }
    if (wm?.done) failed.openbox = await wm.exited;
    return failed;
  } finally {
    for (const child of children.reverse()) {
      if (child.done) continue;
      child.kill('SIGTERM');
      if (!await Promise.race([child.exited.then(() => true), delay(3000).then(() => false)])) { child.kill('SIGKILL'); await child.exited; }
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export const describeHostPlan = plan => BINARIES.map(dep => {
  const entry = plan.binaries[dep.name];
  if (entry) return dep.name + ': ' + entry.path + ' (' + entry.source + ' ' + entry.version + ')';
  return dep.name + ': unavailable';
});
