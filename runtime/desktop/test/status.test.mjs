import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DesktopRuntime } from '../index.mjs';
import { inspection, receipt } from './fixtures.mjs';

test('status observes an owned runtime during pending retirement without changing its mutation lock', async () => {
  const stateDir = await mkdtemp(tmpdir() + '/desktop-status-concurrency-');
  await receipt(stateDir);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const commands = [];
  const runtime = new DesktopRuntime({ stateDir, run: async (args, input) => {
    if (args[0] === 'inspect') return JSON.stringify([inspection()]);
    const request = JSON.parse(input); commands.push(request.op);
    if (request.op === 'stopViewerAndSettle') { entered(); await pending; return JSON.stringify({ retired: true }); }
    return JSON.stringify({ ready: true, viewer: null });
  } });
  const retiring = runtime.stopViewerAndSettle({ leaseId: 'fixture', mayBeWritable: true });
  await started;
  try {
    const lock = await readFile(`${stateDir}/operation.lock/owner.json`, 'utf8');
    const lockInfo = await lstat(`${stateDir}/operation.lock`);
    assert.equal((await runtime.status()).ready, true, 'read-only status must not contend with pending retirement');
    assert.equal(await readFile(`${stateDir}/operation.lock/owner.json`, 'utf8'), lock, 'status neither removes nor rewrites the mutation lock');
    assert.equal((await lstat(`${stateDir}/operation.lock`)).ino, lockInfo.ino, 'status preserves the exact held lock directory');
    await assert.rejects(runtime.startViewer({ leaseId: 'second' }), /locked/);
    assert.deepEqual(commands, ['stopViewerAndSettle', 'status'], 'a second mutation is rejected before RPC dispatch');
  } finally { release(); await retiring; await rm(stateDir, { recursive: true, force: true }); }
});

test('a pending read-only status does not create a mutation lock or block retirement', async () => {
  const stateDir = await mkdtemp(tmpdir() + '/desktop-status-concurrency-');
  await receipt(stateDir);
  const ownership = await readFile(`${stateDir}/ownership.json`, 'utf8');
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const commands = [];
  const runtime = new DesktopRuntime({ stateDir, run: async (args, input) => {
    if (args[0] === 'inspect') return JSON.stringify([inspection()]);
    const request = JSON.parse(input); commands.push(request.op);
    if (request.op === 'status') { entered(); await pending; return JSON.stringify({ ready: true }); }
    return JSON.stringify({ retired: true });
  } });
  const observing = runtime.status();
  await started;
  try {
    await assert.rejects(readFile(`${stateDir}/operation.lock/owner.json`, 'utf8'), { code: 'ENOENT' });
    assert.deepEqual(await readdir(stateDir), ['ownership.json'], 'status creates no lock or journal files');
    assert.equal((await runtime.stopViewerAndSettle({ leaseId: 'fixture', mayBeWritable: true })).retired, true);
    assert.equal(await readFile(`${stateDir}/ownership.json`, 'utf8'), ownership, 'read-only status never updates the ownership journal');
    assert.deepEqual(commands, ['status', 'stopViewerAndSettle']);
  } finally { release(); await observing; await rm(stateDir, { recursive: true, force: true }); }
});

test('status before runtime ownership exists fails without creating state or invoking Docker', async () => {
  const root = await mkdtemp(tmpdir() + '/desktop-status-startup-'), stateDir = root + '/not-created';
  let invoked = false;
  const runtime = new DesktopRuntime({ stateDir, run: async () => { invoked = true; } });
  try {
    await assert.rejects(runtime.status(), { code: 'ENOENT' });
    await assert.rejects(lstat(stateDir), { code: 'ENOENT' });
    assert.equal(invoked, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
