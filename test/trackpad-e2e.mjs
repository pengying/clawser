// Manual real-desktop check for the viewer's Trackpad mode. Not part of npm test.
// A scratch display (140-199) at 1920x1080 runs openbox and a disposable windowed Chrome with two tabs.
// The real viewer runs in a phone-sized headless Chrome and drives it with real touch events in Trackpad mode.
// Nothing leaves the box and nothing touches :20, 9222 or a real profile. Both Chromes run with background traffic off,
// and the X server takes no TCP and only clients holding its cookie. Ctrl-C or a kill still stops everything and removes the temp dir.
// Usage: node test/trackpad-e2e.mjs <noVncAssetsDir>
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { CdpConnection } from '../src/cdp.mjs';
import { readFocus } from '../src/focus-state.mjs';
import { NoVncProbeGateway } from '../src/novnc-probe.mjs';
import { dropStaleLock } from '../runtime/desktop/test/xvfb.mjs';
import { xauthorityEntry } from '../src/host-display.mjs';

const assets = process.argv[2];
const CHROME = process.env.CHROME_BIN || '/opt/google/chrome/chrome';
const W = 1920, H = 1080;
const children = [], cleanups = [];
// Chrome's own traffic to Google (updates, sync, safe browsing lists, pings) stays off, as in renderer-readiness.mjs.
const QUIET = ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
  '--disable-default-apps', '--disable-sync', '--metrics-recording-only', '--no-pings'];
const exists = p => fs.access(p).then(() => true, () => false);
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const run = promisify(execFile);

async function devtoolsPort(profile) {
  for (let i = 0; i < 200; i++) { try { return (await fs.readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { await sleep(100); } }
  throw new Error('Chrome did not start');
}

// Stops every child, then runs the cleanups and removes the temp dir that holds both Chrome profiles. The end of the run
// and a SIGINT or SIGTERM share it, and it runs once.
let dir, x, cleaning;
// A child that starts after a signal began the cleanup is stopped at once, so nothing outlives the run.
const start = (...args) => { const child = spawn(...args); children.push(child); if (cleaning) child.kill('SIGKILL'); return child; };
function cleanup() {
  cleaning ??= (async () => {
    for (const c of [...children].reverse()) { try { c.kill('SIGTERM'); } catch {} }
    await sleep(800);
    for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
    for (const f of cleanups) await f().catch(e => console.log('cleanup:', e.message));
    if (x) {
      const { server } = x;
      if (server.exitCode === null && server.signalCode === null) {
        const exited = new Promise(r => server.once('exit', r));
        server.kill('SIGTERM');
        await Promise.race([exited, sleep(2000)]);
        try { server.kill('SIGKILL'); } catch {}
      }
      await dropStaleLock(x.number).catch(() => {});
    }
    if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(e => console.log('cleanup:', e.message));
  })();
  return cleaning;
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => {
  console.log(`FAIL stopped by ${signal}`);
  void cleanup().finally(() => process.exit(code));
});

try {
  dir = await fs.mkdtemp(join(tmpdir(), 'clawser-trackpad-e2e-'));
  // The server reads its cookie from server-auth. Clients find the same cookie for this display in xauth.
  const cookie = randomBytes(16);
  await fs.writeFile(join(dir, 'server-auth'), xauthorityEntry(0, cookie), { mode: 0o600 });
  for (let n = 140; n < 200 && !x; n++) {
    if (await exists(`/tmp/.X11-unix/X${n}`) || await exists(`/tmp/.X${n}-lock`)) continue;
    const server = spawn('Xvfb', [`:${n}`, '-auth', join(dir, 'server-auth'), '-nolisten', 'tcp', '-screen', '0', `${W}x${H}x24`, '+extension', 'XTEST'], { stdio: 'ignore' });
    x = { number: n, server };
    for (const deadline = Date.now() + 5000; server.exitCode === null; await sleep(50)) {
      if (await exists(`/tmp/.X11-unix/X${n}`)) { x.ready = true; break; }
      if (Date.now() > deadline) { server.kill('SIGKILL'); break; }
    }
    if (!x.ready) x = undefined;
  }
  assert.ok(x, 'free display in 140-199');
  await fs.writeFile(join(dir, 'xauth'), xauthorityEntry(x.number, cookie), { mode: 0o600 });
  const env = { ...process.env, DISPLAY: `:${x.number}`, XAUTHORITY: join(dir, 'xauth') }; delete env.WAYLAND_DISPLAY;
  log('display', x.number);

  // Default-size native radios, as most sites have them. Each logs the X server's view of the press and release.
  const RADIOS = '<!doctype html><title>Radios</title><body style="margin:0;font:16px sans-serif;background:#fff"><div style="padding:40px">' +
    '<p>Delivery</p>' + ['standard', 'express', 'pickup'].map(v => `<label style="display:block;margin:14px 0"><input type=radio name=ship id=${v} value=${v}> ${v}</label>`).join('') +
    '<p id=events></p><script>window.log=[];for(const t of ["mousedown","mouseup","click"])addEventListener(t,e=>log.push([t,e.button,Math.round(e.clientX),Math.round(e.clientY),e.target.id||e.target.tagName]),true)</script>';
  const OTHER = '<!doctype html><title>Second tab</title><body style="font:16px sans-serif">The second tab';
  const page = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(q.url.startsWith('/other') ? OTHER : RADIOS); });
  await new Promise(r => page.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise(r => page.close(r)));
  const base = `http://127.0.0.1:${page.address().port}`;
  start('openbox', [], { env, stdio: 'ignore' });
  await sleep(600);
  const agentProfile = join(dir, 'agent');
  // The live units' flags for size and position.
  start(CHROME, [...QUIET, '--ozone-platform=x11', '--password-store=basic',
    '--window-position=0,0', `--window-size=${W},${H}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${agentProfile}`, base + '/radios', base + '/other'], { env, stdio: 'ignore' });
  const agentCdp = 'http://127.0.0.1:' + await devtoolsPort(agentProfile);
  const agentTabs = async () => (await fetch(agentCdp + '/json/list', { signal: AbortSignal.timeout(3000) })).json();
  const onTab = async (prefix, expression) => {
    const tab = (await agentTabs()).find(t => t.type === 'page' && t.url.startsWith(base + prefix));
    const c = await new CdpConnection({ commandTimeoutMs: 5000 }).connect(tab.webSocketDebuggerUrl);
    try { return (await c.send('Runtime.evaluate', { expression, returnByValue: true })).result.value; } finally { c.close(); }
  };
  const visibleTab = async () => {
    for (const prefix of ['/radios', '/other']) if (await onTab(prefix, 'document.visibilityState') === 'visible') return prefix;
    return 'none';
  };
  let layout;
  const layoutExpression = 'JSON.stringify({ radios: Object.fromEntries(["standard","express","pickup"].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return [id, { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }]; })), top: screenY + outerHeight - innerHeight, left: screenX, chrome: outerHeight - innerHeight })';
  for (let i = 0; i < 100 && !layout; i++) { try { layout = JSON.parse(await onTab('/radios', layoutExpression)); } catch { await sleep(100); } }
  log('agent layout', JSON.stringify(layout));
  // Chrome opened the second tab last, so it is in front. Bring the radios forward over CDP first.
  const radiosTab = (await agentTabs()).find(t => t.type === 'page' && t.url.startsWith(base + '/radios'));
  await fetch(`${agentCdp}/json/activate/${radiosTab.id}`);
  await sleep(300);
  log('front tab', await visibleTab());

  const vnc = {};
  for (const role of ['watch', 'control']) {
    const password = (role + '12345678').slice(0, 8), pw = join(dir, role + '.pw'), sock = join(dir, role + '.sock');
    await fs.writeFile(pw, password + '\n', { mode: 0o600 });
    const args = ['-display', `unix/:${x.number}`, '-unixsock', sock, '-rfbport', '0', '-no6', '-rfbportv6', '-1', '-passwdfile', pw,
      '-forever', '-shared', '-noxdamage', '-noxrecord', '-nosel', '-noprimary', '-noclipboard', '-nosetclipboard', '-nosetprimary', '-noremote', '-nocmds', '-o', '/dev/null', '-norc'];
    if (role === 'watch') args.push('-viewonly');
    start('x11vnc', args, { env, stdio: 'ignore' });
    for (const deadline = Date.now() + 10_000; !(await fs.lstat(sock).then(i => i.isSocket(), () => false)); await sleep(50))
      assert.ok(Date.now() < deadline, 'x11vnc started');
    vnc[role] = { sock, password };
  }
  const supervisor = {
    async create({ probeId }) { return { ownedId: probeId }; }, async read() { return { state: 'running' }; },
    async register() { return { endpoint: { path: vnc.watch.sock }, credentials: { watch: vnc.watch.password, control: vnc.control.password } }; },
    async promote() { return { endpoint: { path: vnc.control.sock }, credentials: { watch: 'unused12', control: vnc.control.password } }; },
    async clipboardRead() { return { text: '' }; }, async clipboardWrite() { return { ok: true }; },
    async focusRead() { return readFocus({ cdpUrl: agentCdp, tabs: agentTabs }); },
    async destroy() {}, async verifyExited() { return true; },
  };
  const gateway = new NoVncProbeGateway({ supervisor, noVncAssetsDir: assets, prefix: '/browser/', completionDisposition: 'retained', capabilities: { clipboard: 'utf8' } });
  await gateway.start({ port: 0 });
  cleanups.unshift(() => gateway.close());
  const invite = await gateway.createProbe({ ttlSeconds: 300, permission: 'control' });

  const phoneProfile = join(dir, 'phone');
  start(CHROME, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', ...QUIET,
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${phoneProfile}`, 'about:blank'], { stdio: 'ignore' });
  const phonePort = await devtoolsPort(phoneProfile);
  const tab = await (await fetch(`http://127.0.0.1:${phonePort}/json/new?about:blank`, { method: 'PUT' })).json();
  const phone = await new CdpConnection({ commandTimeoutMs: 20_000 }).connect(tab.webSocketDebuggerUrl);
  const evaluate = async expression => (await phone.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  const waitFor = async (expression, label, tries = 200) => { for (let i = 0; i < tries; i++) { if (await evaluate(expression)) return; await sleep(50); } throw new Error('timed out: ' + label); };
  await phone.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2.6, mobile: true });
  await phone.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await phone.send('Page.navigate', { url: invite.url });
  await waitFor(`/Watching/.test(document.querySelector('#status')?.textContent || '')`, 'watch connected');
  await evaluate(`document.querySelector('#control').click()`);
  await waitFor(`document.querySelector('#status')?.textContent === 'Control connected.'`, 'control connected');
  const scale = await evaluate(`document.querySelector('canvas').getBoundingClientRect().width / ${W}`);
  log('viewer scale', scale.toFixed(3), 'so one phone pixel is', (1 / scale).toFixed(2), 'desktop pixels');

  const touch = (type, points) => phone.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([px, py], id) => ({ x: px, y: py, id, radiusX: 1, radiusY: 1, force: 1 })) });
  await evaluate(`__viewer.setInputMode('trackpad')`);
  await evaluate(`__viewer.hideBar()`);
  await evaluate(`__viewer.zoomTo('fit')`);
  await sleep(300);
  const resetRadios = () => onTab('/radios', 'for (const r of document.querySelectorAll("input")) r.checked = false; log.length = 0; true');
  const checkedRadio = () => onTab('/radios', '[...document.querySelectorAll("input")].find(r => r.checked)?.id || "none"');
  const pointer = () => evaluate('__viewer.pointer()');

  // Moves the pointer with small slow slides (<= 0.17 px/ms, so the gain is 1) and corrects until it is within 2 desktop px.
  // Each slide ends more than 250 ms after it started, so it is never taken for a tap.
  // The viewer ignores a slide until it has gone 4 phone px, so a correction shorter than 6 px first steps 6 px the other way
  // in one move, which counts in full, then comes back past the start. The two legs add up to the correction.
  const aimAt = async (fx, fy) => {
    for (let round = 0; round < 40; round++) {
      const p = await pointer();
      const dx = (fx - p.x) * scale, dy = (fy - p.y) * scale, distance = Math.hypot(dx, dy);
      if (distance / scale <= 2) return p;
      const start = [200, 500];
      await touch('touchStart', [start]);
      if (distance < 6) {
        await sleep(60); await touch('touchMove', [[start[0] - dx / distance * 6, start[1] - dy / distance * 6]]);
        await sleep(60); await touch('touchMove', [[start[0] + dx, start[1] + dy]]);
      } else {
        const steps = Math.min(8, Math.max(2, Math.ceil(distance / 5)));
        for (let i = 1; i <= steps; i++) { await sleep(30); await touch('touchMove', [[start[0] + dx * i / steps, start[1] + dy * i / steps]]); }
      }
      await sleep(300);
      await touch('touchEnd', []);
      await sleep(120);
    }
    const p = await pointer();
    throw new Error(`could not aim at ${fx},${fy}; pointer is at ${p.x},${p.y}`);
  };
  const tap = async () => { await touch('touchStart', [[200, 500]]); await sleep(60); await touch('touchEnd', []); await sleep(500); };
  const twoFingerTap = async () => { await touch('touchStart', [[150, 500], [260, 500]]); await sleep(80); await touch('touchEnd', []); await sleep(600); };

  // Context-menu detection: the top-level windows from xwininfo -root -children. Chrome's menu is a new override-redirect
  // child of the root, so a new window id after the two-finger tap means a menu opened, and its absence after a click elsewhere means it
  // closed. xdotool is not on the box and xwd diffs depend on theme pixels, so the window list is the exact, cheap choice.
  const rootOnlyChildren = async () => {
    const { stdout } = await run('xwininfo', ['-root', '-children', '-display', `:${x.number}`], { env });
    return new Set(stdout.split('\n').map(l => l.match(/^\s+(0x[0-9a-f]+) /)?.[1]).filter(Boolean));
  };
  const check = (name, ok, detail = '') => { if (!ok) throw new Error(`${name} failed ${detail}`); console.log(`ok   ${name} ${detail}`); };

  // 1. Slide to the second tab and tap: /other becomes the active tab.
  check('starts on the radios tab', await visibleTab() === '/radios');
  const tabAim = await aimAt(330, 20);
  log('pointer at the second tab', JSON.stringify(tabAim));
  await tap();
  await sleep(400);
  check('trackpad tap on the second tab switches to /other', await visibleTab() === '/other', `(now ${await visibleTab()})`);
  await fetch(`${agentCdp}/json/activate/${radiosTab.id}`); await sleep(400);

  // 2. Move onto the third radio button and tap.
  await resetRadios();
  const fx = layout.left + layout.radios.pickup.x, fy = layout.top + layout.radios.pickup.y;
  await aimAt(fx, fy);
  await tap();
  check('trackpad tap on the third radio checks it', await checkedRadio() === 'pickup', `(checked ${await checkedRadio()})`);

  // 3. A two-finger tap opens Chrome's context menu.
  await resetRadios();
  await aimAt(fx + 200, fy + 60);
  const before = await rootOnlyChildren();
  await twoFingerTap();
  const after = await rootOnlyChildren();
  const added = [...after].filter(id => !before.has(id));
  check('a two-finger tap opens a context menu window', added.length > 0, `(new windows ${added.join(',') || 'none'})`);
  // Close it: move well away from the menu and click on the page.
  await aimAt(fx + 700, fy + 400);
  await tap();
  const closed = await rootOnlyChildren();
  check('the context menu closes again', added.every(id => !closed.has(id)));
  console.log('PASS');
  phone.close();
} catch (error) {
  console.log('FAIL ' + (error.stack || error.message));
  process.exitCode = 1;
} finally {
  await cleanup();
}
