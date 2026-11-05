import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { skip as noX, startX, serverArgs, dropStaleLock } from './xvfb.mjs';
import { supervisorRequest } from '../index.mjs';
import { processTree, tcpListeners } from './rfb.mjs';

const has = bin => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = noX || (has('x11vnc') ? false : 'needs x11vnc');
const opts = { skip, timeout: 30_000 };
const script = new URL('../supervisor.py', import.meta.url).pathname;
const fixture = new URL('./input_fixture.py', import.meta.url).pathname;
const text = 'Clipboard proof — 中文 🙂\nsecond line';

async function fakeCdp() {
  let guid = randomUUID(), down = false, delay;
  const timers = new Set();
  const server = http.createServer((request, response) => {
    if (request.url !== '/json/version') return response.writeHead(404).end();
    if (down) return response.writeHead(503).end();
    const body = JSON.stringify({ Browser: 'Chrome/156.0', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/${guid}` });
    const reply = () => { response.setHeader('content-type', 'application/json'); response.end(body); };
    if (!delay) return reply();
    const { ms, arrived } = delay;
    delay = undefined;
    const timer = setTimeout(() => { timers.delete(timer); reply(); }, ms);
    timers.add(timer);
    arrived();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    get guid() { return guid; },
    set guid(value) { guid = value; },
    set down(value) { down = value; },
    delayNext: ms => new Promise(arrived => { delay = { ms, arrived }; }),
    close: () => { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); },
  };
}

async function rfbSecurityTypes(path) {
  const socket = net.connect({ path });
  let buffered = Buffer.alloc(0), wake;
  socket.on('data', bytes => { buffered = Buffer.concat([buffered, bytes]); wake?.(); });
  const read = async n => {
    for (const deadline = Date.now() + 5000; buffered.length < n;) {
      if (Date.now() > deadline) throw new Error('RFB read timeout');
      await new Promise(resolve => { wake = resolve; setTimeout(resolve, 25); });
    }
    const out = buffered.subarray(0, n);
    buffered = buffered.subarray(n);
    return out;
  };
  try {
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const banner = (await read(12)).toString();
    socket.write('RFB 003.008\n');
    const count = (await read(1))[0];
    return { banner, types: [...await read(count)] };
  } finally { socket.destroy(); }
}

const displayPid = async display => Number((await fs.readFile(`/tmp/.X${display}-lock`, 'utf8')).trim());

async function until(check, ms, what) {
  for (const deadline = Date.now() + ms; ;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const exists = path => fs.lstat(path).then(() => true, () => false);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function desktop(t, { cdpDown = false, extraEnv = {}, browserCheckMs } = {}) {
  const x = await startX({ numbered: true });
  const cdp = await fakeCdp();
  cdp.down = cdpDown;
  const run = join(x.dir, 'run'), vncDir = join(x.dir, 'vnc');
  await fs.mkdir(run, { mode: 0o700 });
  await fs.mkdir(vncDir, { mode: 0o700 });
  const controlSocket = join(run, 'control.sock'), config = join(x.dir, 'supervisor.json');
  const display = Number(x.env.DISPLAY.slice(1));
  await fs.writeFile(config, JSON.stringify({ display, xauthority: x.env.XAUTHORITY, controlSocket, vncDir, cdpUrl: cdp.url }), { mode: 0o600 });
  // The config alone must name the display.
  const env = { ...x.env, DESKTOP_TEST_HEARTBEAT_TIMEOUT_MS: '2000', ...browserCheckMs ? { DESKTOP_TEST_BROWSER_CHECK_MS: String(browserCheckMs) } : {} };
  delete env.DISPLAY; delete env.XAUTHORITY;
  Object.assign(env, extraEnv);
  const children = [], pgids = new Set(), holders = [], timers = new Set(), displays = [];
  const h = {
    x, cdp, display, controlSocket, vncDir, config, env,
    rpc: (op, fields = {}) => supervisorRequest(controlSocket, { op, ...fields }),
    launch(configPath = config) {
      const child = spawn('python3', [script, configPath], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      child.log = '';
      child.stderr.on('data', bytes => { child.log = (child.log + bytes).slice(-4000); });
      child.exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      child.refused = () => Promise.race([child.exited, sleep(10_000).then(() => { throw new Error('supervisor kept running'); })]);
      children.push(child);
      return child;
    },
    // Restarts the supervisor with extra config fields.
    async restartWith(fields) {
      h.supervisor.kill('SIGTERM');
      await h.supervisor.exited;
      await fs.writeFile(config, JSON.stringify({ ...JSON.parse(await fs.readFile(config, 'utf8')), ...fields }), { mode: 0o600 });
      return h.serve();
    },
    async serve() {
      const child = h.launch();
      // A killed supervisor leaves its socket behind. Wait for an answer, not the file.
      await until(async () => {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('supervisor exited: ' + child.log);
        return (await h.rpc('status')).phase !== 'starting';
      }, 15_000, 'the supervisor to serve');
      h.supervisor = child;
      return child;
    },
    async start(leaseId, role, { keepAlive = true } = {}) {
      const viewer = await h.rpc('startViewer', { leaseId, role });
      pgids.add(viewer.pid);
      if (keepAlive) h.keepAlive(viewer);
      return viewer;
    },
    keepAlive(viewer) {
      const timer = setInterval(() => h.rpc('heartbeatViewer', { leaseId: viewer.leaseId, epoch: viewer.epoch }).catch(() => clearInterval(timer)), 400);
      timers.add(timer);
    },
    track(pid) { pgids.add(pid); },
    async hold() {
      const holder = spawn('python3', [fixture, 'hold', 'stay'], { env: x.env, stdio: ['pipe', 'pipe', 'inherit'] });
      holders.push(holder);
      const state = await new Promise((resolve, reject) => { holder.stdout.once('data', bytes => resolve(JSON.parse(bytes))); holder.once('exit', () => reject(new Error('fixture exited'))); });
      assert.deepEqual(state, { shift: true, button1: true });
      return holder;
    },
    async restartDisplay() {
      process.kill(x.pid, 'SIGTERM');
      await until(async () => !await exists(`/tmp/.X11-unix/X${display}`) && !alive(x.pid), 5000, 'the display to stop');
      const replacement = spawn('Xvfb', [`:${display}`, ...serverArgs(join(x.dir, 'server-auth'))], { stdio: 'ignore' });
      replacement.exited = new Promise(resolve => replacement.once('exit', resolve));
      displays.push(replacement);
      await until(() => exists(`/tmp/.X11-unix/X${display}`), 5000, 'the replacement display');
      return replacement;
    },
    query: async () => JSON.parse((await x.run(fixture, 'query')).stdout),
    held: async () => (await x.json('held')).held,
  };
  t.after(async () => {
    for (const timer of timers) clearInterval(timer);
    for (const holder of holders) { holder.stdin.end(); holder.kill(); }
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill('SIGTERM');
      if (!await Promise.race([child.exited.then(() => true), sleep(8000).then(() => false)])) { child.kill('SIGKILL'); await child.exited; }
    }
    for (const pgid of pgids) { try { process.kill(-pgid, 'SIGKILL'); } catch {} }
    for (const replacement of displays) { if (replacement.exitCode === null && replacement.signalCode === null) { replacement.kill(); await replacement.exited; } }
    await cdp.close();
    await x.stop();
    await dropStaleLock(display);
  });
  await h.serve();
  return h;
}

test('status describes the host truthfully', opts, async t => {
  const h = await desktop(t);
  const status = await h.rpc('status');
  assert.equal(status.isolation, 'host-user-services');
  assert.equal(status.browserSandbox, 'chrome-os-sandbox');
  assert.equal(status.egressFirewall, false);
  assert.equal(status.ready, true);
  assert.equal(status.browserReady, true);
  assert.equal(status.tainted, false);
  assert.equal(status.viewer, null);
  assert.equal(status.heartbeatTimeoutMs, 2000);
  const [boot, inode, pid, ...rest] = status.displayGeneration.split(':');
  assert.match(boot, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(inode, String((await fs.stat(`/tmp/.X11-unix/X${h.display}`)).ino));
  assert.equal(pid, String(h.x.pid));
  assert.equal(Number(pid), await displayPid(h.display));
  assert.deepEqual(rest, []);
  assert.equal(status.browserGeneration, `${boot}:${h.cdp.guid}`);
});

test('the control socket is private to the supervisor user', opts, async t => {
  const h = await desktop(t);
  const info = await fs.lstat(h.controlSocket);
  assert.ok(info.isSocket());
  assert.equal(info.uid, process.getuid());
  assert.equal(info.mode & 0o077, 0, 'no group or other access to the control socket');
  h.supervisor.kill('SIGTERM');
  await h.supervisor.exited;
  await fs.chmod(join(h.controlSocket, '..'), 0o750);
  const child = h.launch();
  const { code } = await child.refused();
  assert.notEqual(code, 0);
  assert.match(child.log, /must be a 0700 directory/);
  assert.equal(await exists(h.controlSocket), false);
});

test('a CDP origin other than 127.0.0.1 is refused', opts, async t => {
  const h = await desktop(t);
  for (const cdpUrl of ['http://localhost:9', 'http://[::1]:9']) {
    const config = join(h.x.dir, 'other.json');
    await fs.writeFile(config, JSON.stringify({ display: h.display, xauthority: h.x.env.XAUTHORITY, controlSocket: join(h.x.dir, 'run', 'other.sock'), vncDir: h.vncDir, cdpUrl }), { mode: 0o600 });
    const child = h.launch(config);
    const { code } = await child.refused();
    assert.notEqual(code, 0, cdpUrl);
    assert.match(child.log, /cdpUrl must be http:\/\/127\.0\.0\.1/, cdpUrl);
  }
});

test('a relative x11vnc path is refused at config load', opts, async t => {
  const h = await desktop(t);
  const config = join(h.x.dir, 'relative-x11vnc.json');
  await fs.writeFile(config, JSON.stringify({ display: h.display, xauthority: h.x.env.XAUTHORITY, controlSocket: join(h.x.dir, 'run', 'other.sock'), vncDir: h.vncDir, cdpUrl: h.cdp.url, x11vnc: 'x11vnc' }), { mode: 0o600 });
  const child = h.launch(config);
  const { code } = await child.refused();
  assert.notEqual(code, 0);
  assert.match(child.log, /x11vnc must be an absolute path/);
});

test('browserReady drops when the browser stops answering, without retiring a session', opts, async t => {
  const h = await desktop(t);
  const viewer = await h.start('watch-cdp-down', 'watch');
  await h.cdp.close();
  await sleep(1500);
  const status = await h.rpc('status');
  assert.equal(status.browserReady, false);
  assert.equal(status.viewer?.leaseId, viewer.leaseId);
  assert.equal(status.tainted, false);
  assert.equal(status.ready, true);
});

test('a watch viewer serves RFB only on its private socket', opts, async t => {
  const h = await desktop(t);
  const viewer = await h.start('watch-rfb', 'watch');
  assert.equal(viewer.host, undefined);
  assert.equal(viewer.port, undefined);
  assert.match(viewer.socketPath, /\/vnc-[0-9a-f]{16}\.sock$/);
  assert.equal(join(h.vncDir, viewer.socketPath.slice(h.vncDir.length + 1)), viewer.socketPath);
  assert.ok((await fs.lstat(viewer.socketPath)).isSocket());
  assert.equal((await fs.stat(h.vncDir)).mode & 0o777, 0o700);
  assert.ok(viewer.xClients.some(client => client.pid === viewer.pid));
  const { banner, types } = await rfbSecurityTypes(viewer.socketPath);
  assert.match(banner, /^RFB 003\.00[38]\n/);
  assert.deepEqual(types, [2], 'VNC password authentication is the only security type');
  const links = await Promise.all((await fs.readdir(`/proc/${viewer.pid}/fd`)).map(fd => fs.readlink(`/proc/${viewer.pid}/fd/${fd}`).catch(() => '')));
  assert.ok(links.some(link => link.startsWith('socket:')), 'x11vnc holds no sockets, so the scan would prove nothing');
  const tree = await processTree(viewer.pid);
  assert.equal(tree[0], viewer.pid);
  assert.deepEqual(await tcpListeners(tree), [], 'x11vnc listens on TCP');
});

// A desktop session's user manager exports WAYLAND_DISPLAY, and x11vnc exits when it sees one.
test('a Wayland session in the environment does not stop the supervisor from starting a viewer', opts, async t => {
  const h = await desktop(t, { extraEnv: { WAYLAND_DISPLAY: 'wayland-0' } });
  const viewer = await h.start('wayland-watch', 'watch');
  assert.ok(alive(viewer.pid), 'x11vnc exited');
  assert.ok(viewer.xClients.some(client => client.pid === viewer.pid));
  const { banner } = await rfbSecurityTypes(viewer.socketPath);
  assert.match(banner, /^RFB 003\.00[38]\n/);
  assert.ok(alive(viewer.pid), 'x11vnc exited after serving RFB');
});

test('settling a control viewer releases a key held outside it', opts, async t => {
  const h = await desktop(t);
  const viewer = await h.start('control-settle', 'control');
  await h.hold();
  const receipt = await h.rpc('stopViewerAndSettle', { leaseId: viewer.leaseId, mayBeWritable: true });
  assert.equal(receipt.heldInputCleared, true);
  assert.equal(receipt.xClientsAbsent, true);
  assert.equal(receipt.vncProcessesExited, true);
  assert.equal(receipt.inputResetRequired, true);
  assert.equal(await exists(viewer.socketPath), false);
  assert.deepEqual((await fs.readdir(h.vncDir)).sort(), []);
  assert.deepEqual(await h.query(), { shift: false, button1: false });
  assert.equal(alive(viewer.pid), false);
});

test('a watch retirement leaves agent input alone until a writable settlement is asked for', opts, async t => {
  const h = await desktop(t);
  const viewer = await h.start('watch-readonly', 'watch');
  await h.hold();
  const receipt = await h.rpc('stopViewerAndSettle', { leaseId: viewer.leaseId });
  assert.equal(receipt.readOnly, true);
  assert.equal(receipt.inputResetRequired, false);
  assert.equal(receipt.heldInputCleared, false);
  assert.equal(receipt.xClientsAbsent, true);
  assert.deepEqual(await h.query(), { shift: true, button1: true });
  assert.deepEqual(await h.rpc('stopViewerAndSettle', { leaseId: viewer.leaseId }), receipt);
  const forced = await h.rpc('stopViewerAndSettle', { leaseId: viewer.leaseId, mayBeWritable: true });
  assert.equal(forced.readOnly, false);
  assert.equal(forced.inputResetRequired, true);
  assert.equal(forced.heldInputCleared, true);
  assert.ok(forced.epoch > receipt.epoch);
  assert.deepEqual(await h.query(), { shift: false, button1: false });
});

test('promoting a watch viewer replaces its actor and socket', opts, async t => {
  const h = await desktop(t);
  const watch = await h.start('promote', 'watch');
  const promoted = await h.rpc('promoteViewer', { leaseId: watch.leaseId });
  h.track(promoted.pid);
  h.keepAlive(promoted);
  assert.equal(promoted.role, 'control');
  assert.equal(promoted.previousSettlement.readOnly, true);
  assert.equal(promoted.previousSettlement.inputResetRequired, false);
  assert.notEqual(promoted.pid, watch.pid);
  assert.notEqual(promoted.socketPath, watch.socketPath);
  assert.ok(promoted.epoch > watch.epoch);
  assert.equal(await exists(watch.socketPath), false);
  assert.ok((await fs.lstat(promoted.socketPath)).isSocket());
  await h.rpc('stopViewerAndSettle', { leaseId: watch.leaseId });
});

test('heartbeats keep a viewer alive and their loss retires it', opts, async t => {
  const h = await desktop(t);
  const viewer = await h.start('heartbeats', 'control', { keepAlive: false });
  for (let n = 0; n < 6; n++) {
    await sleep(500);
    const ack = await h.rpc('heartbeatViewer', { leaseId: viewer.leaseId, epoch: viewer.epoch });
    assert.equal(ack.ok, true);
    assert.ok(ack.heartbeatDeadline <= viewer.expiresAt);
  }
  assert.equal((await h.rpc('status')).viewer.leaseId, viewer.leaseId);
  await assert.rejects(h.rpc('heartbeatViewer', { leaseId: 'other', epoch: viewer.epoch }), /lease\/epoch mismatch/);
  await assert.rejects(h.rpc('heartbeatViewer', { leaseId: viewer.leaseId, epoch: viewer.epoch + 1 }), /lease\/epoch mismatch/);
  await h.hold();
  await until(async () => (await h.rpc('status')).viewer === null, 4000, 'heartbeat retirement');
  const receipt = await h.rpc('stopViewerAndSettle', { leaseId: viewer.leaseId });
  assert.equal(receipt.retirementReason, 'heartbeat_timeout');
  assert.equal(receipt.heldInputCleared, true);
  assert.deepEqual(await h.query(), { shift: false, button1: false });
  assert.equal((await h.rpc('status')).tainted, false);
});

// A stand-in browser: a copy of python3 that listens on the fake CDP port, so the supervisor finds it by port, as it finds Chrome.
async function browserHolder(t, h) {
  const dir = await fs.mkdtemp(join(h.x.dir, 'chrome-'));
  const exe = join(dir, 'chrome');
  await fs.copyFile(execFileSync('python3', ['-c', 'import sys,os;print(os.path.realpath(sys.executable))']).toString().trim(), exe);
  await fs.chmod(exe, 0o755);
  // The fake CDP server owns the port, so the holder takes a second port and the supervisor is told about it.
  const holder = spawn(exe, ['-c', 'import socket,sys,time\ns=socket.socket();s.bind(("127.0.0.1",0));s.listen();print(s.getsockname()[1],flush=True)\nwhile True: time.sleep(1)'],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  holder.exited = new Promise(resolve => holder.once('exit', (code, signal) => resolve({ code, signal })));
  const port = Number(await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('exit', () => reject(new Error('holder exited'))); }));
  t.after(async () => { if (holder.exitCode === null && holder.signalCode === null) { holder.kill('SIGKILL'); await holder.exited; } });
  return { holder, exe, port, upgrade: async () => { await fs.rm(exe); await fs.copyFile(execFileSync('python3', ['-c', 'import sys,os;print(os.path.realpath(sys.executable))']).toString().trim(), exe); await fs.chmod(exe, 0o755); } };
}

test('an idle browser whose binary was upgraded underneath it is stopped so its unit restarts it', opts, async t => {
  const h = await desktop(t, { browserCheckMs: 300 });
  const b = await browserHolder(t, h);
  await h.restartWith({ browserPort: b.port });
  await sleep(1000);
  assert.equal(b.holder.exitCode, null, 'a current binary is left running');
  await b.upgrade();
  assert.deepEqual(await Promise.race([b.holder.exited, sleep(5000).then(() => 'still running')]), { code: null, signal: 'SIGTERM' });
  assert.match(h.supervisor.log, /was upgraded while it ran; stopping it so its unit restarts it on the new version/);
  assert.equal((await h.rpc('status')).tainted, false);
});

test('a browser upgraded during a control session is left running until the session ends', opts, async t => {
  const h = await desktop(t, { browserCheckMs: 300 });
  const b = await browserHolder(t, h);
  await h.restartWith({ browserPort: b.port });
  const viewer = await h.start('control-browser-upgrade', 'control');
  await b.upgrade();
  await sleep(1500);
  assert.equal(b.holder.exitCode, null, 'never restarted under a person');
  await h.rpc('stopViewerAndSettle', { leaseId: viewer.leaseId, mayBeWritable: true });
  assert.deepEqual(await Promise.race([b.holder.exited, sleep(5000).then(() => 'still running')]), { code: null, signal: 'SIGTERM' });
});

test('a browser whose binary was removed, not replaced, is left running', opts, async t => {
  const h = await desktop(t, { browserCheckMs: 300 });
  const b = await browserHolder(t, h);
  await h.restartWith({ browserPort: b.port });
  await fs.rm(b.exe);
  await sleep(1500);
  assert.equal(b.holder.exitCode, null, 'a restart would fail with no binary to start');
});

test('a browser restart while idle changes browserGeneration and leaves the desktop usable', opts, async t => {
  const h = await desktop(t);
  const before = await h.rpc('status');
  h.cdp.guid = randomUUID();
  await sleep(1000);
  const after = await h.rpc('status');
  assert.notEqual(after.browserGeneration, before.browserGeneration);
  assert.equal(after.browserGeneration.split(':')[1], h.cdp.guid);
  assert.equal(after.displayGeneration, before.displayGeneration);
  assert.equal(after.tainted, false);
  assert.equal(after.ready, true);
  const viewer = await h.start('after-browser-restart', 'watch');
  assert.equal(viewer.browserGeneration, after.browserGeneration);
});

test('a browser restart during a control session retires it and taints the desktop', opts, async t => {
  const h = await desktop(t);
  const viewer = await h.start('control-browser-restart', 'control');
  h.cdp.guid = randomUUID();
  const status = await until(async () => { const s = await h.rpc('status'); return s.viewer === null && s.tainted && s; }, 2000, 'retirement and taint');
  assert.equal(status.ready, false);
  const receipt = await h.rpc('stopViewerAndSettle', { leaseId: viewer.leaseId });
  assert.equal(receipt.retirementReason, 'critical_child_exit');
  assert.equal(receipt.vncProcessesExited, true);
  assert.notEqual(receipt.browserGeneration, viewer.browserGeneration);
  await assert.rejects(h.rpc('startViewer', { leaseId: 'after-taint', role: 'watch' }), /quarantined/);
});

test('a display restart while idle changes displayGeneration and leaves the desktop usable', opts, async t => {
  const h = await desktop(t);
  const before = await h.rpc('status');
  await h.restartDisplay();
  const after = await until(async () => { const s = await h.rpc('status'); return s.ready && s.displayGeneration !== before.displayGeneration && s; }, 3000, 'the new display generation');
  assert.equal(after.tainted, false);
  assert.equal(after.browserGeneration, before.browserGeneration);
  const viewer = await h.start('after-display-restart', 'control');
  assert.equal(viewer.displayGeneration, after.displayGeneration);
  assert.equal((await h.rpc('stopViewerAndSettle', { leaseId: viewer.leaseId })).heldInputCleared, true);
});

test('a display restart during a control session retires it and taints the desktop', opts, async t => {
  const h = await desktop(t);
  const viewer = await h.start('control-display-restart', 'control');
  await h.restartDisplay();
  const status = await until(async () => { const s = await h.rpc('status'); return s.viewer === null && s.displayGeneration !== viewer.displayGeneration && s; }, 4000, 'retirement and the new display generation');
  assert.equal(status.tainted, true);
  assert.equal(status.ready, false);
  const receipt = await h.rpc('stopViewerAndSettle', { leaseId: viewer.leaseId });
  assert.equal(receipt.retirementReason, 'critical_child_exit');
  assert.equal(receipt.vncProcessesExited, true);
  assert.equal(alive(viewer.pid), false);
  await assert.rejects(h.rpc('startViewer', { leaseId: 'after-display-taint', role: 'watch' }), /quarantined/);
});

test('a display restart changes the Xvfb PID in displayGeneration even if its socket inode were reused', opts, async t => {
  const h = await desktop(t);
  const before = await h.rpc('status');
  const replacement = await h.restartDisplay();
  const after = await until(async () => { const s = await h.rpc('status'); return s.ready && s.displayGeneration !== before.displayGeneration && s; }, 3000, 'the new display generation');
  const [beforeBoot, , beforePid] = before.displayGeneration.split(':');
  const [afterBoot, , afterPid] = after.displayGeneration.split(':');
  assert.equal(afterBoot, beforeBoot);
  assert.equal(beforePid, String(h.x.pid));
  assert.equal(afterPid, String(replacement.pid));
  assert.notEqual(afterPid, beforePid, 'the PID part alone distinguishes the new server');
  assert.equal(after.tainted, false);
});

test('a display whose lock file is missing or unparseable is unavailable', opts, async t => {
  const h = await desktop(t);
  const lock = `/tmp/.X${h.display}-lock`;
  const original = await fs.readFile(lock);
  const restore = async () => { await fs.rm(lock, { force: true }); await fs.writeFile(lock, original, { mode: 0o444 }); };
  try {
    for (const replace of [() => fs.rm(lock), async () => { await fs.rm(lock); await fs.writeFile(lock, 'not a pid\n', { mode: 0o444 }); }]) {
      await replace();
      const down = await until(async () => { const s = await h.rpc('status'); return s.ready === false && s; }, 2000, 'the display to read as unavailable');
      assert.equal(down.tainted, false);
      await assert.rejects(h.rpc('startViewer', { leaseId: 'no-lock', role: 'watch' }), /unavailable/);
      await restore();
      await until(async () => (await h.rpc('status')).ready, 2000, 'the display to come back');
    }
  } finally { await restore(); }
});

test('a slow browser probe from before a display restart does not roll the generation back', opts, async t => {
  const h = await desktop(t);
  const arrived = h.cdp.delayNext(1800);
  await arrived;
  await h.restartDisplay();
  const viewer = await h.start('after-slow-probe', 'watch');
  assert.equal(viewer.displayGeneration.split(':')[2], String((await displayPid(h.display))));
  await sleep(1000);
  const status = await h.rpc('status');
  assert.equal(status.tainted, false);
  assert.equal(status.viewer?.leaseId, viewer.leaseId);
  assert.equal(status.displayGeneration, viewer.displayGeneration);
});

test('learning the browser guid for the first time does not taint an active session', opts, async t => {
  const h = await desktop(t, { cdpDown: true });
  const before = await h.rpc('status');
  assert.equal(before.browserReady, false);
  assert.match(before.browserGeneration, /:none$/);
  const viewer = await h.start('first-guid', 'control');
  h.cdp.down = false;
  const status = await until(async () => { const s = await h.rpc('status'); return s.browserReady && s; }, 2000, 'the browser to answer');
  await sleep(200);
  const after = await h.rpc('status');
  assert.equal(after.tainted, false);
  assert.equal(after.viewer?.leaseId, viewer.leaseId);
  assert.equal(status.browserGeneration.split(':')[1], h.cdp.guid);
});

test('a retirement that keeps failing backs off and logs once', opts, async t => {
  const h = await desktop(t);
  await h.start('backoff', 'control');
  process.kill(h.x.pid, 'SIGTERM');
  await until(async () => (await h.rpc('status')).viewer?.retirementAttempts >= 1, 3000, 'the first failed retirement');
  await sleep(4000);
  const status = await h.rpc('status');
  assert.equal(status.tainted, true);
  // Backoff of 0.5, 1 and 2 s fits in the window. A fixed 0.5 s retry would try about nine times.
  assert.ok(status.viewer.retirementAttempts >= 2 && status.viewer.retirementAttempts <= 4, `attempts: ${status.viewer.retirementAttempts}`);
  assert.equal(h.supervisor.log.match(/retirement failed/g)?.length, 1);
});

test('a supervisor restart changes both generations and releases input its x11vnc left held', opts, async t => {
  const h = await desktop(t);
  const viewer = await h.start('restart', 'control', { keepAlive: false });
  const owner = await h.rpc('clipboardWrite', { text: 'orphaned', leaseId: viewer.leaseId, epoch: viewer.epoch });
  h.track(owner.ownerPid);
  const before = await h.rpc('status');
  await h.hold();
  assert.equal(await h.held(), true);
  h.supervisor.kill('SIGKILL');
  await h.supervisor.exited;
  assert.equal(await exists(h.controlSocket), true, 'a killed supervisor leaves its socket behind');
  assert.equal(alive(viewer.pid), true, 'outside systemd its actor outlives it');
  assert.equal(alive(owner.ownerPid), true, 'and so does its clipboard owner');
  await h.serve();
  assert.equal(alive(viewer.pid), false, 'the new supervisor kills the orphaned actor');
  assert.equal(alive(owner.ownerPid), false, 'and the orphaned clipboard owner');
  assert.equal((await h.x.json('selection-owner')).pid, 0);
  assert.equal(await exists(viewer.socketPath), false);
  assert.deepEqual(await fs.readdir(h.vncDir), []);
  const after = await h.rpc('status');
  assert.notEqual(after.displayGeneration, before.displayGeneration);
  assert.notEqual(after.browserGeneration, before.browserGeneration);
  assert.equal(after.displayGeneration.split(':')[1], before.displayGeneration.split(':')[1]);
  assert.equal(after.browserGeneration.split(':')[1], before.browserGeneration.split(':')[1]);
  assert.equal(after.tainted, false);
  assert.equal(after.ready, true);
  assert.equal(after.viewer, null);
  assert.equal(await h.held(), false);
  assert.deepEqual(await h.query(), { shift: false, button1: false });
});

test('clipboard round-trips for the control lease only', opts, async t => {
  const h = await desktop(t);
  await assert.rejects(h.rpc('clipboardRead'), /control lease/);
  const watch = await h.start('clipboard-watch', 'watch');
  await assert.rejects(h.rpc('clipboardRead'), /control lease/);
  await assert.rejects(h.rpc('clipboardWrite', { text: 'no' }), /control lease/);
  await h.rpc('stopViewerAndSettle', { leaseId: watch.leaseId });
  const viewer = await h.start('clipboard-control', 'control');
  await assert.rejects(h.rpc('clipboardRead'), { message: 'desktop clipboardRead: clipboard unavailable' });
  const first = await h.rpc('clipboardWrite', { text, leaseId: viewer.leaseId, epoch: viewer.epoch });
  h.track(first.ownerPid);
  const second = await h.rpc('clipboardWrite', { text, leaseId: viewer.leaseId, epoch: viewer.epoch });
  h.track(second.ownerPid);
  assert.equal(second.selectionOwnedByHelper, true);
  assert.equal(second.bytes, Buffer.byteLength(text));
  assert.ok(second.ownerPid > 0);
  assert.notEqual(first.ownerPid, second.ownerPid);
  assert.equal(alive(first.ownerPid), false, 'the replaced owner is gone');
  assert.equal((await h.x.json('selection-owner')).pid, second.ownerPid);
  assert.equal((await h.rpc('clipboardRead')).text, text);
  assert.equal((await h.rpc('clipboardRead', { leaseId: viewer.leaseId, epoch: viewer.epoch })).text, text);
  await assert.rejects(h.rpc('clipboardWrite', { text: 'stale', leaseId: 'wrong-lease' }), /lease\/epoch mismatch/);
  await assert.rejects(h.rpc('clipboardRead', { leaseId: viewer.leaseId, epoch: viewer.epoch + 1 }), /lease\/epoch mismatch/);
  await h.rpc('stopViewerAndSettle', { leaseId: viewer.leaseId });
  await assert.rejects(h.rpc('clipboardRead'), /control lease/);
});

test('SIGTERM retires the active viewer and removes the control socket, leaving the display', opts, async t => {
  const h = await desktop(t);
  const viewer = await h.start('sigterm', 'control');
  const owner = await h.rpc('clipboardWrite', { text: 'kept until exit', leaseId: viewer.leaseId, epoch: viewer.epoch });
  h.track(owner.ownerPid);
  h.supervisor.kill('SIGTERM');
  assert.deepEqual(await h.supervisor.exited, { code: 0, signal: null });
  assert.equal(await exists(h.controlSocket), false);
  assert.equal(await exists(viewer.socketPath), false);
  assert.equal(alive(viewer.pid), false);
  assert.equal(alive(owner.ownerPid), false);
  assert.deepEqual(await fs.readdir(h.vncDir), []);
  assert.ok(Array.isArray(await h.x.json('clients')), 'the display outlives the supervisor');
});

test('a second supervisor refuses to take over a live control socket', opts, async t => {
  const h = await desktop(t);
  const second = h.launch();
  const { code } = await second.refused();
  assert.notEqual(code, 0);
  assert.match(second.log, /another supervisor/);
  assert.equal((await h.rpc('status')).ready, true);
});

test('the supervisor refuses a VNC directory others can read', opts, async t => {
  const h = await desktop(t);
  h.supervisor.kill('SIGTERM');
  await h.supervisor.exited;
  await fs.chmod(h.vncDir, 0o755);
  const child = h.launch();
  const { code } = await child.refused();
  assert.notEqual(code, 0);
  assert.match(child.log, /0700/);
  assert.equal(await exists(h.controlSocket), false);
});
