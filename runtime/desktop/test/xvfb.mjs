import * as fs from 'node:fs/promises';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { xauthorityEntry } from '../../../src/host-display.mjs';

const execute = promisify(execFile);
const has = bin => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
export const skip = has('Xvfb') && has('python3') ? false : 'needs Xvfb and python3';
const proof = new URL('../xproof.py', import.meta.url).pathname;

export async function startX() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'clawser-xvfb-'));
  const cookie = randomBytes(16);
  await fs.writeFile(join(dir, 'server-auth'), xauthorityEntry(0, cookie), { mode: 0o600 });
  const child = spawn('Xvfb', ['-displayfd', '3', '-auth', join(dir, 'server-auth'), '-nolisten', 'tcp', '-screen', '0', '640x480x24', '+extension', 'XTEST', '+extension', 'X-Resource'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const number = await new Promise((resolve, reject) => {
    let text = '';
    child.stdio[3].on('data', d => { text += d; if (text.includes('\n')) resolve(Number(text)); });
    child.once('exit', () => reject(new Error('Xvfb exited')));
  });
  await fs.writeFile(join(dir, 'xauth'), xauthorityEntry(number, cookie), { mode: 0o600 });
  const env = { ...process.env, DISPLAY: `:${number}`, XAUTHORITY: join(dir, 'xauth') };
  return {
    env,
    dir,
    run: (script, ...args) => execute('python3', [script, ...args], { env }),
    json: async (...args) => JSON.parse((await execute('python3', [proof, ...args], { env })).stdout),
    number,
    pid: child.pid,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(r => child.once('exit', r)); }
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
