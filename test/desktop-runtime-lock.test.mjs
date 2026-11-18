import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostDesktopRuntime, staleOperationLock } from '../runtime/desktop/index.mjs';

const ticks = text => text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
const linux = process.platform === 'linux' ? false : 'needs /proc';

async function runtimeWithLock(t, owner) {
  const stateDir = await mkdtemp(join(tmpdir(), 'clawser-oplock-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const lock = join(stateDir, 'operation.lock');
  await mkdir(lock, { mode: 0o700 });
  if (owner) await writeFile(join(lock, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
  const runtime = new HostDesktopRuntime({ stateDir, controlSocket: join(stateDir, 'control.sock'), cdpUrl: 'http://127.0.0.1:18820' });
  return { stateDir, lock, runtime };
}

async function exitedProcess() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
  const startTicks = ticks(await readFile('/proc/' + child.pid + '/stat', 'utf8'));
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); });
  return { pid: child.pid, processStartTicks: startTicks };
}

test('a lock left by a controller that has exited is taken over', { skip: linux }, async t => {
  const { lock, runtime } = await runtimeWithLock(t, await exitedProcess());
  assert.equal(await staleOperationLock(lock), true);
  assert.equal(await runtime.locked(async () => 'ran'), 'ran');
  await assert.rejects(stat(lock), { code: 'ENOENT' }, 'and released afterwards as usual');
});

test('a lock whose pid now belongs to another process is stale', { skip: linux }, async t => {
  const self = ticks(await readFile('/proc/self/stat', 'utf8'));
  const { lock } = await runtimeWithLock(t, { pid: process.pid, processStartTicks: String(Number(self) - 1) });
  assert.equal(await staleOperationLock(lock), true);
});

test('a lock held by a live process is never taken', { skip: linux }, async t => {
  const self = ticks(await readFile('/proc/self/stat', 'utf8'));
  const { lock, runtime } = await runtimeWithLock(t, { pid: process.pid, processStartTicks: self });
  assert.equal(await staleOperationLock(lock), false);
  await assert.rejects(runtime.locked(async () => 'ran'), /desktop operation is locked/);
  assert.ok((await stat(lock)).isDirectory());
  const parent = await runtimeWithLock(t, { pid: process.ppid });
  assert.equal(await staleOperationLock(parent.lock), false, 'a live pid with no start time is not stale');
});

test('a lock without owner details is stale only after a minute', { skip: linux }, async t => {
  const { lock, runtime } = await runtimeWithLock(t);
  assert.equal(await staleOperationLock(lock), false);
  await assert.rejects(runtime.locked(async () => 'ran'), /desktop operation is locked/);
  const old = new Date(Date.now() - 120_000);
  await utimes(lock, old, old);
  assert.equal(await staleOperationLock(lock), true);
  assert.equal(await runtime.locked(async () => 'ran'), 'ran');
});
