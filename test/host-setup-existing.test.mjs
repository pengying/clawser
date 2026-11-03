import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { runClawser } from '../src/setup.mjs';
import { describeHost } from '../src/host-setup.mjs';
import { classifyOwner, portHolder } from '../src/host-browser.mjs';
import { isPatch, movePackage, systemctl } from './host-fixture.mjs';
import { DROP_IN, MY_UNITS, SAVED_COOKIES, applyWorld, cookieDirs, cookieStore, exportsThree, handWritten, healthyUser } from './host-existing-fixture.mjs';
import { NUL, net, proc, row } from './proc-fixture.mjs';

const RESTARTS = /would restart Chrome, so setup won't stop it/;
const exists = path => fs.lstat(path).then(() => true, () => false);

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

// A CDP install from before the explicit mark, bound to profile user, with its desktop off.
async function unmarkedCdp(w) {
  w.config.plugins = { entries: { 'browser-handoff': { enabled: true, config: { desktop: { enabled: false }, funnel: { enabled: false }, profiles: { user: 'http://127.0.0.1:9222' }, port: 18796,
    cloudflare: { enabled: true, binaryPath: join(w.root, '.openclaw/clawser-cdp/bin/cloudflared'), startupTimeoutMs: 90_000 } } } } };
  const cdpDir = join(w.root, '.openclaw/clawser-cdp');
  await fs.mkdir(cdpDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(join(cdpDir, 'setup.json'), JSON.stringify({ identity: 'clawser-cdp-setup-v1', uid: w.deps.uid, ownerId: randomUUID(), stateDir: cdpDir, binaryDigest: w.artifacts.cloudflared.sha256 }) + '\n', { mode: 0o600 });
}

test('a CDP install without the explicit mark upgrades through option B with its profile', async t => {
  const w = await handWritten(t);
  await unmarkedCdp(w);
  // Only the default state folder continues the CDP install.
  const plain = ['setup', '--dry-run'];
  const result = await runClawser(plain, w.deps);
  assert.equal(result.ok, true);
  assert.ok(result.plan.includes(`Browser profile: user (existing, at ${w.udd})`), result.plan.join('\n'));
  assert.ok(result.plan.includes('Take over my-chrome.service (its unit file is backed up first)'), result.plan.join('\n'));
  assert.equal(result.patch.browser.defaultProfile, 'user');
  const config = result.patch.plugins.entries['browser-handoff'].config;
  assert.equal(config.desktop.profile, 'user');
  assert.equal(Object.hasOwn(config, 'profiles'), false);
  await w.unchanged();
  assert.equal(await exists(join(w.root, '.openclaw/clawser')), false);
  // A default profile the takeover can't use is refused with both ways forward.
  w.config.browser.defaultProfile = 'missing';
  await assert.rejects(runClawser(plain, w.deps), /^Error: The CDP install has no usable default browser profile \(.+\)\. Rerun setup with --browser-profile <name>, or setup --cdp to keep the CDP viewer\.$/);
});

test("an explicit --state-dir does not inherit the CDP viewer's profile", async t => {
  const w = await handWritten(t);
  await unmarkedCdp(w);
  const result = await runClawser([...w.args, '--dry-run'], w.deps);
  assert.equal(result.ok, true);
  assert.ok(result.plan.includes(`Browser profile: clawser (new and empty, at ${join(w.stateDir, 'browser/profile')})`), result.plan.join('\n'));
  assert.equal(result.plan.some(line => line.startsWith('Take over ') || line.startsWith('Close ')), false, result.plan.join('\n'));
  assert.equal(result.patch.browser.defaultProfile, 'clawser');
  await w.unchanged();
});

const SAVED = ' Its cookies are saved and move over when you rerun setup.';
const DROP_INS = unit => `Could not read the drop-in paths of ${unit}; rerun setup after removing quotes or backslashes from their names.`;
const KEEPS = "The agent's browser keeps the logins from user.";
const GOOGLE = 'Sign in to Google once in a handoff link, and re-save any saved site passwords.';
const verb = name => call => call.command === 'systemctl' && call.args[1] === name;
const cookieCall = method => call => call.command === 'cookies' && call.args[0] === method;

// Chrome runs in the desktop session, with no display units.
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
    calls.findIndex(cookieCall('waitForBrowser')), calls.findIndex(cookieCall('importCookies')), calls.findIndex(cookieCall('flushCookies')), calls.findIndex(cookieCall('countCookies')), calls.findIndex(isPatch)];
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), JSON.stringify(order));
  const url = 'http://127.0.0.1:9222';
  assert.deepEqual(calls.filter(call => call.command === 'cookies').map(call => call.args), [['exportCookies', url], ['waitForBrowser', url], ['importCookies', url], ['flushCookies', url], ['countCookies', url]]);
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
  // A re-count that fails after the import and flush keeps the import's own count.
  const recount = await applyWorld(t);
  await cookieStore(recount.udd, ['v11a', 'v11b', 'v11c']);
  Object.assign(recount.cookies, { exportCookies: exportsThree, importCookies: async () => ({ count: 2 }), countCookies: async () => { throw new Error('gone'); } });
  const again = await runClawser(recount.yes, recount.deps);
  assert.equal(again.ok, true);
  const { cookieMigration } = await recount.receipt();
  assert.deepEqual(cookieMigration, { exported: 3, imported: 2, at: cookieMigration.at });
  assert.equal(again.warnings.some(text => text.startsWith('Moving cookies')), false);
  assert.ok(recount.logs.includes(GOOGLE), recount.logs.join('\n'));
  assert.deepEqual(await cookieDirs(recount), []);
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
  assert.deepEqual(await cookieDirs(w), []);
  assert.equal(await exists(join(w.stateDir, 'backups')), false, 'nothing is backed up before the export');
  assert.equal(await exists(join(w.stateDir, 'setup.lock')), false);
});

test('a failed cookie import warns and still finishes setup', async t => {
  const w = await applyWorld(t);
  await cookieStore(w.udd, ['v11a', 'v11b', 'v11c']);
  Object.assign(w.cookies, { exportCookies: exportsThree, importCookies: async () => { throw new Error('nope'); } });
  const result = await runClawser(w.yes, w.deps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings.filter(text => text.startsWith('Moving cookies')), ['Moving cookies failed (nope); rerun setup to try again, or sign in again to sites that ask.']);
  const saved = await w.receipt();
  assert.equal(saved.cookieMigration.failed, true);
  assert.equal(saved.cookieMigration.imported, 0);
  assert.equal(saved.cookieMigration.exported, 3);
  assert.equal(w.logs.includes(GOOGLE), false);
  assert.ok(w.logs.includes(KEEPS), w.logs.join('\n'));
  // Clawser's browser can't read the profile's keyring cookies, so the export is the only readable copy until an import runs.
  const kept = async world => {
    const dirs = await cookieDirs(world);
    assert.deepEqual(dirs, [basename(world.cookieArgs.exportCookies[1])]);
    assert.ok(await exists(join(world.stateDir, dirs[0], 'cookies.json')));
  };
  await kept(w);
  // A browser that never answers keeps the export too, and nothing is imported.
  const slow = await applyWorld(t);
  await cookieStore(slow.udd, ['v11a', 'v11b', 'v11c']);
  Object.assign(slow.cookies, { exportCookies: exportsThree, waitForBrowser: async () => { throw new Error('slow'); } });
  const late = await runClawser(slow.yes, slow.deps);
  assert.equal(late.ok, true);
  assert.deepEqual(late.warnings.filter(text => text.startsWith('Moving cookies')), ['Moving cookies failed (slow); rerun setup to try again, or sign in again to sites that ask.']);
  assert.equal(slow.calls.some(cookieCall('importCookies')), false);
  assert.equal((await slow.receipt()).cookieMigration.failed, true);
  assert.equal(slow.logs.includes(GOOGLE), false);
  await kept(slow);
  // Once an import has run, a failed flush removes the export, and a rerun has nothing left to retry.
  const stuck = await applyWorld(t);
  await cookieStore(stuck.udd, ['v11a', 'v11b', 'v11c']);
  Object.assign(stuck.cookies, { exportCookies: exportsThree, importCookies: async () => ({ count: 3 }), flushCookies: async () => { throw new Error('stuck'); } });
  const flushed = await runClawser(stuck.yes, stuck.deps);
  assert.equal(flushed.ok, true);
  assert.deepEqual(flushed.warnings.filter(text => text.startsWith('Moving cookies')), ['Moving cookies failed (stuck); sign in again to sites that ask.']);
  assert.equal((await stuck.receipt()).cookieMigration.failed, true);
  assert.deepEqual(await cookieDirs(stuck), []);
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
  await cookieStore(w.udd, ['v11a', 'v11b', 'v11c']);
  w.cookies.exportCookies = exportsThree;
  await assert.rejects(runClawser(w.yes, w.deps), error => error.message.startsWith('The browser did not close within 30 seconds; close it yourself, then rerun setup.'));
  assert.equal(w.calls.filter(cookieCall('closeBrowser')).length, 1);
  for (const name of ['enable', 'restart']) assert.deepEqual(systemctl(w.calls, name), [], name);
  assert.equal(w.calls.some(isPatch), false);
  assert.equal(w.calls.some(cookieCall('importCookies')), false);
  const kept = await cookieDirs(w);
  assert.equal(kept.length, 1, 'the export stays for the rerun');
  assert.ok(await exists(join(w.stateDir, kept[0], 'cookies.json')));
});

test('a failure after the takeover names the stopped units and their backups', async t => {
  const w = await applyWorld(t, { deps: { controllerHealth: async () => ({ ready: false }) } });
  await cookieStore(w.udd, ['v11a', 'v11b', 'v11c']);
  w.cookies.exportCookies = exportsThree;
  const error = await runClawser(w.yes, w.deps).then(() => assert.fail('setup should fail'), failure => failure);
  const { replaced } = await w.receipt();
  assert.ok(replaced[0]?.backup, 'the receipt records the backup');
  assert.ok(error.message.endsWith(` Setup already stopped my-chrome.service, my-openbox.service, my-xvfb.service; rerun setup to finish. Their unit files are unchanged, with copies in ${replaced[0].backup}.${SAVED}`), error.message);
  assert.match(error.message, /^Controller health or profile identity is not ready/);
  const kept = await cookieDirs(w);
  assert.equal(kept.length, 1, 'the export stays for the rerun');
  assert.ok(await exists(join(w.stateDir, kept[0], 'cookies.json')));
  assert.equal(w.calls.some(cookieCall('importCookies')), false);
  const session = await sessionWorld(t);
  session.deps.controllerHealth = async () => ({ ready: false });
  session.cookies.closeBrowser = async () => { await fs.rm(join(session.root, 'proc/400'), { recursive: true }); };
  await assert.rejects(runClawser(session.yes, session.deps), error => error.message.endsWith(' Setup already closed the browser from your desktop session; rerun setup to finish.'));
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
    [w => { w.foreign['my-chrome.service'].DropInPaths = '"/home/me/a\\qb.conf"'; }, DROP_INS('my-chrome.service')],
    [w => { w.foreign['my-chrome.service'].DropInPaths = '"/home/me/a.conf'; }, DROP_INS('my-chrome.service')],
    [w => { w.foreign['my-xvfb.service'].DropInPaths = '/home/me/a\\ b.conf'; }, DROP_INS('my-xvfb.service')],
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

// The first matching systemctl call throws, the way a killed setup stops there.
function crashAt(w, name, unit) {
  const run = w.deps.run;
  let crashed = false;
  w.deps.run = async (command, args = [], more) => {
    if (!crashed && command === 'systemctl' && args[1] === name && (!unit || args.at(-1) === unit)) { crashed = true; throw new Error('setup was killed'); }
    return run(command, args, more);
  };
}
// After a finished takeover, Clawser's browser unit is the one listening on the profile port.
const clawserListens = w => fs.writeFile(join(w.root, 'proc/400/cgroup'), `0::/user.slice/user-${w.deps.uid}.slice/user@${w.deps.uid}.service/app.slice/${w.names.browser}\n`);
const nobodyListens = w => net(w.root, '');
const rewriteReceipt = async (w, change) => { const saved = await w.receipt(); change(saved); await fs.writeFile(join(w.stateDir, 'setup.json'), JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 }); };
const leftover = async (w, name, cookies = SAVED_COOKIES) => {
  const dir = join(w.stateDir, name);
  await fs.mkdir(dir, { mode: 0o700 });
  if (cookies) await fs.writeFile(join(dir, 'cookies.json'), JSON.stringify(cookies), { mode: 0o600 });
  return dir;
};
const RESUME = 'Move the cookies an earlier setup run saved into the new browser';
const CLOSES = "This closes the agent's browser. Rerun with --yes to go ahead.";
// A plain rerun prints the plan and stops: no import, nothing written, stopped or started.
async function needsYes(w) {
  w.calls.length = 0;
  w.logs.length = 0;
  const result = await runClawser(w.args, w.deps);
  assert.equal(result.ok, false);
  assert.ok(result.plan.includes(RESUME), result.plan.join('\n'));
  assert.ok(w.logs.includes(CLOSES), w.logs.join('\n'));
  assert.equal(w.calls.some(call => call.command === 'cookies'), false);
  assert.deepEqual(w.mutations(), []);
}
const stopAgain = unit => `Stop ${unit} again (Clawser replaced it)`;
const fsCall = (name, path) => call => call.command === 'fs' && call.args[0] === name && call.args[1] === path;

test("rerunning option B on Clawser's own units takes nothing over and needs no --yes", async t => {
  const w = await applyWorld(t);
  assert.equal((await runClawser(w.yes, w.deps)).ok, true);
  const first = await w.receipt();
  await clawserListens(w);
  w.calls.length = 0;
  const plan = await w.plan();
  assert.deepEqual(plan.takeover, []);
  assert.deepEqual(plan.stop, []);
  assert.equal(plan.cookies, undefined);
  assert.equal(plan.disruptive, false);
  // Rendered from the receipt, the units come out exactly as the takeover wrote them.
  assert.deepEqual(plan.writes, []);
  assert.deepEqual([plan.start, plan.restart], [[], []]);
  assert.deepEqual(plan.browser, first.browser);
  assert.equal(plan.display, 20);
  w.logs.length = 0;
  const result = await runClawser(w.args, w.deps);
  assert.equal(result.ok, true, JSON.stringify(result.plan));
  for (const name of ['stop', 'disable']) assert.deepEqual(systemctl(w.calls, name), [], name);
  assert.equal(w.calls.some(cookieCall('exportCookies')), false);
  assert.deepEqual((await w.receipt()).replaced, first.replaced);
  assert.ok(w.logs.includes(KEEPS), w.logs.join('\n'));
});

test('a crash before the takeover stop resumes the takeover without a second backup', async t => {
  const w = await applyWorld(t);
  crashAt(w, 'stop');
  await assert.rejects(runClawser(w.yes, w.deps), /^Error: setup was killed$/);
  // The interrupted run had recorded only Chrome's unit when it died.
  await rewriteReceipt(w, saved => { saved.replaced = saved.replaced.filter(item => item.unit === 'my-chrome.service'); });
  const [chrome] = (await w.receipt()).replaced;
  assert.equal(chrome?.unit, 'my-chrome.service');
  // A run killed between its backups and its receipt save leaves an unrecorded copy behind. Openbox's is gone, Xvfb's stays.
  await fs.rm(join(chrome.backup, 'my-openbox.service'));
  assert.ok(await exists(join(chrome.backup, 'my-chrome.service')) && await exists(join(chrome.backup, 'my-xvfb.service')));
  await fs.writeFile(join(w.unitDir, 'my-xvfb.service'), '[Service]\nExecStart=/usr/bin/Xvfb :20 -edited\n');
  const stale = await leftover(w, 'cookies-old');
  w.calls.length = 0;
  const plan = await w.plan();
  assert.deepEqual(plan.takeover.map(item => item.unit), ['my-chrome.service', 'my-xvfb.service', 'my-openbox.service']);
  assert.equal(plan.disruptive, true);
  assert.deepEqual(plan.staleCookies, [stale]);
  assert.equal((await runClawser(w.yes, w.deps)).ok, true);
  const saved = await w.receipt();
  assert.equal(saved.replaced.length, 3, JSON.stringify(saved.replaced));
  assert.deepEqual(saved.replaced[0], chrome);
  assert.deepEqual(saved.replaced.map(item => item.unit).sort(), MY_UNITS);
  assert.deepEqual(await fs.readdir(join(w.stateDir, 'backups')), [basename(chrome.backup)]);
  assert.ok(saved.replaced.every(item => item.backup === chrome.backup), JSON.stringify(saved.replaced));
  // The units new to this run are backed up as they are now, beside Chrome's first copy, replacing an unrecorded one.
  assert.equal(await fs.readFile(join(chrome.backup, 'my-xvfb.service'), 'utf8'), '[Service]\nExecStart=/usr/bin/Xvfb :20 -edited\n');
  assert.equal(await fs.readFile(join(chrome.backup, 'my-openbox.service'), 'utf8'), w.originals['my-openbox.service']);
  assert.equal(await fs.readFile(join(chrome.backup, 'my-chrome.service.d/override.conf'), 'utf8'), DROP_IN);
  assert.equal(w.atFirstStop.replaced.length, 3, 'the new units are recorded before the first stop');
  assert.deepEqual(systemctl(w.calls, 'stop'), MY_UNITS);
  assert.deepEqual(systemctl(w.calls, 'disable'), MY_UNITS);
  // Leftover cookies go under the lock, before anything stops.
  const lock = w.calls.findIndex(fsCall('mkdir', join(w.stateDir, 'setup.lock'))), removed = w.calls.findIndex(fsCall('rm', stale));
  assert.ok(lock >= 0 && removed > lock && removed < w.calls.findIndex(verb('stop')), JSON.stringify({ lock, removed }));
  assert.equal(await exists(stale), false);
});

// A takeover killed after stopping Chrome and openbox, before disabling openbox. Nothing listens on the profile port afterwards.
async function crashedBetweenStops(t, options) {
  const w = await applyWorld(t, options);
  crashAt(w, 'disable', 'my-openbox.service');
  await assert.rejects(runClawser(w.yes, w.deps), /^Error: setup was killed Setup already stopped my-chrome\.service, my-openbox\.service;/);
  await nobodyListens(w);
  return w;
}

test('a crash between stops stops the replaced units again without --yes', async t => {
  const w = await crashedBetweenStops(t);
  assert.equal(w.foreign['my-xvfb.service'].ActiveState, 'active');
  assert.deepEqual([w.foreign['my-openbox.service'].ActiveState, w.foreign['my-openbox.service'].UnitFileState], ['inactive', 'enabled']);
  assert.equal((await w.receipt()).replaced.length, 3);
  w.calls.length = 0;
  const dry = await runClawser([...w.args, '--dry-run'], w.deps);
  for (const unit of ['my-xvfb.service', 'my-openbox.service']) assert.ok(dry.plan.includes(stopAgain(unit)), dry.plan.join('\n'));
  assert.equal(dry.plan.includes(stopAgain('my-chrome.service')), false, 'a unit already stopped and disabled stays alone');
  assert.equal(dry.plan.some(line => line.startsWith('Take over ') || line.startsWith('Stop the Docker-era')), false, dry.plan.join('\n'));
  const plan = await w.plan();
  assert.deepEqual(plan.stop, [{ kind: 'unit', unit: 'my-openbox.service', replaced: true }, { kind: 'unit', unit: 'my-xvfb.service', replaced: true }]);
  assert.equal(plan.disruptive, false);
  // Clawser's units move to another package folder, so the rerun rewrites them and runs daemon-reload.
  await movePackage(w);
  w.calls.length = 0;
  const result = await runClawser(w.args, w.deps);
  assert.equal(result.ok, true, JSON.stringify(result.plan));
  assert.deepEqual(systemctl(w.calls, 'stop'), ['my-openbox.service', 'my-xvfb.service']);
  assert.deepEqual(systemctl(w.calls, 'disable'), ['my-openbox.service', 'my-xvfb.service']);
  assert.ok(w.calls.findLastIndex(verb('disable')) < w.calls.findIndex(verb('enable')), 'the old units stop before Clawser starts its own');
  // Every write lands before anything stops, so a write failure never leaves the person without their display.
  const reload = w.calls.findIndex(verb('daemon-reload')), firstStop = w.calls.findIndex(verb('stop'));
  assert.ok(reload >= 0 && firstStop > reload, JSON.stringify({ reload, firstStop }));
  assert.deepEqual(systemctl(w.calls, 'enable'), result.units);
  // A later failure names the units the rerun stopped and where their unit files were copied.
  const failing = await crashedBetweenStops(t);
  failing.deps.controllerHealth = async () => ({ ready: false });
  const { replaced } = await failing.receipt();
  await assert.rejects(runClawser(failing.args, failing.deps), error => error.message.startsWith('Controller health or profile identity is not ready')
    && error.message.endsWith(` Setup already stopped my-openbox.service, my-xvfb.service; rerun setup to finish. Their unit files are unchanged, with copies in ${replaced[0].backup}.`)
    || assert.fail(error.message));
});

test('a resumed takeover on a different display is refused', async t => {
  const w = await applyWorld(t);
  crashAt(w, 'stop');
  await assert.rejects(runClawser(w.yes, w.deps), /setup was killed/);
  assert.equal((await w.receipt()).display, 20);
  await fs.writeFile(join(w.root, 'proc/400/environ'), NUL('DISPLAY=:30'));
  await fs.writeFile(join(w.root, 'proc/300/cmdline'), NUL('/usr/bin/Xvfb', ':30', '-screen', '0', '1280x800x24'));
  await fs.writeFile(join(w.root, 'proc/350/environ'), NUL('DISPLAY=:30'));
  w.calls.length = 0;
  await assert.rejects(runClawser(w.yes, w.deps), /Setup arguments conflict/);
  assert.deepEqual(w.mutations(), []);
  // The receipt is bound to the first port too, so a profile moved to another one is refused the same way.
  const moved = await applyWorld(t);
  crashAt(moved, 'stop');
  await assert.rejects(runClawser(moved.yes, moved.deps), /setup was killed/);
  moved.config.browser.profiles.user.cdpUrl = 'http://127.0.0.1:9333';
  await net(moved.root, row('0100007F', 9222, 4242) + row('0100007F', 9333, 4343));
  await proc(moved.root, 500, { argv: ['/opt/google/chrome/chrome', `--user-data-dir=${moved.udd}`, '--remote-debugging-port=9333'], env: ['DISPLAY=:20'],
    cgroup: `0::/user.slice/user-${moved.deps.uid}.slice/user@${moved.deps.uid}.service/app.slice/my-chrome.service`, sockets: [4343] });
  moved.foreign['my-chrome.service'].MainPID = '500';
  moved.calls.length = 0;
  await assert.rejects(runClawser(moved.yes, moved.deps), /Setup arguments conflict/);
  assert.deepEqual(moved.mutations(), []);
  // The receipt is bound to the first profile folder, in both directions: a folder dropped, and a folder added.
  const argv = folder => NUL('/opt/google/chrome/chrome', `--user-data-dir=${w.udd}`, ...folder ? [`--profile-directory=${folder}`] : [], '--remote-debugging-port=9222');
  for (const [before, after] of [['Profile 1', undefined], [undefined, 'Profile 1']]) {
    const folder = await applyWorld(t);
    const cmdline = join(folder.root, 'proc/400/cmdline');
    await fs.writeFile(cmdline, argv(before).replaceAll(w.udd, folder.udd));
    crashAt(folder, 'stop');
    await assert.rejects(runClawser(folder.yes, folder.deps), /setup was killed/);
    assert.equal((await folder.receipt()).profileDirectory, before);
    await fs.writeFile(cmdline, argv(after).replaceAll(w.udd, folder.udd));
    folder.calls.length = 0;
    await assert.rejects(runClawser(folder.yes, folder.deps), /Setup arguments conflict/, `${before} → ${after}`);
    assert.deepEqual(folder.mutations(), [], `${before} → ${after}`);
  }
});

test('cookies saved by an interrupted run are imported on the next run and then removed', async t => {
  const w = await applyWorld(t);
  Object.assign(w.cookies, { importCookies: async () => ({ count: 3 }), countCookies: async () => 3 });
  crashAt(w, 'disable', 'my-chrome.service');
  await assert.rejects(runClawser(w.yes, w.deps), /setup was killed/);
  await nobodyListens(w);
  assert.equal(Object.hasOwn(await w.receipt(), 'cookieMigration'), false);
  const older = await leftover(w, 'cookies-old');
  await fs.utimes(join(older, 'cookies.json'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const dir = await leftover(w, 'cookies-abc'), path = join(dir, 'cookies.json');
  w.calls.length = 0;
  const plan = await w.plan();
  assert.deepEqual(plan.cookies, { migrate: true, resumeFrom: path });
  assert.deepEqual(plan.staleCookies, [older]);
  assert.equal(plan.disruptive, false);
  const dry = await runClawser([...w.args, '--dry-run'], w.deps);
  assert.ok(dry.plan.includes(RESUME), dry.plan.join('\n'));
  assert.equal(dry.plan.some(line => /^Move \d+ keyring/.test(line)), false, dry.plan.join('\n'));
  const result = await runClawser(w.args, w.deps);
  assert.equal(result.ok, true, JSON.stringify(result.plan));
  assert.ok(result.warnings.every(text => !text.startsWith('Moving cookies')), result.warnings.join('\n'));
  assert.equal(w.calls.some(cookieCall('exportCookies')), false);
  assert.equal(w.cookieArgs.importCookies?.[1], path);
  assert.ok(w.calls.findIndex(cookieCall('importCookies')) > w.calls.findLastIndex(verb('enable')));
  assert.ok(w.calls.findIndex(cookieCall('waitForBrowser')) < w.calls.findIndex(cookieCall('importCookies')));
  assert.deepEqual(await cookieDirs(w), []);
  const saved = await w.receipt();
  assert.deepEqual(saved.cookieMigration, { exported: 3, imported: 3, at: saved.cookieMigration?.at });
  assert.ok(w.logs.includes(GOOGLE), w.logs.join('\n'));
  assert.doesNotMatch(w.logs.join('\n') + JSON.stringify(result) + JSON.stringify(saved), /cookie-secret/);

  // A health wait that failed after the takeover kept the export, and the rerun finds Clawser's own browser on the port.
  const own = await applyWorld(t, { deps: { controllerHealth: async () => ({ ready: false }) } });
  await cookieStore(own.udd, ['v11a', 'v11b', 'v11c']);
  Object.assign(own.cookies, { exportCookies: exportsThree, importCookies: async () => ({ count: 3 }), countCookies: async () => 3 });
  await assert.rejects(runClawser(own.yes, own.deps), /Controller health/);
  const [kept] = await cookieDirs(own);
  assert.ok(kept, 'the export stays');
  await clawserListens(own);
  own.deps.controllerHealth = async () => { own.calls.push({ command: 'health' }); return healthyUser(); };
  own.calls.length = 0;
  const ownPlan = await own.plan();
  assert.equal(ownPlan.cookies?.resumeFrom, join(own.stateDir, kept, 'cookies.json'));
  // Saving the imported cookies closes the agent's running browser, so the resume needs --yes.
  assert.deepEqual([ownPlan.takeover, ownPlan.stop, ownPlan.disruptive], [[], [], true]);
  await needsYes(own);
  own.calls.length = 0;
  assert.equal((await runClawser([...own.args, '--yes'], own.deps)).ok, true);
  assert.equal(own.calls.some(cookieCall('exportCookies')), false);
  assert.equal(own.cookieArgs.importCookies?.[1], join(own.stateDir, kept, 'cookies.json'));
  assert.ok(own.calls.findIndex(cookieCall('importCookies')) > own.calls.findIndex(call => call.command === 'health'), 'the import waits for health');
  assert.deepEqual(await cookieDirs(own), []);
  assert.deepEqual((await own.receipt()).cookieMigration, { exported: 3, imported: 3, at: (await own.receipt()).cookieMigration?.at });

  // An import that failed last time kept the export, and the rerun tries again.
  const failed = await applyWorld(t);
  await cookieStore(failed.udd, ['v11a', 'v11b', 'v11c']);
  Object.assign(failed.cookies, { exportCookies: exportsThree, importCookies: async () => { throw new Error('nope'); } });
  assert.equal((await runClawser(failed.yes, failed.deps)).ok, true);
  assert.equal((await failed.receipt()).cookieMigration.failed, true);
  const [retry] = await cookieDirs(failed);
  await clawserListens(failed);
  Object.assign(failed.cookies, { importCookies: async () => ({ count: 3 }), countCookies: async () => 3 });
  failed.calls.length = 0;
  const failedPlan = await failed.plan();
  assert.equal(failedPlan.cookies?.resumeFrom, join(failed.stateDir, retry, 'cookies.json'));
  assert.equal(failedPlan.disruptive, true);
  await needsYes(failed);
  failed.calls.length = 0;
  const retried = await runClawser([...failed.args, '--yes'], failed.deps);
  assert.equal(retried.ok, true);
  assert.equal(failed.calls.some(cookieCall('exportCookies')), false);
  assert.equal(failed.cookieArgs.importCookies?.[1], join(failed.stateDir, retry, 'cookies.json'));
  assert.deepEqual(await cookieDirs(failed), []);
  const { cookieMigration } = await failed.receipt();
  assert.deepEqual(cookieMigration, { exported: 3, imported: 3, at: cookieMigration.at });
});

test('leftover cookie folders are removed when they are not needed', async t => {
  const w = await applyWorld(t);
  await cookieStore(w.udd, ['v11a', 'v11b', 'v11c']);
  Object.assign(w.cookies, { exportCookies: exportsThree, importCookies: async () => ({ count: 3 }), countCookies: async () => 3 });
  assert.equal((await runClawser(w.yes, w.deps)).ok, true);
  assert.equal((await w.receipt()).cookieMigration.imported, 3);
  await clawserListens(w);
  const folders = [await leftover(w, 'cookies-a'), await leftover(w, 'cookies-b', null)];
  w.calls.length = 0;
  const plan = await w.plan();
  assert.equal(plan.cookies, undefined);
  assert.deepEqual(plan.staleCookies, folders);
  assert.equal(describeHost(plan).includes(RESUME), false);
  const result = await runClawser(w.args, w.deps);
  assert.equal(result.ok, true);
  assert.equal(result.warnings.some(text => text.includes('cookies')), false, result.warnings.join('\n'));
  for (const dir of folders) assert.equal(await exists(dir), false, dir);
  assert.equal(w.calls.some(cookieCall('importCookies')), false);
  // --no-migrate-cookies drops a leftover export instead of importing it.
  const no = await applyWorld(t);
  assert.equal((await runClawser(no.yes, no.deps)).ok, true);
  await clawserListens(no);
  const dropped = await leftover(no, 'cookies-x');
  no.calls.length = 0;
  const declined = await no.plan({ migrateCookies: false });
  assert.deepEqual([declined.cookies, declined.staleCookies], [undefined, [dropped]]);
  assert.equal((await runClawser([...no.args, '--no-migrate-cookies'], no.deps)).ok, true);
  assert.equal(await exists(dropped), false);
  assert.equal(no.calls.some(cookieCall('importCookies')), false);
});

test('a Docker-era install found through an unmarked CDP install names the profile to keep', async t => {
  const w = await handWritten(t);
  await unmarkedCdp(w);
  // The default state folder holds the Docker-era receipt, so plain setup continues the CDP install there.
  const state = join(w.root, '.openclaw/clawser');
  await fs.mkdir(state, { mode: 0o700 });
  await fs.writeFile(join(state, 'setup.json'), JSON.stringify({ identity: 'clawser-setup-v1', uid: w.deps.uid, ownerId: randomUUID() }) + '\n', { mode: 0o600 });
  w.calls.length = 0;
  await assert.rejects(runClawser(['setup'], w.deps), { message: 'This state folder holds a Docker-era install, which converts to a new browser profile only, and your CDP viewer uses browser profile user. Run setup --browser-profile user --state-dir <another folder> to keep its logins, or setup --cdp to keep the CDP viewer.' });
  assert.deepEqual(w.mutations(), []);
  // Asked for by name, the plain Docker-era message still applies.
  await assert.rejects(runClawser(['setup', '--browser-profile', 'user'], w.deps), { message: 'This state folder holds a Docker-era install, which converts to a new browser profile only. Run setup without --browser-profile, or choose another --state-dir.' });
  assert.deepEqual(w.mutations(), []);
});

test('doctor checks an option B install against its own profile', async t => {
  const w = await applyWorld(t);
  assert.equal((await runClawser(w.yes, w.deps)).ok, true);
  w.calls.length = 0;
  const doctor = await runClawser(['doctor', '--state-dir', w.stateDir], w.deps);
  const row = name => doctor.checks.find(item => item.name === name);
  assert.equal(row('configuration')?.ok, true, JSON.stringify(doctor.checks));
  assert.equal(row('controller health')?.ok, true, JSON.stringify(doctor.checks));
  assert.equal(doctor.ok, true, JSON.stringify(doctor.checks));
  assert.deepEqual(w.mutations(), []);
  w.deps.controllerHealth = async () => ({ ready: true, profile: 'clawser', cdpUrl: 'http://127.0.0.1:9222', recoveryRequired: false });
  const wrong = await runClawser(['doctor', '--state-dir', w.stateDir], w.deps);
  assert.equal(wrong.checks.find(item => item.name === 'controller health')?.ok, false, JSON.stringify(wrong.checks));
  assert.equal(wrong.ok, false);
});

test('an import that sets none of the saved cookies keeps them for a rerun', async t => {
  const w = await applyWorld(t);
  await cookieStore(w.udd, ['v11a', 'v11b', 'v11c']);
  Object.assign(w.cookies, { exportCookies: exportsThree, importCookies: async () => ({ count: 0 }) });
  const result = await runClawser(w.yes, w.deps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings.filter(text => text.startsWith('Moving cookies')), ['Moving cookies failed (Chrome accepted none of the saved cookies); rerun setup to try again, or sign in again to sites that ask.']);
  const saved = await w.receipt();
  assert.deepEqual(saved.cookieMigration, { exported: 3, imported: 0, failed: true, at: saved.cookieMigration?.at });
  assert.deepEqual(await cookieDirs(w), [basename(w.cookieArgs.exportCookies[1])]);
  assert.ok(await exists(join(w.cookieArgs.exportCookies[1], 'cookies.json')));
  assert.equal(w.calls.some(cookieCall('flushCookies')), false);
  assert.equal(w.logs.includes(GOOGLE), false);
});

test('a cookie folder setup cannot remove is a warning, not a failure', async t => {
  const w = await applyWorld(t);
  await cookieStore(w.udd, ['v11a', 'v11b', 'v11c']);
  Object.assign(w.cookies, { exportCookies: exportsThree, importCookies: async () => ({ count: 3 }), countCookies: async () => 3 });
  const rm = w.deps.fs.rm;
  w.deps.fs = { ...w.deps.fs, rm: async (path, options) => {
    if (basename(path).startsWith('cookies-')) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    return rm(path, options);
  } };
  const result = await runClawser(w.yes, w.deps);
  assert.equal(result.ok, true);
  const dir = w.cookieArgs.exportCookies[1];
  assert.ok(result.warnings.includes(`Could not remove ${dir}; delete it yourself, it holds saved cookies.`), result.warnings.join('\n'));
  const saved = await w.receipt();
  assert.deepEqual(saved.cookieMigration, { exported: 3, imported: 3, at: saved.cookieMigration?.at });
  assert.ok(w.logs.includes(GOOGLE), w.logs.join('\n'));
  assert.equal(await exists(join(w.stateDir, 'setup.lock')), false);
});

test('option B with --profile-directory names the folder, records it and counts the cookies inside it', async t => {
  const w = await applyWorld(t);
  await fs.writeFile(join(w.root, 'proc/400/cmdline'), NUL('/opt/google/chrome/chrome', `--user-data-dir=${w.udd}`, '--profile-directory=Profile 1', '--remote-debugging-port=9222'));
  await cookieStore(w.udd, ['v11a']);
  await cookieStore(w.udd, ['v11a', 'v11b', 'v10a'], { folder: 'Profile 1' });
  const dry = await runClawser([...w.takeover, '--dry-run'], w.deps);
  assert.ok(dry.plan.includes(`Browser profile: user (existing, at ${w.udd}, folder Profile 1)`), dry.plan.join('\n'));
  assert.ok(dry.plan.includes('Move 2 keyring-encrypted cookies into the new browser'), dry.plan.join('\n'));
  const plan = await w.plan();
  assert.equal(plan.profileDirectory, 'Profile 1');
  assert.deepEqual(plan.cookies, { migrate: true, count: 2 });
  assert.match(plan.units[plan.locations.names.browser], /"--profile-directory=Profile 1"/);
  Object.assign(w.cookies, { exportCookies: exportsThree, importCookies: async () => ({ count: 3 }), countCookies: async () => 3 });
  assert.equal((await runClawser(w.yes, w.deps)).ok, true);
  assert.equal((await w.receipt()).profileDirectory, 'Profile 1');
});

test('option B counts cookies in the legacy <profile>/Cookies store', async t => {
  const w = await handWritten(t);
  await cookieStore(w.udd, ['v11a', 'v11b', 'v11c', 'v10a'], { legacy: true });
  assert.equal(await exists(join(w.udd, 'Default/Network/Cookies')), false);
  assert.deepEqual((await w.plan()).cookies, { migrate: true, count: 3 });
  await w.unchanged();
});

test('a unit file in a sibling of the unit folder is not replaceable', async t => {
  const w = await handWritten(t);
  w.foreign['my-chrome.service'].FragmentPath = w.unitDir + '-evil/my-chrome.service';
  await assert.rejects(runClawser(w.takeover, w.deps), /^Error: my-chrome\.service would restart Chrome, so setup won't stop it/);
  await w.unchanged();
});

test('a window manager unit setup cannot replace moves the browser to a free display', async t => {
  const w = await handWritten(t, { deps: { freeDisplay: async () => 21 } });
  w.foreign['my-openbox.service'].FragmentPath = '/etc/systemd/user/my-openbox.service';
  const plan = await w.plan();
  assert.deepEqual(plan.takeover.map(item => item.unit), ['my-chrome.service']);
  assert.equal(plan.display, 21);
  assert.ok(plan.warnings.includes("Display :20 stays running; Clawser's browser uses :21."), plan.warnings.join('\n'));
  await w.unchanged();
});

test('a program other than Chrome on the profile port is named', async t => {
  const w = await handWritten(t, { deps: { portHolder } });
  await fs.rm(join(w.root, 'proc/400/fd'), { recursive: true });
  await fs.mkdir(join(w.root, 'proc/400/fd'));
  await proc(w.root, 77, { exe: '/usr/bin/nc', argv: ['nc', '-l', '9222'], cgroup: w.session, sockets: [4242] });
  w.busy([9222]);
  await assert.rejects(runClawser(w.takeover, w.deps), { message: 'port 9222 is in use by /usr/bin/nc (pid 77)' });
  await w.unchanged();
});

test('a leftover cookie export that cannot be read is removed, not resumed', async t => {
  const w = await applyWorld(t);
  crashAt(w, 'disable', 'my-chrome.service');
  await assert.rejects(runClawser(w.yes, w.deps), /setup was killed/);
  await nobodyListens(w);
  assert.equal(Object.hasOwn(await w.receipt(), 'cookieMigration'), false);
  const truncated = await leftover(w, 'cookies-cut', null), empty = await leftover(w, 'cookies-empty', null);
  await fs.writeFile(join(truncated, 'cookies.json'), '[{"name":', { mode: 0o600 });
  await fs.writeFile(join(empty, 'cookies.json'), '[]', { mode: 0o600 });
  w.calls.length = 0;
  const plan = await w.plan();
  assert.equal(plan.cookies, undefined);
  assert.deepEqual(plan.staleCookies, [truncated, empty]);
  const dry = await runClawser([...w.args, '--dry-run'], w.deps);
  assert.equal(dry.plan.includes(RESUME), false, dry.plan.join('\n'));
  const result = await runClawser(w.args, w.deps);
  assert.equal(result.ok, true, JSON.stringify(result.plan));
  for (const dir of [truncated, empty]) assert.equal(await exists(dir), false, dir);
  assert.equal(w.calls.some(cookieCall('importCookies')), false);
  assert.equal(w.logs.includes(RESUME), false);
  assert.doesNotMatch(w.logs.join('\n') + JSON.stringify(result), /"name":/);
});

test('option B finds the profile of a Chrome that rewrote its command line', async t => {
  const w = await handWritten(t);
  // Chrome for Testing joins its exe path and every flag with spaces into one entry.
  const flags = [`--user-data-dir=${w.udd}`, '--lang=fr', '--remote-debugging-port=9222', '--remote-debugging-address=127.0.0.1', '--window-size=1280,800'];
  await fs.writeFile(join(w.root, 'proc/400/cmdline'), ['/opt/google/chrome/chrome', ...flags].join(' ') + '\0');
  const result = await runClawser([...w.takeover, '--dry-run'], w.deps);
  assert.ok(result.plan.includes(`Browser profile: user (existing, at ${w.udd})`), result.plan.join('\n'));
  const plan = await w.plan();
  assert.equal(plan.userDataDir, w.udd);
  assert.deepEqual(plan.browser.existingArgs, flags);
  const unit = plan.units[plan.locations.names.browser];
  for (const want of [`"--user-data-dir=${w.udd}"`, '"--lang=fr"', '"--remote-debugging-port=9222"']) assert.ok(unit.includes(want), want);
  assert.equal(unit.includes('--window-size=1280,800'), false);
  // A title shorter than the original arguments leaves NUL padding behind it.
  await fs.writeFile(join(w.root, 'proc/400/cmdline'), ['/opt/google/chrome/chrome', ...flags].join(' ') + '\0'.repeat(40));
  assert.deepEqual((await w.plan()).browser.existingArgs, flags);
  await w.unchanged();
});

test('option B refuses a rewritten command line it cannot split safely', async t => {
  const refused = 'Chrome on port 9222 rewrote its command line, and its flags or profile path contain spaces; start Chrome with flags and a --user-data-dir path that contain no spaces, then rerun setup.';
  for (const cmdline of ['/opt/google/chrome/chrome --user-data-dir=/home/me/my profile --remote-debugging-port=9222', '/opt/google/chrome/chrome --user-data-dir=/p --remote-debugging-port=9222 https://example.com']) {
    const w = await handWritten(t);
    await fs.writeFile(join(w.root, 'proc/400/cmdline'), cmdline + '\0');
    await assert.rejects(runClawser([...w.takeover, '--yes'], w.deps), { message: refused });
    await w.unchanged();
  }
});

test('a Chrome started from a terminal scope is closed like a desktop session Chrome', async t => {
  const w = await handWritten(t, { xvfb: null, openbox: null, deps: { freeDisplay: async () => 21 } });
  const uid = w.deps.uid, apps = `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/`;
  await fs.writeFile(join(w.root, 'proc/400/cgroup'), `0::${apps}vte-spawn-${randomUUID()}.scope\n`);
  const result = await runClawser([...w.takeover, '--dry-run'], w.deps);
  assert.ok(result.plan.includes('Close the browser running in your desktop session (pid 400)'), result.plan.join('\n'));
  assert.equal(result.plan.some(line => line.startsWith('Take over ')), false);
  assert.deepEqual((await w.plan()).stop, [{ kind: 'close-browser', pid: 400 }]);
  // systemd never restarts a scope, whatever started it.
  for (const leaf of ['tmux-spawn-5f2a9c.scope', 'run-r3b1c0d.scope']) assert.deepEqual(classifyOwner(apps + leaf, uid), { kind: 'session' }, leaf);
  // A transient service is still a unit.
  assert.equal(classifyOwner(apps + 'app-org.kde.konsole@a1b2.service', uid).kind, 'user-unit');
  await w.unchanged();
});

test('option B warns when the profile folder is readable by other users', async t => {
  const w = await handWritten(t);
  const loose = `${w.udd} is readable by other users, and Clawser's browser keeps cookies protected only by file permissions; run: chmod 700 ${w.udd}`;
  assert.equal((await w.plan()).warnings.includes(loose), false, 'a private folder needs no warning');
  await fs.chmod(w.udd, 0o750);
  const result = await runClawser([...w.takeover, '--dry-run'], w.deps);
  assert.ok(result.plan.includes('Warning: ' + loose), result.plan.join('\n'));
  assert.ok((await w.plan()).warnings.includes(loose));
  assert.equal((await fs.stat(w.udd)).mode & 0o777, 0o750, 'setup never changes the folder');
  await w.unchanged();
});
