import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { ComparisonProxy } from '../src/comparison-proxy.mjs';
import { HandoffServer } from '../src/server.mjs';

async function fixture(t) {
  const seen = [];
  const upstream = createServer((req, res) => {
    seen.push({ url: req.url, origin: req.headers.origin, cookie: req.headers.cookie });
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Set-Cookie': 'probe=fixture; Path=/probe/novnc/example/; HttpOnly' });
    res.end('probe fixture');
  });
  const wss = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (req, socket, head) => {
    if (req.headers.origin !== 'https://handoff.example' || req.headers.cookie !== 'probe=fixture') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return;
    }
    seen.push({ url: req.url, origin: req.headers.origin, cookie: req.headers.cookie });
    wss.handleUpgrade(req, socket, head, ws => ws.on('message', (data, binary) => ws.send(data, { binary })));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const front = new HandoffServer({ backend: {}, comparisonProxyUrl: target });
  await front.start();
  t.after(async () => {
    await front.close();
    for (const ws of wss.clients) ws.terminate();
    wss.close(); upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  return { front, upstream, seen };
}

test('comparison proxy accepts only a fixed loopback origin', () => {
  for (const value of ['https://127.0.0.1:19400', 'http://example.com:19400', 'http://127.0.0.1:19400/admin',
    'http://user:pass@127.0.0.1:19400', 'http://127.0.0.1:19400/?target=x', 'http://127.0.0.1:19400/#x'])
    assert.throws(() => new ComparisonProxy(value), /loopback|origin/i);
  const proxy = new ComparisonProxy('http://127.0.0.1:19400');
  assert.equal(proxy.matches('/probe/novnc/example/'), true);
  for (const path of ['/assets/viewer.js', '/s/example/state', '/probe/other', '/probe/novnc/../../admin', '/probe/novnc/%2e%2e/%2e%2e/admin'])
    assert.equal(proxy.matches(path), false, path);
  proxy.close();
});

test('opt-in comparison HTTP mount preserves path, cookie, Origin and Set-Cookie', async t => {
  const { front, seen } = await fixture(t);
  const response = await fetch(`${front.localUrl}/probe/novnc/example/state`, { headers: { origin: 'https://handoff.example', cookie: 'probe=fixture' } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'probe fixture');
  assert.match(response.headers.get('set-cookie'), /Path=\/probe\/novnc\/example\//);
  assert.deepEqual(seen, [{ url: '/probe/novnc/example/state', origin: 'https://handoff.example', cookie: 'probe=fixture' }]);
  assert.equal((await fetch(`${front.localUrl}/unrelated`)).status, 404);
  assert.equal(seen.length, 1, 'unrelated paths cannot reach the probe backend');
});

test('comparison mount is absent by default', async t => {
  const front = new HandoffServer({ backend: {} }); await front.start(); t.after(() => front.close());
  assert.equal((await fetch(`${front.localUrl}/probe/novnc/example/`)).status, 404);
});

test('comparison WebSocket forwards binary data and leaves upstream authorization intact', async t => {
  const { front, seen } = await fixture(t);
  const address = front.localUrl.replace('http:', 'ws:') + '/probe/novnc/example/stream';
  const rejected = new WebSocket(address, { origin: 'https://wrong.example', headers: { cookie: 'probe=fixture' } });
  rejected.on('error', () => {});
  const rejectedResponse = await new Promise(resolve => rejected.on('unexpected-response', (_req, res) => { resolve(res.statusCode); res.resume(); rejected.terminate(); }));
  assert.equal(rejectedResponse, 401);
  const ws = new WebSocket(address, { origin: 'https://handoff.example', headers: { cookie: 'probe=fixture' } });
  ws.on('error', () => {}); t.after(() => ws.terminate()); await once(ws, 'open');
  const received = once(ws, 'message'); ws.send(Buffer.from([0, 1, 2, 255]));
  const [data, binary] = await received; assert.equal(binary, true); assert.deepEqual([...data], [0, 1, 2, 255]);
  assert.equal(seen.at(-1).url, '/probe/novnc/example/stream');
  const closed = once(ws, 'close'); await front.close(); await closed;
});

test('unavailable comparison upstream returns bounded 502 without exposing internal errors', async t => {
  const { front, upstream } = await fixture(t);
  await new Promise(resolve => upstream.close(resolve));
  const response = await fetch(`${front.localUrl}/probe/novnc/example/`);
  assert.equal(response.status, 502); assert.equal(await response.text(), 'Comparison service unavailable');
});
