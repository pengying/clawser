import manifest from '../openclaw.plugin.json' with { type: 'json' };
import { authorizedSession } from './authorization.mjs';
import { browserBindingKey, currentBrowserConfig, resolveHandoffBrowser } from './browser-config.mjs';

export const browserTool = name => /(?:^|[.:_])browser(?:_\d+)?$/.test(name || '');
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

// Match the host's JSON-schema default application without mutating either
// current operator settings or the SDK's validated registration settings.
function withDefaults(value, schema = manifest.configSchema) {
  if (value === undefined) return schema.default;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = { ...value };
  for (const [key, child] of Object.entries(schema.properties || {})) {
    const normalized = withDefaults(value[key], child);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

// Every service generation is bound to the live host configuration at start.
// A failed current read is itself drift: restoring a stale snapshot cannot
// revive invitations or an automation fence from the retired generation.
export function createBrowserBindingGuard(api, { onDrift = () => {} } = {}) {
  let pinned, fingerprint, fault;
  function read() {
    const config = currentBrowserConfig(api);
    const pluginConfig = api.pluginConfig || {};
    const liveEntry = config.plugins?.entries?.['browser-handoff'];
    if (liveEntry && (liveEntry.enabled === false || canonical(withDefaults(liveEntry.config || {})) !== canonical(withDefaults(pluginConfig))))
      throw new Error('Browser Handoff plugin configuration changed');
    const binding = resolveHandoffBrowser({ config, pluginConfig });
    return { config, binding, fingerprint: canonical([
      browserBindingKey(binding), config.browser.defaultProfile, pluginConfig, liveEntry,
      Object.keys(binding.profiles).sort().map(profile => [profile, config.browser.profiles[profile]]), config.browser.attachOnly,
    ]) };
  }
  return {
    pin() {
      const state = read(); pinned = state.binding; fingerprint = state.fingerprint; fault = undefined;
      return pinned;
    },
    current() {
      if (fault) throw new Error(fault);
      if (!pinned) throw new Error('Browser Handoff service browser binding is unavailable');
      try {
        const state = read();
        if (state.fingerprint !== fingerprint) throw new Error('Browser configuration changed');
        return state;
      } catch {
        fault = 'Browser Handoff current configuration changed or is unavailable; restart and reconcile the service';
        onDrift();
        throw new Error(fault);
      }
    },
  };
}

const actions = new Set(['status', 'tabs', 'open', 'focus', 'close', 'navigate', 'snapshot', 'screenshot', 'pdf', 'download', 'waitfordownload', 'console', 'errors', 'requests', 'text', 'act', 'upload', 'dialog', 'emulate']);
const routeOverrides = ['node', 'baseUrl', 'cdpUrl', 'endpoint', 'endpointUrl', 'browserUrl', 'wsEndpoint', 'browser', 'systemProfile', 'into', 'dashboard', 'cdpPort', 'executablePath', 'userDataDir', 'driver', 'engine', 'attachOnly'];
export function assertBrowserRoute(event, state) {
  const params = event.params || {};
  if (params.target !== 'host') throw new Error('Browser access requires target="host" and the configured browser profile');
  if (routeOverrides.some(key => params[key] !== undefined)) throw new Error('Browser routing overrides are unavailable; use the configured host browser profile');
  if (!actions.has(params.action)) throw new Error('Browser profile management and browser startup are unavailable');
  const profile = params.profile === undefined ? state.config.browser.defaultProfile : params.profile;
  if (!nonempty(profile) || profile.trim() !== profile || !Object.hasOwn(state.binding.profiles, profile))
    throw new Error('Only the configured host browser profile is permitted');
  return profile;
}

export function createBrowserAccessPolicy({ api, binding, assertAvailable }) {
  return {
    id: 'clawser-browser-access',
    description: 'Verified native owner turns only, confined to the pinned existing host browser and handoff automation fence',
    evaluate(event, ctx) {
      if (!browserTool(event.toolName)) return;
      const requester = ctx?.requester;
      if (requester?.senderIsOwner !== true || ![requester.senderId, requester.channel, ctx.sessionKey, ctx.sessionId, ctx.runId, ctx.toolCallId].every(nonempty) ||
          !authorizedSession(ctx.sessionKey, api.pluginConfig?.ownerGroupSessions))
        return { allow: false, reason: 'Verified owner browser access requires a complete current native invocation in an authorized conversation' };
      try {
        assertBrowserRoute(event, binding.current());
        assertAvailable();
      } catch (error) { return { allow: false, reason: error.message }; }
    },
  };
}

export function registerBrowserAccessPolicy(api, options) {
  if (typeof api.registerTrustedToolPolicy !== 'function') throw new Error('Browser Handoff requires the native registerTrustedToolPolicy SDK API');
  api.registerTrustedToolPolicy(createBrowserAccessPolicy({ api, ...options }));
}

export function monitorBrowserBinding(binding, scheduler = globalThis) {
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true; scheduler.clearInterval(timer);
  };
  const timer = scheduler.setInterval(() => {
    try { binding.current(); }
    catch { stop(); }
  }, 1000);
  timer.unref?.();
  return stop;
}
