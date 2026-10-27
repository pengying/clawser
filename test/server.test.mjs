import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect as tcpConnect } from 'node:net';
import { WebSocket } from 'ws';
import { HandoffServer } from '../src/server.mjs';

export class FakeBrowser {
  inputs = [];
  async list() { return [{ targetId: 'tab1', title: 'Demo', url: 'https://example.com' }]; }
  async open(_target, callbacks) {
    this.callbacks = callbacks;
    return { input: async (event) => { this.inputs.push(event); }, close: async () => {} };
  }
}
async function setup(t, { permission = 'control', ttlMs = 10_000, backend = new FakeBrowser() } = {}) {
  const server = new HandoffServer({ backend });
  await server.start();
  t.after(() => server.close());
  const invite = await server.createShare({ owner: 'owner', profile: 'demo', targetId: 'tab1', permission, ttlMs });
  const base = new URL(`/s/${invite.id}`, server.localUrl).href;
  const post = (route, data = {}, cookie, origin = server.localUrl) => fetch(`${base}/${route}`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(data),
  });
  return { server, backend, invite, base, post };
}

for (const ending of ['release', 'done', 'disconnect', 'expiry']) test(`held gesture blocks agent entry until acknowledged cleanup on ${ending}`, async (t) => {
  let confirmCleanup, cleanupStarted = false;
  const cleaned = new Promise((resolve) => { confirmCleanup = resolve; });
  const backend = new FakeBrowser();
  backend.open = async () => ({ input: async () => ({}), cancelGesture: async () => { cleanupStarted = true; await cleaned; }, close: async () => {} });
  const ctx = await setup(t, { backend });
  try {
    const cookie = await claim(ctx), ws = await connect(ctx, cookie);
    await ctx.post('control', {}, cookie);
    const ack = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'input', event: { kind: 'pointer', phase: 'down', pointerType: 'mouse', gesture: 1, x: .2, y: .3 } }));
    await ack;
    assert.equal(ctx.server.store.gate.humanInputs, 1, 'a button held between RPCs keeps a persistent gate hold');
    if (ending === 'disconnect') { const closed = once(ws, 'close'); ws.close(); await closed; }
    else if (ending === 'expiry') { ctx.server.store.get(ctx.invite.id).expiresAt = Date.now() - 1; ctx.server.store.sweep(); }
    else await ctx.post(ending, {}, cookie);
    assert.equal(ctx.server.store.gate.locked, true);
    assert.throws(() => ctx.server.store.gate.enter('agent'), /human control/i);
    await new Promise(setImmediate);
    assert.equal(cleanupStarted, true);
    confirmCleanup();
    for (let n = 0; n < 20 && ctx.server.store.gate.locked; n++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(ctx.server.store.gate.locked, false);
    ws.close();
  } finally { confirmCleanup(); }
});

test('uncertain held-gesture cleanup poisons the gate instead of resuming the agent', async (t) => {
  const backend = new FakeBrowser();
  backend.open = async () => ({ input: async () => ({}), cancelGesture: async () => { throw new Error('unacknowledged up'); }, close: async () => {} });
  const ctx = await setup(t, { backend }), cookie = await claim(ctx), ws = await connect(ctx, cookie);
  await ctx.post('control', {}, cookie);
  const ack = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'input', event: { kind: 'pointer', phase: 'down', pointerType: 'touch', gesture: 1, x: .2, y: .3 } }));
  await ack; await ctx.post('release', {}, cookie);
  for (let n = 0; n < 20 && !ctx.server.store.gate.poisonReason; n++) await new Promise((r) => setTimeout(r, 5));
  assert.match(ctx.server.store.gate.poisonReason, /uncertain/i);
  assert.throws(() => ctx.server.store.gate.enter('agent'), /uncertain/i);
  ws.close();
});

for (const failure of ['input', 'cancellation']) test(`rejected connection close is contained after uncertain ${failure}`, async (t) => {
  let closes = 0;
  const backend = new FakeBrowser();
  backend.open = async () => ({
    input: async () => { if (failure === 'input') throw new Error('input outcome unknown'); },
    cancelGesture: async () => { throw new Error('release outcome unknown'); },
    close: async () => { closes++; throw new Error('connection close rejected'); },
  });
  const ctx = await setup(t, { backend }), cookie = await claim(ctx), ws = await connect(ctx, cookie);
  await ctx.post('control', {}, cookie);
  const reply = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'input', event: { kind: 'pointer', phase: 'down', pointerType: 'touch', gesture: 1, x: .2, y: .3 } }));
  await reply;
  if (failure === 'cancellation') await ctx.post('release', {}, cookie);
  await ctx.server.streams.get(ctx.invite.id).queue;
  await new Promise(setImmediate);
  assert.ok(closes > 0, 'the actual connection close is attempted despite the earlier failure');
  assert.match(ctx.server.store.gate.poisonReason, /uncertain/i);
  assert.throws(() => ctx.server.store.gate.enter('agent'), /uncertain/i);
  ws.close();
});

test('cleanup still cancels and closes after an earlier queued operation rejects', async () => {
  const server = new HandoffServer({ backend: new FakeBrowser() });
  let cancels = 0, closes = 0;
  await server.store.gate.acquire('share');
  server.store.gate.beginInput('share');
  const entry = {
    share: { id: 'share' }, gestureHeld: true, opening: Promise.resolve(),
    queue: Promise.reject(new Error('earlier queued operation rejected')),
    connection: { cancelGesture: async () => { cancels++; }, close: async () => { closes++; throw new Error('connection close rejected'); } },
  };
  server.streams.set('share', entry);
  await server.cleanup(entry);
  await new Promise(setImmediate);
  assert.equal(cancels, 1, 'an earlier queue error does not skip held-gesture cancellation');
  assert.equal(closes, 1, 'capture close is still attempted after the queue error');
  assert.equal(server.closing.size, 0);
  assert.equal(server.streams.has('share'), false);
  assert.match(server.store.gate.poisonReason, /uncertain/i);
  assert.throws(() => server.store.gate.enter('agent'), /uncertain/i);
  await server.close();
});

test('release during an in-flight down waits for both down and server-owned cancellation', async (t) => {
  let finishDown, finishCancel, downStarted = false, cancelStarted = false;
  const down = new Promise((resolve) => { finishDown = resolve; }), cancel = new Promise((resolve) => { finishCancel = resolve; });
  const backend = new FakeBrowser();
  backend.open = async () => ({ input: async () => { downStarted = true; await down; }, cancelGesture: async () => { cancelStarted = true; await cancel; }, close: async () => {} });
  const ctx = await setup(t, { backend }), cookie = await claim(ctx), ws = await connect(ctx, cookie);
  try {
    await ctx.post('control', {}, cookie);
    ws.send(JSON.stringify({ type: 'input', event: { kind: 'pointer', phase: 'down', pointerType: 'mouse', gesture: 1, x: .2, y: .3 } }));
    for (let n = 0; n < 20 && !downStarted; n++) await new Promise((r) => setTimeout(r, 5));
    await ctx.post('release', {}, cookie);
    assert.equal(ctx.server.store.gate.humanInputs, 2);
    finishDown();
    for (let n = 0; n < 20 && !cancelStarted; n++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(ctx.server.store.gate.humanInputs, 1);
    assert.equal(ctx.server.store.gate.locked, true);
    finishCancel();
    for (let n = 0; n < 20 && ctx.server.store.gate.locked; n++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(ctx.server.store.gate.locked, false);
  } finally { finishDown(); finishCancel(); ws.close(); }
});

test('reconnection cannot replace a stream until its held gesture and capture close settle', async (t) => {
  let finishCancel, finishClose, cancelStarted = false, closeStarted = false, opens = 0;
  const cancel = new Promise((resolve) => { finishCancel = resolve; }), closing = new Promise((resolve) => { finishClose = resolve; });
  const backend = new FakeBrowser();
  backend.open = async () => {
    opens++;
    return { input: async () => ({}), cancelGesture: async () => { cancelStarted = true; await cancel; }, close: async () => { closeStarted = true; await closing; } };
  };
  const ctx = await setup(t, { backend }), cookie = await claim(ctx), ws = await connect(ctx, cookie);
  const tryReplacement = async () => {
    const replacement = new WebSocket(`${ctx.base.replace('http:', 'ws:')}/stream`, { headers: { cookie, origin: ctx.server.localUrl } });
    replacement.on('error', () => {});
    const result = await Promise.race([
      once(replacement, 'unexpected-response').then(([, response]) => { response.resume(); return response.statusCode; }),
      once(replacement, 'open').then(() => 101),
    ]);
    replacement.terminate(); return result;
  };
  try {
    await ctx.post('control', {}, cookie);
    const ack = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'input', event: { kind: 'pointer', phase: 'down', pointerType: 'touch', gesture: 1, x: .2, y: .3 } })); await ack;
    const closed = once(ws, 'close'); ws.close(); await closed;
    for (let n = 0; n < 20 && !cancelStarted; n++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(await tryReplacement(), 401, 'new capture is refused while old contact cancellation is unacknowledged');
    assert.equal(opens, 1);
    finishCancel();
    for (let n = 0; n < 20 && !closeStarted; n++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(await tryReplacement(), 401, 'the old capture must close before another screencast attaches');
    finishClose();
    for (let n = 0; n < 20 && ctx.server.streams.has(ctx.invite.id); n++) await new Promise((r) => setTimeout(r, 5));
    const replacement = await connect(ctx, cookie); replacement.close();
    assert.equal(opens, 2);
  } finally { finishCancel(); finishClose(); ws.close(); }
});
async function claim(ctx) {
  const res = await ctx.post('claim', { token: new URL(ctx.invite.url).hash.slice('#invite='.length) });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}
async function connect(ctx, cookie) {
  const ws = new WebSocket(`${ctx.base.replace('http:', 'ws:')}/stream`, { headers: { cookie, origin: ctx.server.localUrl } });
  const first = once(ws, 'message');
  await once(ws, 'open');
  const ready = JSON.parse(String((await first)[0]));
  let sequence = 0;
  ws.rawSend = ws.send.bind(ws);
  ws.send = (data, ...args) => {
    const packet = JSON.parse(String(data));
    if (packet.type === 'input') {
      packet.id ??= ++sequence;
      packet.connectionId ??= ready.connectionId;
      packet.controlId ??= ctx.server.store.shares.get(ctx.invite.id)?.controlId;
    }
    return ws.rawSend(JSON.stringify(packet), ...args);
  };
  ws.connectionId = ready.connectionId;
  return ws;
}

const edit = (operation, text, focusToken = 'a'.repeat(32)) => ({ kind: 'edit', operation, focusToken, ...(text === undefined ? {} : { text }) });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const activity of ['executing input', 'held touch']) test(`capture closes during ${activity}: recovery is reported before disconnect`, async (t) => {
  let finishInput, announce;
  const held = new Promise(resolve => { finishInput = resolve; }), started = new Promise(resolve => { announce = resolve; });
  const backend = new FakeBrowser();
  backend.open = async (_target, callbacks) => {
    backend.callbacks = callbacks;
    return { input: async () => { announce(); if (activity === 'executing input') await held; }, cancelGesture: async () => {}, close: async () => {} };
  };
  const ctx = await setup(t, { backend }), cookie = await claim(ctx), ws = await connect(ctx, cookie);
  try {
    await ctx.post('control', {}, cookie);
    const entry = ctx.server.streams.get(ctx.invite.id);
    const firstAck = activity === 'held touch' ? once(ws, 'message') : null;
    ws.send(JSON.stringify({ type: 'input', event: activity === 'held touch'
      ? { kind: 'pointer', phase: 'down', pointerType: 'touch', gesture: 1, x: .2, y: .3 }
      : { kind: 'click', x: .2, y: .3 } }));
    await started; if (firstAck) { await firstAck; await entry.queue; }
    const outcome = Promise.race([once(ws, 'message').then(([raw]) => JSON.parse(String(raw))), once(ws, 'close').then(() => ({ type: 'closed' }))]);
    backend.callbacks.onClose();
    assert.equal(ctx.server.store.gate.humanInputs, 1, 'unsettled input remains held during recovery');
    const reply = await outcome;
    assert.equal(reply.type, 'error'); assert.equal(reply.recoveryRequired, true, 'capture failure must not masquerade as a normal unavailable tab');
    const state = await (await fetch(`${ctx.base}/state`, { headers: { cookie } })).json();
    assert.equal(state.recoveryRequired, true);
    const denied = await ctx.post('control', {}, cookie);
    assert.equal(denied.status, 409); assert.equal((await denied.json()).recoveryRequired, true);
    finishInput(); await entry.queue;
    assert.match(ctx.server.store.gate.poisonReason, /uncertain/i);
  } finally { finishInput(); ws.close(); }
});

for (const failure of ['execution', 'invalid-packet']) test(`pipelined successors stop after the first ${failure} failure`, async (t) => {
  let finish, announce;
  const held = new Promise(resolve => { finish = resolve; }), started = new Promise(resolve => { announce = resolve; });
  const backend = new FakeBrowser();
  backend.open = async () => ({ input: async event => {
    backend.inputs.push(event);
    if (backend.inputs.length === 1) { announce(); await held; if (failure === 'execution') throw Object.assign(new Error('Definitive rejection'), { definitive: true }); }
  }, close: async () => {} });
  const ctx = await setup(t, { backend }), cookie = await claim(ctx), ws = await connect(ctx, cookie);
  try {
    await ctx.post('control', {}, cookie);
    const entry = ctx.server.streams.get(ctx.invite.id), event = { kind: 'click', x: .2, y: .3 };
    ws.send(JSON.stringify({ type: 'input', event })); await started;
    ws.send(JSON.stringify({ type: 'input', event })); ws.send(JSON.stringify({ type: 'input', event }));
    for (let n = 0; n < 30 && entry.pending < 3; n++) await delay(5);
    assert.equal(entry.pending, 3, 'successors are received while the first input is held');
    if (failure === 'invalid-packet') { ws.send(JSON.stringify({ type: 'input', event: { kind: 'unsupported' } })); await delay(20); }
    finish(); await entry.queue; await delay(20);
    assert.equal(backend.inputs.length, 1, 'a failed operation cannot be followed by already queued browser mutations');
    assert.notEqual(ws.readyState, WebSocket.OPEN, 'recovery needs a fresh stream rather than replaying queued input');
    assert.equal(ctx.server.store.gate.humanInputs, 0); assert.equal(ctx.server.store.gate.poisonReason, null);
  } finally { finish(); ws.close(); }
});

test('a saturated receiver is disconnected instead of accumulating control replies', async (t) => {
  const ctx = await setup(t), cookie = await claim(ctx), ws = await connect(ctx, cookie);
  await ctx.post('control', {}, cookie);
  const entry = ctx.server.streams.get(ctx.invite.id);
  Object.defineProperty(entry.ws, 'bufferedAmount', { value: 1_000_001 });
  const result = Promise.race([once(ws, 'close').then(() => 'closed'), once(ws, 'message').then(() => 'reply')]);
  ws.send(JSON.stringify({ type: 'input', controlId: 'stale', event: { kind: 'click', x: .2, y: .3 } }));
  assert.equal(await result, 'closed', 'non-reading recipients must not build an unlimited queue of error replies');
  assert.equal(ctx.backend.inputs.length, 0);
});

test('display delivery waits for the receiver and retains only the latest frame', async (t) => {
  const ctx = await setup(t), cookie = await claim(ctx), ws = await connect(ctx, cookie), received = [];
  ws.on('message', raw => received.push(JSON.parse(String(raw))));
  const frame = data => ctx.backend.callbacks.onFrame({ type: 'frame', data, width: 800, height: 600 });
  frame('first'); await delay(90);
  frame('second'); await delay(80); frame('latest'); await delay(80);
  assert.equal(received.length, 1, 'slow recipients must not accumulate already-sent old frames');
  const first = received[0]; assert.equal(first.data, 'first');
  assert.ok(Number.isSafeInteger(first.displayId));
  ws.send(JSON.stringify({ type: 'displayAck', connectionId: 'wrong', displayId: first.displayId }));
  ws.send(JSON.stringify({ type: 'displayAck', connectionId: ws.connectionId, displayId: first.displayId + 1 }));
  await delay(80); assert.equal(received.length, 1, 'invalid ACKs cannot release the outstanding frame');
  ws.send(JSON.stringify({ type: 'displayAck', connectionId: ws.connectionId, displayId: first.displayId, decodeMs: 2 }));
  await delay(80);
  assert.equal(received.length, 2); assert.equal(received[1].data, 'latest');
  frame('after-latest');
  ws.send(JSON.stringify({ type: 'displayAck', connectionId: ws.connectionId, displayId: first.displayId }));
  await delay(80); assert.equal(received.length, 2, 'a duplicate ACK cannot release a different frame');
  assert.equal(ctx.server.store.get(ctx.invite.id).mode, 'watch', 'display ACKs cannot acquire control');
  assert.equal(ctx.server.streams.get(ctx.invite.id).lastInput, 0, 'display and input sequences are independent');
  ws.close();
});

test('metadata shares display backpressure and the latest snapshot travels with the next frame', async (t) => {
  const ctx = await setup(t), cookie = await claim(ctx), ws = await connect(ctx, cookie), received = [];
  ws.on('message', raw => received.push(JSON.parse(String(raw))));
  ctx.backend.callbacks.onMetadata({ title: 'initial' }); await delay(20);
  assert.equal(received[0].type, 'metadata');
  ctx.backend.callbacks.onMetadata({ title: 'intermediate', url: 'https://example.com/fixture' });
  ctx.backend.callbacks.onMetadata({ title: 'latest' });
  ctx.backend.callbacks.onFrame({ type: 'frame', data: 'latest-frame', width: 800, height: 600 });
  await delay(100); assert.equal(received.length, 1, 'metadata cannot build an unbounded second queue');
  ws.send(JSON.stringify({ type: 'displayAck', connectionId: ws.connectionId, displayId: received[0].displayId }));
  await delay(80);
  assert.equal(received.length, 2); assert.equal(received[1].type, 'frame');
  assert.equal(received[1].metadata.title, 'latest');
  assert.equal(received[1].metadata.url, 'https://example.com/fixture', 'partial metadata updates are merged');
  ws.close();
});

test('input acknowledgement is sent before the next display update', async (t) => {
  let finishInput, announceStarted;
  const held = new Promise(resolve => { finishInput = resolve; }), started = new Promise(resolve => { announceStarted = resolve; });
  const backend = new FakeBrowser();
  backend.open = async (_target, callbacks) => { backend.callbacks = callbacks; return { input: async () => { announceStarted(); await held; }, close: async () => {} }; };
  const ctx = await setup(t, { backend }), cookie = await claim(ctx), ws = await connect(ctx, cookie), received = [];
  ws.on('message', raw => received.push(JSON.parse(String(raw))));
  try {
    await ctx.post('control', {}, cookie);
    ws.send(JSON.stringify({ type: 'input', event: { kind: 'click', x: .2, y: .3 } })); await started;
    backend.callbacks.onFrame({ type: 'frame', data: 'changed-page', width: 800, height: 600 });
    backend.callbacks.onMetadata({ title: 'changed-title' });
    await delay(100); assert.equal(received.length, 0, 'new display bytes wait behind pending input processing');
    finishInput(); await delay(100);
    assert.deepEqual(received.map(message => message.type), ['inputAck', 'frame']);
    assert.equal(received[1].metadata.title, 'changed-title');
  } finally { finishInput(); ws.close(); }
});

test('a bounded edit batch preserves individual input order and acknowledges once', async (t) => {
  const backend = new FakeBrowser(), focus = { token: 'a'.repeat(32) };
  backend.open = async () => ({ input: async (event) => { backend.inputs.push(event); return { focus }; }, close: async () => {} });
  const ctx = await setup(t, { backend }), cookie = await claim(ctx), ws = await connect(ctx, cookie);
  await ctx.post('control', {}, cookie);
  const events = [edit('insert', 'a'), edit('insert', 'b'), edit('backspace'), edit('insert', 'c')];
  const response = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'input', events }));
  const reply = JSON.parse(String((await response)[0]));
  assert.equal(reply.type, 'inputAck');
  assert.deepEqual(backend.inputs, events, 'each native edit is dispatched separately, without converting typing into paste');
  assert.deepEqual(reply.focus, focus);
  assert.equal(ctx.server.store.gate.humanInputs, 0);
  ws.close();
});

for (const events of [[], Array(9).fill(edit('insert', 'a')), [edit('insert', 'a'), { kind: 'click', x: .2, y: .3 }],
  [edit('insert', 'a'), edit('insert', 'b', 'b'.repeat(32))], [edit('insert', 'a'), edit('enter')], [edit('insert', 'a'.repeat(257))]])
  test(`invalid edit batch is rejected before any dispatch: ${JSON.stringify(events).slice(0, 90)}`, async (t) => {
    const ctx = await setup(t), cookie = await claim(ctx), ws = await connect(ctx, cookie);
    await ctx.post('control', {}, cookie);
    const response = once(ws, 'message'); ws.send(JSON.stringify({ type: 'input', events }));
    assert.equal(JSON.parse(String((await response)[0])).type, 'error');
    assert.equal(ctx.backend.inputs.length, 0);
    ws.close();
  });

for (const uncertain of [false, true]) test(`edit batch stops at the first ${uncertain ? 'uncertain input' : 'focused-field rejection'}`, async (t) => {
  const backend = new FakeBrowser();
  backend.open = async () => ({
    input: async (event) => {
      backend.inputs.push(event);
      if (backend.inputs.length === 2) throw Object.assign(new Error('Focused field changed'), { definitive: !uncertain });
    }, close: async () => {},
  });
  const ctx = await setup(t, { backend }), cookie = await claim(ctx), ws = await connect(ctx, cookie);
  await ctx.post('control', {}, cookie);
  const response = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'input', events: [edit('insert', 'a'), edit('insert', 'b'), edit('insert', 'c')] }));
  assert.equal(JSON.parse(String((await response)[0])).type, 'error');
  assert.equal(backend.inputs.length, 2, 'the remaining batch is discarded after the failed edit');
  assert.equal(Boolean(ctx.server.store.gate.poisonReason), uncertain);
  assert.equal(ctx.server.store.gate.humanInputs, 0);
  ws.close();
});

for (const ending of ['release', 'done', 'disconnect', 'expiry']) test(`edit batch stops between operations on ${ending} while keeping in-flight input gated`, async (t) => {
  let finishFirst, announceStarted;
  const held = new Promise(resolve => { finishFirst = resolve; }), started = new Promise(resolve => { announceStarted = resolve; });
  const backend = new FakeBrowser();
  backend.open = async () => ({ input: async (event) => { backend.inputs.push(event); announceStarted(); await held; }, close: async () => {} });
  const ctx = await setup(t, { backend }), cookie = await claim(ctx), ws = await connect(ctx, cookie);
  try {
    await ctx.post('control', {}, cookie);
    const earlyReply = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'input', events: [edit('insert', 'a'), edit('insert', 'b')] }));
    assert.equal(await Promise.race([started.then(() => 'started'), earlyReply.then(() => 'rejected')]), 'started');
    const entry = ctx.server.streams.get(ctx.invite.id);
    if (ending === 'disconnect') { const closed = once(ws, 'close'); ws.close(); await closed; }
    else if (ending === 'expiry') { ctx.server.store.get(ctx.invite.id).expiresAt = Date.now() - 1; ctx.server.store.sweep(); }
    else await ctx.post(ending, {}, cookie);
    assert.equal(ctx.server.store.gate.locked, true);
    assert.throws(() => ctx.server.store.gate.enter('agent'), /human control/i);
    finishFirst(); await entry.queue;
    assert.equal(backend.inputs.length, 1, 'no later edit executes after control ends');
    assert.equal(ctx.server.store.gate.humanInputs, 0);
    assert.equal(ctx.server.store.gate.poisonReason, null);
    assert.equal(ctx.server.store.gate.locked, false);
  } finally { finishFirst(); ws.close(); }
});

test('old control epochs cannot replay input after handback and reacquisition', async (t) => {
  const ctx = await setup(t), cookie = await claim(ctx), ws = await connect(ctx, cookie);
  await ctx.post('control', {}, cookie);
  const old = ctx.server.store.get(ctx.invite.id).controlId;
  await ctx.post('release', {}, cookie); await ctx.post('control', {}, cookie);
  const response = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'input', controlId: old, event: { kind: 'click', x: .2, y: .3 } }));
  assert.match(String((await response)[0]), /stale|generation/i);
  assert.equal(ctx.backend.inputs.length, 0);
  ws.close();
});

test('GET previews do not claim invitation; POST claim is one-use and secret stays out of response', async (t) => {
  const ctx = await setup(t);
  assert.equal((await fetch(`${ctx.base}/`)).status, 200);
  assert.equal(ctx.server.store.get(ctx.invite.id).mode, 'unclaimed');
  const cookie = await claim(ctx);
  assert.ok(cookie.startsWith('handoff='));
  const replay = await ctx.post('claim', { token: new URL(ctx.invite.url).hash.slice(8) });
  assert.equal(replay.status, 401);
});

test('cross-origin requests, missing authentication, malformed input and oversized bodies are rejected', async (t) => {
  const ctx = await setup(t);
  assert.equal((await ctx.post('claim', {}, undefined, 'https://evil.example')).status, 403);
  assert.equal((await ctx.post('control')).status, 401);
  assert.equal((await ctx.post('claim', { token: 'x'.repeat(20_000) })).status, 413);
  const cookie = await claim(ctx);
  assert.equal((await ctx.post('control', {}, cookie)).status, 409, 'need a ready stream before control');
  assert.equal((await fetch(`${ctx.base}/state`, { headers: { cookie } })).headers.get('cache-control'), 'no-store');
});

test('watch mode cannot send input; explicit takeover allows input and disconnect releases gate', async (t) => {
  const ctx = await setup(t);
  const cookie = await claim(ctx);
  let ws = await connect(ctx, cookie);
  const error = once(ws, 'message');
  const rejected = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'input', event: { kind: 'click', x: 0.2, y: 0.3 } }));
  assert.match(String((await error)[0]), /control/i);
  assert.equal(ctx.backend.inputs.length, 0);
  await rejected;
  for (let n = 0; n < 30 && ctx.server.streams.has(ctx.invite.id); n++) await delay(5);
  ws = await connect(ctx, cookie);
  assert.equal((await ctx.post('control', {}, cookie)).status, 200);
  const ack = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'input', event: { kind: 'click', x: 0.2, y: 0.3 } }));
  await ack;
  assert.equal(ctx.backend.inputs.length, 1);
  assert.equal(ctx.server.store.gate.locked, true);
  const closed = once(ws, 'close'); ws.close(); await closed;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ctx.server.store.gate.locked, false);
});

test('watch-only share and foreign websocket origins cannot gain control', async (t) => {
  const ctx = await setup(t, { permission: 'watch' });
  const cookie = await claim(ctx);
  const ws = await connect(ctx, cookie);
  assert.equal((await ctx.post('control', {}, cookie)).status, 403);
  const foreign = new WebSocket(`${ctx.base.replace('http:', 'ws:')}/stream`, { headers: { cookie, origin: 'https://evil.example' } });
  const response = once(foreign, 'unexpected-response');
  const [, res] = await response;
  assert.equal(res.statusCode, 401); res.resume(); foreign.terminate();
  foreign.on('error', () => {});
  ws.close();
});

test('expiry closes an already-open stream and revokes its input authority', async (t) => {
  const ctx = await setup(t, { ttlMs: 400 });
  const cookie = await claim(ctx);
  const ws = await connect(ctx, cookie);
  await ctx.post('control', {}, cookie);
  const [code] = await once(ws, 'close');
  assert.equal(code, 4001);
  assert.equal(ctx.server.store.gate.locked, false);
  assert.equal((await ctx.post('control', {}, cookie)).status, 401);
});

test('malformed unauthenticated Upgrade request cannot escape exception handling', async (t) => {
  const ctx = await setup(t);
  const socket = tcpConnect(new URL(ctx.server.localUrl).port, '127.0.0.1');
  const received = once(socket, 'data');
  await once(socket, 'connect');
  socket.write('GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  assert.match(String((await received)[0]), /401/); socket.destroy();
  assert.equal((await fetch(`${ctx.base}/`)).status, 200);
});

test('indeterminate input failure leaves agent gate locked even after release and disconnect', async (t) => {
  const ctx = await setup(t);
  ctx.backend.open = async () => ({ input: async () => { throw new Error('Missing browser ACK'); }, close: async () => {} });
  const cookie = await claim(ctx), ws = await connect(ctx, cookie);
  await ctx.post('control', {}, cookie);
  const result = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'input', event: { kind: 'text', text: 'example' } }));
  assert.match(String((await result)[0]), /uncertain/i);
  await ctx.post('release', {}, cookie);
  assert.throws(() => ctx.server.store.gate.enter('agent'), /uncertain/i);
  ws.close();
});
