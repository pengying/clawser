import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerDesktopPlugin } from '../src/desktop-plugin.mjs';

const ownerContext = () => ({ senderIsOwner: true, sessionKey: 'agent:main:telegram:direct:1', sessionId: 'incarnation', assertInvocationCurrent() {} });
const browserEvent = { toolName: 'browser', params: { action: 'snapshot', profile: 'handoff' } };
const invocation = () => ({ ...ownerContext(), runId: 'run', toolCallId: 'call' });
function setup({ request, runtime = {}, registrationMode, configure, connect, register = registerDesktopPlugin } = {}) {
  const hooks = new Map(), tools = [], services = [], requests = [], clients = [];
  const api = {
    pluginConfig: { desktop: { enabled: true, profile: 'handoff', socketPath: '/tmp/browser-handoff/controller.sock' } },
    config: { browser: { profiles: { handoff: { cdpUrl: 'http://127.0.0.1:19333', attachOnly: true, driver: 'openclaw' } } } }, runtime, registrationMode,
    registerTool: value => tools.push(value), registerService: value => services.push(value),
    on: (name, fn) => hooks.set(name, fn), logger: { warn() {}, info() {} },
  };
  const defaults = async (method) => {
    if (method === 'health' || method === 'ensure') return { profile: 'handoff', cdpUrl: 'http://127.0.0.1:19333' };
    if (method === 'automationEnter') return { admitted: true };
    if (method === 'automationLeave') return { released: true };
    if (method === 'revokeAll') return { revoked: 0, allRetired: true, recoveryRequired: false };
    if (method === 'completions') return [];
    return { ok: true };
  };
  const rpcFactory = (socketPath) => {
    const client = { socketPath, closed: false, async request(method, params, options) {
      requests.push({ method, params, options, client });
      return request ? request(method, params, options, defaults, client) : defaults(method);
    }, close() { this.closed = true; } };
    clients.push(client); return connect ? connect(client) : client;
  };
  configure?.(api);
  register(api, { desktopRpcFactory: rpcFactory });
  return { api, hooks, tools, services, requests, clients, tool: () => tools[0].create(ownerContext()) };
}

test('production branch connects private controller without starting a legacy service', async t => {
  const f = setup();
  await f.services[0].start(); t.after(() => f.services[0].stop());
  assert.equal(f.clients[0].socketPath, '/tmp/browser-handoff/controller.sock');
  assert.equal(f.tools.length, 1);
  assert.equal(f.services.length, 1);
  assert.equal(f.tools[0].contextVersion, 2);
  assert.equal(f.requests[0].method, 'health');
  await f.services[0].stop();
  assert.equal(f.clients[0].closed, true);
});

test('production gate fails closed before start, after stop, and on controller failure', async t => {
  const f = setup({ request: async (method, params, options, defaults) => {
    if (method === 'automationEnter') throw new Error('RPC connection lost');
    return defaults(method);
  } });
  const before = f.hooks.get('before_tool_call');
  assert.equal((await before(browserEvent, invocation())).block, true);
  await f.services[0].start(); t.after(() => f.services[0].stop());
  assert.equal((await before(browserEvent, invocation())).block, true);
  assert.equal(await before({ toolName: 'read' }, {}), undefined);
  await f.services[0].stop();
  assert.equal((await before(browserEvent, invocation())).block, true);
});

test('production browser admission awaits controller and matches complete call identity', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = setup({ request: async (method, params, options, defaults) => method === 'automationEnter' ? pending : defaults(method) });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  let settled = false;
  const enter = f.hooks.get('before_tool_call')(browserEvent, invocation()).then(value => { settled = true; return value; });
  await new Promise(setImmediate);
  assert.equal(settled, false);
  release({ admitted: true });
  assert.equal(await enter, undefined);
  const admission = f.requests.find(r => r.method === 'automationEnter');
  assert.deepEqual(JSON.parse(admission.params.callKey), ['agent:main:telegram:direct:1', 'incarnation', 'run', 'call', 'browser']);
  assert.ok(f.requests.some(r => r.method === 'ensure'));
  await f.hooks.get('after_tool_call')(browserEvent, { ...invocation(), runId: 'different' });
  assert.equal(f.requests.filter(r => r.method === 'automationLeave').length, 0);
  await f.hooks.get('after_tool_call')(browserEvent, invocation());
  assert.equal(f.requests.filter(r => r.method === 'automationLeave').length, 1);
});

test('production gate rejects incomplete lifecycle and uncertain admission receipts', async t => {
  const f = setup({ request: async (method, params, options, defaults) => method === 'automationEnter' ? undefined : defaults(method) });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  assert.equal((await f.hooks.get('before_tool_call')(browserEvent, ownerContext())).block, true);
  assert.equal((await f.hooks.get('before_tool_call')(browserEvent, invocation())).block, true);
});

test('production startup rejects a profile CDP mapping mismatch and keeps gate blocked', async () => {
  const f = setup();
  f.api.config.browser.profiles.handoff.cdpUrl = 'http://127.0.0.1:9222';
  await assert.rejects(f.services[0].start(), /profile|CDP|mapping/i);
  assert.equal(f.clients[0].closed, true);
  assert.equal((await f.hooks.get('before_tool_call')(browserEvent, invocation())).block, true);
});

test('production tools enforce owner-private identity and explicit whole-profile scope', async t => {
  const f = setup({ request: async (method, params, options, defaults) => method === 'create'
    ? { id: 'lease', url: 'https://handoff.example/s/lease/#invite=secret', scope: 'browser-profile', profile: 'handoff', mode: 'unclaimed', resumeAllowed: false }
    : method === 'tabs' ? [{ targetId: 'tab', title: 'Form', url: 'https://example.com' }] : defaults(method) });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  for (const variation of [{ senderIsOwner: false }, { sandboxed: true }, { sessionKey: 'agent:main:telegram:group:1' }, { sessionKey: 'agent:main:subagent:one' }, { sessionId: undefined }]) {
    assert.equal(f.tools[0].create({ ...ownerContext(), ...variation }), null);
  }
  const result = await f.tool().execute('create', { action: 'create', targetId: 'tab', reason: 'Human CAPTCHA' });
  assert.equal(result.details.scope, 'browser-profile');
  assert.match(result.details.scopeNotice, /all tabs|every tab/i);
  const call = f.requests.find(r => r.method === 'create');
  assert.deepEqual(call.params, { owner: JSON.stringify([ownerContext().sessionKey, 'incarnation']), profile: 'handoff', targetId: 'tab', permission: 'control', ttlSeconds: 300, reason: 'Human CAPTCHA' });
  const tabs = await f.tool().execute('tabs', { action: 'tabs' });
  assert.equal(tabs.details.profile, 'handoff');
  assert.equal(tabs.details.tabs[0].targetId, 'tab');
});

test('production create checks stale invocation after ensure and retires a raced invitation', async t => {
  let current = true;
  const f = setup({ request: async (method, params, options, defaults) => {
    if (method === 'create') { current = false; return { id: 'raced', scope: 'browser-profile' }; }
    return defaults(method);
  } });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  const tool = f.tools[0].create({ ...ownerContext(), assertInvocationCurrent() { if (!current) throw new Error('stale invocation'); } });
  await assert.rejects(tool.execute('create', { action: 'create' }), /stale/);
  assert.ok(f.requests.some(r => r.method === 'revoke' && r.params.id === 'raced'));
});

test('production wait propagates abort and never turns failed fencing into safe resume', async t => {
  const f = setup({ request: async (method, params, options, defaults) => method === 'wait'
    ? { id: params.id, mode: 'recovery_required', resumeAllowed: false, recoveryRequired: true } : defaults(method) });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  const controller = new AbortController();
  const result = await f.tool().execute('wait', { action: 'wait', id: 'lease', timeoutSeconds: 60 }, controller.signal);
  assert.equal(result.details.resumeAllowed, false);
  const wait = f.requests.find(r => r.method === 'wait');
  assert.equal(wait.options.signal, controller.signal);
  assert.ok(wait.options.timeoutMs > 60_000);
});

test('production session end revokes only the specified session incarnation', async t => {
  const f = setup();
  await f.services[0].start(); t.after(() => f.services[0].stop());
  await f.hooks.get('session_end')({ sessionId: 'incarnation' }, { sessionKey: ownerContext().sessionKey });
  assert.deepEqual(f.requests.find(r => r.method === 'revokeOwner').params, { sessionKey: ownerContext().sessionKey, sessionId: 'incarnation' });
});

async function eventually(assertion) {
  const deadline = Date.now() + 1000;
  while (true) {
    try { assertion(); return; } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
}
function wakeRuntime({ entry = { sessionId: 'incarnation' }, enqueueResult = true, enqueueError = false, onRead } = {}) {
  const events = [], wakes = [], reads = [];
  return { events, wakes, reads,
    agent: { session: { async getSessionEntryAsync(params) { reads.push(params); return onRead ? onRead() : entry; } } },
    system: {
      enqueueSystemEvent(text, options) { if (enqueueError) throw new Error('event queue full'); events.push({ text, options }); return enqueueResult; },
      requestHeartbeat(options) { wakes.push(options); },
    },
  };
}
const completed = (overrides = {}) => ({ id: 'lease', owner: JSON.stringify([ownerContext().sessionKey, 'incarnation']), profile: 'handoff', reason: 'done', resumeAllowed: true, ...overrides });

test('production completion wakes the exact current owner once and acknowledges after enqueue', async t => {
  const runtime = wakeRuntime();
  const f = setup({ runtime, request: async (method, params, options, defaults) => {
    if (method === 'completions') return { completions: [completed(), completed()] };
    if (method === 'acknowledgeCompletion') assert.equal(runtime.wakes.length, 1);
    return defaults(method);
  } });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  await eventually(() => assert.equal(runtime.wakes.length, 1));
  assert.equal(runtime.events.length, 1);
  assert.deepEqual(runtime.reads[0], { sessionKey: ownerContext().sessionKey, readConsistency: 'latest' });
  assert.equal(runtime.events[0].options.sessionKey, ownerContext().sessionKey);
  assert.match(runtime.events[0].options.contextKey, /browser-handoff.*lease/);
  assert.match(runtime.events[0].text, /fresh.*snapshot/i);
  assert.match(runtime.events[0].text, /does not prove/i);
  assert.deepEqual(runtime.wakes[0], { source: 'background-task', intent: 'immediate', reason: 'browser-handoff:lease', agentId: 'main', sessionKey: ownerContext().sessionKey });
  assert.ok(f.requests.some(r => r.method === 'acknowledgeCompletion' && r.params.id === 'lease'));
});

test('production completion drops changed incarnations and ended owner tasks without a wake', async t => {
  const runtime = wakeRuntime({ entry: { sessionId: 'replacement' } });
  const f = setup({ runtime, request: async (method, params, options, defaults) => method === 'completions' ? { completions: [completed()] } : defaults(method) });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  await eventually(() => assert.ok(f.requests.some(r => r.method === 'acknowledgeCompletion')));
  assert.equal(runtime.events.length, 0);
  assert.equal(runtime.wakes.length, 0);
});

test('production completion rechecks cancellation after awaiting current session metadata', async t => {
  let release;
  const read = new Promise(resolve => { release = resolve; });
  const runtime = wakeRuntime({ onRead: () => read });
  const f = setup({ runtime, request: async (method, params, options, defaults) => method === 'completions' ? { completions: [completed()] } : defaults(method) });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  await eventually(() => assert.equal(runtime.reads.length, 1));
  await f.hooks.get('session_end')({ sessionId: 'incarnation' }, { sessionKey: ownerContext().sessionKey });
  release({ sessionId: 'incarnation' });
  await eventually(() => assert.ok(f.requests.some(r => r.method === 'acknowledgeCompletion')));
  assert.equal(runtime.wakes.length, 0);
});

test('production completion does not acknowledge queue refusal or invent a wake on partial SDKs', async t => {
  const runtime = wakeRuntime({ enqueueResult: false });
  const f = setup({ runtime, request: async (method, params, options, defaults) => method === 'completions' ? { completions: [completed()] } : defaults(method) });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  await eventually(() => assert.equal(runtime.events.length, 1));
  assert.equal(runtime.wakes.length, 0);
  assert.equal(f.requests.some(r => r.method === 'acknowledgeCompletion'), false);
  const partial = setup({ runtime: { system: runtime.system } });
  await partial.services[0].start(); t.after(() => partial.services[0].stop());
  const result = await partial.tool().execute('status', { action: 'status', id: 'lease' });
  assert.equal(result.details.continuation, 'active-wait');
  assert.match(result.details.continuationNotice, /new.*turn|active.*wait/i);
  assert.equal(partial.requests.some(r => r.method === 'completions'), false);
});

test('production expired completion asks for outcome review without regenerating links', async t => {
  const runtime = wakeRuntime();
  const f = setup({ runtime, request: async (method, params, options, defaults) => method === 'completions' ? { completions: [completed({ reason: 'expired' })] } : defaults(method) });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  await eventually(() => assert.equal(runtime.events.length, 1));
  assert.match(runtime.events[0].text, /do not.*(?:recreate|regenerate)/i);
  assert.match(runtime.events[0].text, /expired/);
});

test('production shutdown retires every dedicated-profile lease including pre-restart owners', async () => {
  const f = setup({ request: async (method, params, options, defaults) => method === 'create' ? { id: 'lease' } : defaults(method) });
  await f.services[0].start();
  await f.tool().execute('create', { action: 'create' });
  await f.services[0].stop();
  assert.deepEqual(f.requests.find(r => r.method === 'revokeAll').params, { reason: 'plugin_stop' });
  assert.equal(f.requests.some(r => r.method === 'revokeOwner'), false);
  assert.equal(f.requests.some(r => /shutdownBrowser|stopRuntime|shutdown/.test(r.method)), false);
  assert.equal(f.clients[0].closed, true);
});

test('production leaves require explicit release receipt and fault all later admissions', async t => {
  const f = setup({ request: async (method, params, options, defaults) => method === 'automationLeave' ? { released: false } : defaults(method) });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  await f.hooks.get('before_tool_call')(browserEvent, invocation());
  await f.hooks.get('after_tool_call')(browserEvent, invocation());
  assert.equal((await f.hooks.get('before_tool_call')(browserEvent, { ...invocation(), toolCallId: 'next' })).block, true);
});

test('production completion respects persisted cancellation of the owner run', async t => {
  const runtime = wakeRuntime({ entry: { sessionId: 'incarnation', abortedLastRun: true } });
  const f = setup({ runtime, request: async (method, params, options, defaults) => method === 'completions' ? { completions: [completed()] } : defaults(method) });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  await eventually(() => assert.ok(f.requests.some(r => r.method === 'acknowledgeCompletion')));
  assert.equal(runtime.events.length, 0);
  assert.equal(runtime.wakes.length, 0);
});

test('production create revalidates invocation before issuing a link after runtime startup', async t => {
  let current = true;
  const f = setup({ request: async (method, params, options, defaults) => {
    if (method === 'ensure') current = false;
    return defaults(method);
  } });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  const tool = f.tools[0].create({ ...ownerContext(), assertInvocationCurrent() { if (!current) throw new Error('stale invocation'); } });
  await assert.rejects(tool.execute('create', { action: 'create' }), /stale/);
  assert.equal(f.requests.some(r => r.method === 'create'), false);
});

test('production duplicate browser lifecycles pair each admission with one remote leave', async t => {
  const f = setup();
  await f.services[0].start(); t.after(() => f.services[0].stop());
  await f.hooks.get('before_tool_call')(browserEvent, invocation());
  await f.hooks.get('before_tool_call')(browserEvent, invocation());
  await f.hooks.get('after_tool_call')(browserEvent, invocation());
  assert.equal(f.requests.filter(r => r.method === 'automationLeave').length, 1);
  await f.hooks.get('after_tool_call')(browserEvent, invocation());
  assert.equal(f.requests.filter(r => r.method === 'automationLeave').length, 2);
  await f.hooks.get('after_tool_call')(browserEvent, invocation());
  assert.equal(f.requests.filter(r => r.method === 'automationLeave').length, 2, 'unmatched completion must not release another call');
});

test('production default browser profile is ensured before its ordinary browser calls', async t => {
  const f = setup();
  f.api.config.browser.defaultProfile = 'handoff';
  await f.services[0].start(); t.after(() => f.services[0].stop());
  await f.hooks.get('before_tool_call')({ toolName: 'browser', params: { action: 'snapshot' } }, invocation());
  assert.ok(f.requests.some(r => r.method === 'ensure'));
});

test('production local gate fault still allows owner inspection and revocation', async t => {
  const f = setup({ request: async (method, params, options, defaults) => method === 'automationLeave' ? { released: false } : defaults(method) });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  await f.hooks.get('before_tool_call')(browserEvent, invocation());
  await f.hooks.get('after_tool_call')(browserEvent, invocation());
  const status = await f.tool().execute('status', { action: 'status', id: 'lease' });
  assert.match(status.details.browserGateFault, /completion|recovery/i);
  await f.tool().execute('revoke', { action: 'revoke', id: 'lease' });
  assert.ok(f.requests.some(r => r.method === 'revoke'));
});

test('production startup refuses an explicitly unreconciled controller', async () => {
  const f = setup({ request: async (method, params, options, defaults) => method === 'health'
    ? { profile: 'handoff', cdpUrl: 'http://127.0.0.1:19333', ready: false, recoveryRequired: true } : defaults(method) });
  await assert.rejects(f.services[0].start(), /ready|recovery|reconcil/i);
  assert.equal((await f.hooks.get('before_tool_call')(browserEvent, invocation())).block, true);
});

test('production controller denial never runs browser ensure before the gate', async t => {
  const f = setup({ request: async (method, params, options, defaults) => {
    if (method === 'automationEnter') throw new Error('Browser is under human control');
    return defaults(method);
  } });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  const result = await f.hooks.get('before_tool_call')(browserEvent, invocation());
  assert.equal(result.block, true);
  assert.equal(f.requests.some(r => r.method === 'ensure'), false);
});

test('production ensures the admitted call before execution and balances failed startup', async t => {
  let failEnsure = true;
  const f = setup({ request: async (method, params, options, defaults) => {
    if (method === 'ensure' && failEnsure) throw new Error('Browser startup failed');
    return defaults(method);
  } });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  const result = await f.hooks.get('before_tool_call')(browserEvent, invocation());
  assert.equal(result.block, true);
  assert.match(result.blockReason, /startup/);
  assert.deepEqual(f.requests.filter(r => ['automationEnter', 'ensure', 'automationLeave'].includes(r.method)).map(r => r.method), ['automationEnter', 'ensure', 'automationLeave']);
  const enter = f.requests.find(r => r.method === 'automationEnter');
  assert.equal(f.requests.find(r => r.method === 'ensure').params.callKey, enter.params.callKey);
  await f.hooks.get('after_tool_call')(browserEvent, invocation());
  assert.equal(f.requests.filter(r => r.method === 'automationLeave').length, 1, 'blocked execution has no unmatched leave');
  failEnsure = false;
  assert.equal(await f.hooks.get('before_tool_call')(browserEvent, invocation()), undefined);
  await f.hooks.get('after_tool_call')(browserEvent, invocation());
  assert.equal(f.requests.filter(r => r.method === 'automationLeave').length, 2);
});

test('production startup cleanup failure faults all future browser admissions', async t => {
  const f = setup({ request: async (method, params, options, defaults) => {
    if (method === 'ensure') throw new Error('Browser startup failed');
    if (method === 'automationLeave') throw new Error('Controller disconnected during cleanup');
    return defaults(method);
  } });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  assert.equal((await f.hooks.get('before_tool_call')(browserEvent, invocation())).block, true);
  const next = await f.hooks.get('before_tool_call')(browserEvent, { ...invocation(), toolCallId: 'next' });
  assert.equal(next.block, true);
  assert.match(next.blockReason, /recovery|completion/i);
  assert.equal(f.requests.filter(r => r.method === 'automationEnter').length, 1);
});


test('production startup requires attach-only Chromium CDP profile identity', async () => {
  for (const variation of [
    { attachOnly: undefined }, { attachOnly: false },
    { driver: 'existing-session' }, { driver: 'extension' },
    { engine: 'lightpanda' },
  ]) {
    const f = setup();
    Object.assign(f.api.config.browser.profiles.handoff, variation);
    await assert.rejects(f.services[0].start(), /attachOnly|driver|engine|Chromium/i, JSON.stringify(variation));
    assert.equal(f.clients[0].closed, true);
    assert.equal((await f.hooks.get('before_tool_call')(browserEvent, invocation())).block, true);
  }
});

test('production profile accepts published CDP drivers and Chromium engine', async t => {
  for (const driver of [undefined, 'openclaw', 'clawd']) {
    const f = setup();
    Object.assign(f.api.config.browser.profiles.handoff, { driver, engine: 'chromium' });
    await f.services[0].start(); t.after(() => f.services[0].stop());
    assert.equal(await f.hooks.get('before_tool_call')(browserEvent, invocation()), undefined);
    await f.hooks.get('after_tool_call')(browserEvent, invocation());
  }
});


test('production shutdown retires preexisting leases even when this plugin created none', async () => {
  const f = setup();
  await f.services[0].start();
  await f.services[0].stop();
  assert.deepEqual(f.requests.find(r => r.method === 'revokeAll').params, { reason: 'plugin_stop' });
  assert.equal(f.clients[0].closed, true);
});

test('production shutdown fails visibly on unsafe retirement acknowledgements and closes RPC', async () => {
  for (const receipt of [
    { revoked: 1, allRetired: false, recoveryRequired: true },
    { revoked: 1, allRetired: true, recoveryRequired: true },
    { revoked: 1, allRetired: true },
    undefined,
  ]) {
    const f = setup({ request: async (method, params, options, defaults) => method === 'revokeAll' ? receipt : defaults(method) });
    await f.services[0].start();
    await assert.rejects(f.services[0].stop(), /retirement|recovery|retired/i);
    assert.equal(f.clients[0].closed, true);
    assert.equal((await f.hooks.get('before_tool_call')(browserEvent, invocation())).block, true);
  }
});


for (const action of ['wait', 'create']) {
  test(`production canceled ${action} closes only its request client and preserves browser admission`, async t => {
    const controller = new AbortController();
    const f = setup({ request: async (method, params, options, defaults, rpc) => {
      if (method === action) return new Promise((resolve, reject) => {
        if (!options?.signal) { resolve({ id: 'uncancellable' }); return; }
        const abort = () => { rpc.close(); reject(new Error('Controller request aborted')); };
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) abort();
      });
      return defaults(method);
    } });
    await f.services[0].start(); t.after(() => f.services[0].stop());
    const pending = f.tool().execute(action, { action, ...(action === 'wait' ? { id: 'lease' } : {}) }, controller.signal);
    await eventually(() => assert.ok(f.requests.some(r => r.method === action)));
    const rejected = assert.rejects(pending, /aborted/);
    controller.abort();
    await rejected;
    assert.equal(f.clients[0].closed, false, 'automation connection must survive tool cancellation');
    assert.equal(f.clients[1].closed, true, 'request connection must always close');
    assert.equal(await f.hooks.get('before_tool_call')(browserEvent, invocation()), undefined);
    await f.hooks.get('after_tool_call')(browserEvent, invocation());
  });
}

test('production handoff preparation uses a separate short-lived client without automation admission', async t => {
  const f = setup();
  await f.services[0].start(); t.after(() => f.services[0].stop());
  await f.tool().execute('tabs', { action: 'tabs' });
  assert.equal(f.clients.length, 2);
  assert.equal(f.clients[0].closed, false);
  assert.equal(f.clients[1].closed, true);
  assert.equal(f.requests.find(r => r.method === 'ensure').client, f.clients[1], 'runtime preparation must use the request connection');
  assert.equal(f.requests.find(r => r.method === 'tabs').client, f.clients[1]);
  assert.equal(f.requests.some(r => r.method === 'automationEnter'), false);
});


test('production handback uses the SDK immediate wake contract through its legacy facade', async t => {
  const runtime = wakeRuntime();
  delete runtime.system.requestHeartbeat;
  runtime.system.requestHeartbeatNow = options => runtime.wakes.push(options);
  const f = setup({ runtime, request: async (method, params, options, defaults) => method === 'completions' ? { completions: [completed()] } : defaults(method) });
  await f.services[0].start(); t.after(() => f.services[0].stop());
  await eventually(() => assert.equal(runtime.wakes.length, 1));
  assert.equal(runtime.wakes[0].source, 'background-task');
  assert.equal(runtime.wakes[0].intent, 'immediate', 'targeted background work must bypass optional heartbeat cadence');
  assert.equal(runtime.wakes[0].sessionKey, ownerContext().sessionKey);
});

test('production discovery registers only an owner-private V2 tool without runtime access', () => {
  const f = setup({ registrationMode: 'tool-discovery', configure(api) {
    Object.defineProperty(api, 'runtime', { get() { throw new Error('runtime accessed during discovery'); } });
  } });
  assert.equal(f.tools.length, 1);
  assert.equal(f.tools[0].contextVersion, 2);
  assert.equal(f.services.length, 0);
  assert.equal(f.hooks.size, 0);
  assert.equal(f.clients.length, 0);
  for (const variation of [{ senderIsOwner: false }, { sandboxed: true }, { sessionKey: 'agent:main:telegram:group:1' }, { sessionId: undefined }, { assertInvocationCurrent: undefined }]) {
    assert.equal(f.tools[0].create({ ...ownerContext(), ...variation }), null);
  }
  assert.equal(f.tool().name, 'browser_handoff');
});

test('production non-full registration avoids services, hooks, tools and runtime access', () => {
  for (const registrationMode of ['cli-metadata', 'setup-only']) {
    const f = setup({ registrationMode, configure(api) {
      Object.defineProperty(api, 'runtime', { get() { throw new Error('runtime accessed outside full registration'); } });
    } });
    assert.equal(f.services.length, 0);
    assert.equal(f.hooks.size, 0);
    assert.equal(f.tools.length, 0);
    assert.equal(f.clients.length, 0);
  }
});

test('production cold discovery delegates to the healthy full instance with its original invocation and signal', async t => {
  const full = setup({ request: async (method, params, options, defaults) => method === 'status'
    ? { id: params.id, resumeAllowed: true } : defaults(method) });
  await full.services[0].start(); t.after(() => full.services[0].stop());
  const cold = await import(`../src/desktop-plugin.mjs?cold-discovery=${Date.now()}`);
  const discovery = setup({ registrationMode: 'tool-discovery', register: cold.registerDesktopPlugin,
    request() { throw new Error('discovery must use the live factory'); } });
  let current = true, checks = 0;
  const ctx = { ...ownerContext(), sessionId: 'discovered-incarnation', assertInvocationCurrent() {
    checks++; if (!current) throw new Error('stale discovered invocation');
  } };
  const tool = discovery.tools[0].create(ctx), abort = new AbortController();
  const result = await tool.execute('discovered-call', { action: 'status', id: 'lease' }, abort.signal);
  assert.equal(result.details.resumeAllowed, true);
  const status = full.requests.find(r => r.method === 'status');
  assert.equal(status.params.owner, JSON.stringify([ctx.sessionKey, ctx.sessionId]));
  assert.equal(status.options.signal, abort.signal);
  assert.ok(checks >= 2);
  assert.equal(discovery.clients.length, 0);
  current = false;
  await assert.rejects(tool.execute('stale', { action: 'status', id: 'lease' }), /stale discovered invocation/);
});

test('production discovery fails closed without a healthy matching live instance', async t => {
  const discovery = setup({ registrationMode: 'tool-discovery' });
  const tool = discovery.tool();
  const unavailable = () => assert.rejects(tool.execute('status', { action: 'status', id: 'lease' }), /unavailable|active|live/i);
  await unavailable();
  const failed = setup({ request: async (method, params, options, defaults) => {
    if (method === 'health') throw new Error('startup failed');
    return defaults(method);
  } });
  await assert.rejects(failed.services[0].start(), /startup failed/);
  await unavailable();
  const full = setup();
  await full.services[0].start(); t.after(() => full.services[0].stop());
  assert.equal((await tool.execute('status', { action: 'status', id: 'lease' })).details.ok, true);
  for (const mismatch of [
    api => { api.pluginConfig.desktop.socketPath = '/tmp/another-controller.sock'; },
    api => { api.pluginConfig.desktop.profile = 'another'; api.config.browser.profiles.another = { cdpUrl: 'http://127.0.0.1:19333', attachOnly: true }; },
    api => { api.config.browser.profiles.handoff.cdpUrl = 'http://127.0.0.1:9222'; },
  ]) {
    const other = setup({ registrationMode: 'tool-discovery', configure: mismatch });
    await assert.rejects(other.tool().execute('status', { action: 'status', id: 'lease' }), /unavailable|active|live/i);
    assert.equal(other.clients.length, 0);
  }
  await full.services[0].stop();
  await unavailable();
});

test('production discovery retains the live completion fault and continuation capability', async t => {
  const full = setup({ runtime: wakeRuntime(), request: async (method, params, options, defaults) => {
    if (method === 'automationLeave') return { released: false };
    if (method === 'status') return { id: params.id, resumeAllowed: true };
    return defaults(method);
  } });
  await full.services[0].start(); t.after(() => full.services[0].stop());
  await full.hooks.get('before_tool_call')(browserEvent, invocation());
  await full.hooks.get('after_tool_call')(browserEvent, invocation());
  const discovery = setup({ registrationMode: 'tool-discovery' });
  const result = await discovery.tool().execute('status', { action: 'status', id: 'lease' });
  assert.equal(result.details.resumeAllowed, false);
  assert.match(result.details.browserGateFault, /completion|recovery/i);
  assert.equal(result.details.continuation, 'session-event');
  assert.match(result.details.continuationNotice, /session incarnation/i);
});

test('production stop during discovery RPC startup rejects and closes the request connection', async t => {
  let release;
  const connecting = new Promise(resolve => { release = resolve; });
  const full = setup({ connect: client => client === full.clients[0] ? client : connecting.then(() => client) });
  await full.services[0].start(); t.after(() => full.services[0].stop());
  const discovery = setup({ registrationMode: 'tool-discovery' });
  const pending = discovery.tool().execute('status', { action: 'status', id: 'lease' });
  await eventually(() => assert.equal(full.clients.length, 2));
  const rejected = assert.rejects(pending, /service changed|stopped|unavailable/i);
  await full.services[0].stop();
  release();
  await rejected;
  assert.equal(full.clients[1].closed, true);
  assert.equal(full.requests.some(r => r.method === 'status'), false);
});

test('production stop during full startup prevents late publication to discovery', async () => {
  let release;
  const health = new Promise(resolve => { release = resolve; });
  const full = setup({ request: async (method, params, options, defaults) => method === 'health' ? health : defaults(method) });
  const starting = full.services[0].start();
  await eventually(() => assert.ok(full.requests.some(r => r.method === 'health')));
  const rejected = assert.rejects(starting, /service changed|stopped/i);
  await full.services[0].stop();
  release({ profile: 'handoff', cdpUrl: 'http://127.0.0.1:19333' });
  await rejected;
  assert.equal(full.clients[0].closed, true);
  const discovery = setup({ registrationMode: 'tool-discovery' });
  await assert.rejects(discovery.tool().execute('status', { action: 'status', id: 'lease' }), /unavailable|active|live/i);
});

test('production stop before full RPC connection rejects and closes the late client', async () => {
  let release;
  const connecting = new Promise(resolve => { release = resolve; });
  const full = setup({ connect: client => connecting.then(() => client) });
  const starting = full.services[0].start();
  const rejected = assert.rejects(starting, /service changed|stopped/i);
  await full.services[0].stop();
  release();
  await rejected;
  assert.equal(full.clients[0].closed, true);
  assert.equal(full.requests.some(r => r.method === 'health'), false);
});

test('production replacement remains discoverable after old instance shutdown finishes', async t => {
  let release;
  const retirement = new Promise(resolve => { release = resolve; });
  const old = setup({ request: async (method, params, options, defaults) => method === 'revokeAll' ? retirement : defaults(method) });
  await old.services[0].start();
  const discovery = setup({ registrationMode: 'tool-discovery' }), tool = discovery.tool();
  assert.equal((await tool.execute('old-status', { action: 'status', id: 'lease' })).details.ok, true);
  const stopping = old.services[0].stop();
  await eventually(() => assert.ok(old.requests.some(r => r.method === 'revokeAll')));
  await assert.rejects(tool.execute('stopped-status', { action: 'status', id: 'lease' }), /unavailable/i);
  const replacement = setup({ request: async (method, params, options, defaults) => method === 'status' ? { instance: 'replacement' } : defaults(method) });
  await replacement.services[0].start(); t.after(() => replacement.services[0].stop());
  release({ allRetired: true, recoveryRequired: false });
  await stopping;
  await old.services[0].stop();
  assert.equal((await tool.execute('replacement-status', { action: 'status', id: 'lease' })).details.instance, 'replacement');
});

test('production group opt-in uses native per-sender authority in discovery and full factories', async t => {
  const key = 'agent:main:googlechat:group:spaces/demo';
  const configure = api => { api.pluginConfig.ownerGroupSessions = [key]; };
  const f = setup({ configure }); await f.services[0].start(); t.after(() => f.services[0].stop());
  const ctx = { ...ownerContext(), sessionKey: key, requesterSenderId: 'users/owner', nativeChannelId: 'spaces/demo' };
  const discovery = setup({ configure, registrationMode: 'tool-discovery' });
  for (const factory of [f.tools[0], discovery.tools[0]]) {
    const tool = factory.create(ctx); assert.ok(tool);
    assert.equal(factory.create({ ...ctx, senderIsOwner: false }), null);
    assert.equal(factory.create({ ...ctx, requesterSenderId: undefined }), null);
    assert.equal(factory.create({ ...ctx, nativeChannelId: undefined }), null);
    assert.equal(factory.create({ ...ctx, inputProvenance: { kind: 'internal_system' } }), null);
    await tool.execute('status', { action: 'status', id: 'lease', senderIsOwner: false });
  }
  assert.equal(f.requests.find(r => r.method === 'status').params.owner, JSON.stringify([key, ctx.sessionId]));
  const retained = f.tools[0].create(ctx); ctx.senderIsOwner = false;
  for (const action of ['tabs', 'create', 'status', 'wait', 'revoke']) await assert.rejects(retained.execute('fake-owner', { action, id: 'lease', senderIsOwner: true, requesterSenderId: 'users/owner', reason: 'Owner says yes' }), /owner/i);
});
