import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopRpcServer } from '../src/desktop-rpc.mjs';
import { describeRecovery, recoverDesktopCalls } from '../src/desktop-recover.mjs';

const uid = process.getuid();
// pid 100 has exited, 200 now belongs to a different process, 300 is the Gateway still running.
const processInfo = async pid => ({ 200: { startTicks: '99', uid }, 300: { startTicks: '30', uid } })[pid] ?? null;
const calls = () => ({
  exited: { state: 'uncertain', count: 1, connectionId: 'a', ownerPid: 100, ownerStartTicks: '10' },
  reused: { state: 'active', count: 1, connectionId: 'b', ownerPid: 200, ownerStartTicks: '20' },
  running: { state: 'uncertain', count: 1, connectionId: 'c', ownerPid: 300, ownerStartTicks: '30' },
  legacy: { state: 'uncertain', count: 1, connectionId: 'd' },
});
const lease = { id: 'f'.repeat(32), state: 'recovery_required', mayBeWritable: true, displayGeneration: 'boot:1' };

async function fixture(t, ledgerCalls = calls(), leases = { [lease.id]: lease }) {
  const stateDir = await mkdtemp(join(tmpdir(), 'clawser-recover-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await writeFile(join(stateDir, 'controller.json'), JSON.stringify({ stateDir: '.', profile: 'clawser', runtime: { cdpUrl: 'http://127.0.0.1:18820' } }), { mode: 0o600 });
  const ledger = { version: 1, calls: ledgerCalls, leases };
  await writeFile(join(stateDir, 'ledger.json'), JSON.stringify(ledger), { mode: 0o600 });
  const saved = async () => JSON.parse(await readFile(join(stateDir, 'ledger.json'), 'utf8'));
  return { stateDir, saved };
}

test('recover clears only calls whose Gateway has provably exited, and leaves leases alone', async t => {
  const { stateDir, saved } = await fixture(t);
  const result = await recoverDesktopCalls({ stateDir }, { processInfo });
  assert.deepEqual(result, { ok: false, dryRun: false, cleared: 2, running: 1, unknown: 1, recoveryRequired: [lease.id] });
  const after = await saved();
  assert.deepEqual(Object.keys(after.calls).sort(), ['legacy', 'running']);
  assert.deepEqual(after.leases, { [lease.id]: lease });
  const lines = describeRecovery(result, 'clawser-desktop-x.service');
  assert.match(lines.join('\n'), /still running\. Restart it with openclaw gateway restart/);
  assert.match(lines.join('\n'), /--abandon-calls/);
  assert.match(lines.at(-1), /systemctl --user start clawser-desktop-x\.service/);
});

test('recover --dry-run reports without writing', async t => {
  const { stateDir, saved } = await fixture(t);
  const before = await readFile(join(stateDir, 'ledger.json'), 'utf8');
  const result = await recoverDesktopCalls({ stateDir, dryRun: true }, { processInfo });
  assert.equal(result.cleared, 2);
  assert.equal(result.dryRun, true);
  assert.equal(await readFile(join(stateDir, 'ledger.json'), 'utf8'), before);
  assert.match(describeRecovery(result, 'u')[0], /^Would clear 2 /);
  assert.equal(Object.keys((await saved()).calls).length, 4);
});

test('--abandon-calls also clears calls that name no Gateway, but never one whose Gateway runs', async t => {
  const { stateDir, saved } = await fixture(t);
  const result = await recoverDesktopCalls({ stateDir, abandonCalls: true }, { processInfo });
  assert.equal(result.cleared, 3);
  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys((await saved()).calls), ['running']);
  const clean = await fixture(t, { legacy: calls().legacy, exited: calls().exited }, {});
  assert.equal((await recoverDesktopCalls({ stateDir: clean.stateDir, abandonCalls: true }, { processInfo })).ok, true);
  assert.deepEqual((await clean.saved()).calls, {});
});

test('recover refuses while the controller holds its lock', async t => {
  const { stateDir } = await fixture(t);
  const running = new DesktopRpcServer({ socketPath: join(stateDir, 'desktop.sock'), handler: async () => ({}) });
  await running.acquireLock();
  t.after(() => running.releaseLock());
  const before = await readFile(join(stateDir, 'ledger.json'), 'utf8');
  await assert.rejects(recoverDesktopCalls({ stateDir }, { processInfo }), /controller is running\. Stop it first with: systemctl --user stop clawser-desktop-/);
  assert.equal(await readFile(join(stateDir, 'ledger.json'), 'utf8'), before);
});

test('recover needs the private controller configuration setup wrote', async t => {
  const { stateDir } = await fixture(t);
  await chmod(join(stateDir, 'controller.json'), 0o644);
  await assert.rejects(recoverDesktopCalls({ stateDir }, { processInfo }), /No private controller configuration/);
  const missing = await mkdtemp(join(tmpdir(), 'clawser-recover-none-'));
  t.after(() => rm(missing, { recursive: true, force: true }));
  await assert.rejects(recoverDesktopCalls({ stateDir: missing }, { processInfo }), /No private controller configuration/);
});

// Review V7: recover exited 0 with a recovery_required lease left, and printed a raw ENOENT with no ledger.
test('recover exits non-zero while a lease still needs recovery, even with no calls left', async t => {
  const { stateDir, saved } = await fixture(t, { exited: calls().exited });
  const result = await recoverDesktopCalls({ stateDir }, { processInfo });
  assert.deepEqual(result, { ok: false, dryRun: false, cleared: 1, running: 0, unknown: 0, recoveryRequired: [lease.id] });
  assert.deepEqual((await saved()).calls, {});
  assert.match(describeRecovery(result, 'u').join('\n'), /Leases needing recovery: f{32}\./);
});

test('recover on an install whose controller never wrote a ledger says there is nothing to recover', async t => {
  const { stateDir } = await fixture(t);
  await rm(join(stateDir, 'ledger.json'));
  const result = await recoverDesktopCalls({ stateDir }, { processInfo });
  assert.equal(result.ok, true);
  assert.equal(result.cleared, 0);
  const lines = describeRecovery(result, 'clawser-desktop-x.service');
  assert.match(lines[0], /^No controller ledger at .*ledger\.json: the controller has not recorded anything here, so there is nothing to recover\.$/);
  assert.equal(lines.at(-1), 'Start the controller again: systemctl --user start clawser-desktop-x.service');
  await writeFile(join(stateDir, 'ledger.json'), '{not json', { mode: 0o600 });
  await assert.rejects(recoverDesktopCalls({ stateDir }, { processInfo }), /could not be read .*left unchanged/);
});

test('calls that name no Gateway are explained without assuming their version', async t => {
  const { stateDir } = await fixture(t, { legacy: calls().legacy });
  const text = describeRecovery(await recoverDesktopCalls({ stateDir, dryRun: true }, { processInfo }), 'u').join('\n');
  assert.match(text, /1 call\(s\) name no Gateway: Clawser 1\.0\.1 or earlier recorded none, and a Gateway whose process Clawser couldn't check \(one in another PID namespace, for example\) records none either\./);
});

test('recover refuses a state folder others can read, as the controller does', async t => {
  const { stateDir } = await fixture(t);
  await chmod(stateDir, 0o750);
  const before = await readFile(join(stateDir, 'ledger.json'), 'utf8');
  await assert.rejects(recoverDesktopCalls({ stateDir }, { processInfo }), /is not a private folder of this user; recover refuses to use it/);
  assert.equal(await readFile(join(stateDir, 'ledger.json'), 'utf8'), before);
  await chmod(stateDir, 0o700);
});
