import { dirname, isAbsolute, join, parse } from 'node:path';
import { activationDiagnosticPath, activationTargetFingerprint } from './browser-activation.mjs';
import { resolveHandoffBrowser } from './browser-config.mjs';

const terminal = new Set(['failed', 'stopped', 'retired']);
const phases = new Set(['prepared', 'awaiting-commit', 'activating', 'active', ...terminal]);
const transports = new Set(['warming', 'ready', 'failed', 'on-demand', 'disabled']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const pending = message => Object.assign(new Error(message), { pending: true });

function hostState(d) {
  const value = d.env.OPENCLAW_STATE_DIR || join(d.homeDir, '.openclaw');
  if (!isAbsolute(value)) throw new Error('OpenClaw state directory must be absolute for activation diagnostics');
  return value;
}

async function readDiagnostic(d) {
  const path = activationDiagnosticPath(hostState(d));
  if (d.readActivationDiagnostic) return d.readActivationDiagnostic(path);
  let current = parse(path).root;
  for (const part of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = await d.fs.lstat(current); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    if (info.isSymbolicLink()) throw new Error('Refusing symlinked Gateway activation diagnostic path');
    if (current === dirname(path) && (!info.isDirectory() || info.uid !== d.uid || (info.mode & 0o077))) throw new Error('Gateway activation diagnostic directory is unowned or non-private');
    if (current === path && (!info.isFile() || info.uid !== d.uid || (info.mode & 0o077) || info.size > 32_768)) throw new Error('Gateway activation diagnostic is unowned, non-private or invalid');
  }
  return JSON.parse(await d.fs.readFile(path, 'utf8'));
}

async function validateDiagnostic(value, d) {
  if (!object(value) || value.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.generation ?? '') || !phases.has(value.phase) ||
      !['cdp', 'novnc'].includes(value.backend) || typeof value.profile !== 'string' || !value.profile || /[\x00-\x1f\x7f]/.test(value.profile) ||
      !/^[a-f0-9]{64}$/.test(value.targetFingerprint ?? '') || !Number.isFinite(value.updatedAt) || value.updatedAt > d.now() + 1000 ||
      !Number.isInteger(value.producerPid) || value.producerPid < 1 || !/^\d+$/.test(value.producerStartTicks ?? '') || !transports.has(value.publicTransport)) throw new Error('Gateway activation diagnostic is invalid or stale');
  let ticks;
  try {
    if (d.readProcessStartTicks) ticks = await d.readProcessStartTicks(value.producerPid);
    else {
      const stat = await d.fs.readFile('/proc/' + value.producerPid + '/stat', 'utf8');
      ticks = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
    }
  } catch { throw new Error('Gateway activation producer is no longer running; reload browser-handoff'); }
  if (ticks !== value.producerStartTicks) throw new Error('Gateway activation producer identity is stale; reload browser-handoff');
  return value;
}

function merge(current, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete current[key];
    else if (object(value)) {
      const child = Object.hasOwn(current, key) && object(current[key]) ? current[key] : {};
      Object.defineProperty(current, key, { value: merge(child, value), enumerable: true, configurable: true, writable: true });
    } else Object.defineProperty(current, key, { value: structuredClone(value), enumerable: true, configurable: true, writable: true });
  }
  return current;
}

function target(config, patch = {}) {
  const intended = merge(structuredClone(config), patch);
  const pluginConfig = intended.plugins?.entries?.['browser-handoff']?.config ?? {};
  const binding = resolveHandoffBrowser({ config: intended, pluginConfig });
  return { backend: binding.backend, profile: binding.profile, cdpUrl: binding.cdpUrl,
    targetFingerprint: activationTargetFingerprint({ config: intended, pluginConfig }) };
}

const matches = (status, expected) => status.backend === expected.backend && status.profile === expected.profile && status.targetFingerprint === expected.targetFingerprint;
export const activationSummary = status => status && ({ phase: status.phase, generation: status.generation, publicTransport: status.publicTransport });

export async function captureSetupActivation(config, patch, d) {
  const prior = await readDiagnostic(d);
  return { ...target(config, patch), priorGeneration: prior?.generation, capturedAt: d.now() };
}

export async function inspectSetupActivation(config, d) {
  const expected = target(config);
  const value = await readDiagnostic(d);
  if (!value) throw pending('Gateway activation is pending; no managed activation diagnostic is available');
  const status = await validateDiagnostic(value, d);
  if (!matches(status, expected)) throw new Error('Gateway activation does not match the configured backend and browser connection');
  return status;
}

export function requireActiveActivation(status) {
  if (status.phase === 'active') return;
  if (terminal.has(status.phase)) throw new Error('Gateway activation ' + status.phase + '; inspect browser-handoff service health and reload after correcting the failure');
  throw pending('Gateway activation is pending (' + status.phase + '); the candidate has not become active');
}

export function logSetupActivation(status, d) {
  if (!status) return;
  d.log('Gateway activation: ' + status.phase + '\nPublic transport: ' + status.publicTransport +
    (status.publicTransport === 'warming' ? status.phase === 'active'
      ? ' (local backend is active; public readiness continues in the background)'
      : ' (activation and public readiness are pending)' : ''));
}

export async function waitForSetupActivation(expected, d, localReady) {
  const deadline = d.now() + 30_000;
  let lastPhase = 'awaiting-commit';
  for (let attempt = 0; attempt <= 120; attempt++) {
    const value = await readDiagnostic(d);
    if (value && value.generation !== expected.priorGeneration && value.updatedAt >= expected.capturedAt) {
      const status = await validateDiagnostic(value, d);
      if (matches(status, expected)) {
        lastPhase = status.phase;
        if (terminal.has(status.phase)) requireActiveActivation(status);
        if (status.phase === 'active') {
          try { await localReady(); }
          catch { throw new Error('Gateway activation reports active but its local backend is not ready; inspect browser-handoff service health before retrying'); }
          const latest = await readDiagnostic(d);
          if (latest && latest.generation === status.generation) {
            await validateDiagnostic(latest, d);
            if (matches(latest, expected)) { requireActiveActivation(latest); return latest; }
          }
        }
      }
    }
    const remaining = deadline - d.now();
    if (remaining <= 0) break;
    await d.sleep(Math.min(250, remaining));
  }
  throw pending('Gateway activation is pending (' + lastPhase + ') after 30 seconds. Configuration is saved; inspect browser-handoff service health before retrying.');
}
