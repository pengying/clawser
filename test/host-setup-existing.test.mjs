import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runClawser, setupHelpers } from '../src/setup.mjs';
import { planHost } from '../src/host-setup.mjs';
import { hostWorld, isPatch, systemctl } from './host-fixture.mjs';
import { net, proc, row } from './proc-fixture.mjs';

const STUB = 'Taking over an existing browser is not implemented yet';
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

test('option B with --yes still stops at the takeover stub without writing anything', async t => {
  const w = await handWritten(t);
  await assert.rejects(runClawser([...w.takeover, '--yes'], w.deps), { message: STUB });
  await w.unchanged();
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
});
