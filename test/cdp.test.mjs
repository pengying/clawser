import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { validateInput, validateCdpUrl, CdpConnection, CdpBrowser } from '../src/cdp.mjs';

async function browserFixture(t, { rejectCancel = false, disconnectRecoveryPaint = false, frameMetadata = {}, windowState = 'normal' } = {}) {
  const methods = [], commands = [];
  let bounds = { left: 10, top: 20, width: 800, height: 600, windowState };
  let screenshots = 0;
  let peer;
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ type: 'page', id: 'tab', title: 'Static page', url: 'https://example.com/', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/tab` }]));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket) => { peer = socket; socket.on('message', (raw) => {
    const command = JSON.parse(String(raw)); methods.push(command.method); commands.push(command);
    if (rejectCancel && command.method === 'Input.dispatchTouchEvent' && command.params.type === 'touchCancel') {
      peer.send(JSON.stringify({ id: command.id, error: { message: 'Cancellation rejected' } })); return;
    }
    if (command.method === 'Page.captureScreenshot' && ++screenshots > 1 && disconnectRecoveryPaint) {
      socket.terminate(); return;
    }
    const result = command.method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'frame', url: 'https://example.com/' } } }
      : command.method === 'Page.createIsolatedWorld' ? { executionContextId: 1 }
      : command.method === 'Runtime.evaluate' ? { result: { value: { document: 'fixture', regions: [], focus: null } } }
      : command.method === 'Browser.getWindowForTarget' ? { windowId: 7, bounds }
      : command.method === 'Browser.setWindowBounds' ? (bounds = { ...bounds, ...command.params.bounds }, {})
      : command.method === 'Page.captureScreenshot' ? { data: 'static-frame' } : {};
    peer.send(JSON.stringify({ id: command.id, result }));
    if (command.method === 'Page.captureScreenshot') peer.send(JSON.stringify({ method: 'Page.screencastFrame', params: { sessionId: 1, data: 'static-frame', metadata: { deviceWidth: 800, deviceHeight: 600, ...frameMetadata } } }));
  }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const peer of sockets.clients) peer.terminate(); sockets.close(); server.close(); });
  const backend = new CdpBrowser({ fixture: `http://127.0.0.1:${server.address().port}` });
  return { backend, methods, commands, peer: () => peer };
}

test('screenshot-normalized mouse, touch and wheel coordinates account for remote page scale', async (t) => {
  const { backend, commands } = await browserFixture(t, { frameMetadata: { pageScaleFactor: 2, scrollOffsetX: 384, scrollOffsetY: 225 } });
  const connection = await backend.open({ profile: 'fixture', targetId: 'tab' }, { onFrame() {}, onClose() {} });
  t.after(() => connection.close());
  await connection.input({ kind: 'click', x: .5, y: .5 });
  await connection.input({ kind: 'scroll', x: .25, y: .25, deltaX: 0, deltaY: 20 });
  await connection.input({ kind: 'pointer', phase: 'down', pointerType: 'touch', gesture: 1, x: .25, y: .25 });
  await connection.input({ kind: 'pointer', phase: 'up', pointerType: 'touch', gesture: 1, x: .25, y: .25 });
  const click = commands.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed').params;
  const wheel = commands.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseWheel').params;
  const touch = commands.find((c) => c.method === 'Input.dispatchTouchEvent' && c.params.type === 'touchStart').params.touchPoints[0];
  assert.deepEqual([click.x, click.y, wheel.x, wheel.y, touch.x, touch.y], [200, 150, 100, 75, 100, 75], 'CDP inputs are CSS coordinates relative to the visual viewport; frame scroll offsets must not be added');
});

test('a static background tab produces its initial frame without taking focus', async (t) => {
  const { backend, methods } = await browserFixture(t), frames = [];
  const connection = await backend.open({ profile: 'fixture', targetId: 'tab' }, { onFrame: (frame) => frames.push(frame), onClose() {} });
  t.after(() => connection.close());
  await new Promise(setImmediate);
  assert.equal(frames.length, 1, 'watch mode must receive an initial frame even when Chromium produces none until a snapshot requests a paint');
  assert.deepEqual(frames[0], { type: 'frame', data: 'static-frame', width: 800, height: 600 });
  assert.equal(methods.includes('Page.bringToFront'), false, 'watch mode must not steal focus');
});

test('a minimized renderer is restored and repainted before atomic wheel dispatch', async (t) => {
  const { backend, commands } = await browserFixture(t, { windowState: 'minimized' });
  const connection = await backend.open({ profile: 'fixture', targetId: 'tab' }, { onFrame() {}, onClose() {} });
  t.after(() => connection.close());
  const start = commands.length;

  await connection.input({ kind: 'scroll', x: .5, y: .5, deltaX: 0, deltaY: 20 });

  const input = commands.slice(start).filter(({ method }) => method !== 'Page.screencastFrameAck');
  assert.deepEqual(input.map(({ method }) => method), [
    'Browser.getWindowForTarget', 'Browser.setWindowBounds', 'Page.bringToFront',
    'Page.captureScreenshot', 'Input.dispatchMouseEvent',
  ]);
  assert.equal(input[0].params.targetId, 'tab');
  assert.deepEqual(input[1].params, { windowId: 7, bounds: { windowState: 'normal' } });
  assert.deepEqual(input[3].params, { format: 'jpeg', quality: 70, captureBeyondViewport: false });
  assert.equal(input[4].params.type, 'mouseWheel');
});

test('a normal renderer is activated without a recovery repaint', async (t) => {
  const { backend, commands } = await browserFixture(t);
  const connection = await backend.open({ profile: 'fixture', targetId: 'tab' }, { onFrame() {}, onClose() {} });
  t.after(() => connection.close());
  const start = commands.length;

  await connection.input({ kind: 'click', x: .5, y: .5 });

  assert.deepEqual(commands.slice(start).map(({ method }) => method), [
    'Browser.getWindowForTarget', 'Page.bringToFront',
    'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Runtime.evaluate',
  ]);
});

test('an unacknowledged readiness repaint never dispatches the original input', async (t) => {
  const fixture = await browserFixture(t, { windowState: 'minimized', disconnectRecoveryPaint: true });
  const connection = await fixture.backend.open({ profile: 'fixture', targetId: 'tab' }, { onFrame() {}, onClose() {} });
  const start = fixture.commands.length;

  await assert.rejects(connection.input({ kind: 'scroll', x: .5, y: .5, deltaX: 0, deltaY: 20 }), /disconnected/i);

  const input = fixture.commands.slice(start);
  assert.deepEqual(input.filter(({ method }) => method !== 'Page.screencastFrameAck').map(({ method }) => method), [
    'Browser.getWindowForTarget', 'Browser.setWindowBounds', 'Page.bringToFront', 'Page.captureScreenshot',
  ]);
  assert.equal(input.some(({ method }) => method.startsWith('Input.')), false);
});

test('native gesture readiness is checked once at pointer-down', async (t) => {
  const { backend, commands } = await browserFixture(t, { windowState: 'minimized' });
  const connection = await backend.open({ profile: 'fixture', targetId: 'tab' }, { onFrame() {}, onClose() {} });
  t.after(() => connection.close());
  const start = commands.length;

  await connection.input({ kind: 'pointer', phase: 'down', pointerType: 'touch', gesture: 1, x: .5, y: .5 });
  await connection.input({ kind: 'pointer', phase: 'move', pointerType: 'touch', gesture: 1, x: .5, y: .4 });
  await connection.input({ kind: 'pointer', phase: 'up', pointerType: 'touch', gesture: 1, x: .5, y: .4 });

  const input = commands.slice(start);
  assert.equal(input.filter(({ method }) => method === 'Browser.getWindowForTarget').length, 1);
  assert.equal(input.filter(({ method }) => method === 'Browser.setWindowBounds').length, 1);
  assert.equal(input.filter(({ method }) => method === 'Page.captureScreenshot').length, 1);
  assert.deepEqual(input.filter(({ method }) => method === 'Input.dispatchTouchEvent').map(({ params }) => params.type),
    ['touchStart', 'touchMove', 'touchEnd']);
});

test('typing does not add renderer window-state round trips', async (t) => {
  const { backend, commands } = await browserFixture(t);
  const connection = await backend.open({ profile: 'fixture', targetId: 'tab' }, { onFrame() {}, onClose() {} });
  t.after(() => connection.close());
  const start = commands.length;

  await connection.input({ kind: 'text', text: 'a' });

  assert.deepEqual(commands.slice(start).map(({ method }) => method), ['Page.bringToFront', 'Input.insertText']);
});

test('failed gesture cancellation still stops capture and detaches the browser transport', async (t) => {
  const fixture = await browserFixture(t, { rejectCancel: true });
  const connection = await fixture.backend.open({ profile: 'fixture', targetId: 'tab' }, { onFrame() {}, onClose() {} });
  await connection.input({ kind: 'pointer', phase: 'down', pointerType: 'touch', gesture: 1, x: .2, y: .3 });
  const closed = once(fixture.peer(), 'close');
  await assert.rejects(connection.close(), /Browser command failed/);
  assert.ok(fixture.methods.includes('Page.stopScreencast'), 'a failed cancel must not skip capture cleanup');
  await closed;
});

test('viewer input is a bounded allowlist, never raw CDP or arbitrary evaluation', () => {
  assert.deepEqual(validateInput({ kind: 'click', x: 0.5, y: 0.4 }), { kind: 'click', x: 0.5, y: 0.4 });
  for (const input of [
    { kind: 'evaluate', expression: 'alert(1)' }, { kind: 'click', x: -1, y: 1 },
    { kind: 'click', x: NaN, y: 1 }, { kind: 'click', x: 2, y: 0 },
    { kind: 'text', text: 'a'.repeat(4097) }, { kind: 'key', key: 'F12' },
    { kind: 'scroll', x: 0, y: 0, deltaY: Infinity, deltaX: 0 },
  ]) assert.throws(() => validateInput(input), /invalid|unsupported/i);
});

test('CDP endpoints must be explicit loopback URLs without credentials or query', () => {
  assert.equal(validateCdpUrl('http://127.0.0.1:9222').origin, 'http://127.0.0.1:9222');
  for (const url of ['http://169.254.169.254', 'https://evil.example', 'http://user:pass@localhost:9222', 'http://127.0.0.1:9222/?token=x'])
    assert.throws(() => validateCdpUrl(url), /local|loopback|credentials/i);
});

test('gesture and focused-edit inputs are bounded capabilities, not raw browser commands', () => {
  assert.deepEqual(validateInput({ kind: 'pointer', phase: 'down', pointerType: 'touch', gesture: 7, x: .2, y: .3 }),
    { kind: 'pointer', phase: 'down', pointerType: 'touch', gesture: 7, x: .2, y: .3 });
  assert.equal(validateInput({ kind: 'edit', operation: 'insert', text: 'typed', focusToken: 'a'.repeat(32) }).text, 'typed');
  assert.equal(validateInput({ kind: 'edit', operation: 'key', key: 'ArrowLeft', focusToken: 'a'.repeat(32) }).key, 'ArrowLeft');
  assert.deepEqual(validateInput({ kind: 'focus' }), { kind: 'focus' });
  for (const input of [
    { kind: 'pointer', phase: 'raw', pointerType: 'touch', gesture: 1, x: .2, y: .3 },
    { kind: 'pointer', phase: 'down', pointerType: 'pen', gesture: 1, x: .2, y: .3 },
    { kind: 'pointer', phase: 'down', pointerType: 'mouse', gesture: -1, x: .2, y: .3 },
    { kind: 'edit', operation: 'insert', text: 'x', focusToken: 'selector' },
    { kind: 'edit', operation: 'evaluate', text: 'x', focusToken: 'a'.repeat(32) },
    { kind: 'edit', operation: 'key', key: 'F12', focusToken: 'a'.repeat(32) },
  ]) assert.throws(() => validateInput(input), /invalid|unsupported/i);
});

test('native picker inputs are document-bound, token-bound and shape bounded', () => {
  const document = '1'.repeat(32), pickerToken = '2'.repeat(32);
  assert.deepEqual(validateInput({ kind: 'pickerOpen', document, regionId: `${document}:17` }),
    { kind: 'pickerOpen', document, regionId: `${document}:17` });
  assert.deepEqual(validateInput({ kind: 'pickerApply', pickerToken, indices: [0, 7] }),
    { kind: 'pickerApply', pickerToken, indices: [0, 7] });
  assert.deepEqual(validateInput({ kind: 'pickerApply', pickerToken, color: '#09afce' }),
    { kind: 'pickerApply', pickerToken, color: '#09afce' });
  assert.deepEqual(validateInput({ kind: 'pickerCancel', pickerToken }), { kind: 'pickerCancel', pickerToken });
  for (const input of [
    { kind: 'pickerOpen', document: 'not-a-document', regionId: 'not-a-region' },
    { kind: 'pickerOpen', document, regionId: 17 },
    { kind: 'pickerOpen', document, regionId: `${'3'.repeat(32)}:17` },
    { kind: 'pickerOpen', document, regionId: `${document}:0` },
    { kind: 'pickerApply', pickerToken, indices: [0], color: '#09afce' },
    { kind: 'pickerApply', pickerToken, indices: [0, 0] },
    { kind: 'pickerApply', pickerToken, indices: [-1] },
    { kind: 'pickerApply', pickerToken, indices: Array.from({ length: 257 }, (_, index) => index) },
    { kind: 'pickerApply', pickerToken, color: '#09AFCE' },
    { kind: 'pickerApply', pickerToken, color: '#09afce<script>' },
    { kind: 'pickerCancel', pickerToken: 'selector' },
  ]) assert.throws(() => validateInput(input), /invalid|unsupported/i);
});

test('unacknowledged CDP input terminates its transport rather than silently dropping the command', async (t) => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(() => { for (const client of server.clients) client.terminate(); server.close(); });
  const connected = once(server, 'connection');
  const cdp = await new CdpConnection({ commandTimeoutMs: 40 }).connect(`ws://127.0.0.1:${server.address().port}`);
  const [peer] = await connected;
  const closed = once(peer, 'close');
  await assert.rejects(cdp.send('Input.insertText', { text: 'test' }), (error) => {
    assert.match(error.message, /uncertain/i);
    assert.equal(error.method, 'Input.insertText', 'transport errors identify the failed command without exposing its parameters');
    return true;
  });
  await closed;
  assert.notEqual(cdp.socket.readyState, WebSocket.OPEN);
});

test('a pending input retains the first command timeout that closed its transport', async (t) => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(() => { for (const client of server.clients) client.terminate(); server.close(); });
  const cdp = await new CdpConnection({ commandTimeoutMs: 80 }).connect(`ws://127.0.0.1:${server.address().port}`);
  const earlier = cdp.send('Runtime.evaluate', { expression: 'void 0' }).catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 25));
  const pending = cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: 1, y: 1 }] }).catch(error => error);
  const [first, input] = await Promise.all([earlier, pending]);
  assert.equal(first.method, 'Runtime.evaluate');
  assert.equal(input.method, 'Input.dispatchTouchEvent');
  assert.equal(input.causeCode, 'timeout');
  assert.equal(input.causeMethod, 'Runtime.evaluate', 'diagnostics must identify the earlier timeout instead of blaming only the pending input');
  assert.equal(Object.hasOwn(input, 'params'), false, 'failure metadata contains no command parameters');
});
