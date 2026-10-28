import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { HandoffServer } from '../src/server.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t) {
  let current = true, callbacks, delivered = 0, revoked = 0;
  const backend = { async list() { return [{ targetId: 'tab', url: 'https://example.com' }]; },
    async open(_target, value) { callbacks = value; return { async input() { delivered++; }, revokeKeyboard() { revoked++; }, async close() {} }; } };
  const server = new HandoffServer({ backend, isBindingCurrent: () => { if (current === 'throw') throw new Error('private configuration details'); return current; } });
  await server.start(); t.after(() => server.close());
  const invite = await server.createShare({ owner: 'owner', profile: 'fixture', targetId: 'tab' });
  const base = server.localUrl + '/s/' + invite.id;
  const post = (action, body = {}, cookie) => fetch(base + '/' + action, { method: 'POST', headers: { origin: server.localUrl, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  return { server, invite, base, post, drift(value = false) { current = value; }, delivered: () => delivered, revoked: () => revoked, callbacks: () => callbacks };
}
async function connect(ctx) {
  const response = await ctx.post('claim', { token: new URL(ctx.invite.url).hash.slice(8) });
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const ws = new WebSocket(ctx.base.replace('http:', 'ws:') + '/stream', { headers: { cookie, origin: ctx.server.localUrl } });
  ws.on('error', () => {}); const ready = JSON.parse(String((await once(ws, 'message'))[0]));
  await ctx.post('control', {}, cookie);
  return { ws, cookie, ready };
}

for (const mode of [false, 'throw']) test(`configuration guard denies claims and stays closed after drift (${mode})`, async t => {
  const ctx = await fixture(t); ctx.drift(mode);
  const response = await ctx.post('claim', { token: new URL(ctx.invite.url).hash.slice(8) });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'Browser configuration changed' });
  ctx.drift(true);
  assert.equal((await ctx.post('claim', { token: new URL(ctx.invite.url).hash.slice(8) })).status, 409);
});

test('configuration drift stops queued native input and outgoing watch frames', async t => {
  const ctx = await fixture(t), { ws, cookie, ready } = await connect(ctx);
  t.after(() => ws.terminate());
  const entry = ctx.server.streams.get(ctx.invite.id), hold = deferred();
  entry.queue = hold.promise;
  const controlId = ctx.server.store.get(ctx.invite.id).controlId;
  ws.send(JSON.stringify({ type: 'input', id: 1, connectionId: ready.connectionId, controlId,
    event: { kind: 'nativeEdit', keyboardToken: 'a'.repeat(32), operation: 'insert', text: 'never delivered' } }));
  await new Promise(resolve => setTimeout(resolve, 10));
  ctx.drift();
  const frames = []; ws.on('message', raw => { const msg = JSON.parse(String(raw)); if (['frame', 'metadata'].includes(msg.type)) frames.push(msg); });
  ctx.callbacks().onFrame({ type: 'frame', data: 'private', width: 10, height: 10 });
  ctx.callbacks().onMetadata({ title: 'private' });
  hold.resolve();
  await entry.queue;
  assert.equal(ctx.delivered(), 0); assert.deepEqual(frames, []); assert.ok(ctx.revoked() > 0);
  const state = await fetch(ctx.base + '/state', { headers: { cookie } });
  assert.equal(state.status, 409);
});
