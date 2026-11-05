import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAWSER_CHROME_FLAGS, chromeArgs, renderUnits, systemdArgument, systemdValue, unitNames } from '../src/host-units.mjs';

const base = names => ({
  names, display: 99, xauthority: '/state/Xauthority', xvfb: '/usr/bin/Xvfb', openbox: '/usr/bin/openbox', openboxConfig: '/state/openbox.xml',
  browser: { path: '/usr/bin/google-chrome', args: ['--lang=fr', 'about:blank'], env: [['LANG', 'fr_FR.UTF-8']] },
  python: '/usr/bin/python3', supervisorScript: '/pkg/supervisor.py', supervisorConfig: '/state/sup.json',
  node: '/usr/bin/node', controllerScript: '/pkg/controller.mjs', controllerConfig: '/state/config.json', marker: '/state/marker.json',
});
const render = (over = {}) => { const i = { ...base(unitNames('/state')), ...over }; return renderUnits({ ...i, names: over.names ?? unitNames('/state') }); };

test('unit names are stable per state directory and keep the controller name', () => {
  assert.deepEqual(unitNames('/a'), unitNames('/a'));
  assert.notEqual(unitNames('/a').browser, unitNames('/b').browser);
  assert.match(unitNames('/a').controller, /^clawser-desktop-[a-f0-9]{12}\.service$/);
  assert.match(unitNames('/a').windowManager, /^clawser-wm-[a-f0-9]{12}\.service$/);
});

test('chrome arguments replace only Clawser\'s flags and keep the rest in order', () => {
  const out = chromeArgs({ existing: ['--user-data-dir=/p', '--profile-directory=Work', '--lang=fr', '--remote-debugging-port=1', '--window-size=800,600', 'about:blank'], userDataDir: '/p', profileDirectory: 'Work', cdpPort: 9333 });
  const kept = out.filter(a => ['--user-data-dir=/p', '--profile-directory=Work', '--lang=fr', 'about:blank'].includes(a));
  assert.deepEqual(kept, ['--user-data-dir=/p', '--profile-directory=Work', '--lang=fr', 'about:blank']);
  assert.equal(out.filter(a => a === '--remote-debugging-port=9333').length, 1);
  assert.equal(out.filter(a => a === '--window-size=1920,1080').length, 1);
  assert.equal(out.filter(a => a.startsWith('--remote-debugging-port')).length, 1);
  for (const f of CLAWSER_CHROME_FLAGS) assert.ok(out.some(a => a.split('=')[0] === f), f);
});

test("Clawser's flags go before a -- terminator in the existing args", () => {
  const out = chromeArgs({ existing: ['--lang=fr', '--', 'https://example.com/a'], userDataDir: '/p', cdpPort: 9333 });
  const end = out.indexOf('--');
  assert.deepEqual(out.slice(end), ['--', 'https://example.com/a']);
  assert.ok(out.indexOf('--user-data-dir=/p') < end);
  for (const f of CLAWSER_CHROME_FLAGS) assert.ok(out.findIndex(a => a.split('=')[0] === f) < end, f);
});

test('chrome arguments refuse headless and a mismatched profile', () => {
  const o = { userDataDir: '/p', profileDirectory: 'Work', cdpPort: 9333 };
  assert.throws(() => chromeArgs({ ...o, existing: ['--headless=new'] }), /Refusing to take over a headless Chrome/);
  assert.throws(() => chromeArgs({ ...o, existing: ['--headless'] }), /headless/);
  assert.throws(() => chromeArgs({ ...o, existing: ['--user-data-dir=/other'] }), /--user-data-dir differs from the OpenClaw profile/);
  assert.throws(() => chromeArgs({ ...o, existing: ['--profile-directory=Other'] }), /--profile-directory differs from the OpenClaw profile/);
});

test('the display unit has a cookie, no TCP and never -ac', () => {
  const u = render()[unitNames('/state').display];
  for (const s of ['-nolisten tcp', '-auth "/state/Xauthority"', '1920x1080x24', 'Restart=always', 'RestartSec=2', '+extension XTEST']) assert.ok(u.includes(s), s);
  assert.doesNotMatch(u, /\s-ac(\s|$)/);
});

test('the browser unit waits for the display and restarts always', () => {
  const n = unitNames('/state');
  const u = render()[n.browser];
  assert.match(u, new RegExp(`Requires=${n.display}`));
  assert.match(u, new RegExp(`After=.*${n.display}`));
  assert.match(u, new RegExp(`After=.*${n.windowManager}`));
  for (const s of ['Environment="DISPLAY=:99"', 'Environment="XAUTHORITY=/state/Xauthority"', 'Environment="LANG=fr_FR.UTF-8"', 'UnsetEnvironment=WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS', 'Restart=always', 'RestartSec=5', 'TimeoutStopSec=15', '"--lang=fr"', '"about:blank"']) assert.ok(u.includes(s), s);
  const pre = u.split('\n').find(l => l.startsWith('ExecStartPre='));
  assert.ok(pre.includes('/tmp/.X11-unix/X99'));
  assert.ok(pre.includes('$$'));
  assert.doesNotMatch(pre.replace(/\$\$/g, ''), /\$/);
});

test('browser env rejects bad and owned names', () => {
  for (const name of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', '1X', 'A-B'])
    assert.throws(() => render({ browser: { ...base(unitNames('/state')).browser, env: [[name, 'x']] } }), /environment/i);
});

test('the supervisor unit kills its x11vnc children with it', () => {
  const n = unitNames('/state');
  const u = render()[n.supervisor];
  for (const s of ['KillMode=control-group', 'Restart=on-failure', 'UMask=0077', 'NoNewPrivileges=true', `Wants=${n.display} ${n.browser}`, `After=${n.display} ${n.browser}`, 'ExecStart="/usr/bin/python3" "/pkg/supervisor.py" "/state/sup.json"']) assert.ok(u.includes(s), s);
});

test('the supervisor unit drops a Wayland session from its x11vnc environment', () => {
  const n = unitNames('/state');
  const service = render()[n.supervisor].split('[Service]\n')[1];
  assert.match(service, /^UnsetEnvironment=WAYLAND_DISPLAY$/m);
});

test('the controller unit follows the supervisor', () => {
  const n = unitNames('/state');
  const u = render()[n.controller];
  for (const s of ['After=network-online.target ' + n.supervisor, 'Wants=' + n.supervisor, 'KillMode=mixed', 'TimeoutStopSec=180', 'ExecStart="/usr/bin/node" "/pkg/controller.mjs" "/state/config.json"']) assert.ok(u.includes(s), s);
});

test('without openbox there is no window manager unit and nothing refers to one', () => {
  const n = unitNames('/state');
  const units = render({ openbox: undefined });
  assert.equal(units[n.windowManager], undefined);
  for (const text of Object.values(units)) assert.ok(!text.includes(n.windowManager));
  assert.equal(Object.keys(units).length, 4);
});

test('the window manager unit orders itself between display and browser', () => {
  const n = unitNames('/state');
  const u = render()[n.windowManager];
  for (const s of [`Requires=${n.display}`, `After=${n.display}`, `Before=${n.browser}`, 'Environment="DISPLAY=:99"', 'UnsetEnvironment=WAYLAND_DISPLAY', 'ExecStart="/usr/bin/openbox" --config-file "/state/openbox.xml"', 'Restart=always']) assert.ok(u.includes(s), s);
});

test('every unit is marked as Clawser\'s and installs into default.target', () => {
  for (const u of Object.values(render({ marker: '/state/100%.json' }))) {
    assert.ok(u.startsWith('# Managed by Clawser; ownership is recorded in /state/100%%.json\n'));
    assert.ok(u.includes('[Install]\nWantedBy=default.target\n'));
  }
});

test('quoting helpers escape and the path helper stays strict', () => {
  assert.equal(systemdValue('a"b%c$d\\'), '"a\\"b%%c$$d\\\\"');
  assert.throws(() => systemdArgument('rel'), /absolute/);
  assert.throws(() => systemdValue('a\nb'), /control/);
});

test('dollar signs are doubled in Exec words but literal in Environment= values', () => {
  const n = unitNames('/state');
  const u = render({ xauthority: '/state/X$a', browser: { path: '/usr/bin/chrome', args: ['--x=$HOME'], env: [['PS1', 'a$b']] } })[n.browser];
  assert.ok(u.includes('Environment="PS1=a$b"'));
  assert.ok(u.includes('Environment="XAUTHORITY=/state/X$a"'));
  assert.ok(u.includes('"--x=$$HOME"'));
});
