import { isAbsolute, join } from 'node:path';
import { resolveHandoffBrowser } from './browser-config.mjs';
import { SNAP_MESSAGE, classifyOwner, cookieEncryption, displayServices, isSnapBrowser, listenerProcess, portHolder, processInfo } from './host-browser.mjs';
import { freeDisplay } from './host-display.mjs';
import { chromeArgs } from './host-units.mjs';

export const conflict = 'Setup arguments conflict with the owned installation; use the original arguments or a new state directory';
const OWNED_ENV = new Set(['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS']);
const LOCALE_ENV = name => name === 'LANG' || name === 'LANGUAGE' || name === 'TZ' || /^LC_[A-Za-z0-9_]+$/.test(name);
const restarter = detail => new Error(detail + " would restart Chrome, so setup won't stop it. Stop it from managing Chrome, start Chrome by hand with the same profile, then rerun setup.");

async function foreignUnit(unit, d) {
  const output = await d.run('systemctl', ['--user', 'show', unit, '--property=MainPID,FragmentPath,DropInPaths,UnitFileState,Environment,EnvironmentFiles', '--no-pager']);
  const show = Object.fromEntries(String(output).split('\n').filter(Boolean).map(row => [row.slice(0, row.indexOf('=')), row.slice(row.indexOf('=') + 1)]));
  return { unit, mainPid: Number(show.MainPID), fragmentPath: show.FragmentPath ?? '', dropIns: String(show.DropInPaths ?? '').split(' ').filter(Boolean),
    wasEnabled: show.UnitFileState === 'enabled', environment: show.Environment ?? '', environmentFiles: show.EnvironmentFiles ?? '' };
}

// Units installed outside the user's own unit folder (/etc, /usr/lib, transient ones in /run) can't be disabled cleanly.
async function replaceableUnit(info, p, d) {
  const owner = classifyOwner(info.cgroup, d.uid);
  if (owner.kind !== 'user-unit') return undefined;
  const unit = await foreignUnit(owner.unit, d);
  return unit.mainPid === info.pid && unit.fragmentPath.startsWith(p.unitDir + '/') ? unit : undefined;
}

const takeoverEntry = (role, unit) => ({ role, unit: unit.unit, fragmentPath: unit.fragmentPath, dropIns: unit.dropIns, wasEnabled: unit.wasEnabled });

/** Splits systemd's Environment= property into NAME=value words, or returns undefined when it can't. */
function splitEnvironment(text) {
  const words = [];
  let word = '', quoted = false, started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/[\x00-\x1f\x7f]/.test(c) && !(c === '\t' && !quoted)) return undefined;
    if (quoted) {
      if (c === '"') quoted = false;
      else if (c !== '\\') word += c;
      else if (text[i + 1] === '"' || text[i + 1] === '\\') word += text[++i];
      else return undefined;
    } else if (c === '"') { quoted = true; started = true; }
    else if (c === ' ' || c === '\t') { if (started) words.push(word); word = ''; started = false; }
    else if (c === '\\') return undefined;
    else { word += c; started = true; }
  }
  if (quoted) return undefined;
  if (started) words.push(word);
  if (!words.every(item => /^[A-Za-z_][A-Za-z0-9_]*=/.test(item))) return undefined;
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
    const holder = await (d.portHolder ?? portHolder)(cdpPort, d);
    throw new Error('port ' + cdpPort + ' is in use' + (holder ? ' by ' + holder.exe + ' (pid ' + holder.pid + ')' : ''));
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

  return { profile: name, cdpUrl, cdpPort, userDataDir, ...profileDirectory !== undefined ? { profileDirectory } : {},
    browser: { path: info.exe, existingArgs, env }, args, display, takeover, stop, ...cookies ? { cookies } : {}, warnings };
}
