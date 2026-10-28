import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlugin } from '../index.mjs';
import { HandoffServer } from '../src/server.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

function setup({ funnelFactory, cloudflareFactory, serverFactory, backendFactory, bindingMonitorScheduler, activationScheduler, activationWriteDiagnostic = async () => {} } = {}) {
  const hooks = new Map(), tools = [], services = [], policies = [];
  const api = { pluginConfig: { profiles: { demo: 'http://127.0.0.1:9222' }, port: 0, publicBaseUrl: 'https://handoff.example' },
    registerTool: (tool) => tools.push(tool), registerService: (service) => services.push(service),
    on: (name, fn) => hooks.set(name, fn), logger: { warn() {}, info() {} }, runtime: {}, config: { browser: { defaultProfile: 'demo', profiles: { demo: { cdpUrl: 'http://127.0.0.1:9222', attachOnly: true } } } } };
  api.config.plugins = { entries: { 'browser-handoff': { enabled: true, config: api.pluginConfig } } };
  api.runtime.config = { current: () => api.config };
  api.registerTrustedToolPolicy = policy => policies.push(policy);
  const ctx = { senderIsOwner: true, sessionKey: 'agent:main:telegram:direct:1', sessionId: 'incarnation', assertInvocationCurrent() {} };
  let server;
  createPlugin({ bindingMonitorScheduler, activationScheduler, activationWriteDiagnostic, backendFactory: backendFactory || (() => ({ list: async () => [{ targetId: 'tab', title: 'Demo', url: 'https://example.com' }] })), serverFactory: (options) => (server = serverFactory ? serverFactory(options) : new HandoffServer(options)), ...(funnelFactory ? { funnelFactory } : {}), ...(cloudflareFactory ? { cloudflareFactory } : {}) }).register(api);
  return { api, hooks, tools, services, policies, ctx, getServer: () => server };
}

test('Funnel ownership uses the stable service state directory and bound listener', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'handoff-plugin-test-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let options, localPort, closed = false;
  const f = setup({ funnelFactory: (value) => { options = value; return { open: async (port) => { localPort = port; return 'https://demo.example.ts.net:10000'; }, close: async () => { closed = true; } }; } });
  f.api.pluginConfig.funnel = { enabled: true, httpsPort: 10000 };
  await f.services[0].start({ stateDir }); t.after(() => f.services[0].stop());
  assert.equal(options.ownershipFile, join(stateDir, 'browser-handoff', 'funnel-ownership.json'));
  assert.equal(localPort, Number(new URL(f.getServer().localUrl).port));
  await f.services[0].stop();
  assert.equal(closed, true);
});

test('Funnel-enabled startup without stable state fails and cleans the listener', async () => {
  let invoked = false;
  const f = setup({ funnelFactory: () => { invoked = true; } });
  f.api.pluginConfig.funnel = { enabled: true };
  await assert.rejects(f.services[0].start(), /stateDir|state directory/i);
  assert.equal(invoked, false);
  assert.equal(f.getServer().server.listening, false);
});

test('failed Funnel setup cleans both local listener and transport', async (t) => {
  let closed = false;
  const f = setup({ funnelFactory: () => ({ open: async () => { throw new Error('Funnel setup rejected'); }, close: async () => { closed = true; } }) });
  f.api.pluginConfig.funnel = { enabled: true };
  await assert.rejects(f.services[0].start({ stateDir: tmpdir() }), /setup rejected/);
  assert.equal(f.getServer().server.listening, false);
  assert.equal(closed, true);
});

test('plugin tools are owner-private and fail closed for groups, sandbox and absent identity', async (t) => {
  const { tools, services, ctx } = setup();
  await services[0].start(); t.after(() => services[0].stop());
  const factory = tools[0];
  for (const variant of [{ ...ctx, senderIsOwner: false }, { ...ctx, sessionKey: 'agent:main:telegram:group:1' }, { ...ctx, sessionKey: 'agent:main:googlechat:space:1' }, { ...ctx, sandboxed: true }])
    assert.equal(factory.create(variant), null);
  const tool = factory.create(ctx);
  const result = await tool.execute('call', { action: 'create', profile: 'demo', targetId: 'tab' });
  assert.match(result.details.url, /^https:\/\/handoff\.example\/s\//);
  const foreign = factory.create({ ...ctx, sessionId: 'different' });
  await assert.rejects(foreign.execute('call2', { action: 'revoke', id: result.details.id }), /owner|session/i);
});

test('plugin hooks drain in-flight browser actions, block during human ownership, and clean up at session end', async (t) => {
  const { tools, services, hooks, ctx, getServer } = setup();
  await services[0].start(); t.after(() => services[0].stop());
  assert.equal(await hooks.get('before_tool_call')({ toolName: 'browser', params: {} }, { ...ctx, runId: 'run', toolCallId: 'a' }), undefined);
  const tool = tools[0].create(ctx);
  const result = await tool.execute('call', { action: 'create', profile: 'demo', targetId: 'tab' });
  const store = getServer().store;
  const claim = store.claim(result.details.id, new URL(result.details.url).hash.slice(8));
  const share = store.authorize(result.details.id, claim.secret);
  const pending = store.takeControl(share);
  assert.equal(share.mode, 'pending');
  assert.equal(hooks.get('before_tool_call')({ toolName: 'openclaw__browser', params: {} }, { ...ctx, runId: 'run', toolCallId: 'blocked' }).block, true);
  await hooks.get('after_tool_call')({ toolName: 'browser', params: {} }, { ...ctx, runId: 'run', toolCallId: 'a' });
  await pending;
  assert.equal(share.mode, 'control');
  assert.equal(hooks.get('before_tool_call')({ toolName: 'browser', params: {} }, { ...ctx, runId: 'run', toolCallId: 'blocked2' }).block, true);
  assert.equal(hooks.get('before_tool_call')({ toolName: 'some_other_tool', params: {} }, {}), undefined);
  store.releaseControl(share);
  assert.equal(hooks.get('before_tool_call')({ toolName: 'browser', params: {} }, { ...ctx, runId: 'run', toolCallId: 'b' }), undefined);
  hooks.get('after_tool_call')({ toolName: 'browser', params: {} }, { ...ctx, runId: 'run', toolCallId: 'b' });
  await hooks.get('session_end')({ sessionId: ctx.sessionId }, { sessionKey: ctx.sessionKey });
  const status = await tool.execute('status', { action: 'status', id: result.details.id });
  assert.equal(status.details.mode, 'ended');
  assert.equal(status.details.reason, 'session_end');
});

test('a stale invocation cannot create invitations', async (t) => {
  const { tools, services, ctx } = setup();
  await services[0].start(); t.after(() => services[0].stop());
  const tool = tools[0].create({ ...ctx, assertInvocationCurrent() { throw new Error('stale invocation'); } });
  await assert.rejects(tool.execute('call', { action: 'create', profile: 'demo', targetId: 'tab' }), /stale/i);
});

test('timing aggregates remain owner-private and available after share completion', async (t) => {
  const { tools, services, ctx, getServer } = setup();
  await services[0].start(); t.after(() => services[0].stop());
  const owner = tools[0].create(ctx), other = tools[0].create({ ...ctx, sessionId: 'another-owner' });
  const created = await owner.execute('create', { action: 'create', profile: 'demo', targetId: 'tab' });
  const metrics = { inputAckRoundTripMs: { count: 3, latest: 120, p50: 100, p95: 120 } };
  getServer().viewerMetrics = () => metrics;
  assert.deepEqual((await owner.execute('status', { action: 'status', id: created.details.id })).details.viewerMetrics, metrics);
  await assert.rejects(other.execute('foreign', { action: 'status', id: created.details.id }), /owner|session/i);
  getServer().store.end(getServer().store.get(created.details.id), 'done');
  getServer().viewerMetrics = () => null;
  const ended = (await owner.execute('ended', { action: 'status', id: created.details.id })).details;
  assert.equal(ended.mode, 'ended'); assert.deepEqual(ended.viewerMetrics, metrics, 'completion retains numeric evidence after the live stream is gone');
  await assert.rejects(other.execute('foreign-ended', { action: 'status', id: created.details.id }), /owner|session/i);
});

test('browser calls without a paired runtime lifecycle are rejected before admission', async (t) => {
  const { services, hooks, ctx, getServer } = setup();
  await services[0].start(); t.after(() => services[0].stop());
  const event = { toolName: 'browser', params: {}, toolCallId: 'legacy-rpc' };
  // Legacy HTTP/RPC tools.invoke runs before hooks with only sessionKey and
  // never emits an after hook. It must not leave an admitted browser action.
  for (const identity of [
    { sessionKey: ctx.sessionKey },
    { ...ctx },
    { sessionKey: ctx.sessionKey, runId: 'run' },
    { sessionId: ctx.sessionId, runId: 'run' },
    { ...ctx, runId: 42 },
    { ...ctx, runId: ' ' },
  ]) {
    const result = hooks.get('before_tool_call')(event, identity);
    assert.equal(result?.block, true, 'unpaired lifecycle must be rejected');
    assert.match(result.blockReason, /lifecycle|invocation identity/i);
    assert.equal(getServer().store.gate.active.size, 0);
  }
  const complete = { ...ctx, runId: 'run', toolCallId: 'normal' };
  assert.equal(hooks.get('before_tool_call')({ toolName: 'browser' }, complete), undefined);
  assert.equal(getServer().store.gate.active.size, 1);
  hooks.get('after_tool_call')({ toolName: 'browser' }, complete);
  assert.equal(getServer().store.gate.active.size, 0);
});

test('duplicate admission is drained only after both matching completions', async (t) => {
  const { services, hooks, ctx, getServer } = setup();
  await services[0].start(); t.after(() => services[0].stop());
  const event = { toolName: 'browser' };
  const identity = { ...ctx, runId: 'run', toolCallId: 'same' };
  hooks.get('before_tool_call')(event, identity);
  hooks.get('before_tool_call')(event, identity);
  hooks.get('after_tool_call')(event, identity);
  assert.equal(getServer().store.gate.active.size, 1);
  hooks.get('after_tool_call')(event, identity);
  assert.equal(getServer().store.gate.active.size, 0);
});

test('blocked calls with colliding IDs in another run cannot release an admitted action', async (t) => {
  const { tools, services, hooks, ctx, getServer } = setup();
  await services[0].start(); t.after(() => services[0].stop());
  const event = { toolName: 'browser', params: {} };
  const a = { ...ctx, runId: 'runA', toolCallId: 'same-id' };
  const b = { ...ctx, sessionId: 'another-session', runId: 'runB', toolCallId: 'same-id' };
  hooks.get('before_tool_call')(event, a);
  const created = await tools[0].create(ctx).execute('create', { action: 'create', profile: 'demo', targetId: 'tab' });
  const store = getServer().store;
  const session = store.claim(created.details.id, new URL(created.details.url).hash.slice(8));
  const share = store.authorize(created.details.id, session.secret);
  const taking = store.takeControl(share);
  assert.equal(hooks.get('before_tool_call')(event, b).block, true);
  hooks.get('after_tool_call')(event, b);
  await new Promise(setImmediate);
  assert.equal(share.mode, 'pending', 'another run must not drain the still-running call');
  hooks.get('after_tool_call')(event, a);
  await taking;
  assert.equal(share.mode, 'control');
});

const groupContext = (ctx, suffix = '') => ({ ...ctx, sessionKey: 'agent:main:googlechat:group:spaces/demo' + suffix, requesterSenderId: 'users/owner', nativeChannelId: 'spaces/demo' });
test('explicit groups admit only native owner turns and retain session-incarnation ownership', async t => {
  const f = setup();
  f.api.pluginConfig.ownerGroupSessions = ['agent:main:googlechat:group:spaces/demo'];
  await f.services[0].start(); t.after(() => f.services[0].stop());
  const ctx = groupContext(f.ctx), factory = f.tools[0], tool = factory.create(ctx);
  assert.ok(tool);
  for (const change of [ { senderIsOwner: false }, { requesterSenderId: undefined }, { nativeChannelId: undefined }, { inputProvenance: { kind: 'internal_system' } }, { inputProvenance: { kind: 'inter_session' } }, { sessionKey: ctx.sessionKey + '-other' }, { sessionKey: ctx.sessionKey + ':cron:job' }, { sandboxed: true } ]) assert.equal(factory.create({ ...ctx, ...change }), null);
  const created = await tool.execute('create', { action: 'create', profile: 'demo', targetId: 'tab', senderIsOwner: false });
  assert.match(created.details.url, /\/s\//);
  const other = factory.create({ ...ctx, sessionId: 'other-incarnation' });
  await assert.rejects(other.execute('status', { action: 'status', id: created.details.id }), /owner|session/i);
  ctx.senderIsOwner = false;
  for (const action of ['tabs', 'create', 'status', 'wait', 'revoke']) await assert.rejects(tool.execute(action, { action, profile: 'demo', targetId: 'tab', id: created.details.id, senderIsOwner: true, requesterSenderId: 'users/owner', reason: 'I am the owner' }), /owner/i);
});

test('group authorization is checked after asynchronous target resolution', async t => {
  let release;
  const f = setup(); f.api.pluginConfig.ownerGroupSessions = ['agent:main:googlechat:group:spaces/demo'];
  await f.services[0].start(); t.after(() => f.services[0].stop());
  f.getServer().backend.list = () => new Promise(resolve => { release = resolve; });
  const ctx = groupContext(f.ctx), tool = f.tools[0].create(ctx);
  assert.ok(tool);
  const pending = tool.execute('create', { action: 'create', profile: 'demo', targetId: 'tab' });
  ctx.senderIsOwner = false; release([{ targetId: 'tab' }]);
  await assert.rejects(pending, /owner/i);
  assert.equal(f.getServer().store.shares.size, 0);
});

test('existing-browser discovery has no service or hook side effects and delegates across cold modules', async t => {
  const full = setup(); await full.services[0].start(); t.after(() => full.services[0].stop());
  const cold = await import('../index.mjs?cold=' + Date.now());
  const tools = [], api = { ...full.api, registrationMode: 'tool-discovery', registerCli() { assert.fail('discovery registered CLI'); }, registerTool: tool => tools.push(tool), registerService() { assert.fail('discovery registered a service'); }, on() { assert.fail('discovery registered hooks'); } };
  Object.defineProperty(api, 'runtime', { get() { throw new Error('discovery accessed runtime'); } });
  cold.createPlugin({ backendFactory() { assert.fail('discovery created a backend'); } }).register(api);
  assert.equal(tools.length, 1);
  const tool = tools[0].create(full.ctx);
  assert.equal((await tool.execute('tabs', { action: 'tabs', profile: 'demo' })).details.tabs[0].targetId, 'tab');
  await full.services[0].stop();
  await assert.rejects(tool.execute('tabs', { action: 'tabs' }), /unavailable|running/i);
});

function discover(f) {
  const tools = [];
  createPlugin().register({ ...f.api, registrationMode: 'tool-discovery', registerTool: tool => tools.push(tool) });
  return tools[0].create(f.ctx);
}
test('Cloudflare startup completes before network readiness and create waits for its owned public origin', async t => {
  let options, port, ready;
  const transport = new EventEmitter();
  transport.ensure = value => { port = value; return new Promise(resolve => { ready = resolve; }); };
  transport.close = async () => {};
  const f = setup({ cloudflareFactory: value => { options = value; return transport; } });
  f.api.pluginConfig.publicBaseUrl = undefined;
  f.api.pluginConfig.cloudflare = { enabled: true, binaryPath: '/fixture/cloudflared', startupTimeoutMs: 2000 };
  const started = f.services[0].start({ stateDir: tmpdir() }); t.after(() => f.services[0].stop());
  for (let i = 0; i < 100 && !ready; i++) await new Promise(setImmediate);
  assert.ok(ready, 'transport allocation must begin');
  assert.equal(options.probePath, '/assets/style.css');
  const readiness = await fetch(f.getServer().localUrl + options.probePath);
  assert.equal(readiness.status, 200);
  assert.match(readiness.headers.get('content-type'), /text\/css/);
  await readiness.body.cancel();
  assert.equal(options.binaryPath, '/fixture/cloudflared');
  assert.equal(port, Number(new URL(f.getServer().localUrl).port));
  assert.equal(f.getServer().publicBaseUrl, undefined);
  const activation = await Promise.race([started.then(() => 'started'), new Promise(resolve => setTimeout(() => resolve('blocked'), 50))]);
  assert.equal(activation, 'started', 'service.start must not wait for public network readiness');
  const tool = discover(f);
  assert.deepEqual((await tool.execute('tabs', { action: 'tabs' })).details.profiles, ['demo']);
  let delivered = false;
  const creating = tool.execute('create', { action: 'create', profile: 'demo', targetId: 'tab' }).then(value => { delivered = true; return value; });
  await new Promise(setImmediate);
  assert.equal(delivered, false);
  assert.equal(f.getServer().store.shares.size, 0);
  ready('https://fixture.trycloudflare.com');
  const created = await creating;
  assert.match(created.details.url, /^https:\/\/fixture.trycloudflare.com\/s\//);
  transport.emit('failure', new Error('owned tunnel stopped'));
  assert.equal(f.getServer().publicBaseUrl, undefined);
  assert.equal(f.getServer().store.shares.size, 0);
  await assert.rejects(tool.execute('tabs', { action: 'tabs' }), /unavailable|running/);
});

test('Cloudflare and Funnel cannot both be enabled and background failure retires owned transport', async t => {
  let constructed = false;
  const conflict = setup({ cloudflareFactory() { constructed = true; }, funnelFactory: () => ({ open: async () => 'https://fixture.example', close: async () => {} }) });
  conflict.api.pluginConfig.cloudflare = { enabled: true, binaryPath: '/fixture/cloudflared' };
  conflict.api.pluginConfig.funnel = { enabled: true };
  await assert.rejects(conflict.services[0].start({ stateDir: tmpdir() }), /conflict|one|both|exclusive/i);
  assert.equal(constructed, false);
  let closed = false;
  const failed = setup({ cloudflareFactory: () => ({ on() {}, ensure: async () => { throw new Error('allocation failed'); }, close: async () => { closed = true; } }) });
  failed.api.pluginConfig.cloudflare = { enabled: true, binaryPath: '/fixture/cloudflared' };
  t.after(() => failed.services[0].stop());
  await failed.services[0].start({ stateDir: tmpdir() }).catch(error => { assert.match(error.message, /activation|retired|changed/i); });
  await new Promise(setImmediate);
  assert.equal(closed, true); assert.equal(failed.getServer().publicBaseUrl, undefined);
  await assert.rejects(discover(failed).execute('tabs', { action: 'tabs' }), /unavailable|retired|configuration/i);
});

test('stop during existing-browser transport startup prevents late publication', async t => {
  let ready;
  const transport = new EventEmitter(); transport.ensure = () => new Promise(resolve => { ready = resolve; }); transport.close = async () => {};
  const f = setup({ cloudflareFactory: () => transport });
  f.api.pluginConfig.cloudflare = { enabled: true, binaryPath: '/fixture/cloudflared' };
  const start = f.services[0].start({ stateDir: tmpdir() }); t.after(() => f.services[0].stop());
  for (let i = 0; i < 100 && !ready; i++) await new Promise(setImmediate);
  assert.ok(ready, 'transport allocation must begin');
  const stoppedStart = start.catch(error => { assert.match(error.message, /stopped|changed/i); });
  await f.services[0].stop();
  ready('https://old.trycloudflare.com');
  await stoppedStart;
  await new Promise(setImmediate);
  assert.equal(f.getServer().publicBaseUrl, undefined);
  await assert.rejects(discover(f).execute('tabs', { action: 'tabs' }), /unavailable/);
});

test('late old shutdown cannot unpublish a healthy replacement existing-browser service', async t => {
  let release;
  const old = setup(); await old.services[0].start();
  const server = old.getServer(), close = server.close.bind(server);
  server.close = async () => { await new Promise(resolve => { release = resolve; }); return close(); };
  const stopping = old.services[0].stop();
  const replacement = setup(); await replacement.services[0].start(); t.after(() => replacement.services[0].stop());
  release(); await stopping;
  assert.equal((await discover(replacement).execute('tabs', { action: 'tabs', profile: 'demo' })).details.tabs.length, 1);
});

test('stale discovery refuses a faulted service and mismatching operator configuration', async t => {
  const f = setup(); await f.services[0].start(); t.after(() => f.services[0].stop());
  const tool = discover(f);
  const different = { ...f, api: { ...f.api, pluginConfig: { ...f.api.pluginConfig, profiles: { other: 'http://127.0.0.1:9223' } } } };
  await assert.rejects(discover(different).execute('tabs', { action: 'tabs' }), /unavailable/);
  f.getServer().store.gate.poison('uncertain browser input');
  await assert.rejects(tool.execute('tabs', { action: 'tabs' }), /fault|unavailable|recovery/i);
  await assert.rejects(tool.execute('tabs', { action: 'tabs' }), /unavailable/i);
});

test('existing-browser discovery retains original sender/session identity and signal', async t => {
  const f = setup(); await f.services[0].start(); t.after(() => f.services[0].stop());
  const tools = [];
  createPlugin().register({ ...f.api, registrationMode: 'tool-discovery', registerTool: tool => tools.push(tool) });
  const ctx = { ...f.ctx }, tool = tools[0].create(ctx);
  ctx.sessionId = 'changed';
  await assert.rejects(tool.execute('tabs', { action: 'tabs' }), /owner/i);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(tools[0].create(f.ctx).execute('tabs', { action: 'tabs' }, abort.signal), /cancel/i);
});

test('stopped or superseded existing-browser services cannot return late browser results', async t => {
  let release;
  const f = setup({ backendFactory: () => ({ list: () => new Promise(resolve => { release = resolve; }) }) });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  const pending = f.tools[0].create(f.ctx).execute('tabs', { action: 'tabs', profile: 'demo' });
  await f.services[0].stop(); release([{ targetId: 'stale' }]);
  await assert.rejects(pending, /running|changed|unavailable/i);
});

test('Cloudflare warmup waits cancel per invocation and old completion cannot publish after stop', async t => {
  let ready, options;
  const transport = new EventEmitter(); transport.ensure = () => new Promise(resolve => { ready = resolve; }); transport.close = async () => {};
  const f = setup({ cloudflareFactory: value => { options = value; return transport; } });
  f.api.pluginConfig.cloudflare = { enabled: true, binaryPath: '/fixture/cloudflared' };
  const started = f.services[0].start({ stateDir: tmpdir() }); t.after(() => f.services[0].stop());
  for (let i = 0; i < 100 && !ready; i++) await new Promise(setImmediate);
  assert.ok(ready);
  const activation = await Promise.race([started.then(() => 'started'), new Promise(resolve => setTimeout(() => resolve('blocked'), 50))]);
  assert.equal(activation, 'started');
  assert.equal(options.startupTimeoutMs, 90_000);
  const abort = new AbortController();
  const canceled = discover(f).execute('create', { action: 'create', profile: 'demo', targetId: 'tab' }, abort.signal);
  abort.abort(); await assert.rejects(canceled, /cancel|abort/i);
  const retained = { ...f.ctx };
  const stale = f.tools[0].create(retained).execute('create', { action: 'create', profile: 'demo', targetId: 'tab' });
  retained.assertInvocationCurrent = () => { throw new Error('stale invocation'); };
  const staleRejected = assert.rejects(stale, /stale|stopped|running|changed/i);
  const stopping = discover(f).execute('create', { action: 'create', profile: 'demo', targetId: 'tab' });
  const stopped = assert.rejects(stopping, /stopped|running|changed|cancel/i);
  await f.services[0].stop();
  await stopped;
  const nextTransport = new EventEmitter();
  nextTransport.ensure = async () => 'https://replacement.trycloudflare.com'; nextTransport.close = async () => {};
  const replacement = setup({ cloudflareFactory: () => nextTransport });
  replacement.api.pluginConfig.cloudflare = { ...f.api.pluginConfig.cloudflare };
  await replacement.services[0].start({ stateDir: tmpdir() }); t.after(() => replacement.services[0].stop());
  ready('https://late.trycloudflare.com');
  await staleRejected;
  await new Promise(setImmediate);
  assert.equal(replacement.getServer().publicBaseUrl, 'https://replacement.trycloudflare.com');
  assert.deepEqual((await discover(replacement).execute('tabs', { action: 'tabs' })).details.profiles, ['demo']);
  assert.equal(f.getServer().publicBaseUrl, undefined);
  assert.equal(f.getServer().store.shares.size, 0);
});

test('Cloudflare warmup rechecks owner authority before creating a link and fails closed on readiness failure', async t => {
  let ready, fail;
  const transport = new EventEmitter(); transport.ensure = () => new Promise((resolve, reject) => { ready = resolve; fail = reject; }); transport.close = async () => {};
  const f = setup({ cloudflareFactory: () => transport }); f.api.pluginConfig.cloudflare = { enabled: true, binaryPath: '/fixture/cloudflared' };
  const started = f.services[0].start({ stateDir: tmpdir() }); t.after(() => f.services[0].stop());
  for (let i = 0; i < 100 && !ready; i++) await new Promise(setImmediate);
  const activation = await Promise.race([started.then(() => 'started'), new Promise(resolve => setTimeout(() => resolve('blocked'), 50))]);
  assert.equal(activation, 'started');
  let invocationCurrent = true;
  const ctx = { ...f.ctx, assertInvocationCurrent() { if (!invocationCurrent) throw new Error('stale invocation'); } };
  const revoked = f.tools[0].create(ctx).execute('create', { action: 'create', profile: 'demo', targetId: 'tab' });
  invocationCurrent = false;
  ready('https://ready.trycloudflare.com');
  await assert.rejects(revoked, /stale invocation/i);
  assert.equal(f.getServer().store.shares.size, 0);
  await f.services[0].stop();
  await f.services[0].start({ stateDir: tmpdir() });
  const pending = discover(f).execute('create', { action: 'create', profile: 'demo', targetId: 'tab' });
  const rejected = assert.rejects(pending, /allocation failed|unavailable|running/i);
  fail(new Error('allocation failed')); await rejected;
  await assert.rejects(discover(f).execute('tabs', { action: 'tabs' }), /unavailable/);
  assert.equal(f.getServer().publicBaseUrl, undefined);
  assert.equal(f.getServer().store.shares.size, 0);
});

test('existing default supplies omitted handoff profile and explicit unconfigured profiles never reach backend', async t => {
  const seen = [];
  const f = setup({ backendFactory: profiles => { assert.deepEqual(profiles, { demo: 'http://127.0.0.1:9222' }); return { list: async profile => { seen.push(profile); return [{ targetId: 'tab' }]; } }; } });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  const tool = f.tools[0].create(f.ctx);
  const tabs = (await tool.execute('tabs', { action: 'tabs' })).details;
  assert.equal(tabs.profile, 'demo'); assert.equal(tabs.tabs[0].targetId, 'tab');
  const create = (await tool.execute('create', { action: 'create', targetId: 'tab' })).details;
  assert.equal(create.profile, 'demo');
  const count = seen.length;
  await assert.rejects(tool.execute('escape', { action: 'tabs', profile: 'user' }), /profile/i);
  assert.equal(seen.length, count); assert.ok(seen.every(profile => profile === 'demo'));
});
test('full CDP registration requires native trusted policies while metadata and discovery remain inert', () => {
  const f = setup(); assert.equal(f.policies.length, 1); assert.equal(f.policies[0].id, 'clawser-browser-access');
  assert.throws(() => createPlugin().register({ ...f.api, registerTrustedToolPolicy: undefined }), /registerTrustedToolPolicy/i);
  for (const registrationMode of ['cli-metadata', 'setup-only', 'tool-discovery']) {
    const api = { ...f.api, registrationMode, registerTrustedToolPolicy() { assert.fail('inert mode registered policy'); } };
    Object.defineProperty(api, 'runtime', { get() { assert.fail('inert mode accessed runtime'); } });
    createPlugin().register(api);
  }
});
test('CDP gate blocks browser I/O before startup and after stop instead of bypassing coordination', async () => {
  const f = setup(), event = { toolName: 'browser', params: { action: 'tabs', target: 'host' } }, ctx = { ...f.ctx, runId: 'run', toolCallId: 'call' };
  assert.equal(f.hooks.get('before_tool_call')(event, ctx)?.block, true);
  await f.services[0].start(); await f.services[0].stop();
  assert.equal(f.hooks.get('before_tool_call')(event, ctx)?.block, true);
});
test('CDP configuration drift retires invitations and retains uncertain human-input and pending-automation fences', async t => {
  for (const withInput of [false, true]) {
    const f = setup(); await f.services[0].start(); t.after(() => f.services[0].stop());
    const tool = f.tools[0].create(f.ctx), created = await tool.execute('create', { action: 'create', profile: 'demo', targetId: 'tab' });
    const store = f.getServer().store, share = store.get(created.details.id);
    store.claim(share.id, new URL(created.details.url).hash.slice('#invite='.length));
    if (withInput) { await store.takeControl(share); store.gate.beginInput(share.id); }
    else store.gate.enter('pending-browser');
    f.api.config.browser.profiles.demo.cdpUrl = 'http://127.0.0.1:9555';
    await assert.rejects(tool.execute('drift', { action: 'tabs' }), /config|changed|unavailable/i);
    assert.equal(store.shares.size, 0); assert.ok(store.gate.poisonReason);
    if (withInput) { assert.equal(store.gate.humanInputs, 1); assert.equal(store.gate.holder, share.id); store.gate.endInput(share.id); }
    else { assert.ok(store.gate.active.has('pending-browser')); store.gate.leave('pending-browser'); }
    assert.equal(store.gate.locked, true);
  }
});
test('CDP trusted policy checks fresh default and nonowner authority for every browser invocation', async t => {
  const f = setup(); await f.services[0].start(); t.after(() => f.services[0].stop());
  const policy = f.policies[0], event = { toolName: 'tools.browser_1', params: { action: 'tabs', target: 'host', owner: true } };
  const ctx = { sessionKey: f.ctx.sessionKey, sessionId: f.ctx.sessionId, runId: 'run', toolCallId: 'call', requester: { senderId: 'owner', channel: 'telegram', senderIsOwner: true } };
  assert.equal(policy.evaluate(event, ctx), undefined);
  ctx.requester.senderIsOwner = false; assert.equal(policy.evaluate(event, ctx).allow, false);
  ctx.requester.senderIsOwner = true; f.api.runtime.config.current = undefined;
  assert.equal(policy.evaluate(event, ctx).allow, false);
});
test('explicit invalid handoff profiles cannot redirect to the current default', async t => {
  const f = setup(); await f.services[0].start(); t.after(() => f.services[0].stop());
  for (const profile of [null, '', ' demo ', 42, {}]) await assert.rejects(f.tools[0].create(f.ctx).execute('tabs', { action: 'tabs', profile }), /profile/i);
});
test('CDP server binding callback retires stale invitations before data-plane use and idle monitor cleans up', async t => {
  let tick, callback, cleared = 0;
  const scheduler = { setInterval(fn, ms) { tick = fn; assert.equal(ms, 1000); return { unref() {} }; }, clearInterval() { cleared++; } };
  const f = setup({ bindingMonitorScheduler: scheduler, serverFactory(options) { callback = options.isBindingCurrent; return new HandoffServer(options); } });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  assert.equal(typeof callback, 'function'); assert.equal(callback(), true);
  await f.tools[0].create(f.ctx).execute('create', { action: 'create', targetId: 'tab' });
  f.api.config.browser.profiles.demo.cdpUrl = 'http://127.0.0.1:9555';
  assert.equal(callback(), false); assert.equal(f.getServer().store.shares.size, 0); assert.ok(f.getServer().store.gate.poisonReason);
  tick(); assert.equal(cleared, 1);
  await f.services[0].stop(); assert.equal(cleared, 1); assert.equal(callback(), false);
});

test('data-plane callback permanently retires a superseded publication without unpublishing its replacement', async t => {
  let oldCurrent, newCurrent;
  const old = setup({ serverFactory(options) { oldCurrent = options.isBindingCurrent; return new HandoffServer(options); } });
  await old.services[0].start(); t.after(() => old.services[0].stop());
  const created = await old.tools[0].create(old.ctx).execute('create', { action: 'create', targetId: 'tab' });
  const oldGate = old.getServer().store.gate; oldGate.enter('pending-native-call');
  const replacement = setup({ serverFactory(options) { newCurrent = options.isBindingCurrent; return new HandoffServer(options); } });
  await replacement.services[0].start(); t.after(() => replacement.services[0].stop());
  assert.equal(newCurrent(), true);
  assert.equal(oldCurrent(), false);
  assert.equal(old.getServer().store.shares.has(created.details.id), false);
  assert.ok(oldGate.poisonReason); assert.ok(oldGate.active.has('pending-native-call'));
  assert.equal(oldCurrent(), false);
  await old.services[0].stop();
  assert.equal(newCurrent(), true, 'stale unpublish must preserve the replacement registration');
  assert.equal((await discover(replacement).execute('tabs', { action: 'tabs' })).details.profile, 'demo');
});
test('data-plane callback rejects a gate fault and remains retired even if that gate field is cleared', async t => {
  for (const inspectFirst of [false, true]) {
    let current;
    const f = setup({ serverFactory(options) { current = options.isBindingCurrent; return new HandoffServer(options); } });
    await f.services[0].start(); t.after(() => f.services[0].stop());
    const tool = f.tools[0].create(f.ctx);
    await tool.execute('create', { action: 'create', targetId: 'tab' });
    f.getServer().store.gate.poison();
    if (inspectFirst) await assert.rejects(tool.execute('tabs', { action: 'tabs' }), /fault|recovery/i);
    assert.equal(current(), false);
    assert.equal(f.getServer().store.shares.size, 0);
    f.getServer().store.gate.poisonReason = null;
    assert.equal(current(), false, 'the callback cannot revive a retired service generation');
  }
});
test('prepublication asset readiness stays available and Cloudflare warmup remains asynchronous', async t => {
  let current, ready, startupChecks = 0;
  const transport = new EventEmitter(); transport.close = async () => {};
  transport.ensure = () => { assert.equal(current(), true); return new Promise(resolve => { ready = resolve; }); };
  const f = setup({ cloudflareFactory: () => transport, serverFactory(options) {
    current = options.isBindingCurrent;
    assert.equal(current(), true, 'construction has no published invitations yet'); startupChecks++;
    const server = new HandoffServer(options), start = server.start.bind(server);
    server.start = async options => {
      await start(options);
      assert.equal(current(), true, 'listener assets must be usable before publication'); startupChecks++;
      const response = await fetch(server.localUrl + '/assets/style.css');
      assert.equal(response.status, 200); await response.body.cancel();
      assert.equal(server.store.gate.poisonReason, null);
      return server.localUrl;
    };
    return server;
  } });
  f.api.pluginConfig.cloudflare = { enabled: true, binaryPath: '/fixture/cloudflared' };
  const starting = f.services[0].start({ stateDir: tmpdir() }); t.after(() => f.services[0].stop());
  assert.equal(await Promise.race([starting.then(() => 'started'), new Promise(resolve => setTimeout(() => resolve('blocked'), 100))]), 'started');
  assert.equal(startupChecks, 2); assert.equal(typeof ready, 'function'); assert.equal(current(), true);
  ready('https://warmup.trycloudflare.com'); await new Promise(setImmediate);
  assert.equal(current(), true);
});

test('CDP results declare their tab backend contract and preserve each active or completed share profile', async t => {
  const f = setup();
  f.api.config.browser.profiles.other = { cdpUrl: 'http://127.0.0.1:9333', attachOnly: true };
  f.api.pluginConfig.profiles.other = 'http://127.0.0.1:9333';
  await f.services[0].start(); t.after(() => f.services[0].stop());
  const tool = f.tools[0].create(f.ctx);
  const check = (result, profile) => {
    assert.equal(result.details.backend, 'cdp'); assert.equal(result.details.scope, 'tab');
    assert.equal(result.details.continuation, 'active-wait'); assert.equal(result.details.profile, profile);
    assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  };
  check(await tool.execute('tabs', { action: 'tabs' }), 'demo');
  const created = await tool.execute('create', { action: 'create', profile: 'other', targetId: 'tab' });
  check(created, 'other');
  check(await tool.execute('status', { action: 'status', id: created.details.id }), 'other');
  const waiting = tool.execute('wait', { action: 'wait', id: created.details.id, timeoutSeconds: 1 });
  f.getServer().store.end(f.getServer().store.get(created.details.id), 'done');
  check(await waiting, 'other');
  check(await tool.execute('ended-status', { action: 'status', id: created.details.id }), 'other');
  check(await tool.execute('ended-wait', { action: 'wait', id: created.details.id }), 'other');
  const revoked = await tool.execute('create-revoke', { action: 'create', profile: 'other', targetId: 'tab' });
  check(await tool.execute('revoke', { action: 'revoke', id: revoked.details.id }), 'other');
});

test('native hot CDP activation waits for committed enable or mode-switch before constructing any browser resources', async t => {
  const { activationClock, flushActivation } = await import('./activation-clock.mjs');
  for (const previousMode of ['disabled', 'novnc']) {
    const scheduler = activationClock(), diagnostics = []; let constructed = 0;
    const f = setup({ activationScheduler: scheduler, activationWriteDiagnostic: async value => diagnostics.push(value), backendFactory: () => { constructed++; return { list: async () => [{ targetId: 'tab' }] }; } });
    f.api.config.plugins = { entries: { 'browser-handoff': { enabled: true, config: structuredClone(f.api.pluginConfig) } } };
    const target = structuredClone(f.api.config); let current = structuredClone(target);
    if (previousMode === 'disabled') current.plugins.entries['browser-handoff'].enabled = false;
    else { current.browser.defaultProfile = 'old'; current.browser.profiles.old = { attachOnly: true, cdpUrl: 'http://127.0.0.1:9444' }; current.plugins.entries['browser-handoff'].config = { desktop: { enabled: true, profile: 'old', socketPath: '/old/controller.sock' } }; }
    f.api.runtime.config.current = () => current;
    await f.services[0].start(); t.after(() => f.services[0].stop());
    assert.equal(constructed, 0); assert.equal(f.getServer(), undefined); assert.equal(scheduler.size, 1);
    const tool = f.tools[0].create(f.ctx);
    await assert.rejects(tool.execute('pending', { action: 'tabs' }), /awaiting.*configuration publication/i);
    await assert.rejects(discover(f).execute('pending-discovery', { action: 'tabs' }), /awaiting.*configuration publication/i);
    const native = { ...f.ctx, runId: 'run', toolCallId: 'call', requester: { senderIsOwner: true, senderId: 'owner', channel: 'telegram' } };
    assert.match(f.policies[0].evaluate({ toolName: 'browser', params: { action: 'tabs', target: 'host' } }, native).reason, /awaiting.*configuration publication/i);
    current = target; scheduler.advance(100); await flushActivation();
    assert.equal(constructed, 1); assert.equal(f.getServer().server.listening, true);
    assert.equal((await tool.execute('active', { action: 'tabs' })).details.profile, 'demo');
    assert.equal(diagnostics.at(-1).phase, 'active');
    await f.services[0].stop();
  }
});

test('hot CDP activation stays resource-free after stop or publication deadline', async t => {
  const { activationClock, flushActivation } = await import('./activation-clock.mjs');
  for (const stopEarly of [true, false]) {
    const scheduler = activationClock(), diagnostics = []; let resources = 0;
    const f = setup({ activationScheduler: scheduler, activationWriteDiagnostic: async value => diagnostics.push(value), backendFactory() { resources++; return { list: async () => [] }; } });
    let current = structuredClone(f.api.config); current.plugins.entries['browser-handoff'].enabled = false;
    f.api.runtime.config.current = () => current;
    await f.services[0].start(); t.after(() => f.services[0].stop());
    if (stopEarly) await f.services[0].stop(); else { scheduler.advance(30_000); await flushActivation(); }
    assert.equal(diagnostics.at(-1).phase, stopEarly ? 'stopped' : 'failed');
    current = structuredClone(f.api.config); scheduler.advance(30_000); await flushActivation();
    assert.equal(resources, 0); assert.equal(f.getServer(), undefined); assert.equal(scheduler.size, 0);
    await assert.rejects(f.tools[0].create(f.ctx).execute('late', { action: 'tabs' }), /stopped|deadline/i);
  }
});
test('local active diagnostic reports Cloudflare warming then ready without blocking tabs', async t => {
  let ready; const diagnostics = [];
  const transport = new EventEmitter(); transport.close = async () => {}; transport.ensure = () => new Promise(resolve => { ready = resolve; });
  const f = setup({ activationWriteDiagnostic: async value => diagnostics.push(value), cloudflareFactory: () => transport });
  f.api.pluginConfig.cloudflare = { enabled: true, binaryPath: '/fixture/cloudflared' };
  await f.services[0].start({ stateDir: tmpdir() }); t.after(() => f.services[0].stop());
  assert.equal(diagnostics.at(-1).phase, 'active'); assert.equal(diagnostics.at(-1).publicTransport, 'warming');
  assert.equal((await discover(f).execute('tabs', { action: 'tabs' })).details.profile, 'demo');
  ready('https://ready.trycloudflare.com');
  for (let attempt = 0; attempt < 100 && diagnostics.at(-1).publicTransport !== 'ready'; attempt++) await new Promise(setImmediate);
  assert.equal(diagnostics.at(-1).publicTransport, 'ready'); assert.equal(diagnostics.at(-1).phase, 'active');
});
