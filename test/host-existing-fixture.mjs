import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { setupHelpers } from '../src/setup.mjs';
import { planHost } from '../src/host-setup.mjs';
import { hostWorld, isPatch, systemctl } from './host-fixture.mjs';
import { net, proc, row } from './proc-fixture.mjs';

const exists = path => fs.lstat(path).then(() => true, () => false);
export const userProfile = () => ({ browser: { defaultProfile: 'user', profiles: { user: { cdpUrl: 'http://127.0.0.1:9222', attachOnly: true, driver: 'openclaw' } } } });

// The box's real shape: Chrome, Xvfb :20 and openbox under three hand-written user units, serving profile user on port 9222.
export async function handWritten(t, { config = userProfile(), chrome = {}, xvfb = {}, openbox = {}, listen = '0100007F', deps = {} } = {}) {
  const w = await hostWorld(t, { config, deps });
  const uid = w.deps.uid, slice = `0::/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/`;
  w.session = `0::/user.slice/user-${uid}.slice/session-2.scope`;
  w.udd = join(w.root, 'udd');
  // A person's profile folder is usually private already.
  await fs.mkdir(w.udd, { mode: 0o700 });
  await net(w.root, listen ? row(listen, 9222, 4242) : '');
  await proc(w.root, 400, { argv: ['/opt/google/chrome/chrome', `--user-data-dir=${w.udd}`, '--lang=fr', '--remote-debugging-port=9222', '--remote-debugging-address=127.0.0.1', '--window-size=1280,800'],
    env: ['DISPLAY=:20'], cgroup: slice + 'my-chrome.service', sockets: [4242], ...chrome });
  await proc(w.root, 401, { argv: ['/opt/google/chrome/chrome', '--type=renderer'], env: ['DISPLAY=:20'], cgroup: slice + 'my-chrome.service' });
  if (xvfb) await proc(w.root, 300, { exe: '/usr/bin/Xvfb', argv: ['/usr/bin/Xvfb', ':20', '-screen', '0', '1280x800x24'], cgroup: slice + 'my-xvfb.service', ...xvfb });
  if (openbox) await proc(w.root, 350, { exe: '/usr/bin/openbox', argv: ['/usr/bin/openbox'], env: ['DISPLAY=:20'], cgroup: slice + 'my-openbox.service', ...openbox });
  const unit = (name, pid, extra = {}) => ({ MainPID: String(pid), FragmentPath: join(w.unitDir, name), DropInPaths: '', UnitFileState: 'enabled', ActiveState: 'active', Environment: '', EnvironmentFiles: '', ...extra });
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

// Chrome 96 and later keep cookies in <folder>/Network/Cookies; older ones in <folder>/Cookies.
export async function cookieStore(dir, rows, { folder = 'Default', legacy = false } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const parent = legacy ? join(dir, folder) : join(dir, folder, 'Network');
  await fs.mkdir(parent, { recursive: true });
  const db = new DatabaseSync(join(parent, 'Cookies'));
  db.exec('CREATE TABLE cookies (encrypted_value BLOB)');
  const insert = db.prepare('INSERT INTO cookies VALUES (?)');
  for (const value of rows) insert.run(Buffer.from(value));
  db.close();
}

export const MY_UNITS = ['my-chrome.service', 'my-openbox.service', 'my-xvfb.service'];
export const DROP_IN = '[Service]\nTimeoutStopSec=5\n';
export const healthyUser = async () => ({ ready: true, profile: 'user', cdpUrl: 'http://127.0.0.1:9222', recoveryRequired: false });
export const cookieDirs = async w => (await fs.readdir(w.stateDir)).filter(name => name.startsWith('cookies-'));
export const SAVED_COOKIES = [1, 2, 3].map(n => ({ name: 'sid' + n, value: 'cookie-secret-' + n, domain: 'example.com', path: '/' }));
export const exportsThree = async (url, dir) => {
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700, 'the cookie temp folder is private');
  const path = join(dir, 'cookies.json');
  await fs.writeFile(path, JSON.stringify(SAVED_COOKIES), { mode: 0o600 });
  return { path, count: 3 };
};
const COOKIE_METHODS = ['exportCookies', 'waitForBrowser', 'importCookies', 'closeBrowser', 'flushCookies', 'countCookies'];

// handWritten plus the my-* unit files on disk, a controller healthy on profile user, and a cookie module that records its calls in w.calls.
export async function applyWorld(t, options = {}) {
  const w = await handWritten(t, { ...options, deps: { controllerHealth: healthyUser, ...options.deps } });
  w.originals = {};
  await fs.mkdir(join(w.unitDir, 'my-chrome.service.d'), { recursive: true });
  for (const name of MY_UNITS) await fs.writeFile(join(w.unitDir, name), w.originals[name] = `[Service]\nExecStart=/usr/bin/true ${name}\n`);
  w.dropIn = join(w.unitDir, 'my-chrome.service.d/override.conf');
  await fs.writeFile(w.dropIn, DROP_IN);
  w.foreign['my-chrome.service'].DropInPaths = w.dropIn;
  w.cookies = {
    exportCookies: async (url, dir) => { const path = join(dir, 'cookies.json'); await fs.writeFile(path, '[]', { mode: 0o600 }); return { path, count: 0 }; },
    waitForBrowser: async () => {}, importCookies: async () => ({ count: 0 }), flushCookies: async () => {}, countCookies: async () => 0, closeBrowser: async () => {},
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
