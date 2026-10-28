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

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
export function browserConfigurationState(config, pluginConfig = {}, { requireEnabledEntry = false } = {}) {
  const liveEntry = config?.plugins?.entries?.['browser-handoff'];
  if (requireEnabledEntry && liveEntry?.enabled !== true) throw new Error('Browser Handoff requires an explicitly enabled current plugin entry');
  const normalized = withDefaults(pluginConfig);
  if (liveEntry && (liveEntry.enabled === false || canonical(withDefaults(liveEntry.config || {})) !== canonical(normalized)))
    throw new Error('Browser Handoff plugin configuration changed or is disabled');
  const binding = resolveHandoffBrowser({ config, pluginConfig });
  return { config, binding, fingerprint: canonical([
    browserBindingKey(binding), config.browser.defaultProfile, normalized,
    liveEntry ? { enabled: liveEntry.enabled !== false, config: withDefaults(liveEntry.config || {}) } : null,
    Object.keys(binding.profiles).sort().map(profile => [profile, config.browser.profiles[profile]]), config.browser.attachOnly,
  ]) };
}
export function prepareBrowserConfiguration({ config, pluginConfig = {}, requireEnabledEntry = false }) {
  const initial = browserConfigurationState(config, pluginConfig, { requireEnabledEntry });
  const entry = config.plugins?.entries?.['browser-handoff'];
  // Preparation retains only immutable browser binding inputs, never unrelated
  // channel/provider credentials from the host registration snapshot.
  const snapshot = structuredClone({ pluginConfig, config: {
    browser: { enabled: config.browser.enabled, defaultProfile: config.browser.defaultProfile, attachOnly: config.browser.attachOnly,
      profiles: Object.fromEntries(Object.keys(initial.binding.profiles).map(profile => [profile, config.browser.profiles[profile]])) },
    ...(entry ? { plugins: { entries: { 'browser-handoff': { enabled: entry.enabled, config: entry.config } } } } : {}),
  } });
  return freeze({ ...browserConfigurationState(snapshot.config, snapshot.pluginConfig, { requireEnabledEntry }), pluginConfig: snapshot.pluginConfig, requireEnabledEntry });
}

// Intended registration settings can be prepared before native hot activation
// commits them. Only pinning a fresh matching runtime read grants authority.
export function createBrowserBindingGuard(api, { onDrift = () => {} } = {}) {
  let pinned, fingerprint, fault, requireEnabledEntry = false;
  const read = (required = requireEnabledEntry) => browserConfigurationState(currentBrowserConfig(api), api.pluginConfig || {}, { requireEnabledEntry: required });
  return {
    prepare() {
      let supported;
      try { supported = typeof api.runtime?.config?.current === 'function'; } catch { /* unavailable runtime */ }
      if (!supported) throw new Error('Current browser configuration API is unavailable');
      return prepareBrowserConfiguration({ config: api.config, pluginConfig: api.pluginConfig, requireEnabledEntry: true });
    },
    matches(prepared) {
      try { return read(prepared.requireEnabledEntry).fingerprint === prepared.fingerprint; } catch { return false; }
    },
    pin(prepared) {
      const state = read(prepared?.requireEnabledEntry);
      if (prepared && state.fingerprint !== prepared.fingerprint) throw new Error('Browser Handoff is awaiting configuration publication');
      pinned = state.binding; fingerprint = state.fingerprint; fault = undefined; requireEnabledEntry = prepared?.requireEnabledEntry === true;
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
        assertAvailable();
        assertBrowserRoute(event, binding.current());
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
