#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createCipheriv, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HostDesktopRuntime } from '../runtime/desktop/index.mjs';
import { findBrowserBinary } from '../src/host-browser.mjs';
import { freeDisplay } from '../src/host-display.mjs';
import { hostLocations } from '../src/host-setup.mjs';
import { execute, runClawser } from '../src/setup.mjs';
import { activationFixture } from './setup-activation-fixture.mjs';

export const SKIPPED = 'host noVNC end to end skipped (set CLAWSER_HOST_E2E=1 on a disposable runner)';
const PACKAGE_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE = fileURLToPath(new URL('../runtime/desktop/test/input_fixture.py', import.meta.url));
const GREEN_PAGE = 'data:text/html,<body style="margin:0;background:%2300ff00">';
const REFUSED_X = `import ctypes,sys
x=ctypes.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes=[ctypes.c_char_p];x.XOpenDisplay.restype=ctypes.c_void_p
d=x.XOpenDisplay(sys.argv[1].encode())
print('opened' if d else 'refused')`;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const firstLineOf = error => String(error?.message ?? error).split('\n')[0];

/** The RFB VNC authentication response: DES over the challenge, keyed by the password with each byte's bits reversed. */
function vncResponse(password, challenge) {
  const key = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) {
    const byte = password.charCodeAt(i) || 0;
    for (let b = 0; b < 8; b++) key[i] |= ((byte >> b) & 1) << (7 - b);
  }
  const cipher = createCipheriv('des-ede3', Buffer.concat([key, key, key]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

// 32 bpp, depth 24, little-endian true colour, red at bit 16, green at 8, blue at 0.
const SET_PIXEL_FORMAT = Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);
const RAW = 0, CURSOR = -239;
// Xvfb parks the pointer at the screen centre. Without the Cursor pseudo-encoding, x11vnc paints the cursor into the pixels sent.
const SET_ENCODINGS = Buffer.from([2, 0, 0, 2, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x11]);

function updateRequest(x, y) {
  const message = Buffer.alloc(10);
  message[0] = 3;
  message.writeUInt16BE(x, 2); message.writeUInt16BE(y, 4); message.writeUInt16BE(1, 6); message.writeUInt16BE(1, 8);
  return message;
}

async function updatedPixel(read, x, y) {
  for (;;) {
    const type = (await read(1))[0];
    if (type === 2) continue;
    if (type === 1) { const head = await read(5); await read(head.readUInt16BE(3) * 6); continue; }
    if (type === 3) { const head = await read(7); await read(head.readUInt32BE(3)); continue; }
    if (type !== 0) throw new Error('Unexpected RFB server message ' + type);
    const count = (await read(3)).readUInt16BE(1);
    let pixel;
    for (let i = 0; i < count; i++) {
      const rect = await read(12);
      const [rx, ry, width, height] = [0, 2, 4, 6].map(offset => rect.readUInt16BE(offset));
      const encoding = rect.readInt32BE(8);
      if (encoding === CURSOR) { await read(width * height * 4 + ((width + 7) >> 3) * height); continue; }
      if (encoding !== RAW) throw new Error('Unexpected RFB encoding ' + encoding);
      const data = await read(width * height * 4);
      if (x >= rx && x < rx + width && y >= ry && y < ry + height) {
        const value = data.readUInt32LE(((y - ry) * width + (x - rx)) * 4);
        pixel = { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
      }
    }
    if (pixel) return pixel;
  }
}

/**
 * Authenticates to an RFB 3.8 server on a Unix socket and reads the centre pixel with raw 1×1 updates.
 * It re-requests until `until(pixel)` holds or `timeoutMs` passes, and returns the last pixel either way.
 */
export async function readPixel({ socketPath, password, until = () => true, timeoutMs = 20_000 }) {
  const socket = net.connect({ path: socketPath });
  let buffered = Buffer.alloc(0), wake, failure;
  socket.on('data', bytes => { buffered = Buffer.concat([buffered, bytes]); wake?.(); });
  socket.on('error', error => { failure = error; wake?.(); });
  socket.on('close', () => { failure ??= new Error('RFB connection closed'); wake?.(); });
  const deadline = Date.now() + timeoutMs;
  const read = async n => {
    while (buffered.length < n) {
      if (failure) throw failure;
      if (Date.now() > deadline) throw new Error('RFB read timed out');
      await new Promise(accept => { wake = accept; setTimeout(accept, 25); });
    }
    const out = buffered.subarray(0, n);
    buffered = buffered.subarray(n);
    return out;
  };
  try {
    const banner = (await read(12)).toString('latin1');
    if (!/^RFB \d{3}\.\d{3}\n$/.test(banner)) throw new Error('Not an RFB server: ' + JSON.stringify(banner));
    socket.write('RFB 003.008\n');
    const types = [...await read((await read(1))[0])];
    if (!types.includes(2)) throw new Error('RFB server offers no VNC authentication: ' + types.join(','));
    socket.write(Buffer.from([2]));
    socket.write(vncResponse(password, await read(16)));
    if ((await read(4)).readUInt32BE() !== 0) throw new Error('VNC authentication failed');
    socket.write(Buffer.from([1]));
    const init = await read(24);
    const width = init.readUInt16BE(0), height = init.readUInt16BE(2);
    await read(init.readUInt32BE(20));
    socket.write(SET_PIXEL_FORMAT);
    socket.write(SET_ENCODINGS);
    const x = width >> 1, y = height >> 1;
    for (;;) {
      socket.write(updateRequest(x, y));
      const result = { width, height, x, y, ...await updatedPixel(read, x, y) };
      if (until(result) || Date.now() + 250 > deadline) return result;
      await sleep(250);
    }
  } finally { socket.destroy(); }
}

/** `pid` and every descendant, through /proc/<pid>/task/<tid>/children. A pid that is gone yields nothing. */
export async function processTree(pid, procRoot = '/proc') {
  const found = [];
  const walk = async current => {
    let tasks;
    try { tasks = await fs.readdir(join(procRoot, String(current), 'task')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (found.includes(current)) return;
    found.push(current);
    for (const task of tasks) {
      const children = await fs.readFile(join(procRoot, String(current), 'task', task, 'children'), 'utf8').catch(() => '');
      for (const child of children.split(/\s+/).filter(Boolean)) await walk(Number(child));
    }
  };
  await walk(pid);
  return found;
}

/** TCP sockets in LISTEN state that one of `pids` holds open, matched by inode from /proc/net/tcp{,6} to /proc/<pid>/fd. */
export async function tcpListeners(pids, procRoot = '/proc') {
  const listening = new Set();
  for (const file of ['tcp', 'tcp6']) {
    const text = await fs.readFile(join(procRoot, 'net', file), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '0A') listening.add(fields[9]);
    }
  }
  const found = [];
  for (const pid of pids) {
    let fds;
    try { fds = await fs.readdir(join(procRoot, String(pid), 'fd')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const fd of fds) {
      const inode = (await fs.readlink(join(procRoot, String(pid), 'fd', fd)).catch(() => '')).match(/^socket:\[(\d+)\]$/)?.[1];
      if (inode && listening.has(inode)) found.push({ pid, fd: Number(fd), inode });
    }
  }
  return found;
}

function merge(base, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key];
    else if (object(value)) merge(object(base[key]) ? base[key] : (base[key] = {}), value);
    else base[key] = structuredClone(value);
  }
  return base;
}

/** The OpenClaw CLI calls setup and doctor make, served from an in-memory config. Anything else is a test failure. */
function fakeOpenclaw(config, activation) {
  return async (args, { input } = {}) => {
    const line = args.join(' ');
    if (line === '--version') return 'OpenClaw 2026.10.4';
    if (args.length === 4 && args[0] === 'config' && args[1] === 'get' && args[3] === '--json') return JSON.stringify(config[args[2]] ?? {});
    if (line === 'config patch --stdin' || line === 'config patch --stdin --dry-run') {
      const patch = JSON.parse(input);
      if (!args.includes('--dry-run')) merge(config, patch);
      return '';
    }
    if (line === 'plugins reload browser-handoff --wait') { await activation.publish(); return ''; }
    throw new Error('Unexpected OpenClaw call: openclaw ' + line);
  };
}

const freePort = () => new Promise((accept, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => accept(port)); });
});

function firstLine(child, timeoutMs = 15_000) {
  return new Promise((accept, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('fixture printed nothing within ' + timeoutMs + ' ms')), timeoutMs);
    child.stdout.on('data', bytes => {
      text += bytes;
      if (text.includes('\n')) { clearTimeout(timer); accept(text.slice(0, text.indexOf('\n'))); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('fixture exited (' + code + ') before printing')); });
  });
}

// The supervisor retires a viewer after 30 s without a heartbeat.
function heartbeat(c, runtime, actor) {
  const timer = setInterval(() => { runtime.heartbeatViewer({ leaseId: actor.leaseId, epoch: actor.epoch }).catch(() => {}); }, 5000);
  c.timers.push(timer);
  return () => clearInterval(timer);
}

async function steps(c, log, output) {
  const chrome = process.env.CHROME_BIN;
  if (!chrome || !isAbsolute(chrome)) throw new Error('Set CHROME_BIN to the absolute path of Google Chrome or Chromium');
  c.root = await fs.realpath(await fs.mkdtemp('/tmp/clawser-e2e-'));
  // Setup creates the state folder itself and refuses one that already exists.
  const stateDir = join(c.root, 'state');
  // OpenClaw's own state root decides which install setup upgrades, so the host's must stay out of reach.
  const env = { ...process.env, PATH: dirname(chrome) + ':' + (process.env.PATH ?? ''), OPENCLAW_STATE_DIR: join(c.root, 'openclaw') };
  const p = hostLocations({ stateDir }, { env, homeDir: homedir(), packageDir: PACKAGE_DIR });
  Object.assign(c, { names: p.names, unitDir: p.unitDir });
  const ours = new Set(Object.values(p.names));
  const config = {};
  let openclaw;
  // A signal can arrive mid-setup. Once cleanup starts, setup must not start or write anything more.
  const live = work => (...args) => { if (c.stopping) throw new Error('The run is stopping'); return work(...args); };
  const deps = {
    env, log: line => output.push(line),
    fs: { ...fs, open: live(fs.open), writeFile: live(fs.writeFile), rename: live(fs.rename), mkdir: live(fs.mkdir), chmod: live(fs.chmod) },
    freeDisplay: d => freeDisplay(d, { from: 140, to: 199 }),
    run: (command, args = [], options = {}) => {
      if (c.stopping) throw new Error('The run is stopping');
      if (command === 'openclaw') return openclaw(args, options);
      if (command === 'docker') throw new Error('The end to end test never runs docker');
      const foreign = command === 'systemctl' ? args.filter(arg => arg.endsWith('.service') && !ours.has(arg)) : [];
      if (foreign.length) throw new Error('Refusing a unit this test did not create: ' + foreign.join(' '));
      return execute(command, args, options);
    },
  };
  openclaw = fakeOpenclaw(config, activationFixture(config, deps));

  const wanted = await fs.realpath(chrome);
  const viaPath = (await findBrowserBinary({ fs, env }).catch(() => undefined))?.path === wanted;
  if (!viaPath) deps.findBrowserBinary = async () => ({ path: wanted, brand: 'chrome' });
  const port = await freePort();
  const setup = await runClawser(['setup', '--state-dir', stateDir, '--port', String(port), '--yes'], deps);
  assert.equal(setup.ok, true, 'setup did not finish');
  const receipt = JSON.parse(await fs.readFile(p.marker, 'utf8'));
  c.display = receipt.display;
  assert.equal(receipt.option, 'new');
  assert.ok(receipt.display >= 140 && receipt.display <= 199, 'display :' + receipt.display + ' is outside 140–199');
  assert.equal(receipt.browser.path, wanted);
  assert.ok(setup.units.every(name => ours.has(name)) && [p.names.display, p.names.browser, p.names.supervisor, p.names.controller].every(name => setup.units.includes(name)));
  log(`step 1: setup installed option A with ${setup.units.length} units on display :${receipt.display}, CDP port ${receipt.cdpPort}, controller port ${receipt.port}; Chrome ${wanted} came from ${viaPath ? 'PATH' : 'the findBrowserBinary override'}`);

  const cdpUrl = 'http://127.0.0.1:' + receipt.cdpPort;
  const runtime = new HostDesktopRuntime({ stateDir: p.runtime, controlSocket: p.control, cdpUrl });
  let status;
  for (const deadline = Date.now() + 90_000; ;) {
    status = await runtime.status().catch(error => ({ error: error.message }));
    if (status.ready === true && status.browserReady === true) break;
    if (Date.now() > deadline) throw new Error('The runtime did not report ready and browserReady within 90 s: ' + JSON.stringify(status));
    await sleep(250);
  }
  assert.equal(status.tainted, false);
  assert.equal(status.viewer, null);
  log('step 2: runtime status reports ready and browserReady');

  const doctorOutput = [];
  const doctor = await runClawser(['doctor', '--state-dir', stateDir], { ...deps, log: line => doctorOutput.push(line) });
  output.push(...doctorOutput);
  const row = name => doctor.checks.find(check => check.name === name);
  for (const name of ['services', 'display', 'browser window']) assert.equal(row(name)?.ok, true, `doctor ${name}: ${row(name)?.message ?? 'row missing'}`);
  const failing = doctor.checks.filter(check => !check.ok).map(check => check.name + ': ' + check.message);
  log(`step 2 doctor: services, display and browser window ok; ${failing.length ? 'other failing rows: ' + failing.join('; ') : `all ${doctor.checks.length} rows ok`}`);

  const python = receipt.hostDeps.binaries.python3.path;
  // A NULL display or a non-zero exit both count as refused.
  const refused = await execute(python, ['-c', REFUSED_X, ':' + receipt.display], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', XAUTHORITY: '/dev/null' } })
    .catch(error => 'exited ' + error.code);
  assert.notEqual(refused, 'opened', 'an X client without the cookie connected to :' + receipt.display);
  log(`step 3: XOpenDisplay(":${receipt.display}") with XAUTHORITY=/dev/null was refused (${refused === 'refused' ? 'returned NULL' : refused})`);

  const opened = await fetch(cdpUrl + '/json/new?' + encodeURIComponent(GREEN_PAGE), { method: 'PUT', signal: AbortSignal.timeout(10_000) });
  assert.ok(opened.ok, 'PUT /json/new answered HTTP ' + opened.status);
  const tab = await opened.json();
  const activated = await fetch(cdpUrl + '/json/activate/' + tab.id, { signal: AbortSignal.timeout(10_000) });
  assert.ok(activated.ok, '/json/activate answered HTTP ' + activated.status);
  const pages = targets => targets.filter(target => target.type === 'page').map(target => target.id).sort();
  const fromRuntime = pages(await runtime.tabs());
  const listed = pages(await (await fetch(cdpUrl + '/json/list', { signal: AbortSignal.timeout(10_000) })).json());
  assert.deepEqual(fromRuntime, listed);
  assert.ok(listed.includes(tab.id), 'the new tab is not listed');
  log(`step 4: opened tab ${tab.id} on the green page; runtime.tabs() and /json/list list the same ${listed.length} page targets`);

  const watchId = randomUUID();
  const watch = await runtime.startViewer({ leaseId: watchId, role: 'watch', expiresAt: Date.now() + 120_000 });
  const stopWatchBeat = heartbeat(c, runtime, watch);
  const green = pixel => pixel.g > 200 && pixel.r < 60 && pixel.b < 60;
  const pixel = await readPixel({ socketPath: watch.socketPath, password: watch.password, until: green, timeoutMs: 30_000 });
  assert.deepEqual([pixel.width, pixel.height], [1920, 1080]);
  assert.ok(green(pixel), `the centre pixel (${pixel.x},${pixel.y}) is rgb(${pixel.r},${pixel.g},${pixel.b}), not green`);
  log(`step 5: RFB 3.8 VNC auth on the watch viewer's socket; centre pixel (${pixel.x},${pixel.y}) of ${pixel.width}x${pixel.height} is rgb(${pixel.r},${pixel.g},${pixel.b})`);

  const tree = await processTree(watch.pid);
  assert.equal(tree[0], watch.pid, 'x11vnc pid ' + watch.pid + ' is not running');
  assert.ok((await fs.readdir(`/proc/${watch.pid}/fd`)).length > 0);
  assert.deepEqual(await tcpListeners(tree), [], 'x11vnc holds a TCP listener');
  log(`step 6: x11vnc pid ${watch.pid} and its ${tree.length - 1} children hold no TCP listener`);

  stopWatchBeat();
  assert.equal((await runtime.stopViewerAndSettle({ leaseId: watchId })).readOnly, true);
  const controlId = randomUUID();
  const control = await runtime.startViewer({ leaseId: controlId, role: 'control', expiresAt: Date.now() + 120_000 });
  const stopControlBeat = heartbeat(c, runtime, control);
  const xenv = { PATH: process.env.PATH ?? '/usr/bin:/bin', DISPLAY: ':' + receipt.display, XAUTHORITY: p.xauthority };
  const holder = spawn(python, [FIXTURE, 'hold', 'stay'], { env: xenv, stdio: ['pipe', 'pipe', 'inherit'] });
  c.children.push(holder);
  assert.deepEqual(JSON.parse(await firstLine(holder)), { shift: true, button1: true });
  const settled = await runtime.stopViewerAndSettle({ leaseId: controlId, mayBeWritable: true });
  stopControlBeat();
  assert.equal(settled.inputResetRequired, true);
  assert.equal(settled.heldInputCleared, true);
  assert.deepEqual(JSON.parse(await execute(python, [FIXTURE, 'query'], { env: xenv })), { shift: false, button1: false });
  const exited = new Promise(accept => holder.once('exit', accept));
  holder.stdin.end();
  await exited;
  log('step 7: control viewer settled with mayBeWritable; the shift and button 1 held outside it were released');
}

const exists = path => fs.lstat(path).then(() => true, () => false);

// Our Xvfb removes its lock on SIGTERM. A lock left by a dead server would burn the number.
async function dropDeadLock(display) {
  const lock = `/tmp/.X${display}-lock`;
  const pid = Number((await fs.readFile(lock, 'utf8').catch(() => '')).trim());
  if (!pid) return;
  try { process.kill(pid, 0); throw new Error(`display :${display} still has a live server (pid ${pid})`); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  await fs.rm(lock, { force: true });
  await fs.rm(`/tmp/.X11-unix/X${display}`, { force: true });
}

/** Stops and removes everything the run created. Returns the steps that failed; it never throws. */
async function cleanup(c) {
  c.stopping = true;
  const notes = [];
  const attempt = async (what, work) => { try { await work(); } catch (error) { notes.push(what + ': ' + firstLineOf(error)); } };
  for (const timer of c.timers) clearInterval(timer);
  for (const child of c.children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (c.names) {
    const names = Object.values(c.names);
    // A unit setup never wrote fails to disable, which is fine.
    for (const name of [...names].reverse()) {
      await execute('systemctl', ['--user', 'disable', '--now', name], { timeoutMs: 200_000 }).catch(async error => {
        if (await exists(join(c.unitDir, name))) notes.push('disable ' + name + ': ' + firstLineOf(error));
      });
    }
    // An interrupted atomic write leaves <unit>.<uuid>.tmp beside the unit.
    const leftovers = (await fs.readdir(c.unitDir).catch(() => [])).filter(file => names.some(name => file.startsWith(name + '.') && file.endsWith('.tmp')));
    for (const file of [...names, ...leftovers, ...names.map(name => join('default.target.wants', name))]) {
      await attempt('remove ' + file, () => fs.rm(join(c.unitDir, file), { force: true }));
    }
    await attempt('daemon-reload', () => execute('systemctl', ['--user', 'daemon-reload']));
    // A unit that failed stays listed until its failed state is reset; one that never loaded refuses, which is fine.
    for (const name of names) await execute('systemctl', ['--user', 'reset-failed', name]).catch(() => {});
  }
  if (c.root) {
    const display = c.display ?? await fs.readFile(join(c.root, 'state/setup.json'), 'utf8').then(text => JSON.parse(text).display, () => undefined);
    if (Number.isInteger(display)) await attempt('display lock', () => dropDeadLock(display));
    await attempt('remove ' + c.root, () => fs.rm(c.root, { recursive: true, force: true }));
  }
  return notes;
}

export async function endToEnd(log = line => process.stdout.write(line + '\n')) {
  const c = { timers: [], children: [] }, output = [];
  let cleaning;
  const clean = () => cleaning ??= cleanup(c);
  const report = notes => {
    if (c.names) log(`step 8: cleanup disabled and removed ${Object.keys(c.names).length} units and deleted the state folder` + (notes.length ? '; problems: ' + notes.join('; ') : ''));
  };
  const abort = async reason => {
    log('host noVNC end to end failed: ' + reason);
    report(await clean());
    process.exit(1);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { void abort('interrupted by ' + signal); });
  const overall = setTimeout(() => { void abort('timed out after 8 minutes'); }, 480_000);
  let failure;
  try { await steps(c, log, output); }
  catch (error) { failure = error; }
  clearTimeout(overall);
  // The units' journals go with them, so a failure reads them first.
  if (failure && c.names) {
    for (const name of [c.names.supervisor, c.names.browser, c.names.display]) {
      const journal = await execute('journalctl', ['--user', '-u', name, '-n', '40', '--no-pager', '-o', 'cat', '--since', '-15min'], { timeoutMs: 90_000 }).catch(error => firstLineOf(error));
      output.push('journal ' + name + ':', ...String(journal).split('\n').map(line => '  ' + line));
    }
  }
  const notes = await clean();
  report(notes);
  if (failure) {
    for (const line of output) log('  | ' + line);
    log('host noVNC end to end failed: ' + (failure.stack ?? failure));
    return 1;
  }
  if (notes.length) { log('host noVNC end to end failed: cleanup left work behind'); return 1; }
  log('host noVNC end to end passed');
  return 0;
}

let direct = false;
try { direct = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch {}
if (direct) {
  if (process.env.CLAWSER_HOST_E2E !== '1') console.log(SKIPPED);
  else process.exit(await endToEnd());
}
