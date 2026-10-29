import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { isAbsolute, join } from 'node:path';

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
  Object.freeze({ name: 'Xvfb', probe: '-help', required: true, brew: 'xorg-server', packages: Object.freeze({ apt: 'xvfb', dnf: 'xorg-x11-server-Xvfb', pacman: 'xorg-server-xvfb', zypper: 'xorg-x11-server-Xvfb', apk: 'xvfb' }) }),
  Object.freeze({ name: 'x11vnc', probe: '-version', required: true, brew: 'x11vnc' }),
  Object.freeze({ name: 'openbox', probe: '--version', required: false }),
]);

const rerun = '`clawser setup --novnc`';
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

async function brewPath(d) {
  for (const dir of searchPaths(d)) if (await executable(join(dir, 'brew'), d)) return join(dir, 'brew');
}

async function brewBinary(dep, brew, d) {
  const prefix = String(await d.run(brew, ['--prefix', dep.brew])).trim();
  if (!isAbsolute(prefix)) throw new Error('Homebrew returned an invalid prefix for ' + dep.brew);
  return join(prefix, 'bin', dep.name);
}

// brew upgrade plus brew cleanup moves a binary to a new Cellar path, so follow the formula.
async function upgradedBrew(dep, plan, d) {
  const brew = await brewPath(d);
  if (!brew || !dep.brew) return;
  try { const path = await brewBinary(dep, brew, d); if (await executable(path, d)) return await probe(path, dep, d, { source: 'brew' }); }
  catch (error) { plan.warnings.push('Ignored ' + reason(error)); }
}

function validate(recorded) {
  const malformed = what => new Error('Recorded ' + what + ' in the setup receipt is malformed; restore setup.json, or delete its hostDeps entry and rerun ' + rerun);
  if (!object(recorded?.binaries)) throw malformed('host dependencies');
  for (const dep of HOST_DEPS) {
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

/** Read-only. A changed binary is re-resolved. Throws the distro install command when a required binary is missing and Homebrew is unavailable. */
export async function planHostDeps(recorded, d, h) {
  if (recorded !== undefined) validate(recorded);
  const { manager, hint } = await distro(d);
  const plan = { binaries: {}, warnings: [] };
  const missing = [];
  for (const dep of HOST_DEPS) {
    const entry = recorded?.binaries[dep.name];
    if (entry && await intact(entry, d, h).catch(() => false)) { plan.binaries[dep.name] = entry; continue; }
    const found = (entry?.source === 'brew' ? await upgradedBrew(dep, plan, d) : undefined) ?? await existing(dep, plan, d, manager);
    if (found) plan.binaries[dep.name] = found; else missing.push(dep);
  }
  if (!missing.length) return plan;
  const brew = missing.some(dep => dep.brew) && await brewPath(d);
  if (brew) plan.brew = { path: brew, deps: missing.filter(dep => dep.brew), hint: hint(missing) };
  const rest = missing.filter(dep => !plan.brew?.deps.includes(dep));
  const required = rest.filter(dep => dep.required);
  if (required.length) throw new Error('Missing ' + names(required) + ', and Homebrew is not available to install ' + (required.length > 1 ? 'them' : 'it') + '.' + hint(rest));
  for (const dep of rest) plan.warnings.push(unavailable(dep, hint([dep])));
  return plan;
}

/** Writes only through brew install. A set that differs from `previous` must pass the smoke test before it is returned. */
export async function installHostDeps(plan, d, { previous } = {}) {
  const binaries = { ...plan.binaries }, warnings = [];
  if (plan.brew) {
    const formulas = plan.brew.deps.map(dep => dep.brew);
    try { await d.run(plan.brew.path, ['install', ...formulas], { timeoutMs: 45 * 60_000 }); }
    catch (error) { throw new Error('brew install ' + formulas.join(' ') + ' failed: ' + reason(error) + '.' + plan.brew.hint); }
    for (const dep of plan.brew.deps) binaries[dep.name] = await probe(await brewBinary(dep, plan.brew.path, d), dep, d, { source: 'brew' });
  }
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
  for (const dep of HOST_DEPS) {
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

const freePort = () => new Promise((accept, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen({ host: '127.0.0.1', port: 0 }, () => { const { port } = server.address(); server.close(() => accept(port)); });
});

const rfbBanner = port => new Promise(accept => {
  const socket = net.connect({ host: '127.0.0.1', port });
  let text = '';
  const done = value => { socket.destroy(); accept(value); };
  socket.setTimeout(1000, () => done(false));
  socket.once('error', () => done(false));
  socket.on('data', bytes => { text += bytes; if (text.length >= 12) done(/^RFB \d{3}\.\d{3}\n/.test(text)); });
});

/** Starts the resolved set on a private display and stops it again. Returns failure messages by binary name. */
export async function smokeHostDeps(binaries, d, { timeoutMs = 15_000, settleMs = 1500 } = {}) {
  const children = [], failed = {};
  const base = { ...d.env };
  delete base.DISPLAY; delete base.WAYLAND_DISPLAY;
  try {
    const xvfb = launch(children, binaries.Xvfb, ['-displayfd', '3', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], base, true);
    let display;
    try { display = ':' + await firstLine(xvfb.stdio[3], xvfb, timeoutMs); }
    catch (error) { failed.Xvfb = error.message; return failed; }
    const wm = binaries.openbox && launch(children, binaries.openbox, [], { ...base, DISPLAY: display });
    if (wm) await Promise.race([wm.exited, delay(settleMs)]);
    const port = await freePort();
    const vnc = launch(children, binaries.x11vnc, ['-display', display, '-localhost', '-noxrecord', '-rfbport', String(port), '-nopw', '-forever', '-shared'], { ...base, DISPLAY: display });
    for (const deadline = Date.now() + timeoutMs; ;) {
      if (vnc.done) { failed.x11vnc = await vnc.exited; break; }
      if (await rfbBanner(port)) break;
      if (Date.now() > deadline) { failed.x11vnc = 'did not serve RFB on 127.0.0.1:' + port + ' within ' + timeoutMs + ' ms'; break; }
      await delay(250);
    }
    if (xvfb.done) failed.Xvfb = await xvfb.exited;
    if (wm?.done) failed.openbox = await wm.exited;
    return failed;
  } finally {
    for (const child of children.reverse()) {
      if (child.done) continue;
      child.kill('SIGTERM');
      if (!await Promise.race([child.exited.then(() => true), delay(3000).then(() => false)])) { child.kill('SIGKILL'); await child.exited; }
    }
  }
}

export const describeHostPlan = plan => HOST_DEPS.map(dep => {
  const entry = plan.binaries[dep.name];
  if (entry) return dep.name + ': ' + entry.path + ' (' + entry.source + ' ' + entry.version + ')';
  if (plan.brew?.deps.includes(dep)) return dep.name + ': brew install ' + dep.brew;
  return dep.name + ': unavailable';
});
