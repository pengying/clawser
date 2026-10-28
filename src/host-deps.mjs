import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { isAbsolute, join } from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const delay = ms => new Promise(accept => setTimeout(accept, ms));
const sources = new Set(['system', 'brew', 'extracted']);
const launchVariables = new Set(['LD_LIBRARY_PATH']);
const aptDepends = ['depends', '--no-recommends', '--no-suggests', '--no-conflicts', '--no-breaks', '--no-replaces', '--no-enhances'];
const libraryDirs = ['usr/lib/x86_64-linux-gnu', 'lib/x86_64-linux-gnu', 'usr/lib', 'lib'];
const managers = [
  [/\b(?:debian|ubuntu)\b/, 'apt', 'sudo apt install'], [/\b(?:fedora|rhel|centos)\b/, 'dnf', 'sudo dnf install'],
  [/\barch\b/, 'pacman', 'sudo pacman -S'], [/\bsuse\b/, 'zypper', 'sudo zypper install'], [/\balpine\b/, 'apk', 'sudo apk add'],
];

// Xvfb has no version flag: -version prints usage and exits 1, so -help is its liveness probe.
export const HOST_DEPS = Object.freeze([
  Object.freeze({ name: 'x11vnc', probe: '-version', required: true, brew: 'x11vnc' }),
  Object.freeze({ name: 'openbox', probe: '--version', required: false }),
  Object.freeze({ name: 'Xvfb', probe: '-help', required: true, brew: 'xorg-server', packages: Object.freeze({ apt: 'xvfb', dnf: 'xorg-x11-server-Xvfb', pacman: 'xorg-server-xvfb', zypper: 'xorg-x11-server-Xvfb', apk: 'xvfb' }) }),
]);

const rerun = '`clawser setup --novnc`';
const packageName = (dep, manager) => dep.packages?.[manager] ?? dep.name;
const names = deps => deps.map(dep => dep.name).join(', ');
const reason = error => String(error?.message ?? error).trim();
const unavailable = (dep, detail = '') => dep.name + ' is unavailable; the desktop runs without a window manager, so Chrome popups and dialogs open at 0,0 without stacking.' + detail;
const upgraded = (dep, path) => dep.name + ' at ' + path + ' is missing or changed since setup; rerun ' + rerun + ' to re-check and re-record it';
const owned = (what, root) => what + ' is missing or changed since setup. Clawser owns the extracted root and never repairs it in place; remove ' + root + ' and rerun ' + rerun;
const malformed = what => 'Recorded ' + what + ' in the setup receipt is malformed; restore setup.json, or delete its hostDeps entry and rerun ' + rerun;
const searchPaths = d => [...new Set([...String(d.env.PATH ?? '').split(':'), ...(d.hostPaths ?? ['/usr/local/bin', '/usr/bin', '/bin', '/home/linuxbrew/.linuxbrew/bin', join(d.homeDir, '.linuxbrew/bin')])])].filter(dir => isAbsolute(dir));
const ordered = binaries => Object.fromEntries(HOST_DEPS.filter(dep => binaries[dep.name]).map(dep => [dep.name, binaries[dep.name]]));

async function executable(path, d) {
  try { const info = await d.fs.stat(path); return info.isFile() && (info.mode & 0o111) !== 0; }
  catch { return false; }
}

async function treeDigest(root, d) {
  const hash = createHash('sha256');
  const walk = async (directory, relative) => {
    for (const name of (await d.fs.readdir(directory)).sort()) {
      const path = join(directory, name), next = relative ? relative + '/' + name : name, info = await d.fs.lstat(path);
      if (info.isDirectory()) { hash.update('d\0' + next + '\0'); await walk(path, next); }
      else if (info.isSymbolicLink()) hash.update('l\0' + next + '\0' + await d.fs.readlink(path) + '\0');
      else if (info.isFile()) { hash.update('f\0' + next + '\0' + info.size + '\0'); hash.update(await d.fs.readFile(path)); }
      else throw new Error('Refusing unexpected file type in extracted host root: ' + next);
    }
  };
  await walk(root, ''); return hash.digest('hex');
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
async function probe(path, dep, d, { source, root, env = {}, version, manager } = {}) {
  const real = await d.fs.realpath(path);
  if (root && !real.startsWith(root + '/')) throw new Error('Extracted ' + dep.name + ' resolves outside its private root');
  if (!await executable(real, d)) throw new Error(dep.name + ' at ' + real + ' is not an executable file');
  const sha256 = digest(await d.fs.readFile(real));
  let output;
  try { output = await d.run(real, [dep.probe], { timeoutMs: 10_000, combined: true, ...(Object.keys(env).length ? { env } : {}) }); }
  catch (error) { throw new Error(dep.name + ' at ' + real + ' failed ' + dep.probe + ': ' + reason(error)); }
  const kind = source ?? (real.includes('/Cellar/') ? 'brew' : 'system');
  const found = version ?? await packageVersion(real, kind, manager, d) ?? (dep.probe === '-help' ? undefined : String(output).match(/\d+(?:\.\d+)+/)?.[0]);
  return { path: real, sha256, source: kind, version: found ?? 'unknown', env };
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

async function existing(dep, plan, d, manager) {
  for (const dir of searchPaths(d)) {
    if (!await executable(join(dir, dep.name), d)) continue;
    try { return await probe(join(dir, dep.name), dep, d, { manager }); }
    catch (error) { plan.warnings.push('Ignored ' + reason(error)); }
  }
}

function validate(recorded, p) {
  if (!object(recorded?.binaries) || (recorded.root !== undefined && (recorded.root !== p.hostRoot || !/^[a-f0-9]{64}$/.test(recorded.rootDigest ?? '')))) throw new Error(malformed('host dependencies'));
  for (const dep of HOST_DEPS) {
    const entry = recorded.binaries[dep.name];
    if (entry === undefined) continue;
    const extracted = entry?.source === 'extracted', inside = value => typeof recorded.root === 'string' && value.startsWith(recorded.root + '/');
    if (!object(entry) || !sources.has(entry.source) || typeof entry.path !== 'string' || !isAbsolute(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '') ||
        typeof entry.version !== 'string' || !object(entry.env) || extracted !== inside(entry.path) ||
        Object.entries(entry.env).some(([key, value]) => !launchVariables.has(key) || !extracted || typeof value !== 'string' || value.split(':').some(dir => !inside(dir)))) throw new Error(malformed(dep.name));
  }
}

async function intact(entry, d, h) {
  await h.noSymlinks(entry.path, d);
  const info = await h.stat(entry.path, d);
  return !!info?.isFile() && !!(info.mode & 0o111) && digest(await d.fs.readFile(entry.path)) === entry.sha256;
}

async function verifyRoot(recorded, p, d, h) {
  const { root, rootDigest } = recorded;
  const fail = () => { throw new Error(owned('Extracted host root ' + root, root)); };
  await h.noSymlinks(root, d);
  if (!await h.stat(root, d)) fail();
  await h.privatePath(p.hostDeps, 'directory', d);
  await h.privatePath(root, 'directory', d);
  if (await treeDigest(root, d) !== rootDigest) fail();
  return { root, rootDigest };
}

async function distro(d) {
  const text = await d.fs.readFile(d.osReleasePath ?? '/etc/os-release', 'utf8').catch(() => '');
  const field = key => text.match(new RegExp('^' + key + '=["\']?([^"\'\\n]*)', 'm'))?.[1] ?? '';
  const [, manager, command] = managers.find(([pattern]) => pattern.test((field('ID') + ' ' + field('ID_LIKE')).toLowerCase())) ?? [];
  return { manager, hint: deps => command ? ' Install as an administrator, then rerun setup: ' + command + ' ' + deps.map(dep => packageName(dep, manager)).join(' ')
    : ' Install ' + names(deps) + ' with the system package manager, then rerun setup.' };
}

// Parses `apt-cache depends`: each Depends/PreDepends group lists its OR
// alternatives, and a virtual <name> expands to its indented providers.
function dependencyGroups(output) {
  const groups = [];
  let owner, group = [], last;
  for (const line of String(output).split('\n')) {
    const relation = line.match(/^ ([ |])(?:Pre)?Depends: (<)?([^\s<>()]+)>?(?: \(.*\))?$/);
    if (relation) {
      group.push(last = { name: relation[3].replace(/:[\w-]+$/, ''), virtual: !!relation[2], providers: [] });
      if (relation[1] === ' ') { groups.push({ owner, alternatives: group }); group = []; }
    } else if (/^ {4}\S+$/.test(line) && last) last.providers.push(line.trim().replace(/:[\w-]+$/, ''));
    else { last = undefined; if (/^\S+$/.test(line)) owner = line; }
  }
  return groups.map(({ owner, alternatives }) => ({ owner, names: alternatives.flatMap(alt => alt.virtual ? alt.providers : [alt.name, ...alt.providers]).filter(name => /^[a-z0-9][a-z0-9+.-]+$/.test(name)) }));
}

async function dpkgInstalled(packages, d) {
  if (!packages.length) return new Set();
  // dpkg -s exits 1 when any package is unknown but still reports the others.
  const output = await d.run('dpkg', ['-s', ...packages]).catch(error => { if (error.code === 1 && typeof error.stdout === 'string') return error.stdout; throw error; });
  return new Set(String(output).split(/\n(?=Package: )/).filter(stanza => / installed$/m.test(stanza.match(/^Status: .*$/m)?.[0] ?? '')).map(stanza => stanza.match(/^Package: (\S+)/m)?.[1]).filter(Boolean));
}

async function aptClosure(roots, d, known = []) {
  const seen = new Set([...known, ...roots]);
  for (let queue = roots; queue.length;) {
    const groups = dependencyGroups(await d.run('apt-cache', [...aptDepends, ...queue]));
    const present = await dpkgInstalled([...new Set(groups.flatMap(group => group.names))].filter(name => !seen.has(name)), d);
    queue = [];
    for (const { owner, names } of groups) {
      if (names.some(name => seen.has(name) || present.has(name))) continue;
      if (!names.length) throw new Error('a dependency of ' + owner + ' has no installable package');
      seen.add(names[0]); queue.push(names[0]);
    }
    if (seen.size > 200) throw new Error('the dependency closure exceeds 200 packages');
  }
  return [...seen];
}

async function extract({ deps, packages, hint }, binaries, p, d, h, intend) {
  await h.noSymlinks(p.hostRoot, d);
  if (await h.stat(p.hostRoot, d)) throw new Error('Extracted host root ' + p.hostRoot + ' exists without a setup record; remove it and rerun setup');
  await d.fs.mkdir(p.hostDeps, { recursive: true, mode: 0o700 });
  await h.privatePath(p.hostDeps, 'directory', d);
  const id = randomUUID(), download = join(p.hostDeps, 'download-' + id), staging = join(p.hostDeps, 'root-' + id + '.tmp');
  try {
    await d.fs.mkdir(download, { mode: 0o700 });
    await d.fs.mkdir(staging, { mode: 0o700 });
    try { await d.run('apt-get', ['download', ...packages], { cwd: download, timeoutMs: 15 * 60_000 }); }
    catch (error) { throw new Error('apt-get download failed for ' + packages.join(' ') + ': ' + reason(error) + '. Nothing was extracted; check the apt sources and network access, then rerun setup.' + hint); }
    const files = (await d.fs.readdir(download)).sort();
    if (files.length !== packages.length || files.some(file => !/^[\w.+~%-]+\.deb$/.test(file)) || packages.some(name => !files.some(file => file.startsWith(name + '_')))) throw new Error('apt-get download returned an unexpected package set; nothing was extracted');
    for (const file of files) {
      if (!(await d.fs.lstat(join(download, file))).isFile()) throw new Error('Refusing non-file apt download: ' + file);
      await d.run('dpkg', ['-x', join(download, file), staging], { timeoutMs: 5 * 60_000 });
    }
    // dpkg -x applies each archive's ./ mode to the target directory.
    await d.fs.chmod(staging, 0o700);
    const base = await d.fs.realpath(staging), lib = [], extracted = {};
    for (const dir of libraryDirs) if ((await h.stat(join(base, dir), d))?.isDirectory() && (await d.fs.readdir(join(base, dir))).some(name => /\.so(?:\.|$)/.test(name))) lib.push(dir);
    const debVersion = name => { const file = files.find(file => file.startsWith(name + '_')); return file && decodeURIComponent(file.split('_')[1]); };
    for (const dep of deps) {
      const env = lib.length ? { LD_LIBRARY_PATH: lib.map(dir => join(base, dir)).join(':') } : {};
      const entry = await probe(join(base, 'usr/bin', dep.name), dep, d, { source: 'extracted', root: base, env, version: debVersion(packageName(dep, 'apt')) });
      extracted[dep.name] = { ...entry, path: p.hostRoot + entry.path.slice(base.length), env: lib.length ? { LD_LIBRARY_PATH: lib.map(dir => join(p.hostRoot, dir)).join(':') } : {} };
    }
    const record = { binaries: ordered({ ...binaries, ...extracted }), root: p.hostRoot, rootDigest: await treeDigest(base, d) };
    // Persist intent first so a retry adopts only this exact published tree.
    await intend(record);
    await d.fs.rename(staging, p.hostRoot);
    return record;
  } finally {
    await d.fs.rm(download, { recursive: true, force: true });
    await d.fs.rm(staging, { recursive: true, force: true });
  }
}

/** Read-only. A changed system or Homebrew binary is re-resolved; a changed extracted root fails. Throws the distro install command when a required binary has no rootless source. */
export async function planHostDeps(recorded, p, d, h) {
  if (recorded !== undefined) validate(recorded, p);
  const { manager, hint } = await distro(d);
  const plan = { binaries: {}, warnings: [], ...(recorded?.root !== undefined ? { extracted: await verifyRoot(recorded, p, d, h) } : {}) };
  const missing = [];
  for (const dep of HOST_DEPS) {
    const entry = recorded?.binaries[dep.name];
    if (entry?.source === 'extracted' && !await intact(entry, d, h)) throw new Error(owned(dep.name + ' at ' + entry.path, recorded.root));
    if (entry && (entry.source === 'extracted' || await intact(entry, d, h).catch(() => false))) { plan.binaries[dep.name] = entry; continue; }
    const found = (entry?.source === 'brew' ? await upgradedBrew(dep, plan, d) : undefined) ?? await existing(dep, plan, d, manager);
    if (found) plan.binaries[dep.name] = found; else missing.push(dep);
  }
  if (!missing.length) return plan;
  const brew = missing.some(dep => dep.brew) && await brewPath(d);
  if (brew) plan.brew = { path: brew, deps: missing.filter(dep => dep.brew), hint: hint(missing) };
  const rest = missing.filter(dep => !plan.brew?.deps.includes(dep));
  if (rest.length && manager === 'apt') {
    const occupied = plan.extracted ? ' needs extraction, but ' + p.hostRoot + ' already exists; remove it and rerun ' + rerun : '';
    if (occupied && rest.some(dep => dep.required)) throw new Error(names(rest.filter(dep => dep.required)) + occupied + '.' + hint(rest));
    const deps = rest.filter(dep => dep.required);
    let packages = [];
    if (deps.length) {
      try { packages = await aptClosure(deps.map(dep => packageName(dep, 'apt')), d); }
      catch (error) { throw new Error('apt could not resolve ' + names(deps) + ' without root: ' + reason(error) + '.' + hint(rest)); }
    }
    for (const dep of rest.filter(dep => !dep.required)) {
      if (occupied) { plan.warnings.push(unavailable(dep, ' It' + occupied + '.')); continue; }
      try { packages = await aptClosure([packageName(dep, 'apt')], d, packages); deps.push(dep); }
      catch (error) { plan.warnings.push(unavailable(dep, ' apt could not resolve it: ' + reason(error) + '.' + hint([dep]))); }
    }
    if (deps.length) plan.apt = { deps, packages, hint: hint(HOST_DEPS.filter(dep => deps.includes(dep))) };
    return plan;
  }
  if (rest.some(dep => dep.required)) throw new Error('Missing ' + names(rest) + ', and neither Homebrew nor rootless Debian apt is available.' + hint(rest));
  for (const dep of rest) plan.warnings.push(unavailable(dep, hint([dep])));
  return plan;
}

/** Writes only through brew install and inside p.hostDeps. A set that differs from `previous` must pass the smoke test before it is returned; `intend` must durably record an extraction before it is published. */
export async function installHostDeps(plan, p, d, h, { intend = async () => {}, previous } = {}) {
  const binaries = { ...plan.binaries }, warnings = [];
  let record;
  if (plan.brew) {
    const formulas = plan.brew.deps.map(dep => dep.brew);
    try { await d.run(plan.brew.path, ['install', ...formulas], { timeoutMs: 45 * 60_000 }); }
    catch (error) { throw new Error('brew install ' + formulas.join(' ') + ' failed: ' + reason(error) + '.' + plan.brew.hint); }
    for (const dep of plan.brew.deps) binaries[dep.name] = await probe(await brewBinary(dep, plan.brew.path, d), dep, d, { source: 'brew' });
  }
  if (plan.apt) {
    try { record = await extract(plan.apt, binaries, p, d, h, intend); }
    catch (error) {
      if (plan.apt.deps.some(dep => dep.required)) throw error;
      for (const dep of plan.apt.deps) warnings.push(unavailable(dep, ' ' + reason(error)));
    }
  }
  record ??= { binaries: ordered(binaries), ...plan.extracted };
  if (same(record, previous)) return { record, warnings };
  const failed = await (d.hostSmoke ?? smokeHostDeps)(record.binaries, d);
  const broken = HOST_DEPS.filter(dep => dep.required && failed[dep.name]);
  if (broken.length) throw new Error('Host display smoke test failed, so setup did not record these host dependencies. ' + broken.map(dep => dep.name + ' ' + failed[dep.name]).join('; ') + '. Fix it and rerun ' + rerun + '.');
  for (const dep of HOST_DEPS) if (!dep.required && failed[dep.name]) { warnings.push(unavailable(dep, ' It failed the setup smoke test: ' + failed[dep.name])); delete record.binaries[dep.name]; }
  return { record, warnings };
}

/** Never probes, starts, installs or repairs. */
export async function verifyHostDeps(recorded, p, d, h) {
  if (!object(recorded?.binaries)) throw new Error('Host dependencies are not recorded; rerun ' + rerun);
  validate(recorded, p);
  if (recorded.root !== undefined) await verifyRoot(recorded, p, d, h);
  const warnings = [];
  for (const dep of HOST_DEPS) {
    const entry = recorded.binaries[dep.name];
    if (entry === undefined) {
      if (dep.required) throw new Error(dep.name + ' is not recorded; rerun ' + rerun);
      warnings.push(unavailable(dep));
    } else if (!await intact(entry, d, h).catch(error => { if (entry.source === 'extracted') throw error; return false; })) throw new Error(entry.source === 'extracted' ? owned(dep.name + ' at ' + entry.path, recorded.root) : upgraded(dep, entry.path));
  }
  return warnings;
}

function launch(children, entry, args, env, extraFd = false) {
  const child = spawn(entry.path, args, { stdio: ['ignore', 'pipe', 'pipe', ...(extraFd ? ['pipe'] : [])], env: { ...env, ...entry.env } });
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
  try {
    const base = { ...d.env };
    delete base.DISPLAY; delete base.WAYLAND_DISPLAY;
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
  if (plan.apt?.deps.includes(dep)) return dep.name + ': apt-get download and dpkg -x into the state directory';
  return dep.name + ': unavailable';
}).concat(plan.apt ? ['Debian packages: ' + plan.apt.packages.join(' ')] : []);
