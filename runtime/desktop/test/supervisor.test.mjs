import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { skip as noX, startX } from './xvfb.mjs';
import { supervisorRequest } from '../index.mjs';

const has = bin => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = noX || (has('x11vnc') ? false : 'needs x11vnc');
const script = new URL('../supervisor.py', import.meta.url).pathname;
const fixture = new URL('./input_fixture.py', import.meta.url).pathname;
const text = 'Clipboard proof — 中文 🙂\nsecond line';

async function fakeCdp() {
  let guid = randomUUID();
  const server = http.createServer((request, response) => {
    if (request.url !== '/json/version') return response.writeHead(404).end();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ Browser: 'Chrome/156.0', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/${guid}` }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    get guid() { return guid; },
    set guid(value) { guid = value; },
    close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); },
  };
}

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

async function desktop(t) {
  const x = await startX();
  const cdp = await fakeCdp();
  const run = join(x.dir, 'run'), vncDir = join(x.dir, 'vnc');
  await fs.mkdir(run, { mode: 0o700 });
  await fs.mkdir(vncDir, { mode: 0o700 });
  const controlSocket = join(run, 'control.sock'), config = join(x.dir, 'supervisor.json');
  const display = Number(x.env.DISPLAY.slice(1));
  await fs.writeFile(config, JSON.stringify({ display, xauthority: x.env.XAUTHORITY, controlSocket, vncDir, cdpUrl: cdp.url }), { mode: 0o600 });
  // The config alone must name the display.
  const env = { ...x.env, DESKTOP_TEST_HEARTBEAT_TIMEOUT_MS: '2000' };
  delete env.DISPLAY; delete env.XAUTHORITY;
  const children = [], pgids = new Set(), holders = [], timers = new Set(), displays = [];
  const h = {
    x, cdp, display, controlSocket, vncDir, config, env,
    rpc: (op, fields = {}) => supervisorRequest(controlSocket, { op, ...fields }),
    launch(configPath = config) {
      const child = spawn('python3', [script, configPath], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      child.log = '';
      child.stderr.on('data', bytes => { child.log = (child.log + bytes).slice(-4000); });
      child.exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      children.push(child);
      return child;
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
      const replacement = spawn('Xvfb', [`:${display}`, '-auth', join(x.dir, 'server-auth'), '-nolisten', 'tcp', '-screen', '0', '640x480x24', '+extension', 'XTEST', '+extension', 'X-Resource'], { stdio: 'ignore' });
      replacement.exited = new Promise(resolve => replacement.once('exit', resolve));
      displays.push(replacement);
      await until(() => exists(`/tmp/.X11-unix/X${display}`), 5000, 'the replacement display');
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
  });
  await h.serve();
  return h;
}

test('status describes the host truthfully', { skip }, async t => {
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
  const [boot, inode] = status.displayGeneration.split(':');
  assert.match(boot, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(inode, String((await fs.stat(`/tmp/.X11-unix/X${h.display}`)).ino));
  assert.equal(status.browserGeneration, `${boot}:${h.cdp.guid}`);
});

test('browserReady drops when the browser stops answering, without retiring a session', { skip }, async t => {
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

test('a watch viewer serves RFB only on its private socket', { skip }, async t => {
  const h = await desktop(t);
  const viewer = await h.start('watch-rfb', 'watch');
  assert.equal(viewer.host, undefined);
  assert.equal(viewer.port, undefined);
  assert.match(viewer.socketPath, /\/vnc-[0-9a-f]{16}\.sock$/);
  assert.equal(join(h.vncDir, viewer.socketPath.slice(h.vncDir.length + 1)), viewer.socketPath);
  assert.ok((await fs.lstat(viewer.socketPath)).isSocket());
  assert.equal((await fs.stat(h.vncDir)).mode & 0o777, 0o700);
  assert.ok(viewer.xClients.some(client => client.pid === viewer.pid));
  const banner = await new Promise((resolve, reject) => {
    const socket = net.connect({ path: viewer.socketPath });
    let received = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('no RFB banner')); }, 5000);
    socket.on('data', bytes => { received += bytes; if (received.length >= 12) { clearTimeout(timer); socket.destroy(); resolve(received); } });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
  });
  assert.match(banner, /^RFB 003\.00[38]\n/);
  const inodes = new Set();
  for (const fd of await fs.readdir(`/proc/${viewer.pid}/fd`)) {
    const match = (await fs.readlink(`/proc/${viewer.pid}/fd/${fd}`).catch(() => '')).match(/^socket:\[(\d+)\]$/);
    if (match) inodes.add(match[1]);
  }
  assert.ok(inodes.size > 0);
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const row of (await fs.readFile(table, 'utf8').catch(() => '')).split('\n').slice(1).filter(Boolean).map(line => line.trim().split(/\s+/)))
      if (row[3] === '0A') assert.ok(!inodes.has(row[9]), `x11vnc listens on TCP ${row[1]}`);
  }
});

test('settling a control viewer releases a key held outside it', { skip }, async t => {
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

test('a watch retirement leaves agent input alone until a writable settlement is asked for', { skip }, async t => {
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

test('promoting a watch viewer replaces its actor and socket', { skip }, async t => {
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

test('heartbeats keep a viewer alive and their loss retires it', { skip }, async t => {
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

test('a browser restart while idle changes browserGeneration and leaves the desktop usable', { skip }, async t => {
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

test('a browser restart during a control session retires it and taints the desktop', { skip }, async t => {
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

test('a display restart while idle changes displayGeneration and leaves the desktop usable', { skip }, async t => {
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

test('a display restart during a control session retires it and taints the desktop', { skip }, async t => {
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

test('a supervisor restart changes both generations and releases input its x11vnc left held', { skip }, async t => {
  const h = await desktop(t);
  const viewer = await h.start('restart', 'control', { keepAlive: false });
  const before = await h.rpc('status');
  await h.hold();
  assert.equal(await h.held(), true);
  h.supervisor.kill('SIGKILL');
  await h.supervisor.exited;
  assert.equal(await exists(h.controlSocket), true, 'a killed supervisor leaves its socket behind');
  assert.equal(alive(viewer.pid), true, 'outside systemd its actor outlives it');
  await h.serve();
  assert.equal(alive(viewer.pid), false, 'the new supervisor kills the orphaned actor');
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

test('clipboard round-trips for the control lease only', { skip }, async t => {
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

test('SIGTERM retires the active viewer and removes the control socket, leaving the display', { skip }, async t => {
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

test('a second supervisor refuses to take over a live control socket', { skip }, async t => {
  const h = await desktop(t);
  const second = h.launch();
  const { code } = await second.exited;
  assert.notEqual(code, 0);
  assert.match(second.log, /another supervisor/);
  assert.equal((await h.rpc('status')).ready, true);
});

test('the supervisor refuses a VNC directory others can read', { skip }, async t => {
  const h = await desktop(t);
  h.supervisor.kill('SIGTERM');
  await h.supervisor.exited;
  await fs.chmod(h.vncDir, 0o755);
  const child = h.launch();
  const { code } = await child.exited;
  assert.notEqual(code, 0);
  assert.match(child.log, /0700/);
  assert.equal(await exists(h.controlSocket), false);
});
