#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HostDesktopRuntime } from '../runtime/desktop/index.mjs';
import { firstLine, processTree, readPixel, tcpListeners } from '../runtime/desktop/test/rfb.mjs';
import { dropStaleLock } from '../runtime/desktop/test/xvfb.mjs';
import { findBrowserBinary } from '../src/host-browser.mjs';
import { freeDisplay } from '../src/host-display.mjs';
import { hostLocations } from '../src/host-setup.mjs';
import { execute, runClawser } from '../src/setup.mjs';
import { merge } from './host-fixture.mjs';
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
const firstLineOf = error => String(error?.message ?? error).split('\n')[0];

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
    if (Number.isInteger(display)) await attempt('display lock', async () => {
      await dropStaleLock(display);
      if (await exists(`/tmp/.X${display}-lock`)) throw new Error(`display :${display} still has a live server`);
    });
    await attempt('remove ' + c.root, () => fs.rm(c.root, { recursive: true, force: true }));
  }
  return notes;
}

/**
 * Sends every way the process can die into `abort(reason)`, once, then exits 1 when it settles.
 * A dropped ssh session without a pty closes stdout and sends no SIGHUP, so the next write fails with EPIPE.
 */
export function installCrashCleanup(abort) {
  let aborting;
  const fire = reason => { aborting ??= Promise.resolve().then(() => abort(reason)).catch(() => {}).finally(() => process.exit(1)); };
  for (const stream of [process.stdout, process.stderr]) stream.on('error', error => fire('output closed (' + (error?.code ?? error) + ')'));
  process.on('uncaughtException', error => fire('uncaught ' + (error?.stack ?? error)));
  process.on('unhandledRejection', error => fire('unhandled rejection ' + (error?.stack ?? error)));
  // A second Ctrl-C during a long cleanup must not cut it short.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => fire('interrupted by ' + signal));
  return fire;
}

const print = line => { try { process.stdout.write(line + '\n'); } catch {} };

export async function endToEnd(log = print) {
  const c = { timers: [], children: [] }, output = [];
  let cleaning;
  const clean = () => cleaning ??= cleanup(c);
  const report = notes => {
    if (c.names) log(`step 8: cleanup disabled and removed ${Object.keys(c.names).length} units and deleted the state folder` + (notes.length ? '; problems: ' + notes.join('; ') : ''));
  };
  const abort = installCrashCleanup(async reason => {
    log('host noVNC end to end failed: ' + reason);
    report(await clean());
  });
  const overall = setTimeout(() => abort('timed out after 8 minutes'), 480_000);
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
