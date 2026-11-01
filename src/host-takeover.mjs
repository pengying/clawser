import { basename, dirname, isAbsolute, join } from 'node:path';
import { resolveHandoffBrowser } from './browser-config.mjs';
import { SNAP_MESSAGE, classifyOwner, cookieEncryption, displayServices, isSnapBrowser, listenerProcess, portHolder, portInUse, procRoot, processInfo, showProperties } from './host-browser.mjs';
import { freeDisplay } from './host-display.mjs';
import { OWNED_ENV, cdpUrlFor, chromeArgs } from './host-units.mjs';

export const conflict = 'Setup arguments conflict with the owned installation; use the original arguments or a new state directory';
const LOCALE_ENV = name => name === 'LANG' || name === 'LANGUAGE' || name === 'TZ' || /^LC_[A-Za-z0-9_]+$/.test(name);
const restarter = detail => new Error(detail + " would restart Chrome, so setup won't stop it. Stop it from managing Chrome, start Chrome by hand with the same profile, then rerun setup.");

async function foreignUnit(unit, d) {
  const show = showProperties(await d.run('systemctl', ['--user', 'show', unit, '--property=MainPID,FragmentPath,DropInPaths,UnitFileState,Environment,EnvironmentFiles', '--no-pager']));
  return { unit, mainPid: Number(show.MainPID), fragmentPath: show.FragmentPath ?? '', dropIns: splitWords(show.DropInPaths ?? ''),
    wasEnabled: show.UnitFileState === 'enabled', environment: show.Environment ?? '', environmentFiles: show.EnvironmentFiles ?? '' };
}

// Units installed outside the user's own unit folder (/etc, /usr/lib, transient ones in /run) can't be disabled cleanly.
async function replaceableUnit(info, p, d) {
  const owner = classifyOwner(info.cgroup, d.uid);
  if (owner.kind !== 'user-unit') return undefined;
  const unit = await foreignUnit(owner.unit, d);
  if (unit.mainPid !== info.pid || !unit.fragmentPath.startsWith(p.unitDir + '/')) return undefined;
  // Backups copy every drop-in. A list setup can't read would leave one out.
  if (!unit.dropIns) throw new Error(`Could not read the drop-in paths of ${unit.unit}; rerun setup after removing quotes or backslashes from their names.`);
  return unit;
}

const takeoverEntry = (role, unit) => ({ role, unit: unit.unit, fragmentPath: unit.fragmentPath, dropIns: unit.dropIns, wasEnabled: unit.wasEnabled });

// systemd's shell_maybe_quote double-quotes a word and escapes \\ " $ ` inside it. Any other escape is refused.
const ESCAPED = new Set(['"', '\\', '$', '`']);

/** Splits a systemctl show list value into words, or returns undefined when it can't. */
function splitWords(text) {
  const words = [];
  let word = '', quoted = false, started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/[\x00-\x1f\x7f]/.test(c) && !(c === '\t' && !quoted)) return undefined;
    if (quoted) {
      if (c === '"') quoted = false;
      else if (c !== '\\') word += c;
      else if (ESCAPED.has(text[i + 1])) word += text[++i];
      else return undefined;
    } else if (c === '"') { quoted = true; started = true; }
    else if (c === ' ' || c === '\t') { if (started) words.push(word); word = ''; started = false; }
    else if (c === '\\') return undefined;
    else { word += c; started = true; }
  }
  if (quoted) return undefined;
  if (started) words.push(word);
  return words;
}

/** Splits systemd's Environment= property into [NAME, value] pairs, or returns undefined when it can't. */
function splitEnvironment(text) {
  const words = splitWords(text);
  if (!words?.every(item => /^[A-Za-z_][A-Za-z0-9_]*=/.test(item))) return undefined;
  return words.map(item => [item.slice(0, item.indexOf('=')), item.slice(item.indexOf('=') + 1)]);
}

async function cookieStore(userDataDir, profileDirectory, h, d) {
  const folder = join(userDataDir, profileDirectory || 'Default');
  // Chrome 96 and later keep cookies under Network/.
  for (const path of [join(folder, 'Network/Cookies'), join(folder, 'Cookies')]) if (await h.stat(path, d)) return path;
}

/** Reads the browser serving `o.profile` and how to take it over. It never writes, stops or starts anything. */
export async function discoverExisting(o, p, d, h, { expected } = {}) {
  const name = o.profile, warnings = [];
  let binding;
  try { binding = resolveHandoffBrowser({ config: { browser: await h.configSection('browser', d) }, pluginConfig: {}, profile: name }); }
  catch (error) { throw new Error(`Browser profile ${name} can't be taken over: ${error.message}`); }
  const url = new URL(binding.cdpUrl), cdpUrl = binding.cdpUrl, cdpPort = Number(url.port || 80);
  if (url.hostname === '[::1]') throw new Error(`Browser profile ${name} points at [::1]; Clawser's browser listens on 127.0.0.1. Point it at http://127.0.0.1:${cdpPort}, then rerun setup.`);

  const listener = await listenerProcess(cdpPort, d);
  if (!listener) {
    if (await d.isPortFree(cdpPort)) throw new Error(`Nothing is listening on ${cdpUrl}. Start that browser, then rerun setup.`);
    throw portInUse(cdpPort, await (d.portHolder ?? portHolder)(cdpPort, d));
  }
  if (!['127.0.0.1', '::1'].includes(listener.address)) throw new Error(`The browser on port ${cdpPort} listens on ${listener.address}, which other machines can reach. Restart it listening on 127.0.0.1 only, then rerun setup.`);
  const info = await processInfo(listener.pid, d);

  // Chrome parses only the = form of these switches.
  const existingArgs = info.argv.slice(1);
  const flag = switchName => existingArgs.find(arg => arg.startsWith(switchName + '='))?.slice(switchName.length + 1);
  const userDataDir = flag('--user-data-dir'), profileDirectory = flag('--profile-directory');
  if (userDataDir === undefined) throw new Error(`The browser on port ${cdpPort} has no --user-data-dir, so setup can't tell which profile folder it uses. Restart it with --user-data-dir, then rerun setup.`);
  if (!isAbsolute(userDataDir)) throw new Error(`The browser on port ${cdpPort} uses a relative --user-data-dir; restart it with an absolute path, then rerun setup.`);
  if (info.exe.endsWith(' (deleted)')) throw new Error('Chrome was upgraded while it was running; restart it, then rerun setup.');
  if (isSnapBrowser(info.exe)) throw new Error(SNAP_MESSAGE);

  const takeover = [], stop = [];
  const owner = classifyOwner(info.cgroup, d.uid);
  let chrome;
  if (owner.kind === 'user-unit') {
    if (Object.values(p.names).includes(owner.unit)) throw new Error(conflict);
    chrome = await replaceableUnit(info, p, d);
    if (!chrome) throw restarter(owner.unit);
    takeover.push(takeoverEntry('browser', chrome));
  } else if (owner.kind === 'session') stop.push({ kind: 'close-browser', pid: info.pid });
  else throw restarter(owner.detail);

  const number = String(info.env.get('DISPLAY') ?? '').match(/^:(\d+)(?:\.\d+)?$/)?.[1];
  const services = number === undefined ? {} : await displayServices(number, d);
  let display;
  if (chrome && services.xvfb) {
    const xvfb = await replaceableUnit(services.xvfb, p, d);
    // A session window manager dies with its Xvfb. Only a unit needs taking over.
    const wmKind = services.windowManager && classifyOwner(services.windowManager.cgroup, d.uid).kind;
    const wm = wmKind === 'user-unit' ? await replaceableUnit(services.windowManager, p, d) : undefined;
    if (xvfb && (!wmKind || wmKind === 'session' || wm)) {
      takeover.push(takeoverEntry('display', xvfb), ...wm ? [takeoverEntry('windowManager', wm)] : []);
      display = Number(number);
    }
  }
  if (display === undefined) {
    display = await (d.freeDisplay ?? freeDisplay)(d);
    if (services.xvfb) warnings.push(`Display :${number} stays running; Clawser's browser uses :${display}.`);
  }

  let env;
  if (chrome) {
    const pairs = splitEnvironment(chrome.environment);
    if (!pairs) throw new Error(`Could not read the Environment= settings of ${chrome.unit}; move them onto the Chrome command line or remove them, then rerun setup.`);
    env = pairs.filter(([key]) => !OWNED_ENV.has(key));
    if (chrome.environmentFiles.trim()) warnings.push(`${chrome.unit} loads an EnvironmentFile, which Clawser's browser unit does not; copy anything Chrome needs onto its command line.`);
  } else env = [...info.env].filter(([key]) => LOCALE_ENV(key)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

  const want = expected ?? { userDataDir, profileDirectory };
  const args = chromeArgs({ existing: existingArgs, userDataDir: want.userDataDir, profileDirectory: want.profileDirectory, cdpPort });

  const store = await cookieStore(userDataDir, profileDirectory, h, d);
  const { v11 } = store ? await cookieEncryption(store, d) : { v11: 0 };
  const cookies = (takeover.length || stop.length) && v11 > 0 && o.migrateCookies !== false ? { migrate: true, count: v11 } : undefined;
  if (o.migrateCookies === false && v11 > 0) warnings.push(`${v11} keyring-encrypted cookies will be unreadable; you'll need to sign in to those sites again.`);

  return { profile: name, cdpUrl, sourceCdpUrl: cdpUrl, cdpPort, userDataDir, ...profileDirectory !== undefined ? { profileDirectory } : {},
    browser: { path: info.exe, existingArgs, env }, args, display, takeover, stop, ...cookies ? { cookies } : {}, warnings };
}

/**
 * Plans a rerun of an option B install. Discovery runs only when a browser other than Clawser's holds the port, which is a takeover a crash
 * interrupted before its stop. Otherwise the plan renders from the receipt, and re-stops replaced units a crash left running or enabled.
 */
export async function rerunExisting(o, p, saved, d, h) {
  const listener = await listenerProcess(saved.cdpPort, d);
  const owner = listener && classifyOwner((await processInfo(listener.pid, d)).cgroup, d.uid);
  const resumed = Boolean(listener) && !(owner.kind === 'user-unit' && owner.unit === p.names.browser);
  let found;
  if (resumed) {
    found = await discoverExisting(o, p, d, h, { expected: { userDataDir: saved.userDataDir, profileDirectory: saved.profileDirectory } });
    // The X cookie and the supervisor config are bound to the first display, and the receipt to the first port.
    if (found.display !== saved.display || found.cdpPort !== saved.cdpPort) throw new Error(conflict);
  } else {
    const { userDataDir, profileDirectory, cdpPort, browser } = saved;
    found = { profile: saved.profile, cdpPort, userDataDir, ...profileDirectory !== undefined ? { profileDirectory } : {}, browser, display: saved.display,
      args: chromeArgs({ existing: browser.existingArgs, userDataDir, profileDirectory, cdpPort }), takeover: [], stop: listener ? [] : await stillReplaced(saved.replaced ?? [], d), warnings: [] };
  }
  return { ...found, ...await leftoverCookies(o, saved, resumed, d, h) };
}

// A crash between stop and disable leaves a replaced unit enabled, so it would come back at the next login.
async function stillReplaced(replaced, d) {
  const stop = [];
  for (const { unit } of replaced) {
    const state = showProperties(await d.run('systemctl', ['--user', 'show', unit, '--property=ActiveState,UnitFileState', '--no-pager']));
    if (state.ActiveState === 'active' || state.UnitFileState === 'enabled') stop.push({ kind: 'unit', unit, replaced: true });
  }
  return stop;
}

/** R46: the newest export an interrupted run left resumes until an import succeeds, unless a fresh export supersedes it. Every other cookies-* folder goes. */
async function leftoverCookies(o, saved, resumed, d, h) {
  const folders = [], exports = [];
  for (const name of (await d.fs.readdir(o.stateDir)).sort()) {
    const dir = join(o.stateDir, name);
    if (!name.startsWith('cookies-') || !(await h.stat(dir, d))?.isDirectory()) continue;
    folders.push(dir);
    const file = await h.stat(join(dir, 'cookies.json'), d);
    if (file?.isFile()) exports.push({ dir, at: file.mtimeMs });
  }
  const newest = exports.reduce((best, item) => !best || item.at >= best.at ? item : best, undefined);
  const resume = newest && !resumed && (!saved.cookieMigration || saved.cookieMigration.failed === true) && o.migrateCookies !== false;
  return { ...resume ? { cookies: { migrate: true, resumeFrom: join(newest.dir, 'cookies.json') } } : {}, staleCookies: folders.filter(dir => !resume || dir !== newest.dir) };
}

const STOP_ORDER = ['browser', 'windowManager', 'display'];
// The browser stops first, so nothing it needs goes away under it.
const inStopOrder = takeover => [...takeover].sort((a, b) => STOP_ORDER.indexOf(a.role) - STOP_ORDER.indexOf(b.role));
// Loaded only for option B. It pulls in ws, which option A never needs.
const cookieModule = async d => d.cookieMigration ?? await import('./cookie-migration.mjs');

/**
 * Copies each taken-over unit's fragment and drop-ins into a new 0700 folder under `<stateDir>/backups/`, or into `folder` when a resumed
 * takeover already backed units up there. Returns the `replaced` entries in stop order.
 */
export async function backupUnits(takeover, stateDir, d, h, { folder } = {}) {
  const root = join(stateDir, 'backups');
  await h.noSymlinks(root, d);
  if (await h.stat(root, d)) await h.privatePath(root, 'directory', d);
  else await d.fs.mkdir(root, { mode: 0o700 });
  const reuse = folder !== undefined && dirname(folder) === root && Boolean((await h.stat(folder, d))?.isDirectory());
  if (reuse) await h.privatePath(folder, 'directory', d);
  else await d.fs.mkdir(folder = join(root, new Date(d.now()).toISOString().replace(/[:.]/g, '-')), { mode: 0o700 });
  const copy = async (from, to) => {
    // readFile follows links. A linked unit file is saved by its contents.
    const bytes = await d.fs.readFile(from);
    const file = await d.fs.open(to, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  };
  const ordered = inStopOrder(takeover);
  for (const item of ordered) {
    // These units are not in the receipt yet, so any copy of them here is from a run killed before it could record them.
    if (reuse) for (const path of [join(folder, item.unit), join(folder, item.unit + '.d')]) await d.fs.rm(path, { recursive: true, force: true });
    await copy(item.fragmentPath, join(folder, item.unit));
    if (item.dropIns.length) await d.fs.mkdir(join(folder, item.unit + '.d'), { mode: 0o700 });
    for (const path of item.dropIns) await copy(path, join(folder, item.unit + '.d', basename(path)));
  }
  return ordered.map(item => ({ unit: item.unit, fragmentPath: item.fragmentPath, dropIns: item.dropIns, wasEnabled: item.wasEnabled, backup: folder }));
}

/** Stops, then disables, each taken-over unit in stop order. Calls `stopped(unit)` after each stop. */
export async function stopTakeover(takeover, d, stopped = () => {}) {
  for (const item of inStopOrder(takeover)) {
    await d.run('systemctl', ['--user', 'stop', item.unit]);
    stopped(item.unit);
    await d.run('systemctl', ['--user', 'disable', item.unit]);
  }
}

async function waitForExit(pid, d) {
  const path = join(procRoot(d), String(pid));
  for (let attempt = 0; attempt < 120; attempt++) {
    if (!await d.fs.stat(path).then(() => true, () => false)) return;
    if (attempt !== 119) await d.sleep(250);
  }
  throw new Error('The browser did not close within 30 seconds; close it yourself, then rerun setup.');
}

/** Option B's steps between daemon-reload and the first start. Records what stopped in `after` and returns the cookie export, if any. */
export async function takeOver({ plan, saved, stateDir, save, after }, d, h) {
  const cookies = await cookieModule(d);
  if (plan.cookies?.resumeFrom) after.export = await savedExport(plan.cookies.resumeFrom, d);
  else if (plan.cookies?.migrate) {
    const tempDir = await d.fs.mkdtemp(join(stateDir, 'cookies-'));
    let exported;
    try { exported = await cookies.exportCookies(plan.sourceCdpUrl, tempDir, d); }
    catch (error) {
      await removeCookies([tempDir], d, plan.warnings);
      throw new Error(`Could not read cookies from the running browser (${error.message}). Nothing was stopped; rerun setup, or use --no-migrate-cookies.`);
    }
    // Until an import attempt finishes, the export is the only readable copy of the person's logins.
    after.export = { ...exported, dir: tempDir };
  }
  // A resumed takeover keeps each replaced unit's entry and first backup, and backs up only the units new to it, beside the first ones.
  const known = new Set((saved.replaced ?? []).map(item => item.unit)), fresh = plan.takeover.filter(item => !known.has(item.unit));
  if (fresh.length) {
    saved.replaced = [...saved.replaced ?? [], ...await backupUnits(fresh, stateDir, d, h, { folder: saved.replaced?.[0]?.backup })];
    await save();
  }
  const units = [...plan.takeover, ...plan.stop.filter(item => item.replaced)];
  if (units.length) {
    after.backup = saved.replaced.find(item => units.some(unit => unit.unit === item.unit))?.backup;
    await stopTakeover(units, d, unit => after.stopped.push(unit));
  }
  for (const item of plan.stop) {
    if (item.kind !== 'close-browser') continue;
    await cookies.closeBrowser(plan.sourceCdpUrl, d);
    await waitForExit(item.pid, d);
    after.closed = true;
  }
  return after.export;
}

// An interrupted run's export. Only its length is read, and nothing from inside it reaches a message.
async function savedExport(path, d) {
  let count = 0;
  try { const saved = JSON.parse(await d.fs.readFile(path, 'utf8')); if (Array.isArray(saved)) count = saved.length; } catch {}
  return { path, count, dir: dirname(path) };
}

/** Removes cookie export folders. A failure is a warning, so cleanup never fails setup. */
export async function removeCookies(dirs, d, warnings) {
  for (const dir of dirs) {
    try { await d.fs.rm(dir, { recursive: true, force: true }); }
    catch { warnings.push(`Could not remove ${dir}; delete it yourself, it holds saved cookies.`); }
  }
}

/** Imports an export into Clawser's browser and returns the `cookieMigration` record. A failure is a warning, not an error. Removes the export once an import has run. */
export async function moveCookies(plan, exported, after, d) {
  const cookies = await cookieModule(d), cdpUrl = cdpUrlFor(plan.cdpPort), at = () => new Date(d.now()).toISOString();
  const failed = (error, kept) => {
    plan.warnings.push(`Moving cookies failed (${error.message}); ${kept ? 'rerun setup to try again, or ' : ''}sign in again to sites that ask.`);
    return { exported: exported.count, imported: 0, failed: true, at: at() };
  };
  let imported;
  try {
    // Controller health never checks the browser, and its unit starts before Chrome answers.
    await cookies.waitForBrowser(cdpUrl, d);
    ({ count: imported } = await cookies.importCookies(cdpUrl, exported.path, d));
    // Chrome rejecting every cookie is systematic, so the export stays for a rerun.
    if (imported === 0 && exported.count > 0) throw new Error('Chrome accepted none of the saved cookies');
  } catch (error) { return failed(error, true); }
  // Clawser's browser now holds the cookies, so the plaintext export goes.
  delete after.export;
  await removeCookies([exported.dir], d, plan.warnings);
  try { await cookies.flushCookies(cdpUrl, d); } catch (error) { return failed(error, false); }
  // Only the re-count failed. The import's own count stands.
  imported = await cookies.countCookies(cdpUrl, d).catch(() => imported);
  return { exported: exported.count, imported, at: at() };
}

/** Tells the person what setup already stopped or closed when a later step fails. */
export function afterTakeover(error, after) {
  const parts = [];
  if (after.stopped.length) parts.push(`Setup already stopped ${after.stopped.join(', ')}; rerun setup to finish. Their unit files are unchanged, with copies in ${after.backup}.`);
  if (after.closed) parts.push('Setup already closed the browser from your desktop session; rerun setup to finish.');
  if (parts.length && after.export) parts.push('Its cookies are saved and move over when you rerun setup.');
  if (parts.length && error instanceof Error) error.message += ' ' + parts.join(' ');
  return error;
}
