import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { HandoffServer } from '../src/server.mjs';
import { NoVncProbeGateway, noVncProbePrefix } from '../src/novnc-probe.mjs';

const backend = { list: async () => [], open: async () => ({ input: async () => {}, close: async () => {} }) };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const supervisor = { create: async () => ({ ownedId: 'owned' }), read: async () => ({ state: 'running' }), register: async () => ({}), destroy: async () => {}, verifyExited: async () => true };
const connections = server => new Promise((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count)));
const upgrade = (path, origin) => `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: ${origin}\r\n\r\n`;

// A peer that keeps its own side open (allowHalfOpen) never sends the FIN that would let an ended socket go.
async function halfOpenPeer(t, url, request) {
  const socket = connect({ host: '127.0.0.1', port: Number(new URL(url).port), allowHalfOpen: true });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  let reply = '';
  socket.on('data', chunk => { reply += chunk; });
  socket.write(request);
  return { socket, reply: () => reply };
}

async function untilNoConnections(server, limitMs) {
  for (const deadline = Date.now() + limitMs; Date.now() < deadline; await pause(25)) if (await connections(server) === 0) return true;
  return false;
}

const servers = {
  noVNC: async t => {
    const gateway = new NoVncProbeGateway({ supervisor, closeGraceMs: 100 });
    await gateway.start({ port: 0 });
    t.after(() => gateway.close());
    return { http: gateway.server, url: gateway.localUrl, path: noVncProbePrefix + 'a'.repeat(32) + '/stream/0', close: () => gateway.close() };
  },
  CDP: async t => {
    const server = new HandoffServer({ backend, closeGraceMs: 100 });
    await server.start();
    t.after(() => server.close());
    return { http: server.server, url: server.localUrl, path: '/s/' + 'a'.repeat(32) + '/stream', close: () => server.close() };
  },
};

for (const [name, start] of Object.entries(servers)) {
  test(`${name}: a refused upgrade is destroyed although the peer never closes its side`, async t => {
    const server = await start(t);
    const peer = await halfOpenPeer(t, server.url, upgrade(server.path, 'https://elsewhere.example'));
    for (const deadline = Date.now() + 1500; !peer.reply() && Date.now() < deadline;) await pause(10);
    assert.equal(await untilNoConnections(server.http, 1500), true, 'the refused socket still holds a connection slot');
    assert.match(peer.reply(), /^HTTP\/1\.1 (401|403) /);
  });

  test(`${name}: close() cuts a connection that is stuck mid-request after its grace period`, async t => {
    const server = await start(t);
    // Headers that never finish keep the connection busy until the 10 s headers timeout.
    await halfOpenPeer(t, server.url, 'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    await pause(50);
    assert.equal(await connections(server.http), 1);
    const started = Date.now();
    await server.close();
    assert.ok(Date.now() - started < 2000, 'close() waited ' + (Date.now() - started) + ' ms');
  });
}
