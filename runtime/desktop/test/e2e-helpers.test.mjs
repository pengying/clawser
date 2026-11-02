import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { skip as noX, startX } from './xvfb.mjs';
import { processTree, readPixel, tcpListeners } from '../../../test/host-desktop-e2e.mjs';

const execute = promisify(execFile);
const has = bin => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const script = new URL('../../../test/host-desktop-e2e.mjs', import.meta.url).pathname;
const noProc = existsSync('/proc/net/tcp') ? false : 'needs Linux /proc';
// The painter stays connected until stdin closes: Xvfb resets the root window when its last client leaves.
const PAINT_ROOT = `
import ctypes as c,os,sys
x=c.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes=[c.c_char_p];x.XOpenDisplay.restype=c.c_void_p
x.XDefaultRootWindow.argtypes=[c.c_void_p];x.XDefaultRootWindow.restype=c.c_ulong
x.XSetWindowBackground.argtypes=[c.c_void_p,c.c_ulong,c.c_ulong]
x.XClearWindow.argtypes=[c.c_void_p,c.c_ulong]
x.XSync.argtypes=[c.c_void_p,c.c_int]
d=x.XOpenDisplay(('unix/'+os.environ['DISPLAY']).encode())
if not d:raise SystemExit('display unavailable')
root=x.XDefaultRootWindow(d)
x.XSetWindowBackground(d,root,0x00ff00);x.XClearWindow(d,root);x.XSync(d,0)
print('painted',flush=True);sys.stdin.read()
`;
// argv after -e: the listener kind, then a socket path for 'unix'.
const LISTENER = "const net=require('node:net');const [kind,path]=process.argv.slice(1);net.createServer().listen(kind==='tcp'?{host:'127.0.0.1',port:0}:{path},()=>process.stdout.write('up\\n'))";
const PARENT = "require('node:child_process').spawn(process.execPath,['-e',process.argv[1],'tcp'],{stdio:'inherit'})";
const firstLine = child => new Promise((resolve, reject) => {
  child.stdout.once('data', bytes => resolve(String(bytes)));
  child.once('exit', code => reject(new Error('child exited ' + code)));
});

test('RFB VNC auth reads a pixel from a private x11vnc socket', { skip: noX || (has('x11vnc') ? false : 'needs x11vnc'), timeout: 60_000 }, async () => {
  const x = await startX({ numbered: true });
  const socketPath = join(x.dir, 'vnc.sock'), passwordFile = join(x.dir, 'vnc-password'), password = 'e2e-pass';
  let vnc, painter;
  try {
    await fs.writeFile(passwordFile, password + '\n', { mode: 0o600 });
    vnc = spawn('x11vnc', ['-display', `unix/:${x.number}`, '-unixsock', socketPath, '-rfbport', '0', '-no6', '-rfbportv6', '-1',
      '-passwdfile', passwordFile, '-forever', '-shared', '-noxdamage', '-noxrecord', '-viewonly', '-o', '/dev/null', '-norc'], { env: x.env, stdio: 'ignore' });
    for (const deadline = Date.now() + 10_000; !(await fs.lstat(socketPath).then(info => info.isSocket(), () => false));) {
      if (Date.now() > deadline || vnc.exitCode !== null) throw new Error('x11vnc did not serve ' + socketPath);
      await sleep(50);
    }
    painter = spawn('python3', ['-c', PAINT_ROOT], { env: x.env, stdio: ['pipe', 'pipe', 'inherit'] });
    assert.equal((await firstLine(painter)).trim(), 'painted');
    const green = pixel => pixel.g > 200 && pixel.r < 60 && pixel.b < 60;
    const pixel = await readPixel({ socketPath, password, until: green });
    assert.deepEqual({ width: pixel.width, height: pixel.height, x: pixel.x, y: pixel.y }, { width: 640, height: 480, x: 320, y: 240 });
    assert.ok(green(pixel), 'centre pixel is not green: ' + JSON.stringify(pixel));
    await assert.rejects(readPixel({ socketPath, password: 'wrong-pw' }), /VNC authentication failed/);
  } finally {
    painter?.stdin.end();
    vnc?.kill('SIGKILL');
    await x.stop();
  }
});

test('the TCP listener scan finds a listening socket and ignores a unix one', { skip: noProc, timeout: 30_000 }, async () => {
  const dir = await fs.mkdtemp('/tmp/clawser-scan-');
  const parent = spawn(process.execPath, ['-e', PARENT, LISTENER], { stdio: ['ignore', 'pipe', 'inherit'] });
  const unix = spawn(process.execPath, ['-e', LISTENER, 'unix', join(dir, 'listen.sock')], { stdio: ['ignore', 'pipe', 'inherit'] });
  let tree = [];
  try {
    await Promise.all([firstLine(parent), firstLine(unix)]);
    // The listener is the parent's child, so only the child walk can find it.
    tree = await processTree(parent.pid);
    assert.equal(tree.length, 2);
    assert.equal(tree[0], parent.pid);
    const found = await tcpListeners(tree);
    assert.equal(found.length, 1);
    assert.equal(found[0].pid, tree[1]);
    assert.match(found[0].inode, /^\d+$/);
    assert.deepEqual(await tcpListeners([parent.pid]), []);
    assert.deepEqual(await tcpListeners(await processTree(unix.pid)), []);
  } finally {
    for (const pid of tree.slice(1)) { try { process.kill(pid); } catch {} }
    parent.kill(); unix.kill();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the e2e script skips without CLAWSER_HOST_E2E', async () => {
  const env = { ...process.env };
  delete env.CLAWSER_HOST_E2E;
  const { stdout } = await execute(process.execPath, [script], { env });
  assert.equal(stdout, 'host noVNC end to end skipped (set CLAWSER_HOST_E2E=1 on a disposable runner)\n');
});
