import * as fs from 'node:fs/promises';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { xauthorityEntry } from '../../../src/host-display.mjs';

const execute = promisify(execFile);
const has = bin => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
// xproof needs libXRes, which an Xvfb host can lack.
const loads = soname => { try { execFileSync('python3', ['-c', 'import ctypes,sys;ctypes.CDLL(sys.argv[1])', soname], { stdio: 'ignore' }); return true; } catch { return false; } };
export const skip = has('Xvfb') && has('python3') && loads('libXRes.so.1') ? false : 'needs Xvfb, python3 and libXRes';
const proof = new URL('../xproof.py', import.meta.url).pathname;
const exists = path => fs.access(path).then(() => true, () => false);
export const serverArgs = auth => ['-auth', auth, '-nolisten', 'tcp', '-screen', '0', '640x480x24', '+extension', 'XTEST', '+extension', 'X-Resource'];

// A -displayfd server writes no /tmp/.X<n>-lock. Xvfb's own lock decides a race for a number.
async function numberedServer(args) {
  for (let n = 140; n < 200; n++) {
    if (await exists(`/tmp/.X11-unix/X${n}`) || await exists(`/tmp/.X${n}-lock`)) continue;
    const child = spawn('Xvfb', [`:${n}`, ...args], { stdio: 'ignore' });
    for (const deadline = Date.now() + 5000; child.exitCode === null && child.signalCode === null;) {
      if (await exists(`/tmp/.X11-unix/X${n}`)) return { child, number: n };
      if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`Xvfb :${n} did not start`); }
      await sleep(25);
    }
  }
  throw new Error('no free display between :140 and :199');
}

// A server killed before cleanup leaves its lock. That would burn the number for later tests.
// EPERM means the pid is alive under another user, so its lock is not stale.
export async function dropStaleLock(number) {
  const pid = Number((await fs.readFile(`/tmp/.X${number}-lock`, 'utf8').catch(() => '')).trim());
  if (!pid) return;
  try { process.kill(pid, 0); return; } catch (error) { if (error.code === 'EPERM') return; }
  await fs.rm(`/tmp/.X${number}-lock`, { force: true });
  await fs.rm(`/tmp/.X11-unix/X${number}`, { force: true });
}

export async function startX({ numbered = false } = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'clawser-xvfb-'));
  const cookie = randomBytes(16);
  await fs.writeFile(join(dir, 'server-auth'), xauthorityEntry(0, cookie), { mode: 0o600 });
  let child, number;
  if (numbered) ({ child, number } = await numberedServer(serverArgs(join(dir, 'server-auth'))));
  else {
    child = spawn('Xvfb', ['-displayfd', '3', ...serverArgs(join(dir, 'server-auth'))], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    number = await new Promise((resolve, reject) => {
      let text = '';
      child.stdio[3].on('data', d => { text += d; if (text.includes('\n')) resolve(Number(text)); });
      child.once('exit', () => reject(new Error('Xvfb exited')));
    });
  }
  await fs.writeFile(join(dir, 'xauth'), xauthorityEntry(number, cookie), { mode: 0o600 });
  const env = { ...process.env, DISPLAY: `:${number}`, XAUTHORITY: join(dir, 'xauth') };
  // x11vnc exits when it sees a Wayland session.
  delete env.WAYLAND_DISPLAY;
  return {
    env,
    dir,
    run: (script, ...args) => execute('python3', [script, ...args], { env }),
    json: async (...args) => JSON.parse((await execute('python3', [proof, ...args], { env })).stdout),
    number,
    pid: child.pid,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(r => child.once('exit', r)); }
      if (numbered) await dropStaleLock(number);
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
