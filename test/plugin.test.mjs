import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlugin } from '../index.mjs';
import { HandoffServer } from '../src/server.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup({ funnelFactory } = {}) {
  const hooks = new Map(), tools = [], services = [];
  const api = { pluginConfig: { profiles: { demo: 'http://127.0.0.1:9222' }, port: 0, publicBaseUrl: 'https://handoff.example' },
    registerTool: (tool) => tools.push(tool), registerService: (service) => services.push(service),
    on: (name, fn) => hooks.set(name, fn), logger: { warn() {}, info() {} }, runtime: {}, config: {} };
  const ctx = { senderIsOwner: true, sessionKey: 'agent:main:telegram:direct:1', sessionId: 'incarnation', assertInvocationCurrent() {} };
  let server;
  createPlugin({ backendFactory: () => ({ list: async () => [{ targetId: 'tab', title: 'Demo', url: 'https://example.com' }] }), serverFactory: (options) => (server = new HandoffServer(options)), ...(funnelFactory ? { funnelFactory } : {}) }).register(api);
  return { api, hooks, tools, services, ctx, getServer: () => server };
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
