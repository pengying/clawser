import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as activationModule from '../src/browser-activation.mjs';
import { createBrowserBindingGuard } from '../src/browser-policy.mjs';

const targetConfig = (pluginConfig = {}) => ({ browser: { defaultProfile: 'daily', profiles: { daily: { attachOnly: true, cdpUrl: 'http://127.0.0.1:9222' } } }, plugins: { entries: { 'browser-handoff': { enabled: true, config: pluginConfig } } } });
function clock() {
  let time = 0, nextId = 0; const timers = new Map();
  return { now: () => time, setTimeout(fn, ms) { const id = ++nextId; timers.set(id, { fn, at: time + ms }); return { id, unref() {} }; }, clearTimeout(timer) { timers.delete(timer.id); }, advance(ms) { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); } }, get size() { return timers.size; } };
}
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
function fixture({ initiallyCurrent = false, activate, cleanup, scope } = {}) {
  const target = targetConfig(), scheduler = clock(), diagnostics = [], warnings = [];
  let current = structuredClone(target), activations = 0, drifts = 0, activation;
  if (!initiallyCurrent) current.plugins.entries['browser-handoff'].enabled = false;
  const api = { config: target, pluginConfig: {}, runtime: { config: { current: () => current } }, logger: { warn: message => warnings.push(message) } };
  const binding = createBrowserBindingGuard(api, { onDrift() { drifts++; activation?.retire(); } });
  activation = activationModule.createBrowserActivation({ api, binding, scheduler, scope, writeDiagnostic: async value => { diagnostics.push(value); }, activate: async options => { activations++; if (activate) return activate(options); options.assertCurrent(); }, cleanup: cleanup || (async () => {}) });
  return { api, binding, activation, scheduler, target, diagnostics, warnings, get current() { return current; }, set current(value) { current = value; }, get activations() { return activations; }, get drifts() { return drifts; } };
}
test('hot enable returns awaiting commit without resources or authority, then activates once fresh current matches', async () => {
  const f = fixture();
  await f.activation.start();
  assert.equal(f.activation.status().phase, 'awaiting-commit'); assert.equal(f.activations, 0); assert.equal(f.scheduler.size, 1);
  assert.throws(() => f.activation.assertActive(), /awaiting.*configuration publication/i); assert.equal(f.drifts, 0);
  f.current = structuredClone(f.target); f.scheduler.advance(100); await flush();
  assert.equal(f.activation.status().phase, 'active'); assert.equal(f.activations, 1); assert.equal(f.scheduler.size, 0);
  assert.doesNotThrow(() => f.activation.assertActive());
  await f.activation.stop();
});
test('already-current cold startup awaits actual activation and validates immutable intended settings', async () => {
  const f = fixture({ initiallyCurrent: true, activate: async ({ prepared, assertCurrent }) => {
    assert.equal(Object.isFrozen(prepared.pluginConfig), true); assert.equal(Object.isFrozen(prepared.config.browser.profiles), true); assertCurrent();
  } });
  await f.activation.start(); assert.equal(f.activation.status().phase, 'active'); assert.equal(f.activations, 1); await f.activation.stop();
});
test('missing current API fails preparation; throwing current reads stay pending until a bounded publication deadline', async () => {
  const missing = fixture(); missing.api.runtime.config.current = undefined;
  await assert.rejects(missing.activation.start(), /current.*API/i); assert.equal(missing.activations, 0); assert.equal(missing.activation.status().phase, 'failed');
  const f = fixture(); f.api.runtime.config.current = () => { throw new Error('offline'); };
  await f.activation.start(); assert.equal(f.activation.status().phase, 'awaiting-commit');
  f.scheduler.advance(30_000); await flush();
  assert.equal(f.activation.status().phase, 'failed'); assert.match(f.activation.status().message, /publication.*deadline|deadline.*publication/i); assert.equal(f.activations, 0); assert.equal(f.scheduler.size, 0);
  await missing.activation.stop(); await f.activation.stop();
});
test('stop before commit cancels the only pending timer and cannot later activate', async () => {
  const f = fixture(); await f.activation.start(); await f.activation.stop();
  f.current = structuredClone(f.target); f.scheduler.advance(30_000); await flush();
  assert.equal(f.activation.status().phase, 'stopped'); assert.equal(f.activations, 0); assert.equal(f.scheduler.size, 0);
});
test('stop during activation invalidates late completions without waiting for an uninterruptible operation', async () => {
  let release, published = false, cleanups = 0;
  const f = fixture({ initiallyCurrent: true, activate: async ({ assertCurrent }) => { await new Promise(resolve => { release = resolve; }); assertCurrent(); published = true; }, cleanup: async () => { cleanups++; } });
  const starting = f.activation.start(); await flush();
  assert.equal(f.activation.status().phase, 'activating'); await f.activation.stop();
  release(); await assert.rejects(starting, /stopped|changed|current/i); assert.equal(published, false); assert.ok(cleanups >= 1); assert.equal(f.activation.status().phase, 'stopped');
});
test('armed configuration drift retires permanently; restoring the intended snapshot cannot revive it', async () => {
  const f = fixture({ initiallyCurrent: true }); await f.activation.start();
  f.current.browser.profiles.daily.cdpUrl = 'http://127.0.0.1:9555';
  assert.throws(() => f.activation.assertActive(), /configuration|retired|changed/i); assert.equal(f.activation.status().phase, 'retired'); assert.equal(f.drifts, 1);
  f.current = structuredClone(f.target); assert.throws(() => f.activation.assertActive(), /retired/i); await f.activation.stop();
});
test('a newer candidate owns publication; a stopped or superseded candidate cannot cross-publish', async () => {
  const scope = {};
  const first = fixture({ scope }), second = fixture({ scope });
  await first.activation.start(); await second.activation.start();
  assert.equal(first.activation.status().phase, 'retired'); assert.equal(first.scheduler.size, 0);
  first.current = structuredClone(first.target); second.current = structuredClone(second.target);
  first.scheduler.advance(100); second.scheduler.advance(100); await flush();
  assert.equal(first.activations, 0); assert.equal(second.activation.status().phase, 'active');
  await first.activation.stop(); assert.doesNotThrow(() => second.activation.assertActive()); await second.activation.stop();
});
test('a config change after an activation await prevents publication and records an actionable asynchronous failure', async () => {
  let release, published = false;
  const f = fixture({ activate: async ({ assertCurrent }) => { await new Promise(resolve => { release = resolve; }); assertCurrent(); published = true; } });
  await f.activation.start(); f.current = structuredClone(f.target); f.scheduler.advance(100); await flush();
  f.current.browser.defaultProfile = 'unknown'; release(); await flush();
  assert.equal(published, false); assert.equal(f.activation.status().phase, 'retired'); assert.ok(f.warnings.length); await f.activation.stop();
});

test('target identity normalizes manifest defaults and requires an explicitly enabled intended entry', () => {
  const config = targetConfig(), pluginConfig = { port: 18796, ownerGroupSessions: [] };
  assert.equal(activationModule.activationTargetFingerprint({ config, pluginConfig }), activationModule.activationTargetFingerprint({ config, pluginConfig: {} }));
  delete config.plugins.entries['browser-handoff'];
  assert.throws(() => activationModule.activationTargetFingerprint({ config, pluginConfig }), /enabled.*entry/i);
});
test('private diagnostics identify the producer and an older stopped generation cannot overwrite the latest status', async t => {
  const { mkdtemp, readFile, stat, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const stateDir = await mkdtemp(join(tmpdir(), 'clawser-activation-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  function candidate() {
    const config = targetConfig(); let current = structuredClone(config); current.plugins.entries['browser-handoff'].enabled = false;
    const api = { config, pluginConfig: {}, runtime: { config: { current: () => current } }, logger: { warn() {} } };
    const scheduler = clock(), binding = createBrowserBindingGuard(api);
    const activation = activationModule.createBrowserActivation({ api, binding, scheduler, activate: async ({ assertCurrent }) => assertCurrent() });
    return { activation, scheduler, commit() { current = config; } };
  }
  const old = candidate(), next = candidate();
  await old.activation.start({ stateDir }); await next.activation.start({ stateDir }); await old.activation.stop();
  const path = activationModule.activationDiagnosticPath(stateDir), pending = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(pending.generation, next.activation.status().generation); assert.equal(pending.phase, 'awaiting-commit');
  next.commit(); next.scheduler.advance(100); await flush();
  let text, active;
  for (let attempt = 0; attempt < 100; attempt++) { text = await readFile(path, 'utf8'); active = JSON.parse(text); if (active.phase === 'active') break; }
  assert.equal(active.phase, 'active'); assert.equal(active.producerPid, process.pid); assert.match(active.producerStartTicks, /^[0-9]+$/);
  assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal((await stat(join(stateDir, 'browser-handoff'))).mode & 0o777, 0o700);
  assert.doesNotMatch(text, /9222|127\.0\.0\.1/); await next.activation.stop();
});
test('pending discovery diagnostics are read-only and never publish an execution factory', async () => {
  const f = fixture(); await f.activation.start();
  const status = activationModule.activationStatusForTarget({ config: f.api.config, pluginConfig: f.api.pluginConfig });
  assert.equal(status.phase, 'awaiting-commit'); assert.match(status.message, /awaiting.*configuration publication/i);
  assert.equal(status.factory, undefined); assert.equal(f.activations, 0);
  await f.activation.stop();
  assert.equal(activationModule.activationStatusForTarget({ config: f.api.config, pluginConfig: f.api.pluginConfig }), undefined);
});
test('stop starts resource cancellation before waiting for a delayed diagnostic write', async () => {
  const target = targetConfig(); let release, cleanups = 0;
  const api = { config: target, pluginConfig: {}, runtime: { config: { current: () => target } }, logger: { warn() {} } };
  const binding = createBrowserBindingGuard(api);
  const activation = activationModule.createBrowserActivation({ api, binding, activate: async ({ assertCurrent }) => assertCurrent(), cleanup: async () => { cleanups++; }, writeDiagnostic: async status => { if (status.phase === 'stopped') await new Promise(resolve => { release = resolve; }); } });
  await activation.start(); const stopping = activation.stop(); await flush();
  assert.equal(cleanups, 1); assert.equal(typeof release, 'function'); release(); await stopping;
});
