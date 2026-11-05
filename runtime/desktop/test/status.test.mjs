import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm, readFile, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostDesktopRuntime } from '../index.mjs';

const cdpUrl = 'http://127.0.0.1:18820';

async function supervisor(t, answer) {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-status-'));
  const ops = [];
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', async () => {
      const request = JSON.parse(Buffer.concat(chunks));
      ops.push(request.op);
      socket.end(JSON.stringify(await answer(request)));
    });
  });
  await new Promise(resolve => server.listen(join(dir, 'control.sock'), resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { ops, runtime: new HostDesktopRuntime({ stateDir: join(dir, 'state'), controlSocket: join(dir, 'control.sock'), cdpUrl }) };
}

function gate() {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  return { started, entered: () => entered(), wait: () => pending, release: () => release() };
}

test('status observes the runtime during pending retirement without changing its mutation lock', async t => {
  const g = gate();
  const { ops, runtime } = await supervisor(t, async request => {
    if (request.op === 'stopViewerAndSettle') { g.entered(); await g.wait(); return { retired: true }; }
    return { ready: true, viewer: null };
  });
  const lockDir = `${runtime.stateDir}/operation.lock`;
  const retiring = runtime.stopViewerAndSettle({ leaseId: 'fixture', mayBeWritable: true });
  await g.started;
  try {
    const lock = await readFile(`${lockDir}/owner.json`, 'utf8');
    const lockInfo = await lstat(lockDir);
    assert.equal(JSON.parse(lock).pid, process.pid, 'the mutation lock names its owning process');
    assert.equal((await runtime.status()).ready, true, 'read-only status must not contend with pending retirement');
    assert.equal(await readFile(`${lockDir}/owner.json`, 'utf8'), lock, 'status neither removes nor rewrites the mutation lock');
    assert.equal((await lstat(lockDir)).ino, lockInfo.ino, 'status preserves the exact held lock directory');
    await assert.rejects(runtime.startViewer({ leaseId: 'second' }), /locked/);
    assert.deepEqual(ops, ['stopViewerAndSettle', 'status'], 'a second mutation is rejected before RPC dispatch');
  } finally { g.release(); await retiring; }
  await assert.rejects(lstat(lockDir), { code: 'ENOENT' }, 'the lock is released when the mutation returns');
});

test('a pending read-only status does not create a mutation lock or block retirement', async t => {
  const g = gate();
  const { ops, runtime } = await supervisor(t, async request => {
    if (request.op === 'status') { g.entered(); await g.wait(); return { ready: true }; }
    return { retired: true };
  });
  const observing = runtime.status();
  await g.started;
  try {
    await assert.rejects(lstat(runtime.stateDir), { code: 'ENOENT' }, 'status creates no lock or state files');
    assert.equal((await runtime.stopViewerAndSettle({ leaseId: 'fixture', mayBeWritable: true })).retired, true);
    assert.deepEqual(await readdir(runtime.stateDir), [], 'retirement leaves no lock behind');
    assert.deepEqual(ops, ['status', 'stopViewerAndSettle']);
  } finally { g.release(); await observing; }
});

test('heartbeats bypass a held mutation lock', async t => {
  const g = gate();
  const { ops, runtime } = await supervisor(t, async request => {
    if (request.op === 'stopViewerAndSettle') { g.entered(); await g.wait(); return { retired: true }; }
    return { ok: true, leaseId: request.leaseId, epoch: request.epoch };
  });
  const retiring = runtime.stopViewerAndSettle({ leaseId: 'fixture' });
  await g.started;
  try {
    assert.deepEqual(await runtime.heartbeatViewer({ leaseId: 'fixture', epoch: 3 }), { ok: true, leaseId: 'fixture', epoch: 3 });
    assert.throws(() => runtime.heartbeatViewer({ leaseId: 'fixture' }), /exact actor epoch/);
    assert.deepEqual(ops, ['stopViewerAndSettle', 'heartbeatViewer']);
  } finally { g.release(); await retiring; }
});

test('status before the supervisor serves reports starting without creating state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-status-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'not-created');
  const runtime = new HostDesktopRuntime({ stateDir, controlSocket: join(root, 'absent.sock'), cdpUrl });
  assert.deepEqual(await runtime.status(), { ready: false, phase: 'starting' });
  await assert.rejects(lstat(stateDir), { code: 'ENOENT' });
  await assert.rejects(runtime.startViewer({ leaseId: 'cold' }), { code: 'ENOENT' });
  assert.deepEqual(await readdir(stateDir), [], 'a refused mutation releases its lock');
});
