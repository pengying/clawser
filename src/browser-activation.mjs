import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { prepareBrowserConfiguration } from './browser-policy.mjs';

const ownersSymbol = Symbol.for('openclaw.browser-handoff.activation-owners.v1');
const scopeKeysSymbol = Symbol.for('openclaw.browser-handoff.activation-scope-keys.v1');
const scopeKeys = () => globalThis[scopeKeysSymbol] ??= new WeakMap();
function scopeKey(value) {
  if (value && (typeof value === 'object' || typeof value === 'function')) {
    if (!scopeKeys().has(value)) scopeKeys().set(value, randomUUID());
    return scopeKeys().get(value);
  }
  return value || randomUUID();
}
const queuesSymbol = Symbol.for('openclaw.browser-handoff.activation-diagnostic-queues.v1');
const owners = () => globalThis[ownersSymbol] ??= new Map();
const queues = () => globalThis[queuesSymbol] ??= new Map();
let producerIdentity;
async function readProducerIdentity() {
  producerIdentity ??= (async () => {
    let producerStartTicks = null;
    if (process.platform === 'linux') {
      const stat = await readFile('/proc/self/stat', 'utf8');
      producerStartTicks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      if (!/^[0-9]+$/.test(producerStartTicks || '')) throw new Error('Browser Handoff process identity is unavailable');
    }
    return { producerPid: process.pid, producerStartTicks };
  })();
  return producerIdentity;
}
const terminal = new Set(['failed', 'stopped', 'retired']);
export const activationDiagnosticPath = stateDir => join(stateDir, 'browser-handoff', 'activation.json');
export function activationTargetFingerprint({ config, pluginConfig = {} }) {
  return createHash('sha256').update(prepareBrowserConfiguration({ config, pluginConfig, requireEnabledEntry: true }).fingerprint).digest('hex');
}

// Diagnostic-only lookup for a cold discovery module. It grants no execution
// factory or browser authority and never reads runtime configuration.
export function activationStatusForTarget(settings) {
  let expected;
  try { expected = activationTargetFingerprint(settings); } catch { return undefined; }
  const matching = [...owners().values()].filter(owned => owned.status.targetFingerprint === expected);
  const pending = matching.filter(owned => !terminal.has(owned.status.phase));
  if (pending.length === 1) return { ...pending[0].status };
  if (pending.length > 1) return undefined;
  return matching.length === 1 ? { ...matching[0].status } : undefined;
}

async function writePrivateDiagnostic(path, value, current) {
  const directory = join(path, '..');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || typeof process.getuid === 'function' && stat.uid !== process.getuid())
    throw new Error('Browser Handoff activation diagnostic directory must be private and owner-controlled');
  if (!current()) return;
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    if (current()) await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

// Native hot reload starts services before publishing runtime.config.current().
// Preparation is not authority: only a fresh matching read can arm the binding.
export function createBrowserActivation({ api, binding, activate, cleanup = async () => {}, scheduler = globalThis, scope, publicationTimeoutMs = 30_000, pollIntervalMs = 100, writeDiagnostic } = {}) {
  let record;
  const now = () => typeof scheduler.now === 'function' ? scheduler.now() : Date.now();
  const status = () => record ? { ...record.status } : { version: 1, phase: 'prepared', message: 'Browser Handoff service is not running' };
  function clearTimer(owned) { if (owned.timer) { scheduler.clearTimeout(owned.timer); owned.timer = undefined; } }
  function isOwner(owned) { return record === owned && owners().get(owned.scope) === owned.token; }
  function diagnostic(owned) {
    owned.token.status = { ...owned.status };
    if (!owned.path && !writeDiagnostic) return Promise.resolve();
    const value = { ...owned.status }, key = owned.path || owned.scope;
    const prior = queues().get(key) || Promise.resolve();
    const job = prior.catch(() => {}).then(async () => {
      if (!isOwner(owned)) return;
      Object.assign(value, await readProducerIdentity());
      if (!isOwner(owned)) return;
      if (writeDiagnostic) await writeDiagnostic(value);
      else await writePrivateDiagnostic(owned.path, value, () => isOwner(owned));
    }).catch(() => { if (isOwner(owned)) api.logger?.warn?.('Browser Handoff activation diagnostic could not be written; inspect service health before reporting readiness.'); });
    queues().set(key, job);
    void job.finally(() => { if (queues().get(key) === job) queues().delete(key); });
    return job;
  }
  function transition(owned, phase, message) {
    owned.status = { ...owned.status, phase, message, updatedAt: now() };
    return diagnostic(owned);
  }
  function report(owned, error) {
    if (!isOwner(owned)) return;
    api.logger?.warn?.('Browser Handoff activation did not complete: ' + error.message);
    if (typeof owned.ctx.serviceHealth?.reportFailure === 'function') owned.ctx.serviceHealth.reportFailure(error);
  }
  function assertCurrent(owned) {
    if (!isOwner(owned) || terminal.has(owned.status.phase) || owned.abort.signal.aborted)
      throw new Error('Browser Handoff activation ' + owned.status.phase + '; service generation changed or stopped');
    binding.current();
  }
  function retireOwned(owned, message = 'Browser Handoff service generation is retired and unavailable; operator reconciliation is required') {
    if (terminal.has(owned.status.phase)) return;
    clearTimer(owned); owned.abort.abort(new Error(message));
    void transition(owned, 'retired', message);
    void Promise.resolve().then(() => { if (record === owned) return cleanup('retired'); }).catch(error => report(owned, error));
  }
  function runActivation(owned) {
    clearTimer(owned); void transition(owned, 'activating', 'Browser Handoff backend activation is in progress');
    owned.task = Promise.resolve().then(async () => {
      assertCurrent(owned);
      const activated = await activate({ ctx: owned.ctx, prepared: owned.prepared, assertCurrent: () => assertCurrent(owned), signal: owned.abort.signal, generation: owned.status.generation, setPublicTransport: value => {
        if (isOwner(owned) && !terminal.has(owned.status.phase)) { owned.status.publicTransport = value; void diagnostic(owned); }
      } });
      assertCurrent(owned);
      await transition(owned, 'active', 'Browser Handoff backend is active');
      assertCurrent(owned);
      if (isOwner(owned) && owned.status.phase === 'active') {
        if (typeof owned.ctx.serviceHealth?.clearFailure === 'function') owned.ctx.serviceHealth.clearFailure();
        activated?.onActive?.();
      }
    }).catch(async error => {
      if (!terminal.has(owned.status.phase)) {
        clearTimer(owned); owned.abort.abort(error);
        await transition(owned, 'failed', 'Browser Handoff backend activation failed and is unavailable; inspect service health and reload the plugin');
      }
      report(owned, error);
      try { if (record === owned) await cleanup(owned.status.phase); } catch (failure) { report(owned, failure); }
      throw error;
    });
    // A pending native start has already returned; retain diagnostics and observe
    // every asynchronous failure without an unhandled promise rejection.
    void owned.task.catch(() => {});
    return owned.task;
  }
  function check(owned) {
    if (!isOwner(owned) || owned.status.phase !== 'awaiting-commit') return;
    if (now() >= owned.deadline) {
      clearTimer(owned); owned.abort.abort();
      const error = new Error('Browser Handoff configuration publication deadline expired; verify current runtime configuration and reload the plugin');
      void transition(owned, 'failed', error.message); report(owned, error); return;
    }
    if (binding.matches(owned.prepared)) {
      let pinned = false;
      try { binding.pin(owned.prepared); pinned = true; } catch { /* A second fresh read may race publication. */ }
      if (pinned) return runActivation(owned);
    }
    if (!owned.timer) {
      owned.timer = scheduler.setTimeout(() => { owned.timer = undefined; check(owned); }, Math.min(pollIntervalMs, owned.deadline - now()));
      owned.timer.unref?.();
    }
  }
  return {
    status,
    async start(ctx = {}) {
      if (record && !terminal.has(record.status.phase)) throw new Error('Browser Handoff service is already running or awaiting configuration publication');
      const owned = record = { ctx, scope: scopeKey(scope || (isAbsolute(ctx.stateDir || '') ? ctx.stateDir : api.runtime?.config)), abort: new AbortController(), status: { version: 1, generation: randomUUID(), phase: 'prepared', updatedAt: now(), message: 'Browser Handoff intended configuration is prepared' } };
      if (isAbsolute(ctx.stateDir || '')) owned.path = activationDiagnosticPath(ctx.stateDir);
      // The process registry stores fixed diagnostic metadata plus a weak owner
      // reference. It cannot retain host API/config credentials after retirement.
      owned.token = { status: { ...owned.status }, owner: new WeakRef(owned) };
      const previous = owners().get(owned.scope); owners().set(owned.scope, owned.token);
      previous?.owner.deref()?.retire?.();
      owned.retire = () => retireOwned(owned, 'Browser Handoff activation was superseded by a newer service generation');
      for (const [key, value] of owners()) {
        if (owners().size <= 128) break;
        if (terminal.has(value.status.phase) && value !== owned.token) owners().delete(key);
      }
      try {
        owned.prepared = binding.prepare();
        owned.status = { ...owned.status, backend: owned.prepared.binding.backend, profile: owned.prepared.binding.profile, publicTransport: owned.prepared.binding.backend === 'novnc' ? 'on-demand' : owned.prepared.pluginConfig.cloudflare?.enabled === true || owned.prepared.pluginConfig.funnel?.enabled === true ? 'warming' : owned.prepared.pluginConfig.publicBaseUrl ? 'ready' : 'disabled', targetFingerprint: createHash('sha256').update(owned.prepared.fingerprint).digest('hex') };
        owned.deadline = now() + publicationTimeoutMs;
        await transition(owned, 'awaiting-commit', 'Browser Handoff is awaiting configuration publication');
        if (terminal.has(owned.status.phase)) throw new Error('Browser Handoff activation stopped or superseded before configuration publication');
        const task = check(owned);
        if (task) await task;
      } catch (error) {
        if (!terminal.has(owned.status.phase)) { await transition(owned, 'failed', 'Browser Handoff activation preparation failed; inspect service health and plugin configuration'); report(owned, error); }
        throw error;
      }
    },
    assertActive() {
      const phase = record?.status.phase;
      if (phase !== 'active') throw new Error(record?.status.message || 'Browser Handoff service is not running');
      assertCurrent(record);
    },
    assertCurrent() { if (!record) throw new Error('Browser Handoff service is not running'); assertCurrent(record); },
    retire() { if (record) retireOwned(record); },
    async stop() {
      const owned = record;
      if (!owned) return;
      clearTimer(owned); owned.abort.abort(new Error('Browser Handoff service stopped'));
      await transition(owned, 'stopped', 'Browser Handoff service stopped and is unavailable');
      try { if (record === owned) await cleanup('stopped'); }
      finally { if (owners().get(owned.scope) === owned.token) owners().delete(owned.scope); }
    },
  };
}
