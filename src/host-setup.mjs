import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { captureSetupActivation, waitForSetupActivation } from './setup-activation.mjs';
import { chromeArgs, renderUnits, unitNames } from './host-units.mjs';
import { freeDisplay, xauthorityEntry } from './host-display.mjs';
import { classifyOwner, findBrowserBinary, portHolder } from './host-browser.mjs';
import { describeHostPlan, installHostDeps, planHostDeps, verifyHostDeps } from './host-deps.mjs';

const identity = 'clawser-setup-v2';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const own = (value, key) => Object.hasOwn(value ?? {}, key);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const json = value => JSON.stringify(value, null, 2) + '\n';
const fieldsMatch = (current, wanted) => object(current) && Object.entries(wanted).every(([key, value]) => current[key] === value) && Object.keys(current).every(key => own(wanted, key));
const cdpUrlFor = port => 'http://127.0.0.1:' + port;
const profileConfig = cdpPort => ({ cdpUrl: cdpUrlFor(cdpPort), driver: 'openclaw', engine: 'chromium', attachOnly: true });
const ROLES = ['display', 'windowManager', 'browser', 'supervisor', 'controller'];
const CDP_PORTS = Array.from({ length: 10 }, (_, i) => 18820 + i);
const conflict = 'Setup arguments conflict with the owned installation; use the original arguments or a new state directory';
const resolver = d => d.hostResolver ?? { plan: planHostDeps, install: installHostDeps, verify: verifyHostDeps, describe: describeHostPlan };

export function hostLocations(o, d) {
  const configRoot = d.env.XDG_CONFIG_HOME || join(d.homeDir, '.config');
  if (!isAbsolute(configRoot)) throw new Error('XDG_CONFIG_HOME must be absolute');
  const state = join(o.stateDir, 'state'), runtime = join(state, 'runtime'), desktop = join(d.packageDir, 'runtime/desktop');
  return {
    marker: join(o.stateDir, 'setup.json'), config: join(o.stateDir, 'controller.json'), xauthority: join(o.stateDir, 'xauthority'),
    openboxConfig: join(o.stateDir, 'openbox/rc.xml'), profileDir: join(o.stateDir, 'browser/profile'),
    state, socket: join(state, 'desktop.sock'), runtime, supervisorConfig: join(runtime, 'supervisor.json'), control: join(runtime, 'control.sock'), vncDir: join(runtime, 'vnc'),
    binary: join(o.stateDir, 'bin/cloudflared'), assets: join(o.stateDir, 'vendor/novnc-1.7.0'),
    unitDir: join(configRoot, 'systemd/user'), names: unitNames(o.stateDir),
    supervisorScript: join(desktop, 'supervisor.py'), openboxScript: join(desktop, 'openbox_config.py'), controllerScript: join(d.packageDir, 'bin/desktop-controller.mjs'),
  };
}

export async function readHostReceipt(o, p, d, h) {
  await h.noSymlinks(o.stateDir, d);
  if (!await h.stat(o.stateDir, d)) return { kind: 'none' };
  await h.privatePath(o.stateDir, 'directory', d);
  if (!await h.stat(p.marker, d)) throw new Error('State path exists without Clawser ownership: ' + o.stateDir);
  await h.privatePath(p.marker, 'file', d);
  const saved = await h.readJson(p.marker, d);
  if (![identity, 'clawser-setup-v1'].includes(saved?.identity) || saved.uid !== d.uid || !/^[a-f0-9-]{36}$/.test(saved.ownerId || '')) throw new Error('Refusing unowned Clawser setup receipt');
  return { kind: saved.identity === identity ? 'v2' : 'v1', saved };
}

/** `cdpPort` defaults to the receipt's; planning a fresh install passes the chosen one. `convertingFrom` is `{ profile, containerName, imageId? }`. */
export async function hostConfigPatch(o, p, saved, d, h, { requireConfigured = false, convertingFrom, cdpPort = saved?.cdpPort } = {}) {
  const browser = await h.configSection('browser', d), plugins = await h.configSection('plugins', d), tools = await h.configSection('tools', d);
  const profile = browser.profiles?.clawser, entry = plugins.entries?.['browser-handoff'], desktop = entry?.config?.desktop;
  const ours = { enabled: true, socketPath: p.socket, profile: 'clawser' };
  if (profile !== undefined && (!saved || !fieldsMatch(profile, profileConfig(cdpPort)))) throw new Error('Browser profile clawser is unowned or conflicts with Clawser');
  const inertDesktop = (!saved || saved.pendingInertDesktop === true) && fieldsMatch(desktop, { enabled: false });
  if (!saved && inertDesktop) o.pendingInertDesktop = true;
  const anyEnabled = wanted => typeof desktop?.enabled === 'boolean' && fieldsMatch({ ...desktop, enabled: true }, wanted);
  const ownedDesktop = anyEnabled(ours) || (convertingFrom && anyEnabled({ ...ours, profile: convertingFrom.profile }));
  if (desktop !== undefined && !inertDesktop && !ownedDesktop) throw new Error('Existing browser-handoff desktop config is unowned or conflicts with Clawser');
  for (const [name, value] of [['browser.profiles', browser.profiles], ['plugins.entries', plugins.entries], ['plugin config', entry?.config]]) {
    if (value !== undefined && !object(value)) throw new Error('Conflicting ' + name + ' configuration');
  }
  const list = (value, name) => { if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Conflicting ' + name + ' allowlist'); return value; };
  if (plugins.deny?.includes('browser-handoff') || tools.deny?.includes('browser_handoff')) throw new Error('Existing deny policy conflicts with Clawser; resolve it explicitly before setup');
  const patch = {
    browser: { profiles: { clawser: profileConfig(cdpPort) }, defaultProfile: 'clawser' },
    plugins: { entries: { 'browser-handoff': { enabled: true, config: { desktop: ours, cloudflare: { enabled: false } } } } },
    tools: {},
  };
  if (plugins.allow !== undefined) patch.plugins.allow = [...new Set([...list(plugins.allow, 'plugins.allow'), 'browser-handoff'])];
  const toolKey = Array.isArray(tools.allow) && tools.allow.length ? 'allow' : 'alsoAllow';
  if (tools.allow !== undefined) list(tools.allow, 'tools.allow');
  if (tools.alsoAllow !== undefined) list(tools.alsoAllow, 'tools.alsoAllow');
  patch.tools[toolKey] = [...new Set([...(tools[toolKey] || []), 'browser_handoff'])];
  if (requireConfigured && (!fieldsMatch(profile, profileConfig(cdpPort)) || !fieldsMatch(desktop, ours) || entry?.enabled !== true || !tools[toolKey]?.includes('browser_handoff') || (plugins.allow && !plugins.allow.includes('browser-handoff')) || browser.defaultProfile !== 'clawser')) throw new Error('Owned OpenClaw browser/profile/plugin/tool configuration is incomplete; rerun setup');
  return patch;
}

const changedOutside = path => path + ' was changed outside Clawser; restore it or remove it, then rerun setup';
const unowned = path => path + ' exists but Clawser does not own it; move it away, then rerun setup';
const unitPath = (p, name) => join(p.unitDir, name);

// rc.xml has no desired text: it is generated once, so only its recorded digest can vouch for it.
async function classify(path, desired, recorded, d, h) {
  await h.noSymlinks(path, d);
  const info = await h.stat(path, d);
  if (!info) return 'write';
  const actual = info.isFile() ? sha256(await d.fs.readFile(path)) : undefined;
  const state = desired !== undefined && actual === sha256(desired) ? 'current' : recorded && actual === recorded ? desired === undefined ? 'current' : 'rewrite' : undefined;
  if (!state) throw new Error(recorded ? changedOutside(path) : unowned(path));
  await h.privatePath(path, 'file', d);
  return state;
}

async function unitStatus(name, p, d) {
  const output = await d.run('systemctl', ['--user', 'show', name, '--property=LoadState,FragmentPath,ActiveState', '--no-pager']);
  const status = Object.fromEntries(String(output).split('\n').filter(Boolean).map(row => [row.slice(0, row.indexOf('=')), row.slice(row.indexOf('=') + 1)]));
  if (status.LoadState !== 'not-found' && status.FragmentPath !== unitPath(p, name)) throw new Error('Refusing unmanaged conflicting user service: ' + name);
  return status;
}

async function openboxSource(openbox, d, h) {
  for (const path of d.openboxRcPaths ?? [join(dirname(dirname(openbox)), 'etc/xdg/openbox/rc.xml'), '/etc/xdg/openbox/rc.xml']) {
    if ((await h.stat(path, d))?.isFile()) return path;
  }
}

async function checkPort(port, p, d) {
  if (await d.isPortFree(port)) return;
  const holder = await (d.portHolder ?? portHolder)(port, d);
  const owner = holder && classifyOwner(holder.cgroup, d.uid);
  if (owner?.kind === 'user-unit' && Object.values(p.names).includes(owner.unit)) return;
  throw new Error('port ' + port + ' is in use' + (holder ? ' by ' + holder.exe + ' (pid ' + holder.pid + ')' : ''));
}

async function firstFreeCdpPort(d) {
  for (const port of CDP_PORTS) if (await d.isPortFree(port)) return port;
  throw new Error('No free CDP port between 18820 and 18829');
}

const unitDirMoved = (old, p) => new Error('The systemd user unit folder changed since setup (' + old + ' → ' + p.unitDir + ')');

const convertedFrom = v1 => ({ profile: v1.options?.profile, containerName: v1.options?.containerName, ...v1.imageId ? { imageId: v1.imageId } : {} });
const dockerLeftovers = ({ containerName: name, imageId }) =>
  [...name ? ['docker rm -f ' + name, 'docker network rm ' + name + '-net', 'docker volume rm ' + name + '-profile'] : [], ...imageId ? ['docker image rm ' + imageId] : []];

async function linger(d, warnings) {
  const on = await d.run('loginctl', ['show-user', String(d.uid), '-p', 'Linger', '--value']).then(out => String(out).trim() === 'yes', () => false);
  if (!on) warnings.push('Linger is off, so these services stop when you log out. Run: loginctl enable-linger');
}

const optionB = 'Taking over an existing browser is not implemented yet';
const noWm = 'Chrome popups and dialogs open at 0,0 without stacking';

export async function planHost(o, d, h) {
  if (o.option === 'existing') throw new Error(optionB);
  const p = hostLocations(o, d);
  const receipt = await readHostReceipt(o, p, d, h);
  const v2 = receipt.kind === 'v2' ? receipt.saved : undefined, v1 = receipt.kind === 'v1' ? receipt.saved : undefined;
  if (v2?.option === 'existing') throw new Error(optionB);
  if (v2 && o.specified.includes('--port') && o.port !== v2.port) throw new Error(conflict);
  if (v2 && v2.unitDir !== p.unitDir) throw unitDirMoved(v2.unitDir, p);
  if (v1?.options?.servicePath && v1.options.servicePath !== unitPath(p, p.names.controller)) throw unitDirMoved(dirname(v1.options.servicePath), p);
  if (v1?.serviceUnit && v1.serviceUnit !== p.names.controller) throw new Error(changedOutside(p.marker));
  // A v1 install that died during its image build never wrote controller.json, so only a recorded digest makes absence a tamper.
  if (v1?.configDigest && !await h.stat(p.config, d)) throw new Error(changedOutside(p.config));
  for (const path of [p.socket, p.control, join(p.vncDir, 'vnc-0000000000000000.sock')]) {
    if (Buffer.byteLength(path) > 107) throw new Error('Socket path ' + path + ' is longer than 107 bytes; choose a shorter --state-dir');
  }
  const browser = await (d.findBrowserBinary ?? findBrowserBinary)(d);
  const host = await resolver(d).plan(v2?.hostDeps, d, { stat: h.stat, noSymlinks: h.noSymlinks });
  const warnings = [...host.warnings ?? []], bins = host.binaries;
  const source = bins.openbox && await openboxSource(bins.openbox.path, d, h);
  // The real resolver already warns when openbox is missing; one warning is enough.
  if (!bins.openbox && !warnings.some(text => text.startsWith('openbox '))) warnings.push('openbox is unavailable, so ' + noWm);
  if (bins.openbox && !source) warnings.push('openbox has no rc.xml to start from; ' + noWm);
  const display = v2 ? v2.display : await (d.freeDisplay ?? freeDisplay)(d);
  const cdpPort = v2 ? v2.cdpPort : await firstFreeCdpPort(d);
  const port = v2 ? v2.port : o.port;
  for (const n of [cdpPort, port]) await checkPort(n, p, d);
  const cdpUrl = cdpUrlFor(cdpPort), wm = source ? bins.openbox.path : undefined;
  const units = renderUnits({
    names: p.names, marker: p.marker, display, xauthority: p.xauthority, xvfb: bins.Xvfb.path, openbox: wm, openboxConfig: p.openboxConfig,
    python: bins.python3.path, supervisorScript: p.supervisorScript, supervisorConfig: p.supervisorConfig,
    node: d.execPath, controllerScript: p.controllerScript, controllerConfig: p.config,
    browser: { path: browser.path, args: chromeArgs({ existing: [], userDataDir: p.profileDir, cdpPort }), env: [] },
  });
  const controller = { stateDir: p.state, profile: 'clawser', port, socketPath: p.socket, noVncAssetsDir: p.assets,
    runtime: { stateDir: p.runtime, controlSocket: p.control, cdpUrl }, transport: { binaryPath: p.binary, startupTimeoutMs: 90_000 } };
  const supervisor = { display, xauthority: p.xauthority, controlSocket: p.control, vncDir: p.vncDir, cdpUrl, x11vnc: bins.x11vnc.path };
  const names = ROLES.map(role => p.names[role]).filter(name => units[name]);
  const files = [
    { path: p.xauthority, kind: 'xauthority', consumer: p.names.display },
    ...wm ? [{ path: p.openboxConfig, key: 'openboxDigest', recorded: v2?.openboxDigest, consumer: p.names.windowManager }] : [],
    { path: p.supervisorConfig, text: json(supervisor), key: 'supervisorConfigDigest', recorded: v2?.supervisorConfigDigest, consumer: p.names.supervisor },
    { path: p.config, text: json(controller), key: 'configDigest', recorded: (v2 ?? v1)?.configDigest, consumer: p.names.controller },
    ...names.map(name => ({ path: unitPath(p, name), text: units[name], unit: name, consumer: name,
      recorded: v2?.units?.[name] ?? (v1 && name === p.names.controller ? v1.serviceDigest : undefined) })),
  ];
  // The v1 controller config and unit count as owned under their v1 digests, so classify verifies them too.
  for (const file of files) {
    if (file.kind !== 'xauthority') file.state = await classify(file.path, file.text, file.recorded, d, h);
    else if (await h.stat(file.path, d)) { await h.privatePath(file.path, 'file', d); file.state = 'current'; }
    else file.state = 'write';
  }
  const status = {};
  for (const name of names) status[name] = await unitStatus(name, p, d);
  // A v1 receipt names its unit before the image build, so a failed build leaves a unit that was never installed.
  const stop = v1 && status[p.names.controller].LoadState !== 'not-found' ? [{ kind: 'unit', unit: p.names.controller }] : [];
  const start = [], restart = [];
  for (const name of names) {
    const unit = files.find(file => file.unit === name);
    const touched = files.some(file => file.consumer === name && file.state !== 'current');
    const active = status[name].ActiveState === 'active' && !(stop.length && name === p.names.controller);
    if (unit.state === 'write' || !active) start.push(name);
    else if (touched) restart.push(name);
  }
  await linger(d, warnings);
  const converted = v1 ? convertedFrom(v1) : v2?.convertedFrom;
  const patch = await hostConfigPatch(o, p, v2, d, h, { convertingFrom: converted, cdpPort });
  const previousDefaultProfile = v2 ? v2.previousDefaultProfile ?? null : (await h.configSection('browser', d)).defaultProfile ?? null;
  return {
    option: 'new', profile: 'clawser', display, cdpPort, port, userDataDir: p.profileDir, browser, units,
    writes: files.filter(file => file.state !== 'current').map(file => ({ path: file.path, digest: file.text === undefined ? null : sha256(file.text), ...file.unit ? { unit: file.unit } : {}, consumer: file.consumer })),
    start, restart, stop, takeover: [], disruptive: restart.some(name => [p.names.display, p.names.windowManager, p.names.browser].includes(name)),
    warnings, ...converted ? { dockerLeftovers: dockerLeftovers(converted) } : {},
    patch, previousDefaultProfile, hostDeps: host, openboxSource: source, files, convertedFrom: converted, receipt: receipt.kind, saved: receipt.saved, locations: p,
  };
}

export const describeHost = plan => [
  'Browser profile: clawser (new and empty, at ' + plan.userDataDir + ')',
  'Display: :' + plan.display,
  'Browser: ' + plan.browser.path,
  ...plan.stop.map(item => 'Stop the Docker-era controller ' + item.unit),
  ...plan.writes.map(item => 'Write ' + (item.unit ?? item.path)),
  ...plan.start.map(name => 'Start ' + name),
  ...plan.restart.map(name => 'Restart ' + name),
  'Default browser profile: ' + (plan.previousDefaultProfile ?? 'none') + ' → clawser',
  ...(plan.dockerLeftovers ?? []).map(command => 'Run yourself afterwards: ' + command),
  ...plan.warnings.map(text => 'Warning: ' + text),
];

function assertHealth(health, cdpPort) {
  if (health?.ready !== true || health.recoveryRequired === true || health.profile !== 'clawser' || health.cdpUrl !== cdpUrlFor(cdpPort)) throw new Error('Controller health or profile identity is not ready; inspect its user-service journal before retrying');
}

const record = (saved, file, digest) => { if (file.unit) saved.units[file.unit] = digest; else if (file.key) saved[file.key] = digest; };
const save = (saved, p, d, h) => h.atomicPrivate(p.marker, json(saved), d);

function receiptFor(plan, o, d, extra) {
  const p = plan.locations;
  return { identity, uid: d.uid, option: 'new', profile: 'clawser', cdpPort: plan.cdpPort, port: plan.port, display: plan.display,
    stateDir: o.stateDir, packageDir: d.packageDir, execPath: d.execPath, unitDir: p.unitDir, userDataDir: p.profileDir,
    browser: { path: plan.browser.path }, previousDefaultProfile: plan.previousDefaultProfile, units: {}, replaced: [], ...extra,
    ...o.pendingInertDesktop ? { pendingInertDesktop: true } : {} };
}

async function privateDir(path, d, h) {
  await h.noSymlinks(path, d);
  if (await h.stat(path, d)) await h.privatePath(path, 'directory', d);
  else await d.fs.mkdir(path, { mode: 0o700 });
}

export async function applyHost(plan, o, d, h) {
  const p = plan.locations, v1 = plan.receipt === 'v1' ? plan.saved : undefined;
  let saved = plan.receipt === 'v2' ? structuredClone(plan.saved) : undefined;
  if (plan.receipt === 'none') {
    await d.fs.mkdir(dirname(o.stateDir), { recursive: true, mode: 0o700 });
    await h.noSymlinks(o.stateDir, d);
    // Never adopt an unowned directory that appeared after planning.
    await d.fs.mkdir(o.stateDir, { mode: 0o700 });
    await h.privatePath(o.stateDir, 'directory', d);
    saved = receiptFor(plan, o, d, { ownerId: randomUUID() });
    await d.fs.writeFile(p.marker, json(saved), { flag: 'wx', mode: 0o600 });
  }
  const lock = join(o.stateDir, 'setup.lock');
  try { await d.fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Clawser setup is already locked; inspect the existing setup process before retrying'); throw error; }
  try {
    for (const item of plan.stop) {
      await d.run('systemctl', ['--user', 'stop', item.unit]);
      await d.run('systemctl', ['--user', 'disable', item.unit]);
    }
    // The v1 digests carry over so a crash before the rewrite still finds these files owned.
    if (v1) {
      saved = receiptFor(plan, o, d, { ownerId: v1.ownerId, assetsDigest: v1.assetsDigest, configDigest: v1.configDigest, units: v1.serviceDigest ? { [p.names.controller]: v1.serviceDigest } : {}, convertedFrom: plan.convertedFrom });
      await save(saved, p, d, h);
    } else if (plan.receipt === 'v2') {
      Object.assign(saved, { packageDir: d.packageDir, execPath: d.execPath, browser: { path: plan.browser.path } });
      if (!same(saved, plan.saved)) await save(saved, p, d, h);
    }
    for (const path of [p.state, p.runtime, p.vncDir, dirname(p.binary), dirname(p.assets), dirname(p.openboxConfig), dirname(p.profileDir), p.profileDir]) await privateDir(path, d, h);
    const { record: hostDeps, warnings } = await resolver(d).install(plan.hostDeps, d, { previous: saved.hostDeps });
    plan.warnings.push(...warnings ?? []);
    // Re-planning without a window manager here would apply a plan nobody was shown.
    if (plan.units[p.names.windowManager] && !hostDeps.binaries?.openbox) throw new Error('openbox is installed but fails to start; repair or remove it, then rerun setup');
    if (!same(hostDeps, saved.hostDeps)) { saved.hostDeps = hostDeps; await save(saved, p, d, h); }
    await h.assets(p, saved, d);
    let unitsWritten = false;
    for (const file of plan.files) {
      if (file.state === 'current') {
        if (file.text !== undefined && file.recorded !== sha256(file.text)) { record(saved, file, sha256(file.text)); await save(saved, p, d, h); }
        continue;
      }
      if (file.kind === 'xauthority') {
        await h.noSymlinks(file.path, d);
        await d.fs.writeFile(file.path, xauthorityEntry(plan.display, (d.randomBytes ?? randomBytes)(16)), { flag: 'wx', mode: 0o600 });
        continue;
      }
      if (file.text === undefined) await d.run(plan.hostDeps.binaries.python3.path, [p.openboxScript, plan.openboxSource, file.path]);
      else {
        if (file.unit && !unitsWritten) { await h.noSymlinks(p.unitDir, d); await d.fs.mkdir(p.unitDir, { recursive: true, mode: 0o700 }); }
        await h.atomicPrivate(file.path, file.text, d);
      }
      unitsWritten ||= Boolean(file.unit);
      record(saved, file, file.text === undefined ? sha256(await d.fs.readFile(file.path)) : sha256(file.text));
      await save(saved, p, d, h);
    }
    if (unitsWritten) await d.run('systemctl', ['--user', 'daemon-reload']);
    for (const name of ROLES.map(role => p.names[role])) {
      if (plan.start.includes(name)) await d.run('systemctl', ['--user', 'enable', '--now', name]);
      else if (plan.restart.includes(name)) await d.run('systemctl', ['--user', 'restart', name]);
    }
    let healthError;
    for (let attempt = 0; attempt < 120; attempt++) {
      try { assertHealth(await d.controllerHealth(p.socket), plan.cdpPort); healthError = undefined; break; }
      catch (error) { healthError = error; if (attempt !== 119) await d.sleep(250); }
    }
    if (healthError) throw healthError;
    // Re-read immediately before the validated merge so concurrent config edits are preserved.
    const patch = await hostConfigPatch(o, p, saved, d, h, { convertingFrom: plan.convertedFrom, cdpPort: plan.cdpPort });
    const intended = { browser: await h.configSection('browser', d), plugins: await h.configSection('plugins', d) };
    const expected = await captureSetupActivation(intended, patch, d);
    await d.run('openclaw', ['config', 'patch', '--stdin'], { input: JSON.stringify(patch) + '\n' });
    if (saved.pendingInertDesktop || saved.convertedFrom) { delete saved.pendingInertDesktop; delete saved.convertedFrom; await save(saved, p, d, h); }
    await h.reloadPlugin(d);
    return await waitForSetupActivation(expected, d, async () => assertHealth(await d.controllerHealth(p.socket), plan.cdpPort));
  } finally { await d.fs.rm(lock, { recursive: true }); }
}
