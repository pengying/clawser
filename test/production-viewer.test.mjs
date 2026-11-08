import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { Duplex } from 'node:stream';
import { WebSocket } from 'ws';
import { NoVncProbeGateway } from '../src/novnc-probe.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
class Socket extends Duplex { _read() {} _write(_data, _encoding, callback) { callback(); } }
async function fixture(t, options = {}) {
  let text = '', destroys = 0;
  const supervisor = {
    async create({ probeId }) { return { ownedId: probeId }; },
    async read() { return { state: 'running' }; },
    async register() { return { endpoint: { path: '/tmp/fixture.sock' }, credentials: { watch: 'watch123', control: 'oldadmin' } }; },
    async promote() { return { endpoint: { path: '/tmp/fixture.sock' }, credentials: { watch: 'unused12', control: 'newadmin' } }; },
    async clipboardRead() { return { text }; }, async clipboardWrite(_id, value) { text = value; },
    async destroy() { destroys++; }, async verifyExited() { return true; }, ...options.supervisor,
  };
  const gateway = new NoVncProbeGateway({ supervisor, upstreamConnect: async () => new Socket(),
    prefix: '/browser/', completionDisposition: 'retained', capabilities: { clipboard: 'utf8' },
    onEnded: options.onEnded, ...options.gateway });
  await gateway.start({ port: 0 }); t.after(() => gateway.close());
  const invite = await gateway.createProbe({ ttlSeconds: 60, permission: options.permission || 'control' });
  const url = new URL(invite.url), base = url.origin + url.pathname;
  const post = (action, body = {}, cookie) => fetch(base + action, { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const claim = await post('claim', { token: url.hash.slice(8) });
  const cookie = claim.headers.get('set-cookie')?.split(';')[0];
  const open = async generation => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + 'stream/' + generation, { origin: url.origin, headers: { cookie } });
    ws.on('error', () => {}); t.after(() => ws.terminate()); await once(ws, 'open'); return ws;
  };
  return { gateway, invite, base, post: (action, body) => post(action, body, cookie), cookie, open, destroys: () => destroys };
}

test('production prefix serves the viewer, routes assets, and scopes its cookie', async t => {
  const ctx = await fixture(t);
  assert.match(ctx.base, /\/browser\/[a-f0-9]{32}\/$/);
  const page = await (await fetch(ctx.base)).text();
  assert.match(page, /\/browser\/assets\/probe.js/);
  const js = await (await fetch(ctx.gateway.localUrl + '/browser/assets/probe.js')).text();
  assert.match(js, /\/browser\/novnc\/core\/rfb.js/);
  assert.equal((await ctx.post('credentials')).status, 200);
});

test('new control credentials are returned only after asynchronous runtime promotion', async t => {
  const pending = defer();
  const ctx = await fixture(t, { supervisor: { promote: () => pending.promise } });
  const credentials = await (await ctx.post('credentials')).json(); await ctx.open(credentials.generation);
  let returned = false;
  const request = ctx.post('control').then(r => { returned = true; return r; });
  await pause(30); assert.equal(returned, false);
  pending.resolve({ endpoint: { path: '/tmp/fixture.sock' }, credentials: { watch: 'unused12', control: 'newadmin' } });
  const control = await (await request).json();
  assert.equal(control.password, 'newadmin'); assert.deepEqual(control.capabilities, { clipboard: 'utf8' });
});

test('Done waits for a late promotion and does not publish its credentials', async t => {
  const pending = defer(), entered = defer();
  const ctx = await fixture(t, { supervisor: { promote: () => { entered.resolve(); return pending.promise; } } });
  const watch = await (await ctx.post('credentials')).json(); await ctx.open(watch.generation);
  const taking = ctx.post('control'); await entered.promise;
  let doneReturned = false;
  const done = ctx.post('done').then(r => { doneReturned = true; return r; });
  await pause(20); assert.equal(doneReturned, false); assert.equal(ctx.destroys(), 0);
  pending.resolve({ endpoint: { path: '/tmp/fixture.sock' }, credentials: { watch: 'unused12', control: 'newadmin' } });
  assert.notEqual((await taking).status, 200);
  assert.deepEqual(await (await done).json(), { mode: 'ended', reason: 'done', disposition: 'retained' });
  assert.equal(ctx.destroys(), 1);
});

test('UTF8 clipboard is control-only and pending writes settle before handback', async t => {
  const pending = defer(), entered = defer(); let saved;
  const ctx = await fixture(t, { supervisor: {
    async clipboardWrite(_id, text) { saved = text; entered.resolve(); await pending.promise; },
    async clipboardRead() { return { text: saved }; },
  } });
  assert.equal((await ctx.post('clipboard', { action: 'read' })).status, 409);
  const watch = await (await ctx.post('credentials')).json(); const oldSocket = await ctx.open(watch.generation);
  const oldClosed = once(oldSocket, 'close');
  const control = await (await ctx.post('control')).json(); await oldClosed; await ctx.open(control.generation);
  const text = 'Hello\n中文🙂';
  const writing = ctx.post('clipboard', { action: 'write', text }); await entered.promise;
  const done = ctx.post('done'); await pause(20); assert.equal(ctx.destroys(), 0);
  pending.resolve(); await writing; await done;
  assert.equal(saved, text); assert.equal(ctx.destroys(), 1);
  assert.equal((await ctx.post('clipboard', { action: 'read' })).status, 410);
  assert.equal(JSON.stringify(ctx.gateway.status(ctx.invite.id)).includes(text), false);
});

test('completion callback persists the result before ended status is visible', async t => {
  const entered = defer(), persisted = defer(); let reason;
  const ctx = await fixture(t, { supervisor: { async destroy(_id, options) { reason = options.reason; } },
    onEnded: async (_session, status) => { assert.equal(status.mode, 'ended'); entered.resolve(); await persisted.promise; } });
  const done = ctx.post('done'); await entered.promise;
  assert.equal(ctx.gateway.status(ctx.invite.id).mode, 'ending');
  persisted.resolve(); assert.equal((await done).status, 200); assert.equal(reason, 'done');
});

test('watch-only permission cannot acquire control', async t => {
  const ctx = await fixture(t, { permission: 'watch' });
  const watch = await (await ctx.post('credentials')).json(); await ctx.open(watch.generation);
  assert.equal((await ctx.post('control')).status, 403);
});

test('focus is control-only, passes only the field kind, and is advertised as a capability', async t => {
  const reads = [];
  const ctx = await fixture(t, { supervisor: { async focusRead(id) { reads.push(id); return { kind: 'editable', inputMode: 'tel', multiline: false, value: 'leak', url: 'https://x' }; } } });
  assert.equal((await ctx.post('focus')).status, 409, 'no focus answers before control');
  const watch = await (await ctx.post('credentials')).json(); const oldSocket = await ctx.open(watch.generation);
  assert.equal((await ctx.post('focus')).status, 409, 'watch mode gets no focus answers');
  const oldClosed = once(oldSocket, 'close');
  const control = await (await ctx.post('control')).json(); await oldClosed; await ctx.open(control.generation);
  assert.deepEqual(control.capabilities, { clipboard: 'utf8', focus: true });
  const reply = await ctx.post('focus');
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { kind: 'editable', inputMode: 'tel', multiline: false }, 'only the kind and keyboard type reach the viewer');
  assert.deepEqual(reads, [ctx.invite.id]);
  await ctx.post('done');
  assert.equal((await ctx.post('focus')).status, 410);
});

test('a focus answer outside the allowed kinds becomes unknown', async t => {
  let answer;
  const ctx = await fixture(t, { supervisor: { async focusRead() { return answer; } } });
  const watch = await (await ctx.post('credentials')).json(); const oldSocket = await ctx.open(watch.generation);
  const oldClosed = once(oldSocket, 'close');
  const control = await (await ctx.post('control')).json(); await oldClosed; await ctx.open(control.generation);
  for (answer of [{ kind: 'secret' }, { kind: 'editable', inputMode: 'javascript:alert(1)' }, null, { kind: 'browser-ui' }, { kind: 'none' }]) {
    const body = await (await ctx.post('focus')).json();
    const expected = answer?.kind === 'browser-ui' || answer?.kind === 'none' ? { kind: answer.kind } : { kind: 'unknown' };
    assert.deepEqual(body, expected, JSON.stringify(answer));
  }
});

test('a gateway without a focus reader keeps the focus capability off', async t => {
  const ctx = await fixture(t);
  const watch = await (await ctx.post('credentials')).json(); const oldSocket = await ctx.open(watch.generation);
  const oldClosed = once(oldSocket, 'close');
  const control = await (await ctx.post('control')).json(); await oldClosed; await ctx.open(control.generation);
  assert.deepEqual(control.capabilities, { clipboard: 'utf8' });
  assert.equal((await ctx.post('focus')).status, 404);
});

test('frequent focus checks do not use up the request limit that Done relies on', async t => {
  const ctx = await fixture(t, { supervisor: { async focusRead() { return { kind: 'none' }; } } });
  const watch = await (await ctx.post('credentials')).json(); const oldSocket = await ctx.open(watch.generation);
  const oldClosed = once(oldSocket, 'close');
  const control = await (await ctx.post('control')).json(); await oldClosed; await ctx.open(control.generation);
  for (let tap = 0; tap < 40; tap++) assert.equal((await ctx.post('focus')).status, 200, 'tap ' + tap);
  assert.equal((await ctx.post('done')).status, 200);
});

test('focus checks with a wrong cookie still count toward the guessing limit', async t => {
  const ctx = await fixture(t, { supervisor: { async focusRead() { return { kind: 'none' }; } } });
  const wrong = () => fetch(ctx.base + 'focus', { method: 'POST', headers: { origin: new URL(ctx.base).origin, 'content-type': 'application/json', cookie: 'novnc_probe=wrong' }, body: '{}' });
  const statuses = [];
  for (let attempt = 0; attempt < 31; attempt++) statuses.push((await wrong()).status);
  assert.equal(statuses[0], 401);
  assert.equal(statuses.at(-1), 429);
});
