import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopController } from '../src/desktop-controller.mjs';
import { DesktopRpcServer } from '../src/desktop-rpc.mjs';
const recovery = await import('../src/desktop-recovery.mjs').catch(() => null);
const owner = JSON.stringify(['agent:main:main', 'fixture-owner']);
const id = 'a'.repeat(32);
const row = () => ({ id, owner, profile: 'fixture', state: 'recovery_required', reason: 'done', recoveryStage: 'input_fence', mayBeWritable: true, epoch: 35, displayGeneration: 'display', browserGeneration: 'browser' });
const receipt = () => ({ leaseId: id, epoch: 36, displayGeneration: 'display', browserGeneration: 'browser', readOnly: false, inputResetRequired: true, vncProcessesExited: true, xClientsAbsent: true, heldInputCleared: true, xSyncComplete: true, retirementReason: 'heartbeat_timeout' });
const status = () => ({ ready: true, tainted: false, viewer: null, epoch: 36, displayGeneration: 'display', browserGeneration: 'browser', browserSandbox: true, authenticatedInternetReady: true });
const observation = () => ({ snapshotObserved: true, displayGeneration: 'display', browserGeneration: 'browser' });
async function fixture(t, overrides = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'desktop-recovery-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const ledger = { version: 1, calls: {}, leases: { [id]: row() } };
  await writeFile(join(stateDir, 'ledger.json'), JSON.stringify(ledger), { mode: 0o600 });
  const events = [];
  const runtime = { status: async () => { events.push('status'); return status(); }, stopViewerAndSettle: async params => { events.push('retire'); assert.deepEqual(params, { leaseId: id, mayBeWritable: true }); return receipt(); }, ...overrides };
  const options = { stateDir, profile: 'fixture', runtime, leaseId: id };
  const dependencies = { observe: async () => { events.push('observe'); return observation(); } };
  const journal = async () => JSON.parse(await readFile(join(stateDir, 'ledger.json'), 'utf8'));
  return { stateDir, ledger, runtime, options, dependencies, journal, events };
}

test('offline recovery helper is available', () => assert.ok(recovery?.reconcileDesktop));

test('lost host retirement response followed by watchdog settlement stays blocked until explicit strict offline reconciliation', async t => {
  if (!recovery) return;
  const f = await fixture(t);
  let available = false;
  f.runtime.startViewer = async ({ leaseId }) => ({ leaseId, role: 'watch', epoch: 34, displayGeneration: 'display', browserGeneration: 'browser', host: '127.0.0.1', port: 59090, password: 'fixture' });
  f.runtime.promoteViewer = async ({ leaseId }) => ({ ...(await f.runtime.startViewer({ leaseId })), role: 'control', epoch: 35 });
  f.runtime.stopViewerAndSettle = async params => { if (!available) throw new Error('fixture host transport loss'); return receipt(); };
  f.runtime.heartbeatViewer = async params => ({ ok: true, ...params });
  f.runtime.ensure = async () => ({});
  const make = () => new DesktopController({ stateDir: f.stateDir, profile: 'fixture', runtime: f.runtime, transport: { ensure: async () => 'https://example.test', close: async () => {} }, port: 0, observe: f.dependencies.observe });
  await writeFile(join(f.stateDir, 'ledger.json'), JSON.stringify({ version: 1, calls: {}, leases: {} }));
  const original = make(); await original.start();
  original.ledger.leases[id] = { ...row(), state: 'control' }; original.gate.holder = id;
  await assert.rejects(original.retire(id, { reason: 'done' }), /recovery/);
  assert.equal((await f.journal()).leases[id].state, 'recovery_required');
  assert.equal((await f.journal()).leases[id].receipt, undefined);
  await original.close();
  // A failed journal remains fenced across an ordinary controller restart.
  const blocked = make(); await blocked.start();
  await assert.rejects(blocked.request('automationEnter', { callKey: 'blocked' }), /recovery|uncertain/);
  await blocked.close(); available = true;
  const result = await recovery.reconcileDesktop(f.options, f.dependencies);
  assert.deepEqual(result, { ok: true, leaseId: id, inputFenced: true, snapshotObserved: true, restartRequired: true });
  const saved = (await f.journal()).leases[id];
  assert.equal(saved.state, 'ended'); assert.equal(saved.receipt.epoch, 36); assert.equal(saved.receipt.snapshotObserved, true);
  assert.equal(saved.reason, 'done');
  const restarted = make(); await restarted.start();
  try { assert.deepEqual(await restarted.request('automationEnter', { callKey: 'next' }), { admitted: true }); await restarted.request('automationLeave', { callKey: 'next' }); }
  finally { await restarted.close(); }
});

for (const scenario of ['active-call', 'active-lease', 'other-failed-lease', 'active-viewer', 'missing-row-generation', 'wrong-runtime-generation', 'missing-receipt-generation', 'wrong-receipt-generation', 'stale-receipt', 'wrong-idle-epoch', 'false-fence', 'snapshot-failure', 'runtime-changed', 'runtime-changed-after-proof']) test(`offline reconciliation refuses ${scenario} and keeps failed authority fenced`, async t => {
  if (!recovery) return;
  const f = await fixture(t);
  if (scenario === 'active-call') f.ledger.calls.unknown = { state: 'uncertain' };
  if (scenario === 'active-lease') f.ledger.leases[id].state = 'control';
  if (scenario === 'other-failed-lease') f.ledger.leases.other = { ...row(), id: 'other' };
  if (scenario === 'missing-row-generation') delete f.ledger.leases[id].browserGeneration;
  await writeFile(join(f.stateDir, 'ledger.json'), JSON.stringify(f.ledger));
  if (scenario === 'active-viewer') f.runtime.status = async () => ({ ...status(), viewer: { leaseId: id } });
  if (scenario === 'wrong-runtime-generation') f.runtime.status = async () => ({ ...status(), browserGeneration: 'other' });
  if (scenario === 'missing-receipt-generation') f.runtime.stopViewerAndSettle = async () => { const r = receipt(); delete r.browserGeneration; return r; };
  if (scenario === 'wrong-receipt-generation') f.runtime.stopViewerAndSettle = async () => ({ ...receipt(), browserGeneration: 'other' });
  if (scenario === 'stale-receipt') f.runtime.stopViewerAndSettle = async () => ({ ...receipt(), epoch: 35 });
  if (scenario === 'wrong-idle-epoch') f.runtime.stopViewerAndSettle = async () => ({ ...receipt(), epoch: 37 });
  if (scenario === 'false-fence') f.runtime.stopViewerAndSettle = async () => ({ ...receipt(), heldInputCleared: false });
  if (scenario === 'snapshot-failure') f.dependencies.observe = async () => { throw new Error('fixture private error must not escape'); };
  if (scenario === 'runtime-changed' || scenario === 'runtime-changed-after-proof') { let count = 0; const changesAt = scenario === 'runtime-changed' ? 2 : 3; f.runtime.status = async () => (++count < changesAt ? status() : { ...status(), epoch: 37 }); }
  await assert.rejects(recovery.reconcileDesktop(f.options, f.dependencies), error => /^DESKTOP_RECOVERY_[A-Z_]+$/.test(error.code) && !error.message.includes('fixture private'));
  assert.notEqual((await f.journal()).leases[id].state, 'ended');
});

test('offline reconciliation refuses the running controller lock before reading runtime', async t => {
  if (!recovery) return;
  const f = await fixture(t);
  const lock = new DesktopRpcServer({ socketPath: join(f.stateDir, 'desktop.sock'), handler: async () => ({}) });
  await lock.acquireLock();
  try { await assert.rejects(recovery.reconcileDesktop(f.options, f.dependencies), { code: 'DESKTOP_RECOVERY_CONTROLLER_RUNNING' }); assert.deepEqual(f.events, []); }
  finally { await lock.releaseLock(); }
});

for (const failure of ['lock-loss', 'persistence']) test(`offline reconciliation does not end a lease after ${failure}`, async t => {
  if (!recovery) return;
  const f = await fixture(t); let controller;
  f.dependencies.controllerFactory = options => { controller = new DesktopController(options); if (failure === 'persistence') controller.persist = async () => { throw new Error('fixture disk failure'); }; return controller; };
  f.dependencies.observe = async () => {
    if (failure === 'lock-loss') { controller.rpc.lockHolder.lost = true; }
    return observation();
  };
  await assert.rejects(recovery.reconcileDesktop(f.options, f.dependencies), error => error.code.startsWith('DESKTOP_RECOVERY_'));
  assert.equal((await f.journal()).leases[id].state, 'recovery_required');
});


test('operator binary reports a fixed code for an invalid private configuration', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const result = await promisify(execFile)(process.execPath, ['bin/reconcile-desktop.mjs', '/missing-private-config', id]).catch(error => error);
  assert.equal(result.code, 1);
  assert.equal(result.stderr.trim(), 'Desktop recovery refused: DESKTOP_RECOVERY_CONFIG_INVALID');
});


test('offline proof leaves the failed journal unchanged until one final atomic completion write', async t => {
  const f = await fixture(t); let writes = 0, statuses = 0;
  const original = await readFile(join(f.stateDir, 'ledger.json'), 'utf8');
  f.runtime.status = async () => {
    statuses++;
    assert.equal(await readFile(join(f.stateDir, 'ledger.json'), 'utf8'), original);
    return status();
  };
  f.dependencies.observe = async () => {
    assert.equal(await readFile(join(f.stateDir, 'ledger.json'), 'utf8'), original);
    return observation();
  };
  f.dependencies.controllerFactory = options => {
    const controller = new DesktopController(options), persist = controller.persist.bind(controller);
    controller.persist = async () => { writes++; assert.equal(controller.ledger.leases[id].state, 'ended'); return persist(); };
    return controller;
  };
  await recovery.reconcileDesktop(f.options, f.dependencies);
  assert.equal(statuses, 3); assert.equal(writes, 1);
  assert.equal((await f.journal()).leases[id].state, 'ended');
});
