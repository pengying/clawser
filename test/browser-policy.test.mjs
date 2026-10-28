import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as policyModule from '../src/browser-policy.mjs';

const currentConfig = () => ({ browser: { defaultProfile: 'daily', profiles: {
  daily: { cdpUrl: 'http://127.0.0.1:9222', attachOnly: true },
  other: { cdpUrl: 'http://127.0.0.1:9223', attachOnly: true },
} } });
const identity = () => ({ sessionKey: 'agent:main:googlechat:group:spaces/demo', sessionId: 'incarnation', runId: 'run', toolCallId: 'call', requester: { senderIsOwner: true, senderId: 'owner', channel: 'googlechat' } });
const event = params => ({ toolName: 'browser', params: { action: 'snapshot', target: 'host', ...params } });
function fixture() {
  let config = currentConfig(), available = true, drift = 0;
  const pluginConfig = { ownerGroupSessions: ['agent:main:googlechat:group:spaces/demo'] };
  const api = { pluginConfig, config: currentConfig(), runtime: { config: { current: () => config } } };
  const guard = policyModule.createBrowserBindingGuard(api, { onDrift: () => { drift++; } });
  guard.pin();
  const policy = policyModule.createBrowserAccessPolicy({ api, binding: guard, assertAvailable() { if (!available) throw new Error('service unavailable'); } });
  return { api, guard, policy, get config() { return config; }, set config(value) { config = value; }, set available(value) { available = value; }, get drift() { return drift; } };
}
test('verified per-turn owner can use the pinned host browser and aliases; subsequent member cannot', () => {
  const f = fixture(), ctx = identity();
  assert.equal(f.policy.id, 'clawser-browser-access');
  for (const toolName of ['browser', 'node_browser_1', 'tools.browser', 'browser_2']) assert.equal(f.policy.evaluate({ ...event(), toolName }, ctx), undefined);
  ctx.requester.senderIsOwner = false;
  const denied = f.policy.evaluate(event({ owner: true, senderIsOwner: true, requester: { senderIsOwner: true } }), ctx);
  assert.equal(denied.allow, false); assert.match(denied.reason, /owner/i); assert.doesNotMatch(denied.reason, /9222|daily/);
  assert.equal(f.policy.evaluate({ toolName: 'browser_handoff' }, {}), undefined);
});
test('native policy rejects incomplete host identity and disallowed sessions', () => {
  const f = fixture();
  for (const field of ['sessionKey', 'sessionId', 'runId', 'toolCallId']) {
    const ctx = identity(); delete ctx[field]; assert.equal(f.policy.evaluate(event(), ctx).allow, false);
  }
  for (const patch of [undefined, {}, { senderIsOwner: true, senderId: 'owner' }, { senderIsOwner: true, senderId: ' ', channel: 'googlechat' }]) assert.equal(f.policy.evaluate(event(), { ...identity(), requester: patch }).allow, false);
  for (const sessionKey of ['agent:main:googlechat:group:spaces/other', 'agent:main:subagent:child', 'agent:main:cron:job']) assert.equal(f.policy.evaluate(event(), { ...identity(), sessionKey }).allow, false);
  assert.equal(f.policy.evaluate(event(), { ...identity(), sessionKey: 'agent:main:telegram:direct:1' }), undefined);
});
test('routing is confined to the pinned host profiles and cannot select alternative browser state', () => {
  const f = fixture();
  for (const params of [{ target: undefined }, { target: 'node' }, { target: 'sandbox' }, { profile: 'other' }, { profile: 'user' }, { profile: '' }, { profile: ' daily ' }, { node: 'remote' }, { baseUrl: 'http://localhost:9999' }, { cdpUrl: 'http://localhost:9999' }, { endpoint: 'http://localhost:9999' }, { browser: 'chrome' }, { systemProfile: 'Default' }, { into: 'other' }, { dashboard: 'other' }, { action: 'start' }, { action: 'create-profile' }, { action: 'importprofile' }, { action: 'profiles' }]) {
    assert.equal(f.policy.evaluate(event(params), identity())?.allow, false, JSON.stringify(params));
  }
  for (const action of ['tabs', 'open', 'snapshot', 'act', 'navigate', 'close']) assert.equal(f.policy.evaluate(event({ action }), identity()), undefined);
});
test('current configuration API and service faults deny before native I/O without snapshot fallback', () => {
  const f = fixture(); f.available = false;
  assert.equal(f.policy.evaluate(event(), identity()).allow, false);
  f.available = true;
  for (const value of [() => { throw new Error('offline'); }, () => ({}), undefined]) {
    f.api.runtime.config.current = value; assert.equal(f.policy.evaluate(event(), identity()).allow, false);
  }
});
test('default, endpoint and eligibility drift invalidate one service generation permanently', () => {
  for (const mutate of [config => { config.browser.defaultProfile = 'other'; }, config => { config.browser.profiles.daily.cdpUrl = 'http://127.0.0.1:9555'; }, config => { config.browser.profiles.daily.attachOnly = false; }]) {
    const f = fixture(); mutate(f.config);
    assert.equal(f.policy.evaluate(event(), identity()).allow, false); assert.equal(f.drift, 1);
    f.config = currentConfig(); assert.equal(f.policy.evaluate(event(), identity()).allow, false); assert.equal(f.drift, 1);
  }
});
test('missing profile follows native current default even for explicit noVNC profile selection', () => {
  const f = fixture(); f.api.pluginConfig.desktop = { enabled: true, profile: 'other' }; f.guard.pin();
  assert.equal(f.policy.evaluate(event(), identity()).allow, false);
  assert.equal(f.policy.evaluate(event({ profile: 'other' }), identity()), undefined);
});

test('plugin manifest declares the trusted policy capability for normal native acceptance', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.contracts.trustedToolPolicies, ['clawser-browser-access']);
  assert.doesNotMatch(manifest.configSchema.properties.desktop.description, /Legacy tab sharing is the default/);
});
test('live plugin settings compare with SDK schema defaults and still detect changed operator settings', () => {
  const f = fixture();
  f.api.pluginConfig = { port: 18796, ownerGroupSessions: [], desktop: { enabled: false }, funnel: { enabled: false, httpsPort: 10000 }, cloudflare: { enabled: false, startupTimeoutMs: 90000 } };
  f.config.plugins = { entries: { 'browser-handoff': { enabled: true, config: { desktop: {}, funnel: {}, cloudflare: {} } } } };
  assert.doesNotThrow(() => f.guard.pin());
  const ctx = { ...identity(), sessionKey: 'agent:main:telegram:direct:1' };
  assert.equal(f.policy.evaluate(event(), ctx), undefined);
  f.config.plugins.entries['browser-handoff'].config.port = 19999;
  assert.equal(f.policy.evaluate(event(), ctx).allow, false); assert.equal(f.drift, 1);
});
test('removing or disabling the current plugin entry retires its pinned generation', () => {
  for (const remove of [entries => { delete entries['browser-handoff']; }, entries => { entries['browser-handoff'].enabled = false; }]) {
    const f = fixture();
    f.config.plugins = { entries: { 'browser-handoff': { enabled: true, config: f.api.pluginConfig } } };
    f.guard.pin(); remove(f.config.plugins.entries);
    assert.equal(f.policy.evaluate(event(), identity())?.allow, false);
    assert.equal(f.drift, 1);
  }
});
test('binding monitor checks at one-second intervals and stops once a generation is invalidated', () => {
  const f = fixture(); let tick, scheduled = 0, cleared = 0;
  const stop = policyModule.monitorBrowserBinding(f.guard, { setInterval(callback, ms) { tick = callback; scheduled++; assert.equal(ms, 1000); return { unref() {} }; }, clearInterval() { cleared++; } });
  assert.equal(scheduled, 1); tick(); assert.equal(cleared, 0);
  f.config.browser.defaultProfile = 'other'; tick(); assert.equal(f.drift, 1); assert.equal(cleared, 1);
  stop(); assert.equal(cleared, 1);
});
test('native page-text reads remain available on the pinned existing host connection', () => {
  const f = fixture();
  assert.equal(f.policy.evaluate(event({ action: 'text' }), identity()), undefined);
});

test('preparation snapshots intended host settings while mismatching current config stays unarmed and retryable', () => {
  const f = fixture(); f.api.config = structuredClone(f.config);
  f.api.config.plugins = { entries: { 'browser-handoff': { enabled: true, config: f.api.pluginConfig } } };
  f.config.plugins = { entries: { 'browser-handoff': { enabled: false, config: f.api.pluginConfig } } };
  const prepared = f.guard.prepare();
  assert.equal(Object.isFrozen(prepared.config.browser.profiles), true);
  assert.equal(f.guard.matches(prepared), false); assert.equal(f.drift, 0);
  f.config.plugins.entries['browser-handoff'].enabled = true;
  assert.equal(f.guard.matches(prepared), true); assert.doesNotThrow(() => f.guard.pin(prepared));
  assert.equal(f.guard.current().binding.profile, 'daily');
});
