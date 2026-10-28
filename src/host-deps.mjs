import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const sources = new Set(['system', 'brew', 'extracted']);
const aptDepends = ['depends', '--no-recommends', '--no-suggests', '--no-conflicts', '--no-breaks', '--no-replaces', '--no-enhances'];
const libraryDirs = ['usr/lib/x86_64-linux-gnu', 'lib/x86_64-linux-gnu', 'usr/lib', 'lib'];
const managers = [
  [/\b(?:debian|ubuntu)\b/, 'apt', 'sudo apt install'], [/\b(?:fedora|rhel|centos)\b/, 'dnf', 'sudo dnf install'],
  [/\barch\b/, 'pacman', 'sudo pacman -S'], [/\bsuse\b/, 'zypper', 'sudo zypper install'], [/\balpine\b/, 'apk', 'sudo apk add'],
];

export const HOST_DEPS = Object.freeze([
  Object.freeze({ name: 'x11vnc', flag: '-version', required: true, brew: 'x11vnc' }),
  Object.freeze({ name: 'openbox', flag: '--version', required: false }),
  Object.freeze({ name: 'Xvfb', flag: '-version', required: true, brew: 'xorg-server', packages: Object.freeze({ apt: 'xvfb', dnf: 'xorg-x11-server-Xvfb', pacman: 'xorg-server-xvfb', zypper: 'xorg-x11-server-Xvfb', apk: 'xvfb' }) }),
]);

const packageName = (dep, manager) => dep.packages?.[manager] ?? dep.name;
const names = deps => deps.map(dep => dep.name).join(', ');
const reason = error => String(error?.message ?? error).trim();
const unavailable = (dep, detail = '') => dep.name + ' is unavailable; the desktop runs without a window manager, so Chrome popups and dialogs open at 0,0 without stacking.' + detail;
const changed = path => path + ' is missing or changed since setup recorded its sha256. Clawser never reinstalls or re-adopts a changed host dependency; restore it or use a new state directory';
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

// Hash the resolved file before its version probe; never record a PATH name.
async function probe(path, dep, d, { source, root, libraryPath } = {}) {
  const real = await d.fs.realpath(path);
  if (root && !real.startsWith(root + '/')) throw new Error('Extracted ' + dep.name + ' resolves outside its private root');
  if (!await executable(real, d)) throw new Error(dep.name + ' at ' + real + ' is not an executable file');
  const sha256 = digest(await d.fs.readFile(real));
  const output = await d.run(real, [dep.flag], { timeoutMs: 10_000, combined: true, ...(libraryPath?.length ? { env: { LD_LIBRARY_PATH: libraryPath.join(':') } } : {}) });
  const version = String(output).match(/\d+(?:\.\d+)+/)?.[0];
  if (!version) throw new Error(dep.name + ' at ' + real + ' did not report a version');
  return { path: real, sha256, source: source ?? (real.includes('/Cellar/') ? 'brew' : 'system'), version };
}

async function existing(dep, plan, d) {
  for (const dir of searchPaths(d)) {
    if (!await executable(join(dir, dep.name), d)) continue;
    try { return await probe(join(dir, dep.name), dep, d); }
    catch (error) { plan.warnings.push('Ignored ' + reason(error)); }
  }
}

async function verify(dep, entry, recorded, d, h) {
  if (!object(entry) || !sources.has(entry.source) || typeof entry.path !== 'string' || !isAbsolute(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '') ||
      typeof entry.version !== 'string' || (entry.source === 'extracted') !== (typeof recorded.root === 'string' && entry.path.startsWith(recorded.root + '/'))) throw new Error('Recorded ' + dep.name + ' host dependency is invalid; use a new state directory');
  await h.noSymlinks(entry.path, d);
  const info = await h.stat(entry.path, d);
  if (!info?.isFile() || !(info.mode & 0o111) || digest(await d.fs.readFile(entry.path)) !== entry.sha256) throw new Error(dep.name + ' at ' + changed(entry.path));
  return entry;
}

async function verifyRoot(recorded, p, d, h) {
  const { root, libraryPath, rootDigest } = recorded;
  if (root !== p.hostRoot || !Array.isArray(libraryPath) || libraryPath.some(dir => typeof dir !== 'string' || !dir.startsWith(root + '/')) || !/^[a-f0-9]{64}$/.test(rootDigest ?? '')) throw new Error('Recorded extracted host root is invalid; use a new state directory');
  await h.noSymlinks(root, d);
  if (!await h.stat(root, d)) throw new Error('Extracted host root ' + changed(root));
  await h.privatePath(p.hostDeps, 'directory', d);
  await h.privatePath(root, 'directory', d);
  if (await treeDigest(root, d) !== rootDigest) throw new Error('Extracted host root ' + changed(root));
  return { root, libraryPath, rootDigest };
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
    for (const dep of deps) {
      const entry = await probe(join(base, 'usr/bin', dep.name), dep, d, { source: 'extracted', root: base, libraryPath: lib.map(dir => join(base, dir)) });
      extracted[dep.name] = { ...entry, path: p.hostRoot + entry.path.slice(base.length) };
    }
    const record = { binaries: ordered({ ...binaries, ...extracted }), root: p.hostRoot, libraryPath: lib.map(dir => join(p.hostRoot, dir)), rootDigest: await treeDigest(base, d) };
    // Persist intent first so a retry adopts only this exact published tree.
    await intend(record);
    await d.fs.rename(staging, p.hostRoot);
    return record;
  } finally {
    await d.fs.rm(download, { recursive: true, force: true });
    await d.fs.rm(staging, { recursive: true, force: true });
  }
}

/** Read-only. Throws the distro install command when a required binary has no rootless source. */
export async function planHostDeps(recorded, p, d, h) {
  if (recorded !== undefined && !object(recorded?.binaries)) throw new Error('Recorded host dependencies are invalid; use a new state directory');
  const plan = { binaries: {}, warnings: [], ...(recorded?.root !== undefined ? { extracted: await verifyRoot(recorded, p, d, h) } : {}) };
  const missing = [];
  for (const dep of HOST_DEPS) {
    const entry = recorded?.binaries[dep.name];
    const found = entry !== undefined ? await verify(dep, entry, recorded, d, h) : recorded && dep.required ? undefined : await existing(dep, plan, d);
    if (found) plan.binaries[dep.name] = found; else missing.push(dep);
  }
  if (!missing.length) return plan;
  const { manager, hint } = await distro(d);
  // A recorded set never installs again; only a newly installed window manager can join it.
  if (recorded) {
    if (missing.some(dep => dep.required)) throw new Error(names(missing.filter(dep => dep.required)) + ' is not recorded; use a new state directory');
    for (const dep of missing) plan.warnings.push(unavailable(dep, hint([dep])));
    return plan;
  }
  if (missing.some(dep => dep.brew)) {
    for (const dir of searchPaths(d)) if (await executable(join(dir, 'brew'), d)) { plan.brew = { path: join(dir, 'brew'), deps: missing.filter(dep => dep.brew), hint: hint(missing) }; break; }
  }
  const rest = missing.filter(dep => !plan.brew?.deps.includes(dep));
  if (rest.length && manager === 'apt') {
    const deps = rest.filter(dep => dep.required);
    let packages = [];
    if (deps.length) {
      try { packages = await aptClosure(deps.map(dep => packageName(dep, 'apt')), d); }
      catch (error) { throw new Error('apt could not resolve ' + names(deps) + ' without root: ' + reason(error) + '.' + hint(rest)); }
    }
    for (const dep of rest.filter(dep => !dep.required)) {
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

/** Writes only through brew install and inside p.hostDeps. `intend` must durably record an extraction before it is published. */
export async function installHostDeps(plan, p, d, h, intend) {
  const binaries = { ...plan.binaries }, warnings = [];
  if (plan.brew) {
    const formulas = plan.brew.deps.map(dep => dep.brew);
    try { await d.run(plan.brew.path, ['install', ...formulas], { timeoutMs: 45 * 60_000 }); }
    catch (error) { throw new Error('brew install ' + formulas.join(' ') + ' failed: ' + reason(error) + '.' + plan.brew.hint); }
    for (const dep of plan.brew.deps) {
      const prefix = String(await d.run(plan.brew.path, ['--prefix', dep.brew])).trim();
      if (!isAbsolute(prefix)) throw new Error('Homebrew returned an invalid prefix for ' + dep.brew);
      binaries[dep.name] = await probe(join(prefix, 'bin', dep.name), dep, d, { source: 'brew' });
    }
  }
  if (plan.apt) {
    try { return { record: await extract(plan.apt, binaries, p, d, h, intend), warnings }; }
    catch (error) {
      if (plan.apt.deps.some(dep => dep.required)) throw error;
      for (const dep of plan.apt.deps) warnings.push(unavailable(dep, ' ' + reason(error)));
    }
  }
  return { record: { binaries: ordered(binaries), ...plan.extracted }, warnings };
}

/** Never probes, installs or repairs. */
export async function verifyHostDeps(recorded, p, d, h) {
  if (!object(recorded?.binaries)) throw new Error('Host dependencies are not recorded; rerun clawser setup --novnc');
  if (recorded.root !== undefined) await verifyRoot(recorded, p, d, h);
  const warnings = [];
  for (const dep of HOST_DEPS) {
    const entry = recorded.binaries[dep.name];
    if (entry !== undefined) await verify(dep, entry, recorded, d, h);
    else if (dep.required) throw new Error(dep.name + ' is not recorded; use a new state directory');
    else warnings.push(unavailable(dep));
  }
  return warnings;
}

export const describeHostPlan = plan => HOST_DEPS.map(dep => {
  const entry = plan.binaries[dep.name];
  if (entry) return dep.name + ': ' + entry.path + ' (' + entry.source + ' ' + entry.version + ')';
  if (plan.brew?.deps.includes(dep)) return dep.name + ': brew install ' + dep.brew;
  if (plan.apt?.deps.includes(dep)) return dep.name + ': apt-get download and dpkg -x into the state directory';
  return dep.name + ': unavailable';
}).concat(plan.apt ? ['Debian packages: ' + plan.apt.packages.join(' ')] : []);
