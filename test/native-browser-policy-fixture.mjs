import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import { HandoffServer } from '../src/server.mjs';

// Run: node test/native-browser-policy-fixture.mjs /path/to/openclaw/dist
// Real native registry, policy wrapper and browser configuration resolver.
// All state is disposable, backend browser I/O is a counter, and no CDP
// endpoint is contacted. The production plugin registers its actual policy.
const dist = path.resolve(process.argv[2]);
const pluginPath = fileURLToPath(new URL('../index.mjs', import.meta.url));
const { createPlugin } = await import(pathToFileURL(pluginPath));
const pluginConfig = { port: 0, ownerGroupSessions: ['agent:fixture:googlechat:channel:fixture'] };
let currentConfig = { browser: { defaultProfile: 'daily', profiles: { daily: { driver: 'openclaw', attachOnly: true, cdpUrl: 'http://127.0.0.1:9222' }, other: { attachOnly: true, cdpUrl: 'http://127.0.0.1:9223' } } } };
currentConfig.plugins = { entries: { 'browser-handoff': { enabled: true, config: pluginConfig } } };
let currentAvailable = true;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawser-owner-policy-native-'));
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: path.join(stateDir, 'openclaw.json'),
  OPENCLAW_SKIP_CHANNELS: '1',
});
fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, '{}');
async function nativeExport(name, prefix) {
  for (const file of fs.readdirSync(dist).filter(file => file.startsWith(prefix) && file.endsWith('.mjs'))) {
    const source = fs.readFileSync(path.join(dist, file), 'utf8');
    const alias = source.match(new RegExp(`\\b${name} as ([A-Za-z_$][A-Za-z0-9_$]*)[, }]`))?.[1];
    if (alias) return (await import(pathToFileURL(path.join(dist, file))))[alias];
  }
  throw new Error(`Missing native export ${name}`);
}
const resolveBrowserConfig = await nativeExport('resolveBrowserConfig', 'config-');
const resolveProfile = await nativeExport('resolveProfile', 'config-');
const createRegistry = await nativeExport('createPluginRegistry', 'registry-');
const initialize = await nativeExport('initializeGlobalHookRunner', 'hook-runner-global-');
const getHookRunner = await nativeExport('getGlobalHookRunner', 'hook-runner-global-');
const wrap = await nativeExport('wrapToolWithBeforeToolCallHook', 'agent-tools.before-tool-call');
const summarize = await nativeExport('buildPluginCapabilitySummary', 'capability-summary-');
const diff = await nativeExport('diffDeclaredSurfaceWidening', 'capability-summary-');
const hash = await nativeExport('computeDeclaredSurfaceHash', 'capability-summary-');
const acceptedCurrent = await nativeExport('resolveAcceptedSurfaceCurrent', 'capability-summary-');
const resolveHttpOwner = await nativeExport('resolveOpenAiCompatibleHttpSenderIsOwner', 'http-auth-utils-');
const applyToolChoice = await nativeExport('applyToolChoice', 'openai-');
const administrativeOwner = resolveHttpOwner({ headers: {} }, { authMethod: 'token' });
assert.equal(administrativeOwner, true, 'native authenticated shared-secret administrative scopes establish HTTP owner authority');
assert.equal(resolveHttpOwner({ headers: {} }, { authMethod: 'device-token', trustDeclaredOperatorScopes: false }), false);
assert.deepEqual(applyToolChoice([{ type: 'function', function: { name: 'client_fixture' } }], 'none').tools, []);
let buildRequester, nativeRequesterConstruction = 'exported-harness-builder';
try { buildRequester = await nativeExport('buildHarnessHostRequester', 'agent-tools-'); }
catch (error) {
  // 10.4 constructs this host context inline rather than exporting its builder.
  // Check its actual source shape before constructing the synthetic attempt.
  const source = fs.readdirSync(dist).filter(name => /^agent-tools-.*\.mjs$/.test(name)).map(name => fs.readFileSync(path.join(dist, name), 'utf8')).find(text => text.includes('const requester = {'));
  assert.ok(source?.includes('...turnSourceChannel ? { channel: turnSourceChannel } : {}'));
  assert.ok(source?.includes('...options?.senderId ? { senderId: options.senderId } : {}'));
  assert.ok(source.includes('...options?.senderIsOwner !== void 0 ? { senderIsOwner: options.senderIsOwner } : {}'));
  buildRequester = attempt => ({ channel: attempt.messageChannel, senderIsOwner: attempt.senderIsOwner });
  nativeRequesterConstruction = 'verified-10.4-inline-source';
}
const administrativeRequester = buildRequester({ messageChannel: 'webchat', senderIsOwner: administrativeOwner });
assert.equal('senderId' in administrativeRequester, false);
const registryParams = {
  runtime: {config: {current: () => { if (!currentAvailable) throw new Error('fixture config unavailable'); return currentConfig; }}},
  coreGatewayMethodNames: [],
  logger: {info() {}, warn() {}, error() {}, debug() {}},
};
const policyId = 'clawser-browser-access';
const record = {
  id: 'browser-handoff', name: 'Fixture', source: path.join(stateDir, 'index.mjs'),
  cliCommands: [], toolNames: [], hookNames: [], services: [], hookCount: 0,
  origin: 'config', enabled: true, explicitlyEnabled: true,
  contracts: {tools: ['browser_handoff'], trustedToolPolicies: [policyId]},
};
const browserTool = name => /(?:^|[.:_])browser(?:_\d+)?$/.test(name || '');
let failEvaluation = false;
const observed = [];
let actualPolicy;
const policy = { id: policyId, description: 'Actual Clawser native browser policy fixture', evaluate(event, ctx) {
  observed.push({contextKeys: Object.keys(ctx).sort(), requesterKeys: Object.keys(ctx.requester || {}).sort(), owner: ctx.requester?.senderIsOwner});
  if (failEvaluation) throw new Error('fixture policy error');
  return actualPolicy.evaluate(event, ctx);
} };
for (const bad of [
  {...record, contracts: {}},
  {...record, explicitlyEnabled: false},
]) {
  const r = createRegistry(registryParams);
  r.registry.plugins.push(bad);
  r.registerTrustedToolPolicy(bad, policy);
  assert.equal(r.registry.trustedToolPolicies.length, 0);
  assert.equal(r.registry.diagnostics.some(d => d.level === 'error'), true);
}
const r = createRegistry(registryParams);
r.registry.plugins.push(record);
const services = [];
const api = r.createApi(record, {config: currentConfig, pluginConfig, registrationMode: 'full'});
const originalRegisterPolicy = api.registerTrustedToolPolicy.bind(api);
api.registerTrustedToolPolicy = value => { actualPolicy = value; originalRegisterPolicy(policy); };
api.registerService = value => services.push(value);
let server;
createPlugin({ backendFactory: () => ({list: async () => []}), serverFactory: options => server = new HandoffServer(options) }).register(api);
await services[0].start();
assert.equal(r.registry.trustedToolPolicies.length, 1);
assert.deepEqual(r.registry.diagnostics, []);
initialize(r.registry);
let browserIo = 0;
const cases = [
  {label: 'nonowner-spoofed-params', owner: false, expected: 0},
  {label: 'owner', owner: true, expected: 1},
  {label: 'missing-requester', expected: 0},
  {label: 'next-nonowner-same-session', owner: false, expected: 0},
  {label: 'nonowner-browser-alias', owner: false, name: 'node_browser_1', expected: 0},
  {label: 'owner-missing-sender', owner: true, missingSender: true, expected: 0},
  {label: 'administrative-http-main', administrative: true, expected: 1},
  {label: 'next-nonowner-family-turn-after-admin', owner: false, expected: 0},
  {label: 'administrative-http-matching-host-channel', administrative: true, channelId: 'webchat', expected: 1},
  {label: 'administrative-http-contradictory-host-channel', administrative: true, channelId: 'googlechat', expected: 0},
  {label: 'administrative-http-group', administrative: true, sessionKey: 'agent:fixture:googlechat:channel:fixture', expected: 0},
  {label: 'administrative-http-main-thread', administrative: true, sessionKey: 'agent:fixture:main:thread:fixture', expected: 0},
  {label: 'administrative-http-telegram-without-id', administrative: true, channel: 'telegram', sessionKey: 'agent:fixture:telegram:direct:fixture', expected: 0},
  {label: 'administrative-http-missing-owner', administrative: true, missingOwner: true, expected: 0},
  {label: 'administrative-http-nonowner', administrative: true, administrativeOwner: false, expected: 0},
  ...[undefined, null, '', ' ', 42, {}].map((senderId, index) => ({label: 'administrative-http-malformed-sender-' + index, administrative: true, senderId, expected: 0})),
  {label: 'administrative-http-missing-run', administrative: true, missingLifecycle: 'runId', expected: 0},
  {label: 'administrative-http-missing-session-incarnation', administrative: true, missingLifecycle: 'sessionId', expected: 0},
  {label: 'administrative-http-missing-call', administrative: true, missingToolCallId: true, expected: 0},
  {label: 'administrative-http-other-profile', administrative: true, params: {profile: 'other'}, expected: 0},
  {label: 'administrative-http-node-route', administrative: true, params: {target: 'node'}, expected: 0},
  {label: 'administrative-http-alternate-cdp', administrative: true, params: {cdpUrl: 'http://localhost:9444'}, expected: 0},
  {label: 'administrative-http-fenced', administrative: true, fenced: true, expected: 0},
  {label: 'administrative-http-pending-activation', administrative: true, pending: true, expected: 0},
  {label: 'administrative-http-after-published-activation', administrative: true, reset: true, expected: 1},
  {label: 'owner-node-route', owner: true, params: {target: 'node'}, expected: 0},
  {label: 'owner-sandbox-route', owner: true, params: {target: 'sandbox'}, expected: 0},
  {label: 'owner-unconfigured-user-profile', owner: true, params: {profile: 'user'}, expected: 0},
  {label: 'owner-other-profile', owner: true, params: {profile: 'other'}, expected: 0},
  {label: 'owner-implicit-target', owner: true, params: {target: undefined}, expected: 0},
  {label: 'owner-alternate-cdp', owner: true, params: {cdpUrl: 'http://localhost:9444'}, expected: 0},
  {label: 'owner-policy-evaluation-error', owner: true, throw: true, expected: 0},
  {label: 'owner-current-default-drift', owner: true, changeDefault: true, expected: 0},
  {label: 'owner-current-endpoint-drift', owner: true, reset: true, changeEndpoint: true, expected: 0},
  {label: 'owner-config-current-failure', reset: true, owner: true, unavailable: true, expected: 0},
  {label: 'restored-config-cannot-revive-generation', owner: true, expected: 0},
  {label: 'administrative-http-retired-generation', administrative: true, expected: 0},
];
const results = [];
for (const test of cases) {
  if (test.reset) {
    await services[0].stop();
    currentAvailable = true; currentConfig.browser.defaultProfile = 'daily'; currentConfig.browser.profiles.daily.cdpUrl = 'http://127.0.0.1:9222';
    currentConfig.plugins.entries['browser-handoff'].enabled = true; api.config = currentConfig;
    await services[0].start();
  }
  if (test.pending) {
    await services[0].stop(); api.config = structuredClone(currentConfig);
    currentConfig.plugins.entries['browser-handoff'].enabled = false;
    await services[0].start();
  }
  if (test.changeDefault) currentConfig.browser.defaultProfile = 'other';
  if (test.changeEndpoint) currentConfig.browser.profiles.daily.cdpUrl = 'http://127.0.0.1:9555';
  const ctx = {
    agentId: 'fixture', sessionKey: 'agent:fixture:googlechat:channel:fixture',
    sessionId: 'same-shared-session', runId: `run-${results.length}`, config: {},
    ...(test.owner === undefined ? {} : {requester: Object.freeze({
      channel: 'googlechat', accountId: 'fixture-account',
      ...(test.missingSender ? {} : {senderId: test.owner ? 'fixture-owner' : 'fixture-member'}),
      senderIsOwner: test.owner,
    })}),
  };
  if (test.administrative) {
    ctx.sessionKey = test.sessionKey ?? 'agent:fixture:main';
    ctx.requester = { ...administrativeRequester, ...(test.channel ? { channel: test.channel } : {}), ...(Object.hasOwn(test, 'administrativeOwner') ? { senderIsOwner: test.administrativeOwner } : {}) };
    if (test.missingOwner) delete ctx.requester.senderIsOwner;
    if (Object.hasOwn(test, 'senderId')) ctx.requester.senderId = test.senderId;
    if (test.channelId) ctx.channelId = test.channelId;
    if (test.missingLifecycle) delete ctx[test.missingLifecycle];
    Object.freeze(ctx.requester);
  }
  const fake = {
    name: test.name || 'browser', description: 'No-network browser fixture', parameters: {type: 'object'},
    async execute(_id, params) {
      const resolved = resolveBrowserConfig(currentConfig.browser, currentConfig);
      const effective = params.profile ?? resolved.defaultProfile;
      const nativeProfile = resolveProfile(resolved, effective);
      assert.equal(effective, 'daily', 'native executor effective profile must agree with pinned policy');
      assert.equal(nativeProfile.cdpUrl.replace(/\/$/, ''), 'http://127.0.0.1:9222', 'native executor endpoint must agree with pin');
      assert.equal(nativeProfile.attachOnly, true); assert.equal(params.target, 'host'); browserIo++; return {content: [{type: 'text', text: 'fixture'}], details: {fixture: true}}; },
  };
  failEvaluation = test.throw === true;
  currentAvailable = test.unavailable !== true;
  const before = browserIo;
  if (test.fenced) await server.store.gate.acquire('fixture-human');
  const toolCallId = test.missingToolCallId ? '' : `call-${results.length}`;
  await wrap(fake, ctx, {emitDiagnostics: false}).execute(toolCallId, {
    action: 'tabs', target: 'host', owner: true, senderIsOwner: true, ...test.params,
  });
  // The real agent runtime pairs the before-wrapper with its after hook. Keep
  // fixture admissions paired too; no direct gate clearing or bypass is used.
  await getHookRunner().runAfterToolCall({ toolName: fake.name, toolCallId }, { ...ctx, toolCallId });
  if (test.fenced) server.store.gate.release('fixture-human');
  assert.equal(browserIo - before, test.expected, test.label);
  results.push({case: test.label, browserIo: browserIo - before});
}
const oldDeclared = summarize({manifest: {id: record.id, contracts: {tools: ['browser_handoff']}}}).declared;
const newDeclared = summarize({manifest: {id: record.id, contracts: {tools: ['browser_handoff'], trustedToolPolicies: [policyId]}}}).declared;
assert.deepEqual(diff(oldDeclared, newDeclared).widened.contracts, [`trustedToolPolicies: ${policyId}`]);
assert.equal(acceptedCurrent({acceptedSurface: oldDeclared, acceptedSurfaceHash: hash(oldDeclared)}, newDeclared), false);
assert.equal(acceptedCurrent({acceptedSurface: newDeclared, acceptedSurfaceHash: hash(newDeclared)}, newDeclared), true);
await services[0].stop();
fs.rmSync(stateDir, {recursive: true, force: true});
console.log(JSON.stringify({actualPlugin: pluginPath, host: dist, passed: true, browserIo, results, observed, administrativeOwnerDerivedFromNativeScopes: true, nativeRequesterConstruction, clientToolChoiceNoneVerified: true, contractDeclarationAccepted: true, undeclaredRejected: true, implicitEnableRejected: true, oldCapabilityAcceptanceInvalidated: true, stateDir}, null, 2));
