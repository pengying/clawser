import { basename, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SNAP_MESSAGE = "Snap Chromium can't use the hidden folder where Clawser keeps its files. Install Google Chrome, or a Chromium that isn't a snap, then rerun setup.";
const NOT_FOUND = 'No Google Chrome or Chromium found. Install Google Chrome, then rerun setup.';
const NAMES = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];
const OPT_CHROME = '/opt/google/chrome/chrome';
export const procRoot = d => d.procRoot ?? '/proc';

/** Parses `systemctl show` output into an object of property strings. */
export const showProperties = text => Object.fromEntries(String(text).split('\n').filter(Boolean).map(row => [row.slice(0, row.indexOf('=')), row.slice(row.indexOf('=') + 1)]));

/** The refusal for a port something else holds, naming the holder when it is known. */
export const portInUse = (port, holder) => new Error('port ' + port + ' is in use' + (holder ? ' by ' + holder.exe + ' (pid ' + holder.pid + ')' : ''));

async function executable(path, d) {
  try { const info = await d.fs.stat(path); return info.isFile() && (info.mode & 0o111) !== 0; }
  catch { return false; }
}

async function head(path, d) {
  let handle;
  try {
    handle = await d.fs.open(path, 'r');
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('latin1');
  } catch { return ''; }
  finally { await handle?.close().catch(() => {}); }
}

export function isSnapBrowser(realPath, headText = '') {
  return String(realPath).startsWith('/snap/') || /\/snap\/bin\/|snap run/.test(String(headText));
}

export async function findBrowserBinary(d) {
  const dirs = String(d.env.PATH ?? '').split(':').filter(dir => isAbsolute(dir));
  for (const name of NAMES) {
    const candidates = dirs.map(dir => join(dir, name));
    if (name === 'google-chrome-stable') candidates.push(d.optChrome ?? OPT_CHROME);
    for (const candidate of candidates) {
      if (!await executable(candidate, d)) continue;
      const path = await d.fs.realpath(candidate);
      if (isSnapBrowser(path, await head(path, d)) || isSnapBrowser(candidate, '')) throw new Error(SNAP_MESSAGE);
      return { path, brand: /chrome/.test(name) ? 'chrome' : 'chromium' };
    }
  }
  throw new Error(NOT_FOUND);
}

// /proc/net addresses are hex in 32-bit words, each word little-endian.
function wordBytes(hex) {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 8) {
    const word = hex.slice(i, i + 8);
    for (let j = 6; j >= 0; j -= 2) bytes.push(parseInt(word.slice(j, j + 2), 16));
  }
  return bytes;
}

function formatAddress(hex) {
  const bytes = wordBytes(hex);
  if (bytes.length === 4) return bytes.join('.');
  const mapped = bytes.slice(0, 10).every(b => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return bytes.slice(12).join('.');
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  const text = groups.join(':');
  if (text === '0:0:0:0:0:0:0:1') return '::1';
  if (text === '0:0:0:0:0:0:0:0') return '::';
  return text;
}

async function listenRows(port, d) {
  const rows = [];
  for (const file of ['tcp', 'tcp6']) {
    let text;
    try { text = await d.fs.readFile(join(procRoot(d), 'net', file), 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10 || parts[3] !== '0A') continue;
      const [address, hexPort] = parts[1].split(':');
      if (parseInt(hexPort, 16) !== port) continue;
      rows.push({ address: formatAddress(address), inode: parts[9] });
    }
  }
  return rows;
}

async function pids(d) {
  try { return (await d.fs.readdir(procRoot(d))).filter(name => /^\d+$/.test(name)).map(Number); }
  catch { return []; }
}

async function ownedByUid(pid, d) {
  try { return (await d.fs.stat(join(procRoot(d), String(pid)))).uid === d.uid; }
  catch { return false; }
}

async function socketInodes(pid, d) {
  const fdDir = join(procRoot(d), String(pid), 'fd');
  const found = new Set();
  let entries;
  try { entries = await d.fs.readdir(fdDir); } catch { return found; }
  for (const entry of entries) {
    try {
      const target = await d.fs.readlink(join(fdDir, entry));
      const inode = target.match(/^socket:\[(\d+)\]$/)?.[1];
      if (inode) found.add(inode);
    } catch {}
  }
  return found;
}

async function scanListeners(port, d, accept) {
  const rows = await listenRows(port, d);
  if (!rows.length) return;
  for (const pid of await pids(d)) {
    if (!await ownedByUid(pid, d)) continue;
    const inodes = await socketInodes(pid, d);
    const row = rows.find(r => inodes.has(r.inode));
    if (!row) continue;
    let info;
    try { info = await processInfo(pid, d); } catch { continue; }
    const found = accept(info, row);
    if (found) return found;
  }
}

// A Chrome whose binary was upgraded underneath it reports `<exe> (deleted)`; it is still the listener.
export const listenerProcess = (port, d) => scanListeners(port, d, (info, row) =>
  /^(chrome|chromium)$/.test(basename(info.exe.replace(/ \(deleted\)$/, ''))) && !info.argv.some(arg => arg.startsWith('--type=')) && { pid: info.pid, address: row.address });

export const portHolder = (port, d) => scanListeners(port, d, info => ({ pid: info.pid, exe: info.exe, cgroup: info.cgroup }));

const split = text => { const parts = text.split('\0'); if (parts.at(-1) === '') parts.pop(); return parts; };

// Some Chrome builds rewrite their process title into one entry: the exe path and every flag joined by spaces, padded with NULs.
// Only flags can be split back safely. Anything else is marked unsplit, so option B can refuse it.
// A split is marked rewritten, because a path holding ' --' still splits into flags, and option B must check the folder it names.
function commandLine(parts, exe) {
  const path = exe.replace(/ \(deleted\)$/, ''), title = parts.length && parts.slice(1).every(part => part === '') ? parts[0] : undefined;
  if (!title?.startsWith(path + ' ')) return { argv: parts };
  const flags = title.slice(path.length + 1).split(' ');
  return flags.every(flag => flag.startsWith('--')) ? { argv: [path, ...flags], rewritten: true } : { argv: [title], unsplit: true };
}

export async function processInfo(pid, d) {
  const dir = join(procRoot(d), String(pid));
  const exe = await d.fs.readlink(join(dir, 'exe'));
  const { argv, unsplit, rewritten } = commandLine(split(await d.fs.readFile(join(dir, 'cmdline'), 'utf8')), exe);
  const env = new Map();
  for (const item of split(await d.fs.readFile(join(dir, 'environ'), 'utf8'))) {
    const at = item.indexOf('=');
    if (at > 0) env.set(item.slice(0, at), item.slice(at + 1));
  }
  const cgroup = (await d.fs.readFile(join(dir, 'cgroup'), 'utf8')).split('\n').find(line => line.startsWith('0::'))?.slice(3) ?? '';
  return { pid, exe, argv, env, cgroup, ...unsplit ? { unsplit } : {}, ...rewritten ? { rewritten } : {} };
}

export function classifyOwner(cgroup, uid) {
  const path = String(cgroup).replace(/^0::/, '').trim();
  const unit = path.match(new RegExp('^/user\\.slice/user-' + uid + '\\.slice/user@' + uid + '\\.service/(?:app\\.slice/)?([^/]+\\.service)$'))?.[1];
  if (unit) return { kind: 'user-unit', unit };
  // systemd never restarts a scope: desktop sessions, apps, terminal tabs (vte-spawn, tmux-spawn) and systemd-run all land in one.
  // Only this user's own scopes count. A scope inside a service belongs to that service, and container scopes belong to their engine.
  const scope = path.match(new RegExp('^/user\\.slice/user-' + uid + '\\.slice/(?:user@' + uid + '\\.service/(?:[^/]+\\.slice/)*)?([^/]+\\.scope)$'))?.[1];
  if (scope && !/^(docker|libpod|crio|cri-containerd)-/.test(scope)) return { kind: 'session' };
  return { kind: 'unknown', detail: path };
}

export async function unitMainPid(unit, d) {
  const out = await d.run('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', unit]);
  return Number(String(out).trim());
}

export async function displayServices(display, d) {
  const found = {};
  const want = ':' + String(display).replace(/^:/, '');
  for (const pid of await pids(d)) {
    if (found.xvfb && found.windowManager) break;
    if (!await ownedByUid(pid, d)) continue;
    let info;
    try { info = await processInfo(pid, d); } catch { continue; }
    const name = basename(info.argv[0] ?? '');
    if (!found.xvfb && name === 'Xvfb' && info.argv[1] === want) found.xvfb = info;
    else if (!found.windowManager && (name === 'openbox' || basename(info.exe) === 'openbox') && info.env.get('DISPLAY') === want) found.windowManager = info;
  }
  return found;
}

async function defaultOpen(url, options) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(url, options);
}

// d.openDatabase(url, options) is injectable so tests can observe the SQL.
export async function cookieEncryption(cookiesPath, d) {
  const result = { total: 0, v10: 0, v11: 0, other: 0 };
  try { await d.fs.stat(cookiesPath); } catch { return result; }
  const url = pathToFileURL(cookiesPath);
  url.searchParams.set('immutable', '1');
  let db;
  try {
    db = await (d.openDatabase ?? defaultOpen)(url.href, { readOnly: true });
    for (const row of db.prepare('SELECT substr(encrypted_value,1,3) AS v, count(*) AS n FROM cookies GROUP BY v').all()) {
      const prefix = row.v == null ? '' : Buffer.from(row.v).toString('latin1');
      const n = Number(row.n);
      result.total += n;
      if (prefix === 'v10') result.v10 += n;
      else if (prefix === 'v11') result.v11 += n;
      else result.other += n;
    }
  } catch (error) {
    throw new Error('Could not read the cookie store at ' + cookiesPath + ': ' + String(error?.message ?? error));
  } finally { db?.close(); }
  return result;
}
