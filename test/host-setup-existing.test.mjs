import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { runClawser, setupHelpers } from '../src/setup.mjs';
import { planHost } from '../src/host-setup.mjs';
import { hostWorld, isPatch, systemctl } from './host-fixture.mjs';
import { net, proc, row } from './proc-fixture.mjs';

const RESTARTS = /would restart Chrome, so setup won't stop it/;
const exists = path => fs.lstat(path).then(() => true, () => false);
const userProfile = () => ({ browser: { defaultProfile: 'user', profiles: { user: { cdpUrl: 'http://127.0.0.1:9222', attachOnly: true, driver: 'openclaw' } } } });

// The box's real shape: Chrome, Xvfb :20 and openbox under three hand-written user units, serving profile user on port 9222.
async function handWritten(t, { config = userProfile(), chrome = {}, xvfb = {}, openbox = {}, listen = '0100007F', deps = {} } = {}) {
  const w = await hostWorld(t, { config, deps });
  const uid = w.deps.uid, slice = `0::/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/`;
  w.session = `0::/user.slice/user-${uid}.slice/session-2.scope`;
  w.udd = join(w.root, 'udd');
  await net(w.root, listen ? row(listen, 9222, 4242) : '');
  await proc(w.root, 400, { argv: ['/opt/google/chrome/chrome', `--user-data-dir=${w.udd}`, '--lang=fr', '--remote-debugging-port=9222', '--remote-debugging-address=127.0.0.1', '--window-size=1280,800'],
    env: ['DISPLAY=:20'], cgroup: slice + 'my-chrome.service', sockets: [4242], ...chrome });
  await proc(w.root, 401, { argv: ['/opt/google/chrome/chrome', '--type=renderer'], env: ['DISPLAY=:20'], cgroup: slice + 'my-chrome.service' });
  if (xvfb) await proc(w.root, 300, { exe: '/usr/bin/Xvfb', argv: ['/usr/bin/Xvfb', ':20', '-screen', '0', '1280x800x24'], cgroup: slice + 'my-xvfb.service', ...xvfb });
  if (openbox) await proc(w.root, 350, { exe: '/usr/bin/openbox', argv: ['/usr/bin/openbox'], env: ['DISPLAY=:20'], cgroup: slice + 'my-openbox.service', ...openbox });
  const unit = (name, pid, extra = {}) => ({ MainPID: String(pid), FragmentPath: join(w.unitDir, name), DropInPaths: '', UnitFileState: 'enabled', Environment: '', EnvironmentFiles: '', ...extra });
  w.foreign['my-chrome.service'] = unit('my-chrome.service', 400, { Environment: 'LANG=fr_FR.UTF-8 DISPLAY=:20' });
  w.foreign['my-xvfb.service'] = unit('my-xvfb.service', 300);
  w.foreign['my-openbox.service'] = unit('my-openbox.service', 350);
  w.takeover = [...w.args, '--browser-profile', 'user'];
  // Unit texts never leave runClawser. The rendered units are read from the plan itself.
  w.plan = (extra = {}) => planHost({ command: 'setup', stateDir: w.stateDir, profile: 'user', port: 19420, dryRun: true, yes: false, cdp: false, migrateCookies: true,
    specified: ['--state-dir', '--browser-profile', '--dry-run'], option: 'existing', ...extra }, w.deps, setupHelpers);
  w.unchanged = async () => {
    assert.deepEqual(w.mutations(), []);
    assert.equal(await exists(join(w.root, 'config')), false, 'nothing under XDG_CONFIG_HOME');
    assert.equal(await exists(w.stateDir), false, 'no state dir');
    for (const verb of ['stop', 'disable', 'enable', 'restart', 'daemon-reload']) assert.deepEqual(systemctl(w.calls, verb), [], verb);
    assert.equal(w.calls.some(isPatch), false);
  };
  return w;
}

async function cookieStore(dir, rows) {
  const { DatabaseSync } = await import('node:sqlite');
  await fs.mkdir(join(dir, 'Default/Network'), { recursive: true });
  const db = new DatabaseSync(join(dir, 'Default/Network/Cookies'));
  db.exec('CREATE TABLE cookies (encrypted_value BLOB)');
  const insert = db.prepare('INSERT INTO cookies VALUES (?)');
  for (const value of rows) insert.run(Buffer.from(value));
  db.close();
}

test('option B without --yes prints the takeover and stops, writes and starts nothing', async t => {
  const w = await handWritten(t);
  const result = await runClawser(w.takeover, w.deps);
  assert.equal(result.ok, false);
  const text = result.plan.join('\n');
  for (const unit of ['my-chrome.service', 'my-xvfb.service', 'my-openbox.service']) assert.ok(result.plan.includes(`Take over ${unit} (its unit file is backed up first)`), text);
  assert.ok(result.plan.includes('Display: :20'), text);
  await w.unchanged();
});

test('option B plans to keep the display, profile, port and other flags of hand-written units', async t => {
  const w = await handWritten(t);
  const result = await runClawser([...w.takeover, '--dry-run'], w.deps);
  assert.equal(result.ok, true);
  const plan = await w.plan();
  const unit = plan.units[plan.locations.names.browser];
  for (const want of [`--user-data-dir=${w.udd}`, '--lang=fr', '--remote-debugging-port=9222', 'DISPLAY=:20']) assert.ok(unit.includes(want), want);
  assert.equal(unit.split('LANG=fr_FR.UTF-8').length - 1, 1, unit);
  assert.equal(unit.includes('--window-size=1280,800'), false);
  assert.equal(result.patch.browser.profiles, undefined);
  assert.equal(result.patch.browser.defaultProfile, 'user');
  const config = result.patch.plugins.entries['browser-handoff'].config;
  assert.equal(config.desktop.profile, 'user');
  assert.equal(Object.hasOwn(config, 'profiles'), false);
  assert.ok(result.plan.includes('Default browser profile: user (unchanged)'), result.plan.join('\n'));
  assert.ok(result.plan.includes(`Browser profile: user (existing, at ${w.udd})`), result.plan.join('\n'));
  assert.ok(result.plan.includes('Browser: /opt/google/chrome/chrome'), result.plan.join('\n'));
  assert.deepEqual(plan.takeover.map(item => [item.role, item.unit, item.wasEnabled]), [['browser', 'my-chrome.service', true], ['display', 'my-xvfb.service', true], ['windowManager', 'my-openbox.service', true]]);
  assert.equal(plan.disruptive, true);
  await w.unchanged();
});

test('option B on a desktop-session Chrome plans to close it on a free display, keeping only locale settings', async t => {
  const w = await handWritten(t, { xvfb: null, openbox: null, deps: { freeDisplay: async () => 21 } });
  await fs.rm(join(w.root, 'proc/400'), { recursive: true });
  await proc(w.root, 400, { argv: ['/opt/google/chrome/chrome', `--user-data-dir=${w.udd}`], cgroup: w.session, sockets: [4242],
    env: ['DISPLAY=:0', 'LANG=fr_FR.UTF-8', 'LC_TIME=en_GB.UTF-8', 'TZ=Europe/Paris', 'SECRET_TOKEN=hunter2'] });
  const result = await runClawser([...w.takeover, '--dry-run'], w.deps);
  assert.ok(result.plan.includes('Close the browser running in your desktop session (pid 400)'), result.plan.join('\n'));
  assert.ok(result.plan.includes('Display: :21'), result.plan.join('\n'));
  assert.equal(result.plan.some(line => line.startsWith('Take over ')), false);
  const plan = await w.plan();
  const unit = plan.units[plan.locations.names.browser];
  for (const want of ['LANG=fr_FR.UTF-8', 'LC_TIME=en_GB.UTF-8', 'TZ=Europe/Paris', 'DISPLAY=:21']) assert.ok(unit.includes(want), want);
  assert.deepEqual(plan.browser.env, [['LANG', 'fr_FR.UTF-8'], ['LC_TIME', 'en_GB.UTF-8'], ['TZ', 'Europe/Paris']]);
  assert.deepEqual(plan.stop, [{ kind: 'close-browser', pid: 400 }]);
  for (const text of [unit, JSON.stringify(result), w.logs.join('\n'), JSON.stringify(plan.writes)]) assert.doesNotMatch(text, /SECRET_TOKEN|hunter2/);
  await w.unchanged();
});

test('option B refuses a headless or exposed Chrome before changing anything', async t => {
  const headless = await handWritten(t, { chrome: { argv: ['/opt/google/chrome/chrome', '--headless=new', `--user-data-dir=/tmp/udd`, '--remote-debugging-port=9222'] } });
  await assert.rejects(runClawser(headless.takeover, headless.deps), /headless/);
  await headless.unchanged();
  const exposed = await handWritten(t, { listen: '00000000' });
  await assert.rejects(runClawser(exposed.takeover, exposed.deps), /other machines can reach/);
  await exposed.unchanged();
});

test('option B fails when nothing listens on the profile port', async t => {
  const w = await handWritten(t, { listen: null });
  await assert.rejects(runClawser(w.takeover, w.deps), { message: 'Nothing is listening on http://127.0.0.1:9222. Start that browser, then rerun setup.' });
  await assert.rejects(runClawser(w.takeover, w.deps), /Start that browser, then rerun setup/);
  await w.unchanged();
});

test('option B refuses a Chrome that an unrecognized service would restart', async t => {
  const system = await handWritten(t, { chrome: { cgroup: '0::/system.slice/chrome.service' } });
  await assert.rejects(runClawser(system.takeover, system.deps), { message: "/system.slice/chrome.service would restart Chrome, so setup won't stop it. Stop it from managing Chrome, start Chrome by hand with the same profile, then rerun setup." });
  await system.unchanged();
  const otherPid = await handWritten(t);
  otherPid.foreign['my-chrome.service'].MainPID = '999';
  await assert.rejects(runClawser(otherPid.takeover, otherPid.deps), RESTARTS);
  await assert.rejects(runClawser(otherPid.takeover, otherPid.deps), /^Error: my-chrome\.service would restart/);
  await otherPid.unchanged();
  const etc = await handWritten(t);
  etc.foreign['my-chrome.service'].FragmentPath = '/etc/systemd/user/my-chrome.service';
  await assert.rejects(runClawser(etc.takeover, etc.deps), RESTARTS);
  await etc.unchanged();
});

test('an Xvfb outside a unit leaves that display running and moves the browser to a free one', async t => {
  const w = await handWritten(t, { deps: { freeDisplay: async () => 21 } });
  await fs.writeFile(join(w.root, 'proc/300/cgroup'), w.session + '\n');
  const result = await runClawser([...w.takeover, '--dry-run'], w.deps);
  const takeovers = result.plan.filter(line => line.startsWith('Take over '));
  assert.deepEqual(takeovers, ['Take over my-chrome.service (its unit file is backed up first)']);
  assert.ok(result.plan.includes('Display: :21'), result.plan.join('\n'));
  assert.ok(result.plan.includes("Warning: Display :20 stays running; Clawser's browser uses :21."), result.plan.join('\n'));
  const plan = await w.plan();
  assert.match(plan.units[plan.locations.names.browser], /DISPLAY=:21/);
  await w.unchanged();
});

test('keyring cookies are counted for migration, and --no-migrate-cookies warns how many logins will be lost', async t => {
  const w = await handWritten(t);
  await cookieStore(w.udd, ['v11a', 'v11b', 'v11c', 'v10a', 'v10b']);
  const migrate = await runClawser([...w.takeover, '--dry-run'], w.deps);
  assert.ok(migrate.plan.includes('Move 3 keyring-encrypted cookies into the new browser'), migrate.plan.join('\n'));
  assert.deepEqual((await w.plan()).cookies, { migrate: true, count: 3 });
  const lose = await runClawser([...w.takeover, '--dry-run', '--no-migrate-cookies'], w.deps);
  assert.ok(lose.plan.includes("Warning: 3 keyring-encrypted cookies will be unreadable; you'll need to sign in to those sites again."), lose.plan.join('\n'));
  assert.equal(lose.plan.some(line => line.startsWith('Move ')), false);
  await w.unchanged();
});

test('a CDP install without the explicit mark upgrades through option B with its profile', async t => {
  const w = await handWritten(t);
  w.config.plugins = { entries: { 'browser-handoff': { enabled: true, config: { desktop: { enabled: false }, funnel: { enabled: false }, profiles: { user: 'http://127.0.0.1:9222' }, port: 18796,
    cloudflare: { enabled: true, binaryPath: join(w.root, '.openclaw/clawser-cdp/bin/cloudflared'), startupTimeoutMs: 90_000 } } } } };
  const cdpDir = join(w.root, '.openclaw/clawser-cdp');
  await fs.mkdir(cdpDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(join(cdpDir, 'setup.json'), JSON.stringify({ identity: 'clawser-cdp-setup-v1', uid: w.deps.uid, ownerId: randomUUID(), stateDir: cdpDir, binaryDigest: w.artifacts.cloudflared.sha256 }) + '\n', { mode: 0o600 });
  const result = await runClawser([...w.args, '--dry-run'], w.deps);
  assert.equal(result.ok, true);
  assert.ok(result.plan.includes(`Browser profile: user (existing, at ${w.udd})`), result.plan.join('\n'));
  assert.ok(result.plan.includes('Take over my-chrome.service (its unit file is backed up first)'), result.plan.join('\n'));
  assert.equal(result.patch.browser.defaultProfile, 'user');
  const config = result.patch.plugins.entries['browser-handoff'].config;
  assert.equal(config.desktop.profile, 'user');
  assert.equal(Object.hasOwn(config, 'profiles'), false);
  await w.unchanged();
  // A default profile the takeover can't use is refused with both ways forward.
  w.config.browser.defaultProfile = 'missing';
  await assert.rejects(runClawser([...w.args, '--dry-run'], w.deps), /^Error: The CDP install has no usable default browser profile \(.+\)\. Rerun setup with --browser-profile <name>, or setup --cdp to keep the CDP viewer\.$/);
});

const MY_UNITS = ['my-chrome.service', 'my-openbox.service', 'my-xvfb.service'];
const COOKIE_METHODS = ['exportCookies', 'importCookies', 'closeBrowser', 'flushCookies', 'countCookies'];
const KEEPS = "The agent's browser keeps the logins from user.";
const GOOGLE = 'Sign in to Google once in a handoff link, and re-save any saved site passwords.';
const DROP_IN = '[Service]\nTimeoutStopSec=5\n';
const healthyUser = async () => ({ ready: true, profile: 'user', cdpUrl: 'http://127.0.0.1:9222', recoveryRequired: false });
const verb = name => call => call.command === 'systemctl' && call.args[1] === name;
const cookieCall = method => call => call.command === 'cookies' && call.args[0] === method;
const exportsThree = async (url, dir) => { const path = join(dir, 'cookies.json'); await fs.writeFile(path, '[]', { mode: 0o600 }); return { path, count: 3 }; };

// handWritten plus what applying option B touches: the my-* unit files on disk (my-chrome.service has a drop-in),
// a controller healthy on profile user, and a cookie module whose calls land in w.calls beside systemctl and openclaw.
async function applyWorld(t, options = {}) {
  const w = await handWritten(t, { ...options, deps: { controllerHealth: healthyUser, ...options.deps } });
  w.originals = {};
  await fs.mkdir(join(w.unitDir, 'my-chrome.service.d'), { recursive: true });
  for (const name of MY_UNITS) await fs.writeFile(join(w.unitDir, name), w.originals[name] = `[Service]\nExecStart=/usr/bin/true ${name}\n`);
  w.dropIn = join(w.unitDir, 'my-chrome.service.d/override.conf');
  await fs.writeFile(w.dropIn, DROP_IN);
  w.foreign['my-chrome.service'].DropInPaths = w.dropIn;
  w.cookies = {
    exportCookies: async (url, dir) => { const path = join(dir, 'cookies.json'); await fs.writeFile(path, '[]', { mode: 0o600 }); return { path, count: 0 }; },
    importCookies: async () => ({ count: 0 }), flushCookies: async () => {}, countCookies: async () => 0, closeBrowser: async () => {},
  };
  w.cookieArgs = {};
  w.deps.cookieMigration = Object.fromEntries(COOKIE_METHODS.map(method => [method, async (...args) => {
    w.calls.push({ command: 'cookies', args: [method, args[0]] });
    w.cookieArgs[method] = args;
    return w.cookies[method](...args);
  }]));
  const run = w.deps.run;
  w.deps.run = async (command, args = [], more) => {
    if (command === 'systemctl' && args[1] === 'stop' && !w.atFirstStop) w.atFirstStop = await w.receipt();
    return run(command, args, more);
  };
  w.yes = [...w.takeover, '--yes'];
  return w;
}

// 8a test 3's world: Chrome runs in the desktop session, with no display units.
async function sessionWorld(t) {
  const w = await applyWorld(t, { xvfb: null, openbox: null, deps: { freeDisplay: async () => 21 } });
  await fs.rm(join(w.root, 'proc/400'), { recursive: true });
  await proc(w.root, 400, { argv: ['/opt/google/chrome/chrome', `--user-data-dir=${w.udd}`], cgroup: w.session, sockets: [4242], env: ['DISPLAY=:0', 'LANG=fr_FR.UTF-8'] });
  return w;
}

test('option B takes over hand-written units with --yes, backing them up and recording them before the first stop', async t => {
  const w = await applyWorld(t);
  const result = await runClawser(w.yes, w.deps);
  assert.equal(result.ok, true);
  const calls = w.calls, firstStop = calls.findIndex(verb('stop'));
  const unitWrite = call => call.command === 'fs' && String(call.args[1]).startsWith(w.unitDir + '/');
  assert.ok(calls.some(unitWrite) && calls.some(verb('daemon-reload')));
  assert.ok(firstStop > calls.findLastIndex(unitWrite) && firstStop > calls.findIndex(verb('daemon-reload')), JSON.stringify({ firstStop, write: calls.findLastIndex(unitWrite) }));
  assert.deepEqual(systemctl(calls, 'stop'), MY_UNITS);
  assert.deepEqual(systemctl(calls, 'disable'), MY_UNITS);
  assert.deepEqual(systemctl(calls, 'enable'), result.units);
  assert.ok(calls.findIndex(verb('enable')) > calls.findLastIndex(verb('disable')));
  const backup = w.atFirstStop?.replaced?.[0]?.backup;
  assert.deepEqual(w.atFirstStop.replaced, [
    { unit: 'my-chrome.service', fragmentPath: join(w.unitDir, 'my-chrome.service'), dropIns: [w.dropIn], wasEnabled: true, backup },
    { unit: 'my-openbox.service', fragmentPath: join(w.unitDir, 'my-openbox.service'), dropIns: [], wasEnabled: true, backup },
    { unit: 'my-xvfb.service', fragmentPath: join(w.unitDir, 'my-xvfb.service'), dropIns: [], wasEnabled: true, backup },
  ]);
  assert.equal(dirname(backup), join(w.stateDir, 'backups'));
  assert.match(basename(backup), /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  for (const dir of [dirname(backup), backup]) assert.equal((await fs.stat(dir)).mode & 0o777, 0o700, dir);
  for (const name of MY_UNITS) {
    assert.deepEqual(await fs.readFile(join(backup, name)), Buffer.from(w.originals[name]), name);
    assert.equal((await fs.stat(join(backup, name))).mode & 0o777, 0o600, name);
    assert.equal(await fs.readFile(join(w.unitDir, name), 'utf8'), w.originals[name], 'the original unit file stays in place');
  }
  assert.equal(await fs.readFile(join(backup, 'my-chrome.service.d/override.conf'), 'utf8'), DROP_IN);
  assert.equal((await fs.stat(join(backup, 'my-chrome.service.d/override.conf'))).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(w.dropIn, 'utf8'), DROP_IN);
  assert.equal(await exists(join(w.stateDir, 'browser')), false, 'option B never creates a profile folder');
  const saved = await w.receipt();
  assert.equal(saved.option, 'existing');
  assert.equal(saved.profile, 'user');
  assert.equal(saved.userDataDir, w.udd);
  assert.deepEqual(saved.browser, { path: '/opt/google/chrome/chrome',
    existingArgs: [`--user-data-dir=${w.udd}`, '--lang=fr', '--remote-debugging-port=9222', '--remote-debugging-address=127.0.0.1', '--window-size=1280,800'], env: [['LANG', 'fr_FR.UTF-8']] });
  assert.deepEqual(saved.replaced, w.atFirstStop.replaced);
  assert.equal(JSON.parse(calls.find(isPatch).input).browser.defaultProfile, 'user');
  assert.equal(w.config.browser.defaultProfile, 'user');
  assert.equal(w.config.plugins.entries['browser-handoff'].config.desktop.profile, 'user');
  assert.ok(w.logs.includes(KEEPS), w.logs.join('\n'));
  assert.equal(w.logs.some(line => line.includes('starts with no logins')), false);
  assert.equal(w.logs.includes(GOOGLE), false);
  assert.equal(calls.some(call => call.command === 'cookies'), false, 'no cookies, so no cookie calls');
});

test("keyring cookies are exported before the first stop and imported after Clawser's browser is healthy, and the temp folder is removed", async t => {
  const w = await applyWorld(t);
  await cookieStore(w.udd, ['v11a', 'v11b', 'v11c']);
  Object.assign(w.cookies, { exportCookies: exportsThree, importCookies: async () => ({ count: 3 }), countCookies: async () => 3 });
  const result = await runClawser(w.yes, w.deps);
  assert.equal(result.ok, true);
  const calls = w.calls;
  const order = [calls.findIndex(cookieCall('exportCookies')), calls.findIndex(verb('stop')), calls.findLastIndex(verb('enable')),
    calls.findIndex(cookieCall('importCookies')), calls.findIndex(cookieCall('flushCookies')), calls.findIndex(cookieCall('countCookies')), calls.findIndex(isPatch)];
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), JSON.stringify(order));
  const url = 'http://127.0.0.1:9222';
  assert.deepEqual(calls.filter(call => call.command === 'cookies').map(call => call.args), [['exportCookies', url], ['importCookies', url], ['flushCookies', url], ['countCookies', url]]);
  const dir = w.cookieArgs.exportCookies[1];
  assert.equal(dirname(dir), w.stateDir);
  assert.match(basename(dir), /^cookies-/);
  assert.equal(w.cookieArgs.importCookies[1], join(dir, 'cookies.json'));
  assert.equal(await exists(dir), false, 'the temp folder is removed');
  const saved = await w.receipt();
  assert.deepEqual(saved.cookieMigration, { exported: 3, imported: 3, at: saved.cookieMigration?.at });
  assert.match(saved.cookieMigration.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(w.logs.includes(GOOGLE), w.logs.join('\n'));
  assert.ok(w.logs.includes(KEEPS), w.logs.join('\n'));
});

test('a failed cookie export stops and closes nothing', async t => {
  const w = await applyWorld(t);
  await cookieStore(w.udd, ['v11a', 'v11b', 'v11c']);
  w.cookies.exportCookies = async () => { throw new Error('boom'); };
  await assert.rejects(runClawser(w.yes, w.deps), { message: 'Could not read cookies from the running browser (boom). Nothing was stopped; rerun setup, or use --no-migrate-cookies.' });
  assert.ok(w.calls.some(cookieCall('exportCookies')));
  for (const name of ['stop', 'disable', 'enable']) assert.deepEqual(systemctl(w.calls, name), [], name);
  assert.equal(w.calls.some(cookieCall('closeBrowser')), false);
  assert.equal(w.calls.some(isPatch), false);
  assert.deepEqual((await fs.readdir(w.stateDir)).filter(name => name.startsWith('cookies-')), []);
  assert.equal(await exists(join(w.stateDir, 'backups')), false, 'nothing is backed up before the export');
  assert.equal(await exists(join(w.stateDir, 'setup.lock')), false);
});

test('a failed cookie import warns and still finishes setup', async t => {
  const w = await applyWorld(t);
  await cookieStore(w.udd, ['v11a', 'v11b', 'v11c']);
  Object.assign(w.cookies, { exportCookies: exportsThree, importCookies: async () => { throw new Error('nope'); } });
  const result = await runClawser(w.yes, w.deps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings.filter(text => text.startsWith('Moving cookies')), ['Moving cookies failed (nope); sign in again to sites that ask.']);
  const saved = await w.receipt();
  assert.equal(saved.cookieMigration.failed, true);
  assert.equal(saved.cookieMigration.imported, 0);
  assert.equal(saved.cookieMigration.exported, 3);
  assert.equal(w.logs.includes(GOOGLE), false);
  assert.ok(w.logs.includes(KEEPS), w.logs.join('\n'));
  assert.equal(await exists(w.cookieArgs.exportCookies[1]), false, 'the temp folder is removed');
});

test('option B closes a desktop-session Chrome and waits for it to exit', async t => {
  const w = await sessionWorld(t);
  w.cookies.closeBrowser = async () => { await fs.rm(join(w.root, 'proc/400'), { recursive: true }); };
  const result = await runClawser(w.yes, w.deps);
  assert.equal(result.ok, true);
  assert.equal(w.cookieArgs.closeBrowser?.[0], 'http://127.0.0.1:9222');
  const close = w.calls.findIndex(cookieCall('closeBrowser')), reload = w.calls.findIndex(verb('daemon-reload'));
  assert.ok(reload >= 0 && close > reload && close < w.calls.findIndex(verb('enable')), JSON.stringify({ reload, close }));
  for (const name of ['stop', 'disable']) assert.deepEqual(systemctl(w.calls, name).filter(unit => unit.startsWith('my-')), [], name);
  assert.ok(w.logs.includes(KEEPS), w.logs.join('\n'));
});

test('a desktop-session Chrome that does not close within 30 seconds stops setup before anything starts', async t => {
  const w = await sessionWorld(t);
  await assert.rejects(runClawser(w.yes, w.deps), error => error.message.startsWith('The browser did not close within 30 seconds; close it yourself, then rerun setup.'));
  assert.equal(w.calls.filter(cookieCall('closeBrowser')).length, 1);
  for (const name of ['enable', 'restart']) assert.deepEqual(systemctl(w.calls, name), [], name);
  assert.equal(w.calls.some(isPatch), false);
});

test('a failure after the takeover names the stopped units and their backups', async t => {
  const w = await applyWorld(t, { deps: { controllerHealth: async () => ({ ready: false }) } });
  const error = await runClawser(w.yes, w.deps).then(() => assert.fail('setup should fail'), failure => failure);
  const { replaced } = await w.receipt();
  assert.ok(replaced[0]?.backup, 'the receipt records the backup');
  assert.ok(error.message.endsWith(` Setup already stopped my-chrome.service, my-openbox.service, my-xvfb.service; rerun setup to finish. Their unit files are unchanged, with copies in ${replaced[0].backup}.`), error.message);
  assert.match(error.message, /^Controller health or profile identity is not ready/);
});

test('option B on an option A install or a Docker-era install is refused', async t => {
  const a = await handWritten(t);
  assert.equal((await runClawser(a.args, a.deps)).ok, true);
  a.calls.length = 0;
  await assert.rejects(runClawser(a.takeover, a.deps), /Setup arguments conflict/);
  assert.deepEqual(a.mutations(), []);
  const docker = await handWritten(t);
  await fs.mkdir(docker.stateDir, { mode: 0o700 });
  await fs.writeFile(join(docker.stateDir, 'setup.json'), JSON.stringify({ identity: 'clawser-setup-v1', uid: docker.deps.uid, ownerId: randomUUID() }) + '\n', { mode: 0o600 });
  docker.calls.length = 0;
  await assert.rejects(runClawser(docker.takeover, docker.deps), { message: 'This state folder holds a Docker-era install, which converts to a new browser profile only. Run setup without --browser-profile, or choose another --state-dir.' });
  await assert.rejects(runClawser(docker.takeover, docker.deps), /Docker-era install, which converts to a new browser profile only/);
  assert.deepEqual(docker.mutations(), []);
});

test('option B refuses a profile or Chrome it cannot read cleanly', async t => {
  const cases = [
    [w => { w.config.browser.profiles.user.cdpUrl = 'http://[::1]:9222'; }, "Browser profile user points at [::1]; Clawser's browser listens on 127.0.0.1. Point it at http://127.0.0.1:9222, then rerun setup."],
    [w => { delete w.config.browser.profiles.user.attachOnly; }, /^Browser profile user can't be taken over: Browser profile requires attachOnly=true/],
    [async w => { await fs.writeFile(join(w.root, 'proc/400/cmdline'), '/opt/google/chrome/chrome\0--remote-debugging-port=9222\0'); },
      "The browser on port 9222 has no --user-data-dir, so setup can't tell which profile folder it uses. Restart it with --user-data-dir, then rerun setup."],
    [async w => { await fs.writeFile(join(w.root, 'proc/400/cmdline'), '/opt/google/chrome/chrome\0--user-data-dir=udd\0'); },
      'The browser on port 9222 uses a relative --user-data-dir; restart it with an absolute path, then rerun setup.'],
    [async w => { await fs.rm(join(w.root, 'proc/400/exe')); await fs.symlink('/opt/google/chrome/chrome (deleted)', join(w.root, 'proc/400/exe')); },
      'Chrome was upgraded while it was running; restart it, then rerun setup.'],
    [w => { w.foreign['my-chrome.service'].Environment = '"LANG=fr_FR.UTF-8'; },
      'Could not read the Environment= settings of my-chrome.service; move them onto the Chrome command line or remove them, then rerun setup.'],
    [w => { w.foreign['my-chrome.service'].Environment = 'LANG=fr_FR.UTF-8 NOVALUE'; }, /^Could not read the Environment= settings of my-chrome\.service/],
    [w => { w.foreign['my-chrome.service'].Environment = '"GREETING=a\tb"'; }, /^Could not read the Environment= settings of my-chrome\.service/],
    [w => { w.foreign['my-chrome.service'].Environment = '"GREETING=a\\qb"'; }, /^Could not read the Environment= settings of my-chrome\.service/],
    [w => { w.foreign['my-chrome.service'].DropInPaths = '"/home/me/a\\qb.conf"'; }, RESTARTS],
    [async w => { await fs.rm(join(w.root, 'proc/400/exe')); await fs.symlink('/snap/chromium/123/usr/lib/chromium-browser/chrome', join(w.root, 'proc/400/exe')); }, /^Snap Chromium can't use the hidden folder/],
    [async w => { await fs.writeFile(join(w.root, 'proc/400/cgroup'), `0::/user.slice/user-${w.deps.uid}.slice/user@${w.deps.uid}.service/app.slice/${w.names.browser}\n`); }, /^Setup arguments conflict/],
    [async w => { await net(w.root, ''); w.busy([9222]); }, 'port 9222 is in use'],
  ];
  for (const [change, message] of cases) {
    const w = await handWritten(t);
    await change(w);
    await assert.rejects(runClawser(w.takeover, w.deps), typeof message === 'string' ? { message } : error => message.test(error.message));
    await w.unchanged();
  }
  const quoted = await handWritten(t);
  quoted.foreign['my-chrome.service'].Environment = 'LANG=fr_FR.UTF-8 "GREETING=a \\"b\\" c\\\\d" XAUTHORITY=/x DBUS_SESSION_BUS_ADDRESS=unix:path=/run/bus';
  quoted.foreign['my-chrome.service'].EnvironmentFiles = '/home/me/chrome.env (ignore_errors=no)';
  const plan = await quoted.plan();
  assert.deepEqual(plan.browser.env, [['LANG', 'fr_FR.UTF-8'], ['GREETING', 'a "b" c\\d']]);
  assert.ok(plan.warnings.includes("my-chrome.service loads an EnvironmentFile, which Clawser's browser unit does not; copy anything Chrome needs onto its command line."), plan.warnings.join('\n'));
  // systemd's shell_maybe_quote escapes $ and ` inside double quotes.
  const escaped = await handWritten(t);
  escaped.foreign['my-chrome.service'].Environment = '"PRICE=\\$5 \\`date\\`" LANG=C';
  assert.deepEqual((await escaped.plan()).browser.env, [['PRICE', '$5 `date`'], ['LANG', 'C']]);
  // It quotes a drop-in path that holds a space, too.
  const spaced = await handWritten(t);
  const odd = join(spaced.unitDir, 'my-chrome.service.d/my override.conf'), plain = join(spaced.unitDir, 'my-chrome.service.d/plain.conf');
  spaced.foreign['my-chrome.service'].DropInPaths = `"${odd}" ${plain}`;
  assert.deepEqual((await spaced.plan()).takeover[0].dropIns, [odd, plain]);
});
