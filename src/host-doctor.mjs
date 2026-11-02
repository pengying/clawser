import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { resolveHandoffBrowser } from './browser-config.mjs';
import { cookieEncryption, showProperties } from './host-browser.mjs';
import { verifyHostDeps } from './host-deps.mjs';
import { assertHealth, hostConfigPatch, hostLocations, readHostReceipt, renderHost, unitDirMoved } from './host-setup.mjs';
import { cdpUrlFor, chromeArgs } from './host-units.mjs';
import { inspectSetupActivation, requireActiveActivation } from './setup-activation.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const rerun = 'rerun openclaw clawser setup';
const ROLES = ['display', 'windowManager', 'browser', 'supervisor', 'controller'];
const firstLine = error => String(error?.message ?? error).split('\n')[0];

async function present(path, d) {
  try { return await d.fs.stat(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

// The person's original store, where Chrome 96 and later keep cookies under Network/.
async function cookieSource(saved, d, h) {
  const folder = join(saved.userDataDir, saved.profileDirectory || 'Default');
  for (const path of [join(folder, 'Network/Cookies'), join(folder, 'Cookies')]) if (await h.stat(path, d)) return path;
}

/**
 * Checks an owned host install and pushes one row per check onto `checks`. A row whose precondition failed is skipped.
 * Read-only: it runs only `systemctl --user show`, `loginctl show-user` and `xproof.py clients`, and reads files and configuration.
 * It never writes, starts, stops, enables, downloads or patches. Returns the activation, the v2 receipt and its recorded unit names.
 */
export async function diagnoseHost(o, d, h, checks) {
  const p = hostLocations(o, d);
  let receipt, activation;
  const check = async (name, work) => {
    try { await work(); checks.push({ name, ok: true }); return true; }
    catch (error) { checks.push({ name, ok: false, message: error.message, ...(error.pending ? { pending: true } : {}) }); return false; }
  };
  // A warning row never fails doctor. Its message comes from `work`, or from what it threw.
  const advise = async (name, work) => {
    let message;
    try { message = await work(); } catch (error) { message = error.message; }
    if (message) checks.push({ name, ok: true, warning: true, message });
  };

  await check('installation', async () => {
    receipt = await readHostReceipt(o, p, d, h);
    if (receipt.kind === 'v1') throw new Error('This is a Docker desktop install from an older Clawser; ' + rerun);
    if (receipt.kind === 'none') throw new Error('No owned Clawser setup found; run openclaw clawser setup');
  });
  const saved = receipt?.kind === 'v2' ? receipt.saved : undefined;
  if (!saved) return { activation, saved };
  const units = ROLES.map(role => p.names[role]).filter(name => saved.units?.[name]);

  const owned = await check('ownership', async () => {
    await h.privatePath(o.stateDir, 'directory', d);
    await h.privatePath(p.marker, 'file', d);
    // Unit names, sockets and the X cookie are all bound to the folder setup ran in.
    if (saved.stateDir !== o.stateDir) throw new Error(`This state folder was set up as ${saved.stateDir}; move it back there, then rerun doctor`);
    if (saved.unitDir !== p.unitDir) throw unitDirMoved(saved.unitDir, p);
  });
  await check('configuration', () => hostConfigPatch(o, p, saved, d, h, { requireConfigured: true, convertingFrom: saved.convertedFrom, profile: saved.profile, option: saved.option }));
  await check('pinned assets', async () => {
    await h.privatePath(p.binary, 'file', d);
    if (sha256(await d.fs.readFile(p.binary)) !== d.artifacts.cloudflared.sha256) throw new Error('Installed cloudflared checksum changed');
    if (!saved.assetsDigest || await h.treeDigest(p.assets, d) !== saved.assetsDigest) throw new Error('Installed noVNC assets checksum changed');
  });
  let warnings = [];
  const verified = await check('host dependencies', async () => { warnings = await (d.hostResolver?.verify ?? verifyHostDeps)(saved.hostDeps, d, { stat: h.stat, noSymlinks: h.noSymlinks }); });
  checks.push(...warnings.map(message => ({ name: 'window manager', ok: true, warning: true, message })));

  const status = {};
  const running = await check('services', async () => {
    const down = [];
    for (const name of units) {
      status[name] = showProperties(await d.run('systemctl', ['--user', 'show', name, '--property=ActiveState,SubState,MainPID', '--no-pager']));
      if (status[name].ActiveState !== 'active') down.push(name);
    }
    if (!down.length) return;
    const [first] = down, { ActiveState, SubState } = status[first];
    throw new Error(`${first} is ${ActiveState}/${SubState}; inspect it with journalctl --user -u ${first}` + (down.length > 1 ? ` (and ${down.length - 1} more)` : ''));
  });
  const screen = ':' + saved.display;
  const shown = await check('display', async () => {
    if (!(await h.stat(join(d.x11SocketDir ?? '/tmp/.X11-unix', 'X' + saved.display), d))?.isSocket()) {
      throw new Error(`Display ${screen} has no X socket; inspect ${p.names.display} with journalctl --user -u ${p.names.display}`);
    }
  });
  const python = saved.hostDeps?.binaries?.python3?.path, browserUnit = p.names.browser;
  // Doctor runs the recorded python3 only after its digest checked out.
  if (running && shown && verified && status[browserUnit] && typeof python === 'string' && isAbsolute(python)) await check('browser window', async () => {
    const pid = Number(status[browserUnit].MainPID);
    // xproof talks to Clawser's X display only, with its own cookie.
    const env = { ...d.env, DISPLAY: screen, XAUTHORITY: p.xauthority };
    delete env.WAYLAND_DISPLAY;
    let clients;
    try {
      clients = JSON.parse(await d.run(python, [join(d.packageDir, 'runtime/desktop/xproof.py'), 'clients'], { env, timeoutMs: 10_000 }));
      if (!Array.isArray(clients)) throw new Error('xproof printed no client list');
    } catch (error) { throw new Error(`Could not list the windows on display ${screen} (${firstLine(error)})`); }
    const pids = clients.map(client => client?.pid);
    if (!pids.includes(pid)) throw new Error(`Chrome (pid ${pid}) has no window on display ${screen}; restart ${browserUnit}`);
  });
  await check('CDP origin', async () => {
    const { cdpUrl } = resolveHandoffBrowser({ config: { browser: await h.configSection('browser', d) }, pluginConfig: {}, profile: saved.profile });
    if (cdpUrl !== cdpUrlFor(saved.cdpPort)) throw new Error(`Browser profile ${saved.profile} points at ${cdpUrl}, not ${cdpUrlFor(saved.cdpPort)}; ${rerun}`);
  });
  // Option B's folder is the person's own. Doctor reports a loose mode there too, and never fixes it.
  await check('profile directory', async () => {
    const dir = saved.userDataDir, info = await present(dir, d);
    if (!info?.isDirectory()) throw new Error(`${dir} is missing`);
    if (info.mode & 0o077) throw new Error(`${dir} is readable by other users; run: chmod 700 ${dir}`);
  });
  await check('linger', async () => {
    const on = await d.run('loginctl', ['show-user', String(d.uid), '-p', 'Linger', '--value']).then(out => String(out).trim() === 'yes', () => false);
    if (!on) throw new Error('Linger is off, so these services stop when you log out. Run: loginctl enable-linger');
  });
  // Rendering needs the recorded binaries, and the unit files sit where ownership vouched for them.
  const bins = saved.hostDeps?.binaries;
  if (owned && ['Xvfb', 'x11vnc', 'python3'].every(name => typeof bins?.[name]?.path === 'string')) await check('units current', async () => {
    // A git upgrade installs the plugin in a new folder, and the units still name the old one.
    if (saved.packageDir !== d.packageDir || saved.execPath !== d.execPath) throw new Error('the plugin moved; ' + rerun);
    const { userDataDir, profileDirectory, cdpPort, browser } = saved;
    const rendered = renderHost({ p, display: saved.display, cdpPort, port: saved.port, profile: saved.profile, bins, execPath: d.execPath,
      wm: saved.units?.[p.names.windowManager] ? bins.openbox?.path : undefined,
      browser: { path: browser.path, args: chromeArgs({ existing: browser.existingArgs, userDataDir, profileDirectory, cdpPort }), env: browser.env } }).units;
    for (const name of ROLES.map(role => p.names[role]).filter(name => rendered[name] !== undefined || saved.units?.[name])) {
      const recorded = saved.units?.[name], path = join(p.unitDir, name);
      await h.noSymlinks(path, d);
      const file = (await h.stat(path, d))?.isFile() ? await d.fs.readFile(path) : undefined;
      if (rendered[name] === undefined || sha256(rendered[name]) !== recorded || file === undefined || sha256(file) !== recorded) throw new Error(`${name} differs from what setup would write; ${rerun}`);
      // Setup refuses a unit file others can write, so doctor does too.
      await h.privatePath(path, 'file', d);
    }
  });
  await check('controller health', async () => assertHealth(await d.controllerHealth(p.socket), saved.cdpPort, saved.profile));
  await check('Gateway activation', async () => {
    activation = await inspectSetupActivation({ browser: await h.configSection('browser', d), plugins: await h.configSection('plugins', d) }, d);
    if (activation.backend !== 'novnc') throw new Error('Gateway activation does not match the requested noVNC backend');
    requireActiveActivation(activation);
  });

  // Option B only: Clawser's browser reads the basic store, so keyring cookies nobody moved over are lost logins.
  if (saved.option === 'existing' && (!saved.cookieMigration || saved.cookieMigration.failed)) await advise('cookie store', async () => {
    const store = await cookieSource(saved, d, h);
    const { v11 } = store ? await cookieEncryption(store, d) : { v11: 0 };
    if (v11 > 0) return `${v11} cookies are still encrypted with the desktop keyring, which Clawser's browser can't read; sign in again to sites that ask.`;
  });
  // A kept export is the only readable copy of the person's logins, in plaintext, until a rerun moves it over.
  await advise('cookie export', async () => {
    const folders = [];
    for (const name of (await d.fs.readdir(o.stateDir)).sort()) {
      const dir = join(o.stateDir, name);
      if (name.startsWith('cookies-') && (await h.stat(dir, d))?.isDirectory() && (await h.stat(join(dir, 'cookies.json'), d))?.isFile()) folders.push(dir);
    }
    if (folders.length) return `An earlier setup run saved cookies in ${folders.join(', ')}; rerun openclaw clawser setup to move them over and remove it.`;
  });
  return { activation, saved, units };
}
