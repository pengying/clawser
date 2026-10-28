import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { activationDiagnosticPath } from '../src/browser-activation.mjs';
import { captureSetupActivation, inspectSetupActivation, logSetupActivation, waitForSetupActivation } from '../src/setup-activation.mjs';
import { activationFixture } from './setup-activation-fixture.mjs';

async function harness(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'clawser-activation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let time = Date.now(), localChecks = 0;
  const d = { fs, env: { OPENCLAW_STATE_DIR: root }, homeDir: '/unused/home', uid: process.getuid(), now: () => time, sleep: async ms => { time += ms; } };
  const config = { browser: { defaultProfile: 'personal', profiles: { personal: { attachOnly: true, cdpUrl: 'http://127.0.0.1:9333' } } }, plugins: { entries: { 'browser-handoff': { enabled: true, config: {} } } } };
  const fixture = activationFixture(config, d);
  delete d.readActivationDiagnostic;
  const path = activationDiagnosticPath(root);
  const write = async overrides => {
    const status = await fixture.publish(overrides);
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.writeFile(path, JSON.stringify(status), { mode: 0o600 });
    return status;
  };
  return { root, path, d, config, write, get time() { return time; }, get localChecks() { return localChecks; }, localReady: async () => { localChecks++; } };
}

test('activation wait rejects an old active generation even when the intended fingerprint matches', async t => {
  const h = await harness(t);
  const prior = await h.write();
  const expected = await captureSetupActivation(h.config, {}, h.d);
  assert.equal(expected.priorGeneration, prior.generation);
  await assert.rejects(waitForSetupActivation(expected, h.d, h.localReady), /activation is pending/);
  assert.equal(h.localChecks, 0);
});

test('activation wait requires the intended fingerprint and a publication after capture', async t => {
  for (const overrides of [{ targetFingerprint: 'a'.repeat(64) }, { updatedAt: 1 }]) {
    const h = await harness(t);
    const expected = await captureSetupActivation(h.config, {}, h.d);
    await h.write(overrides);
    await assert.rejects(waitForSetupActivation(expected, h.d, h.localReady), /activation is pending/);
    assert.equal(h.localChecks, 0);
  }
});

test('activation waits through prepared phases and verifies the same active generation after local readiness', async t => {
  const h = await harness(t), expected = await captureSetupActivation(h.config, {}, h.d);
  const initial = await h.write({ phase: 'awaiting-commit', publicTransport: 'warming' });
  h.d.sleep = async () => { await h.write({ generation: initial.generation, phase: 'active', publicTransport: 'warming' }); };
  const status = await waitForSetupActivation(expected, h.d, h.localReady);
  assert.equal(status.phase, 'active');
  assert.equal(status.publicTransport, 'warming');
  assert.equal(h.localChecks, 1);
  await assert.rejects(waitForSetupActivation({ ...expected, priorGeneration: undefined }, h.d, async () => { await h.write({ generation: initial.generation, phase: 'retired' }); }), /activation retired/);
});

test('activation rejects a reused producer PID and terminal matching generations', async t => {
  for (const overrides of [{ producerStartTicks: '0' }, { phase: 'failed' }, { phase: 'stopped' }, { phase: 'retired' }]) {
    const h = await harness(t), expected = await captureSetupActivation(h.config, {}, h.d);
    await h.write(overrides);
    await assert.rejects(waitForSetupActivation(expected, h.d, h.localReady), /identity is stale|activation (?:failed|stopped|retired)/);
    assert.equal(h.localChecks, 0);
  }
});

test('activation diagnostics require private files and directories and reject symlink paths', async t => {
  for (const mutation of [async h => fs.chmod(h.path, 0o644), async h => fs.chmod(dirname(h.path), 0o755), async h => { const other = join(h.root, 'other.json'); await fs.rename(h.path, other); await fs.symlink(other, h.path); }]) {
    const h = await harness(t); await h.write(); await mutation(h);
    await assert.rejects(inspectSetupActivation(h.config, h.d), /non-private|symlinked/);
  }
});

test('activation inspection uses the native host state rather than the setup asset namespace', async t => {
  const h = await harness(t); await h.write();
  h.d.stateDir = join(h.root, 'clawser-cdp');
  assert.equal((await inspectSetupActivation(h.config, h.d)).phase, 'active');
  await assert.rejects(fs.stat(h.d.stateDir), { code: 'ENOENT' });
});

test('pending activation output never calls its local backend active while public transport warms', () => {
  const messages = [];
  logSetupActivation({ phase: 'awaiting-commit', publicTransport: 'warming' }, { log: value => messages.push(value) });
  assert.equal(messages.join('\n').includes('local backend is active'), false);
  assert.match(messages.join('\n'), /awaiting-commit/);
});

test('an active diagnostic still requires actionable local readiness proof', async t => {
  const h = await harness(t), expected = await captureSetupActivation(h.config, {}, h.d);
  await h.write();
  await assert.rejects(waitForSetupActivation(expected, h.d, async () => { throw new Error('private transport detail'); }), /local backend.*not ready.*inspect/i);
});
