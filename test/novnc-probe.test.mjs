import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as connectRaw } from 'node:net';
import { Duplex } from 'node:stream';
import { WebSocket } from 'ws';
import { CdpConnection } from '../src/cdp.mjs';
import { NoVncProbeGateway } from '../src/novnc-probe.mjs';

const chromePath = process.env.CHROME_BIN || '/usr/bin/google-chrome-stable';
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class MemoryVncSocket extends Duplex {
  writes = [];
  _read() {}
  _write(chunk, _encoding, callback) { this.writes.push(Buffer.from(chunk)); callback(); }
  fromServer(chunk) { this.push(Buffer.from(chunk)); }
}

class FakeSupervisor {
  calls = [];
  instances = new Map();
  verify = true;
  destroyError = false;
  endpoint = { host: '127.0.0.1', port: 59080 };
  credentials = { watch: 'watch123', control: 'admin456' };
  async create({ probeId, expiresAt }) {
    this.calls.push(['create', probeId, expiresAt]);
    const ownedId = `owned-${probeId}`;
    this.instances.set(ownedId, 'running');
    return { ownedId };
  }
  async read(ownedId) { this.calls.push(['read', ownedId]); return { state: this.instances.get(ownedId) || 'missing' }; }
  async register({ probeId, ownedId }) {
    this.calls.push(['register', probeId, ownedId]);
    return { endpoint: { ...this.endpoint }, credentials: { ...this.credentials } };
  }
  async destroy(ownedId) {
    this.calls.push(['destroy', ownedId]);
    this.instances.set(ownedId, 'exited');
    if (this.destroyError) throw new Error('destroy acknowledgement lost');
  }
  async verifyExited(ownedId) { this.calls.push(['verifyExited', ownedId]); return this.verify; }
}

async function setup(t, options = {}) {
  const supervisor = options.supervisor || new FakeSupervisor();
  const sockets = [];
  const gateway = new NoVncProbeGateway({
    supervisor,
    now: options.now,
    monotonicNow: options.monotonicNow,
    promotionMs: options.promotionMs || 200,
    heartbeatMs: options.heartbeatMs,
    upstreamConnectMs: options.upstreamConnectMs,
    maxProbes: options.maxProbes,
    tcpConnect: options.tcpConnect || (async () => {
      const socket = new MemoryVncSocket(); sockets.push(socket); return socket;
    }),
  });
  await gateway.start({ port: 0 });
  t.after(() => gateway.close());
  const invite = await gateway.createProbe({ ttlSeconds: options.ttlSeconds || 60 });
  const base = invite.url.slice(0, invite.url.indexOf('/#'));
  const origin = gateway.localUrl;
  const post = (action, data = {}, cookie, requestOrigin = origin) => fetch(`${base}/${action}`, {
    method: 'POST',
    headers: { origin: requestOrigin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(data),
  });
  return { gateway, supervisor, sockets, invite, base, origin, post };
}

async function claim(ctx) {
  const token = new URL(ctx.invite.url).hash.slice('#invite='.length);
  const response = await ctx.post('claim', { token });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

async function credentials(ctx, cookie) {
  const response = await ctx.post('credentials', {}, cookie);
  return { response, body: await response.json() };
}

function openSocket(ctx, cookie, generation = 0, origin = ctx.origin) {
  const socket = new WebSocket(`${ctx.base.replace('http:', 'ws:')}/stream/${generation}`, {
    headers: { cookie, origin },
  });
  socket.on('error', () => {});
  return socket;
}

test('private LAN HTTP requires an explicit opt-in and canonical RFC1918 IPv4 literal', async (t) => {
  assert.throws(() => new NoVncProbeGateway({ supervisor: new FakeSupervisor(), publicBaseUrl: 'http://10.0.0.214:0', allowLanHttp: true }), /origin|port/i);
  const privateOrigins = ['http://10.0.0.214:19400', 'http://172.16.0.1:19400', 'http://172.31.255.254:19400', 'http://192.168.1.1:19400'];
  for (const publicBaseUrl of privateOrigins) {
    assert.throws(() => new NoVncProbeGateway({ supervisor: new FakeSupervisor(), publicBaseUrl }), /origin|HTTPS/i);
    assert.throws(() => new NoVncProbeGateway({ supervisor: new FakeSupervisor(), publicBaseUrl, allowLanHttp: 'true' }), /origin|HTTPS/i);
    const gateway = new NoVncProbeGateway({ supervisor: new FakeSupervisor(), publicBaseUrl, allowLanHttp: true });
    t.after(() => gateway.close());
    assert.equal(gateway.origin, publicBaseUrl);
  }
  for (const host of ['0.0.0.0', '8.8.8.8', '169.254.169.254', '100.64.0.1', '172.15.255.255', '172.32.0.1',
    '192.169.0.1', 'lan.example', '10.0.0.214.nip.io', '[fd00::1]', '[::ffff:10.0.0.214]', '0x0a0000d6', '012.0.0.214', '10.214', '167772374']) {
    for (const allowLanHttp of [false, true]) {
      assert.throws(() => new NoVncProbeGateway({ supervisor: new FakeSupervisor(), publicBaseUrl: `http://${host}:19400`, allowLanHttp }), /origin|HTTPS/i, host);
    }
  }
});

function mockListener(gateway) {
  const bindings = [];
  // Capture listen arguments without opening any LAN socket or contacting a service.
  gateway.server.listen = (port, host, callback) => { bindings.push({ port, host }); queueMicrotask(callback); return gateway.server; };
  gateway.server.address = () => ({ port: bindings.at(-1)?.port });
  return bindings;
}

test('LAN listener requires the configured private address and port; other origins stay on loopback', async (t) => {
  const gateway = new NoVncProbeGateway({ supervisor: new FakeSupervisor(), publicBaseUrl: 'http://10.0.0.214:19400', allowLanHttp: true });
  t.after(() => gateway.close());
  const bindings = mockListener(gateway);
  for (const host of ['127.0.0.1', '0.0.0.0', '10.0.0.215', '8.8.8.8', 'localhost', '[::1]']) {
    await assert.rejects(gateway.start({ host }), /bind|listen|LAN/i, host);
  }
  await assert.rejects(gateway.start({ host: '10.0.0.214', port: 19401 }), /bind|listen|LAN/i);
  assert.deepEqual(bindings, [], 'invalid configurations cannot call listen');
  assert.equal(await gateway.start({ host: '10.0.0.214', port: 19400 }), 'http://10.0.0.214:19400');
  assert.deepEqual(bindings, [{ host: '10.0.0.214', port: 19400 }]);

  for (const options of [{}, { publicBaseUrl: 'https://fixture.example' }, { publicBaseUrl: 'https://fixture.example', allowLanHttp: true },
    { publicBaseUrl: 'http://localhost:19400' }, { publicBaseUrl: 'http://[::1]:19400', allowLanHttp: true }]) {
    const local = new NoVncProbeGateway({ supervisor: new FakeSupervisor(), ...options });
    t.after(() => local.close());
    const localBindings = mockListener(local);
    for (const host of ['10.0.0.214', '0.0.0.0', '8.8.8.8', 'localhost', '::1']) await assert.rejects(local.start({ host }), /bind|listen|LAN/i);
    assert.equal(await local.start(), 'http://127.0.0.1:19400');
    assert.deepEqual(localBindings, [{ host: '127.0.0.1', port: 19400 }]);
    assert.equal(local.origin, options.publicBaseUrl || 'http://127.0.0.1:19400');
  }
});

test('only opted-in LAN HTTP omits Secure while retaining scoped authentication and loopback VNC', async (t) => {
  for (const options of [
    { publicBaseUrl: 'http://10.0.0.214:19400', allowLanHttp: true },
    { publicBaseUrl: 'https://fixture.example' },
    { publicBaseUrl: 'https://fixture.example', allowLanHttp: true },
    {},
  ]) {
    const supervisor = new FakeSupervisor();
    const gateway = new NoVncProbeGateway({ supervisor, ...options });
    t.after(() => gateway.close());
    mockListener(gateway);
    await gateway.start(options.allowLanHttp && options.publicBaseUrl.startsWith('http:') ? { host: '10.0.0.214' } : {});
    const invite = await gateway.createProbe({ ttlSeconds: 60 });
    const session = gateway.sessions.get(invite.id);
    assert.equal(gateway.status(invite.id).transport.route, options.publicBaseUrl?.startsWith('http://10.') ? 'lan' : options.publicBaseUrl?.startsWith('https:') ? 'https' : 'loopback');
    assert.deepEqual(gateway.status(invite.id).transport.websocketRttMs, { sampleCount: 0, latest: null, p50: null, p95: null });
    let headers;
    gateway.claim({ writeHead: (_status, value) => { headers = value; }, end() {} }, session, { token: new URL(invite.url).hash.slice('#invite='.length) });
    const cookie = headers['Set-Cookie'];
    const isLan = options.publicBaseUrl === 'http://10.0.0.214:19400';
    assert.equal(/; Secure(?:;|$)/.test(cookie), !isLan);
    assert.match(cookie, /HttpOnly; (?:Secure; )?SameSite=Strict/);
    assert.ok(cookie.includes(`Path=/probe/novnc/${invite.id}/; Max-Age=`));
    assert.equal(session.mode, 'watch');
    assert.deepEqual(session.endpoint, { host: '127.0.0.1', port: 59080 });
    assert.equal(gateway.originAllowed({ headers: { origin: gateway.origin } }), true);
    assert.equal(gateway.originAllowed({ headers: { origin: 'http://10.0.0.215:19400' } }), false);
    assert.throws(() => gateway.authorize({ headers: { cookie: 'novnc_probe=wrong' } }, session), /session/i);
    await gateway.end(session, 'done');
    assert.equal(session.mode, 'ended');
    assert.deepEqual(supervisor.calls.slice(-2).map(([name]) => name), ['destroy', 'verifyExited']);
  }

  const supervisor = new FakeSupervisor();
  supervisor.endpoint.host = '10.0.0.214';
  const gateway = new NoVncProbeGateway({ supervisor, publicBaseUrl: 'http://10.0.0.214:19400', allowLanHttp: true });
  t.after(() => gateway.close());
  mockListener(gateway);
  await gateway.start({ host: '10.0.0.214' });
  await assert.rejects(gateway.createProbe(), (error) => /fixed loopback VNC/.test(error.cause?.message));
});

async function socketOutcome(socket) {
  return Promise.race([
    once(socket, 'open').then(() => ({ status: 101, socket })),
    once(socket, 'unexpected-response').then(([, response]) => { response.resume(); return { status: response.statusCode, socket }; }),
  ]);
}

test('creation registers only the fixed owned loopback endpoint and returns a secret in the fragment', async (t) => {
  const ctx = await setup(t);
  assert.deepEqual(ctx.supervisor.calls.slice(0, 3).map(([name]) => name), ['create', 'read', 'register']);
  assert.match(ctx.invite.url, /^http:\/\/127\.0\.0\.1:\d+\/probe\/novnc\/[a-f0-9]{32}\/#invite=[A-Za-z0-9_-]{43}$/);
  assert.equal(ctx.invite.url.includes(ctx.supervisor.credentials.watch), false);
  assert.equal(ctx.invite.url.includes(ctx.supervisor.credentials.control), false);
  const session = ctx.gateway.sessions.get(ctx.invite.id);
  assert.deepEqual(session.endpoint, { host: '127.0.0.1', port: 59080 });
});

test('claim is one-use, origin-bound, and establishes a scoped hardened cookie', async (t) => {
  const ctx = await setup(t);
  const token = new URL(ctx.invite.url).hash.slice('#invite='.length);
  assert.equal((await ctx.post('claim', { token }, undefined, 'https://evil.example')).status, 403);
  assert.equal((await ctx.post('claim', { token: 'wrong' })).status, 401);
  const response = await ctx.post('claim', { token });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /^novnc_probe=[A-Za-z0-9_-]{43};/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, new RegExp(`Path=/probe/novnc/${ctx.invite.id}/`));
  assert.equal((await ctx.post('claim', { token })).status, 401);

  const cookie = setCookie.split(';')[0];
  const watch = await credentials(ctx, cookie);
  assert.equal(watch.response.status, 200);
  assert.deepEqual(watch.body, { mode: 'watch', password: 'watch123', generation: 0, expiresAt: ctx.invite.expiresAt });
  assert.equal(JSON.stringify(watch.body).includes('admin456'), false);
  assert.equal((await ctx.post('credentials', {}, cookie, 'https://evil.example')).status, 403);

  const wrongOrigin = await socketOutcome(openSocket(ctx, cookie, 0, 'https://evil.example'));
  assert.equal(wrongOrigin.status, 403);
});

test('the bridge copies opaque binary bytes in both directions without parsing RFB', async (t) => {
  const ctx = await setup(t), cookie = await claim(ctx);
  await credentials(ctx, cookie);
  const ws = openSocket(ctx, cookie);
  assert.equal((await socketOutcome(ws)).status, 101);
  await new Promise(setImmediate);
  ws.send(Buffer.from([0, 1, 2, 255]));
  for (let n = 0; n < 20 && !ctx.sockets[0]?.writes.length; n++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(ctx.sockets[0].writes[0], Buffer.from([0, 1, 2, 255]));
  const received = once(ws, 'message');
  ctx.sockets[0].fromServer([82, 70, 66, 32]);
  const [data, isBinary] = await received;
  assert.equal(isBinary, true);
  assert.deepEqual(Buffer.from(data), Buffer.from([82, 70, 66, 32]));
  ws.terminate();
});

test('transport diagnostics count opaque RFB bytes across promotion and survive cleanup', async (t) => {
  const ctx = await setup(t), cookie = await claim(ctx);
  await credentials(ctx, cookie);
  const watch = openSocket(ctx, cookie);
  await socketOutcome(watch);
  watch.send(Buffer.from('private-input'));
  const frame = once(watch, 'message');
  ctx.sockets[0].fromServer(Buffer.from('private-frame'));
  await frame;
  for (let n = 0; n < 30 && !ctx.sockets[0].writes.length; n++) await pause(5);
  let transport = ctx.gateway.status(ctx.invite.id).transport;
  assert.ok(transport, 'owner status includes aggregate transport diagnostics');
  assert.equal(transport.viewerBytesSent, Buffer.byteLength('private-frame'));
  assert.equal(transport.viewerBytesReceived, Buffer.byteLength('private-input'));
  assert.equal(transport.route, 'loopback');
  assert.equal(transport.funnelIngress, false);
  assert.equal(Number.isSafeInteger(transport.peakBufferedAmount), true);

  const watchClosed = once(watch, 'close');
  const promoted = await (await ctx.post('control', {}, cookie)).json();
  await watchClosed;
  const control = openSocket(ctx, cookie, promoted.generation);
  assert.equal((await socketOutcome(control)).status, 101);
  control.send(Buffer.from([1, 2, 3]));
  const secondFrame = once(control, 'message');
  ctx.sockets[1].fromServer(Buffer.from([4, 5]));
  await secondFrame;
  for (let n = 0; n < 30 && !ctx.sockets[1].writes.length; n++) await pause(5);
  await ctx.post('done', {}, cookie);
  transport = ctx.gateway.status(ctx.invite.id).transport;
  assert.equal(transport.viewerBytesSent, Buffer.byteLength('private-frame') + 2);
  assert.equal(transport.viewerBytesReceived, Buffer.byteLength('private-input') + 3);
  assert.equal(ctx.gateway.status(ctx.invite.id).mode, 'ended');
  const status = JSON.stringify(ctx.gateway.status(ctx.invite.id));
  for (const secret of ['private-input', 'private-frame', cookie.split('=')[1], ctx.supervisor.credentials.watch, ctx.supervisor.credentials.control]) assert.equal(status.includes(secret), false);
});

test('existing heartbeat records real WebSocket pong RTT with a bounded timing window', async (t) => {
  let monotonic = 100;
  const ctx = await setup(t, { monotonicNow: () => monotonic, heartbeatMs: 60_000 });
  const cookie = await claim(ctx);
  await credentials(ctx, cookie);
  const ws = openSocket(ctx, cookie);
  await socketOutcome(ws);
  ws.on('ping', () => { monotonic += 7; });
  for (let sample = 1; sample <= 40; sample++) {
    ctx.gateway.heartbeat();
    for (let n = 0; n < 40 && ctx.gateway.sessions.get(ctx.invite.id).socket?.alive !== true; n++) await pause(5);
    assert.equal(ctx.gateway.sessions.get(ctx.invite.id).socket?.alive, true, 'real client pong reached the gateway');
    monotonic += 10;
  }
  assert.ok(ctx.gateway.status(ctx.invite.id).transport, 'owner status includes aggregate transport diagnostics');
  const rtt = ctx.gateway.status(ctx.invite.id).transport.websocketRttMs;
  assert.deepEqual(rtt, { sampleCount: 32, latest: 7, p50: 7, p95: 7 });
  assert.equal(ctx.gateway.sessions.get(ctx.invite.id).transport.rttSamples.length, 32, 'retained data stays bounded');
  ws.terminate();
});

test('RTT percentiles and peak queue include queued bytes while keeping only numeric aggregates', async (t) => {
  let monotonic = 100;
  const ctx = await setup(t, { monotonicNow: () => monotonic, heartbeatMs: 60_000 });
  const cookie = await claim(ctx);
  await credentials(ctx, cookie);
  const ws = openSocket(ctx, cookie);
  await socketOutcome(ws);
  const serverSocket = ctx.gateway.sessions.get(ctx.invite.id).socket;
  let queued = 0;
  Object.defineProperty(serverSocket, 'bufferedAmount', { get: () => queued });
  // Keep the real connection, but advance the injected clock before its pong
  // handler. No wall-clock sleeps or browser rendering are measured here.
  serverSocket.ping = () => {};
  for (let sample = 1; sample <= 40; sample++) {
    queued = sample * 1024;
    ctx.gateway.heartbeat();
    monotonic += sample;
    serverSocket.emit('pong');
    monotonic += 1;
  }
  const transport = ctx.gateway.status(ctx.invite.id).transport;
  assert.ok(transport, 'owner status includes aggregate transport diagnostics');
  assert.equal(transport.peakBufferedAmount, 40 * 1024);
  assert.deepEqual(transport.websocketRttMs, { sampleCount: 32, latest: 40, p50: 24, p95: 39 });
  assert.deepEqual(Object.keys(transport).sort(), ['funnelIngress', 'peakBufferedAmount', 'route', 'viewerBytesReceived', 'viewerBytesSent', 'websocketRttMs'].sort());
  await ctx.post('done', {}, cookie);
  assert.deepEqual(ctx.gateway.status(ctx.invite.id).transport, transport, 'cleanup retains aggregates');
});

test('Funnel header is observed only after authentication and never grants access', async (t) => {
  const ctx = await setup(t);
  const session = ctx.gateway.sessions.get(ctx.invite.id);
  const post = (token, origin = ctx.origin) => fetch(`${ctx.base}/claim`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', 'tailscale-funnel-request': '?1' }, body: JSON.stringify({ token }),
  });
  assert.equal((await post('invalid')).status, 401);
  assert.ok(ctx.gateway.status(ctx.invite.id).transport, 'owner status includes aggregate transport diagnostics');
  assert.equal(ctx.gateway.status(ctx.invite.id).transport.funnelIngress, false);
  const token = new URL(ctx.invite.url).hash.slice('#invite='.length);
  assert.equal((await post(token, 'https://wrong.example')).status, 403);
  assert.equal(ctx.gateway.status(ctx.invite.id).transport.funnelIngress, false);
  const claimed = await post(token);
  assert.equal(claimed.status, 200);
  assert.equal(ctx.gateway.status(ctx.invite.id).transport.funnelIngress, true);
  assert.equal(session.mode, 'watch');

  const direct = await setup(t), cookie = await claim(direct);
  await credentials(direct, cookie);
  const denied = new WebSocket(`${direct.base.replace('http:', 'ws:')}/stream/0`, { headers: {
    origin: direct.origin, cookie: 'novnc_probe=invalid', 'tailscale-funnel-request': '?1',
  } });
  denied.on('error', () => {});
  assert.equal((await socketOutcome(denied)).status, 401);
  assert.equal(direct.gateway.status(direct.invite.id).transport.funnelIngress, false);
  const ws = new WebSocket(`${direct.base.replace('http:', 'ws:')}/stream/0`, { headers: {
    origin: direct.origin, cookie, 'tailscale-funnel-request': '?1',
  } });
  assert.equal((await socketOutcome(ws)).status, 101);
  assert.equal(direct.gateway.status(direct.invite.id).transport.funnelIngress, true);
  ws.terminate();
});

test('only one watch WebSocket may attach', async (t) => {
  const ctx = await setup(t), cookie = await claim(ctx);
  await credentials(ctx, cookie);
  const first = openSocket(ctx, cookie);
  assert.equal((await socketOutcome(first)).status, 101);
  const duplicate = await socketOutcome(openSocket(ctx, cookie));
  assert.equal(duplicate.status, 409);
  assert.equal(first.readyState, WebSocket.OPEN);
  first.terminate();
});

test('duplicate upgrades cannot clear an in-flight stream reservation', async (t) => {
  let allowConnect;
  const held = new Promise((resolve) => { allowConnect = resolve; });
  t.after(allowConnect);
  const sockets = [];
  const ctx = await setup(t, { tcpConnect: async () => {
    const socket = new MemoryVncSocket();
    sockets.push(socket);
    await held;
    return socket;
  } });
  const cookie = await claim(ctx);
  await credentials(ctx, cookie);
  const first = openSocket(ctx, cookie);
  for (let n = 0; n < 20 && sockets.length === 0; n++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sockets.length, 1);
  assert.equal((await socketOutcome(openSocket(ctx, cookie))).status, 409);
  const third = openSocket(ctx, cookie);
  const thirdOutcome = socketOutcome(third);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sockets.length, 1, 'rejected duplicates cannot start another upstream connection');
  allowConnect();
  assert.equal((await socketOutcome(first)).status, 101);
  assert.equal((await thirdOutcome).status, 409);
  first.terminate();
});

test('an upstream connect deadline destroys a late VNC socket and the owned server', async (t) => {
  let allowConnect, started;
  const waiting = new Promise((resolve) => { allowConnect = resolve; });
  const connecting = new Promise((resolve) => { started = resolve; });
  t.after(allowConnect);
  const late = new MemoryVncSocket();
  const ctx = await setup(t, { upstreamConnectMs: 20, tcpConnect: async () => { started(); await waiting; return late; } });
  const cookie = await claim(ctx);
  await credentials(ctx, cookie);
  const attempt = openSocket(ctx, cookie);
  await connecting;
  assert.equal((await socketOutcome(attempt)).status, 502);
  allowConnect();
  for (let n = 0; n < 30 && !late.destroyed; n++) await pause(5);
  assert.equal(late.destroyed, true, 'a socket resolving after timeout is immediately destroyed');
  for (let n = 0; n < 30 && ctx.gateway.status(ctx.invite.id).mode !== 'ended'; n++) await pause(5);
  assert.equal(ctx.gateway.status(ctx.invite.id).mode, 'ended');
});

test('a raw viewer that leaves during upstream connect cannot leak the late socket or reservation', async (t) => {
  let allowConnect, started;
  const waiting = new Promise((resolve) => { allowConnect = resolve; });
  const connecting = new Promise((resolve) => { started = resolve; });
  t.after(allowConnect);
  const late = new MemoryVncSocket();
  const ctx = await setup(t, { upstreamConnectMs: 200, tcpConnect: async () => { started(); await waiting; return late; } });
  const cookie = await claim(ctx);
  await credentials(ctx, cookie);
  const attempt = openSocket(ctx, cookie);
  await connecting;
  attempt.terminate();
  allowConnect();
  for (let n = 0; n < 30 && !late.destroyed; n++) await pause(5);
  assert.equal(late.destroyed, true);
  assert.equal(ctx.gateway.sessions.get(ctx.invite.id).connecting, false);
  for (let n = 0; n < 30 && ctx.gateway.status(ctx.invite.id).mode !== 'ended'; n++) await pause(5);
  assert.equal(ctx.gateway.status(ctx.invite.id).mode, 'ended');
});

test('a malformed WebSocket handshake cannot leak its connected VNC upstream', async (t) => {
  const ctx = await setup(t), cookie = await claim(ctx);
  await credentials(ctx, cookie);
  const port = Number(new URL(ctx.gateway.localUrl).port);
  const raw = connectRaw({ host: '127.0.0.1', port });
  raw.on('error', () => {});
  await once(raw, 'connect');
  raw.write([
    `GET ${new URL(ctx.base).pathname}/stream/0 HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: invalid',
    `Origin: ${ctx.origin}`,
    `Cookie: ${cookie}`,
    '', '',
  ].join('\r\n'));
  await Promise.race([once(raw, 'close'), pause(300)]);
  for (let n = 0; n < 30 && !ctx.sockets[0]?.destroyed; n++) await pause(5);
  assert.equal(ctx.sockets[0]?.destroyed, true);
  assert.equal(ctx.gateway.sessions.get(ctx.invite.id).connecting, false);
  for (let n = 0; n < 30 && ctx.gateway.status(ctx.invite.id).mode !== 'ended'; n++) await pause(5);
  assert.equal(ctx.gateway.status(ctx.invite.id).mode, 'ended');
  raw.destroy();
});

test('take-control atomically retires watch and permits one bounded generation replacement', async (t) => {
  const ctx = await setup(t), cookie = await claim(ctx);
  await credentials(ctx, cookie);
  const watch = openSocket(ctx, cookie);
  assert.equal((await socketOutcome(watch)).status, 101);
  const watchClosed = once(watch, 'close');
  const response = await ctx.post('control', {}, cookie);
  assert.equal(response.status, 200);
  const control = await response.json();
  assert.deepEqual(control, { mode: 'control-pending', password: 'admin456', generation: 1, reconnectBy: control.reconnectBy });
  assert.equal(typeof control.reconnectBy, 'number');
  await watchClosed;

  const attempts = [openSocket(ctx, cookie, 1), openSocket(ctx, cookie, 1)];
  const outcomes = await Promise.all(attempts.map(socketOutcome));
  assert.deepEqual(outcomes.map(({ status }) => status).sort(), [101, 409]);
  assert.equal(ctx.gateway.status(ctx.invite.id).mode, 'control');
  outcomes.find(({ status }) => status === 101).socket.terminate();
});

test('a failed promotion deadline destroys the owned server', async (t) => {
  const ctx = await setup(t, { promotionMs: 20 }), cookie = await claim(ctx);
  await credentials(ctx, cookie);
  const watch = openSocket(ctx, cookie);
  await socketOutcome(watch);
  await ctx.post('control', {}, cookie);
  for (let n = 0; n < 50 && ctx.gateway.status(ctx.invite.id).mode !== 'ended'; n++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ctx.gateway.status(ctx.invite.id).mode, 'ended');
  assert.deepEqual(ctx.supervisor.calls.slice(-2).map(([name]) => name), ['destroy', 'verifyExited']);
});

test('expiry, Done, and unexpected disconnect destroy and verify the exact owned server', async (t) => {
  for (const ending of ['expiry', 'done', 'disconnect']) {
    let time = 10_000;
    const ctx = await setup(t, { now: () => time });
    const cookie = await claim(ctx);
    await credentials(ctx, cookie);
    const ws = openSocket(ctx, cookie);
    await socketOutcome(ws);
    if (ending === 'expiry') { time = ctx.invite.expiresAt + 1; await ctx.gateway.sweep(); }
    else if (ending === 'done') {
      const response = await ctx.post('done', {}, cookie);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { mode: 'ended', reason: 'done' });
    } else {
      ws.terminate();
      for (let n = 0; n < 30 && ctx.gateway.status(ctx.invite.id).mode !== 'ended'; n++) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(ctx.gateway.status(ctx.invite.id).mode, 'ended', ending);
    const ownedId = `owned-${ctx.invite.id}`;
    assert.deepEqual(ctx.supervisor.calls.slice(-2), [['destroy', ownedId], ['verifyExited', ownedId]], ending);
    assert.equal((await ctx.post('credentials', {}, cookie)).status, 410);
    ws.terminate();
  }
});

test('cleanup verification failure retains fault ownership and permanently denies access', async (t) => {
  const supervisor = new FakeSupervisor();
  supervisor.verify = false;
  const ctx = await setup(t, { supervisor }), cookie = await claim(ctx);
  const response = await ctx.post('done', {}, cookie);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { mode: 'cleanup_failed', reason: 'done' });
  const state = ctx.gateway.status(ctx.invite.id);
  assert.equal(state.mode, 'cleanup_failed');
  assert.equal(state.ownedId, `owned-${ctx.invite.id}`);
  assert.equal((await ctx.post('credentials', {}, cookie)).status, 410);
  assert.equal((await socketOutcome(openSocket(ctx, cookie))).status, 410);
  assert.equal((await fetch(`${ctx.base}/`)).status, 410);

  supervisor.verify = true;
  const retry = await ctx.post('done', {}, cookie);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { mode: 'ended', reason: 'done' });
  assert.deepEqual(supervisor.calls.slice(-2).map(([name]) => name), ['destroy', 'verifyExited']);
});

test('cleanup verifies exit even when destroy reports an error', async (t) => {
  const supervisor = new FakeSupervisor();
  supervisor.destroyError = true;
  const ctx = await setup(t, { supervisor }), cookie = await claim(ctx);
  const response = await ctx.post('done', {}, cookie);
  assert.equal(response.status, 200);
  assert.equal(ctx.gateway.status(ctx.invite.id).mode, 'ended');
  assert.deepEqual(supervisor.calls.slice(-2).map(([name]) => name), ['destroy', 'verifyExited']);
});

test('the owner can directly retry a failed cleanup without restoring viewer access', async (t) => {
  const supervisor = new FakeSupervisor();
  supervisor.verify = false;
  const ctx = await setup(t, { supervisor }), cookie = await claim(ctx);
  assert.equal((await ctx.post('done', {}, cookie)).status, 503);
  supervisor.verify = true;
  assert.deepEqual(await ctx.gateway.retryCleanup(ctx.invite.id), { mode: 'ended', reason: 'done' });
  assert.equal((await ctx.post('credentials', {}, cookie)).status, 410);
  assert.equal((await socketOutcome(openSocket(ctx, cookie))).status, 410);
});

test('a cleanup-failed owned server continues to consume the probe resource cap', async (t) => {
  const supervisor = new FakeSupervisor();
  supervisor.verify = false;
  const ctx = await setup(t, { supervisor, maxProbes: 1 }), cookie = await claim(ctx);
  assert.equal((await ctx.post('done', {}, cookie)).status, 503);
  await assert.rejects(ctx.gateway.createProbe(), /too many active probes/i);
  supervisor.verify = true;
  await ctx.gateway.retryCleanup(ctx.invite.id);
  const replacement = await ctx.gateway.createProbe({ ttlSeconds: 60 });
  assert.match(replacement.id, /^[a-f0-9]{32}$/);
});

test('viewer serves pinned noVNC with local scaling, explicit clipboard controls and no remote resize', async (t) => {
  const ctx = await setup(t);
  const page = await fetch(`${ctx.base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /\/probe\/novnc\/assets\/probe\.js/);
  assert.match(html, /id="screen"/);
  assert.match(html, /id="control"/);
  assert.match(html, /id="done"/);
  assert.match(html, /id="clipboard-dialog"/);
  assert.doesNotMatch(html, /id="release"/i);

  const clientResponse = await fetch(`${ctx.gateway.localUrl}/probe/novnc/assets/probe.js`);
  assert.equal(clientResponse.status, 200);
  const client = await clientResponse.text();
  assert.match(client, /\/probe\/novnc\/novnc\/core\/rfb\.js/);
  assert.match(client, /scaleViewport\s*=\s*true/);
  assert.match(client, /resizeSession\s*=\s*false/);
  assert.match(client, /viewOnly/);
  assert.match(client, /clipboardPasteFrom/);
  assert.doesNotMatch(client, /setDesktopSize|post\(['"]release['"]/i);

  const styleResponse = await fetch(`${ctx.gateway.localUrl}/probe/novnc/assets/probe.css`);
  assert.equal(styleResponse.status, 200);
  assert.match(await styleResponse.text(), /touch-action/);
});

test('an inactive WebSocket is detected and destroys the owned VNC server', async (t) => {
  const ctx = await setup(t, { heartbeatMs: 20 }), cookie = await claim(ctx);
  await credentials(ctx, cookie);
  const ws = openSocket(ctx, cookie);
  assert.equal((await socketOutcome(ws)).status, 101);
  ws._socket.pause();
  for (let n = 0; n < 50 && ctx.gateway.status(ctx.invite.id).mode !== 'ended'; n++) await pause(10);
  assert.equal(ctx.gateway.status(ctx.invite.id).mode, 'ended');
  assert.equal(ctx.gateway.status(ctx.invite.id).reason, 'unexpected_disconnect');
  ws._socket.resume();
});

test('an upstream VNC failure closes the viewer before destructive cleanup', async (t) => {
  const ctx = await setup(t), cookie = await claim(ctx);
  await credentials(ctx, cookie);
  const ws = openSocket(ctx, cookie);
  assert.equal((await socketOutcome(ws)).status, 101);
  const closed = once(ws, 'close').then(() => true);
  ctx.sockets[0].destroy();
  assert.equal(await Promise.race([closed, pause(150).then(() => false)]), true, 'viewer WebSocket is explicitly closed');
  for (let n = 0; n < 30 && ctx.gateway.status(ctx.invite.id).mode !== 'ended'; n++) await pause(5);
  assert.equal(ctx.gateway.status(ctx.invite.id).mode, 'ended');
});

test('shutdown waits for an in-flight creation then destroys the acquired owned server', async () => {
  let continueCreate, createStarted;
  const waiting = new Promise((resolve) => { continueCreate = resolve; });
  const started = new Promise((resolve) => { createStarted = resolve; });
  const supervisor = new FakeSupervisor();
  supervisor.create = async ({ probeId, expiresAt }) => {
    supervisor.calls.push(['create', probeId, expiresAt]); createStarted(); await waiting;
    const ownedId = `owned-${probeId}`; supervisor.instances.set(ownedId, 'running'); return { ownedId };
  };
  const gateway = new NoVncProbeGateway({ supervisor });
  await gateway.start({ port: 0 });
  const creation = gateway.createProbe({ ttlSeconds: 60 });
  await started;
  let closeSettled = false;
  const closing = gateway.close().then(() => { closeSettled = true; });
  await pause(20);
  assert.equal(closeSettled, false, 'shutdown owns the unresolved creation');
  continueCreate();
  await assert.rejects(creation, /closed|ended/i);
  await closing;
  assert.deepEqual(supervisor.calls.slice(-2).map(([name]) => name), ['destroy', 'verifyExited']);
  await assert.rejects(gateway.createProbe(), /closed/i);
});

test('expiry during creation waits for owned identity and cannot publish a late invitation', async (t) => {
  let time = 1_000, continueCreate, createStarted;
  const waiting = new Promise((resolve) => { continueCreate = resolve; });
  const started = new Promise((resolve) => { createStarted = resolve; });
  const supervisor = new FakeSupervisor();
  supervisor.create = async ({ probeId, expiresAt }) => {
    supervisor.calls.push(['create', probeId, expiresAt]); createStarted(); await waiting;
    const ownedId = `owned-${probeId}`; supervisor.instances.set(ownedId, 'running'); return { ownedId };
  };
  const gateway = new NoVncProbeGateway({ supervisor, now: () => time });
  await gateway.start({ port: 0 });
  t.after(() => gateway.close());
  const creation = gateway.createProbe({ ttlSeconds: 1 });
  await started;
  time = 2_001;
  const sweeping = gateway.sweep();
  continueCreate();
  await assert.rejects(creation, /expired|ended/i);
  await sweeping;
  assert.deepEqual(supervisor.calls.slice(-2).map(([name]) => name), ['destroy', 'verifyExited']);
});

async function openProbeFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'novnc-probe-ui-'));
  const fixtureScript = String.raw`<script>
    (() => {
      const realSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, Math.min(delay, 70), ...args);
      AbortSignal.timeout = () => {
        const controller = new AbortController();
        realSetTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), 70);
        return controller.signal;
      };
      const config = ${JSON.stringify(options)};
      const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      const hang = (init) => new Promise((resolve, reject) => {
        const abort = () => reject(init.signal?.reason || new DOMException('Aborted', 'AbortError'));
        if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
      });
      window.fixture = { config, claimCalls: 0, credentialCalls: 0, controlCalls: 0, doneCalls: 0, rfbs: [] };
      window.fetch = async (url, init = {}) => {
        const action = String(url).split('/').at(-1);
        if (action === 'claim') { fixture.claimCalls++; return response({ mode: 'watch' }); }
        if (action === 'credentials') {
          fixture.credentialCalls++;
          if (config.stallCredentials) return hang(init);
          return response({ mode: 'watch', password: 'watch123', generation: 0, expiresAt: Date.now() + 60000 });
        }
        if (action === 'control') {
          fixture.controlCalls++;
          if (config.signalPromotionClose) setTimeout(() => fixture.rfbs[0].dispatchEvent(new Event('disconnect')), 0);
          return response({ mode: 'control-pending', password: 'admin456', generation: 1, reconnectBy: Date.now() + 10000 });
        }
        if (action === 'done') {
          fixture.doneCalls++;
          if (config.firstDoneStalls && fixture.doneCalls === 1) return hang(init);
          return response({ mode: 'ended', reason: 'done' });
        }
        return response({ error: 'missing fixture route' }, 404);
      };
    })();
  </script>`;
  const rfbModule = String.raw`
    export default class FixtureRFB extends EventTarget {
      constructor() {
        super(); const index = window.fixture.rfbs.length; window.fixture.rfbs.push(this);
        if (!window.fixture.config.stallConnect && !(window.fixture.config.stallReplacementConnect && index > 0)) setTimeout(() => this.dispatchEvent(new Event('connect')), 0);
      }
      disconnect() {
        window.fixture.disconnectCalls = (window.fixture.disconnectCalls || 0) + 1;
        if (!window.fixture.config.stallDisconnect) setTimeout(() => this.dispatchEvent(new Event('disconnect')), 0);
      }
    }
  `;
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/probe/novnc/assets/probe.js') {
        response.setHeader('Content-Type', 'text/javascript');
        return response.end(await readFile(new URL('../public/probe.js', import.meta.url)));
      }
      if (request.url === '/probe/novnc/assets/probe.css') {
        response.setHeader('Content-Type', 'text/css');
        return response.end(await readFile(new URL('../public/probe.css', import.meta.url)));
      }
      if (request.url === '/probe/novnc/novnc/core/rfb.js') {
        if (options.failAsset) { response.statusCode = 404; return response.end('missing'); }
        response.setHeader('Content-Type', 'text/javascript'); return response.end(rfbModule);
      }
      response.setHeader('Content-Type', 'text/html');
      response.end((await readFile(new URL('../public/probe.html', import.meta.url), 'utf8')).replace(
        '<script type="module" src="/probe/novnc/assets/probe.js"></script>',
        `${fixtureScript}<script type="module" src="/probe/novnc/assets/probe.js"></script>`,
      ));
    } catch (error) { response.statusCode = 500; response.end(String(error)); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const chrome = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank',
  ], { stdio: 'ignore' });
  let cdp;
  t.after(async () => {
    cdp?.close(); chrome.kill('SIGTERM');
    await new Promise((resolve) => server.close(resolve));
    await pause(100);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let port;
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    try { port = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
    catch { await pause(30); }
  }
  assert.ok(port, 'Chromium started');
  const id = 'a'.repeat(32);
  const target = `http://127.0.0.1:${server.address().port}/probe/novnc/${id}/#invite=${'b'.repeat(43)}`;
  const page = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(target)}`, { method: 'PUT' })).json();
  cdp = await new CdpConnection().connect(page.webSocketDebuggerUrl);
  const evaluate = async (expression) => {
    const reply = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text);
    return reply.result.value;
  };
  const waitFor = async (expression, description) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      if (await evaluate(`Boolean(window.fixture) && Boolean(${expression})`)) return;
      await pause(25);
    }
    assert.fail(description);
  };
  return { evaluate, waitFor };
}

test('stalled bootstrap is bounded and failed cleanup remains manually retryable', { skip: !existsSync(chromePath) }, async (t) => {
  const { evaluate, waitFor } = await openProbeFixture(t, { stallCredentials: true, firstDoneStalls: true });
  await waitFor('fixture.doneCalls === 1 && document.querySelector("#done").disabled === false', 'stalled bootstrap attempted bounded cleanup and enabled retry');
  assert.match(await evaluate('document.querySelector("#status").textContent'), /cleanup could not be verified/i);
  await evaluate('document.querySelector("#done").click()');
  await waitFor('fixture.doneCalls === 2 && /destroyed/i.test(document.querySelector("#status").textContent)', 'manual cleanup retry completed');
  assert.equal(await evaluate('document.querySelector("#done").disabled'), true);
});

test('failed noVNC import surfaces the error and verifies destructive cleanup', { skip: !existsSync(chromePath) }, async (t) => {
  const { evaluate, waitFor } = await openProbeFixture(t, { failAsset: true });
  await waitFor('fixture.doneCalls === 1 && /destroyed/i.test(document.querySelector("#status").textContent)', 'asset failure triggered verified cleanup');
  assert.match(await evaluate('document.querySelector("#status").textContent'), /import|module|asset/i);
  assert.equal(await evaluate('fixture.rfbs.length'), 0);
});

test('stalled promotion disconnect is bounded and destroys instead of reconnecting', { skip: !existsSync(chromePath) }, async (t) => {
  const { evaluate, waitFor } = await openProbeFixture(t, { stallDisconnect: true });
  await waitFor('fixture.rfbs.length === 1 && document.querySelector("#control").disabled === false', 'watch connection became ready');
  await evaluate('document.querySelector("#control").click()');
  await waitFor('fixture.doneCalls === 1 && /destroyed/i.test(document.querySelector("#status").textContent)', 'stalled promotion triggered verified cleanup');
  assert.equal(await evaluate('fixture.rfbs.length'), 1, 'no replacement or automatic reconnect was created');
});

test('stalled initial VNC readiness is bounded and cleans up without reconnecting', { skip: !existsSync(chromePath) }, async (t) => {
  const { evaluate, waitFor } = await openProbeFixture(t, { stallConnect: true });
  await waitFor('fixture.doneCalls === 1 && /destroyed/i.test(document.querySelector("#status").textContent)', 'late watch readiness triggered verified cleanup');
  assert.equal(await evaluate('fixture.rfbs.length'), 1);
});

test('stalled control VNC readiness is bounded after the one permitted replacement', { skip: !existsSync(chromePath) }, async (t) => {
  const { evaluate, waitFor } = await openProbeFixture(t, { signalPromotionClose: true, stallReplacementConnect: true });
  await waitFor('fixture.rfbs.length === 1 && document.querySelector("#control").disabled === false', 'watch connection became ready');
  await evaluate('document.querySelector("#control").click()');
  await waitFor('fixture.rfbs.length === 2 && fixture.doneCalls === 1 && /destroyed/i.test(document.querySelector("#status").textContent)', 'late control readiness triggered verified cleanup');
  assert.equal(await evaluate('fixture.rfbs.length'), 2, 'only the bounded promotion replacement was created');
});
