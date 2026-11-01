import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HostDesktopRuntime, supervisorRequest } from '../index.mjs';

const refused = () => {
  const socket = new net.Socket();
  setImmediate(() => socket.destroy(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })));
  return socket;
};

async function server(t, onRequest) {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-ready-'));
  const sockets = new Set();
  const listener = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => onRequest(Buffer.concat(chunks).toString(), socket));
  });
  await new Promise(resolve => listener.listen(join(dir, 'control.sock'), resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => listener.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return join(dir, 'control.sock');
}

test('cold supervisor socket is a not-ready status but never a successful mutation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-cold-start-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const absent = join(dir, 'absent.sock');
  assert.deepEqual(await supervisorRequest(absent, { op: 'status' }), { ready: false, phase: 'starting' });
  await assert.rejects(supervisorRequest(absent, { op: 'clipboardWrite', text: 'x' }), { code: 'ENOENT' });
  assert.deepEqual(await supervisorRequest(absent, { op: 'status' }, { connect: refused }), { ready: false, phase: 'starting' });
  await assert.rejects(supervisorRequest(absent, { op: 'startViewer' }, { connect: refused }), { code: 'ECONNREFUSED' });
});

test('the request is half-closed and the whole reply is read', async t => {
  let received;
  const path = await server(t, (text, socket) => {
    received = text;
    socket.write('{"ok":');
    setTimeout(() => socket.end('true,"text":"' + 'x'.repeat(200_000) + '"}'), 20);
  });
  const reply = await supervisorRequest(path, { op: 'clipboardRead', leaseId: 'a' });
  assert.equal(received, JSON.stringify({ op: 'clipboardRead', leaseId: 'a' }));
  assert.equal(reply.ok, true);
  assert.equal(reply.text.length, 200_000);
});

test('a supervisor error rejects with the operation name', async t => {
  const path = await server(t, (text, socket) => socket.end(JSON.stringify({ error: 'active lease mismatch' })));
  await assert.rejects(supervisorRequest(path, { op: 'stopViewerAndSettle' }), { message: 'desktop stopViewerAndSettle: active lease mismatch' });
});

test('a silent supervisor times out', async t => {
  const path = await server(t, () => {});
  await assert.rejects(supervisorRequest(path, { op: 'status' }, { timeoutMs: 100 }), /desktop status timed out/);
});

test('a Docker-era runtime config fails closed', () => {
  assert.throws(() => new HostDesktopRuntime({ stateDir: '/tmp/state', cdpPort: 18810, vncPort: 59090 }), { message: 'Desktop runtime config is from an older Clawser; rerun openclaw clawser setup' });
});

test('the runtime only accepts a 127.0.0.1 HTTP CDP origin and starts nothing', async () => {
  const options = { stateDir: '/tmp/state', controlSocket: '/tmp/control.sock' };
  for (const cdpUrl of [undefined, 'https://127.0.0.1:18820', 'http://10.0.0.5:18820', 'http://user:pw@127.0.0.1:18820', 'http://127.0.0.1:18820/json', 'ws://127.0.0.1:18820', 'http://localhost:18820', 'http://[::1]:18820'])
    assert.throws(() => new HostDesktopRuntime({ ...options, cdpUrl }), /must be http:\/\/127\.0\.0\.1/, String(cdpUrl));
  assert.throws(() => new HostDesktopRuntime({ ...options, controlSocket: 'relative.sock', cdpUrl: 'http://127.0.0.1:18820' }), /absolute/);
  const runtime = new HostDesktopRuntime({ ...options, cdpUrl: 'http://127.0.0.1:18820' });
  assert.equal(runtime.cdpUrl, 'http://127.0.0.1:18820');
  assert.deepEqual(await runtime.ensure(), { cdpUrl: 'http://127.0.0.1:18820', persistent: true });
});
