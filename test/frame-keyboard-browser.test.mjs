import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { CdpBrowser, CdpConnection } from '../src/cdp.mjs';
import { HandoffServer } from '../src/server.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(fn, label) { for (let n = 0; n < 200; n++) { try { const value = await fn(); if (value) return value; } catch {} await pause(15); } throw new Error('Timed out: ' + label); }

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'frame-keyboard-'));
  let releaseNavigation;
  const handler = (req, res) => {
    res.setHeader('content-type', 'text/html');
    const base = `http://127.0.0.1:${server.address().port}`, opaque = base.replace('127.0.0.1', 'localhost');
    if (req.url.startsWith('/slow-child')) {
      releaseNavigation = () => { if (!res.writableEnded) res.end('<input id=field><script>field.focus()</script>'); };
      return;
    }
    if (req.url.startsWith('/child')) return res.end('<style>body{margin:0}input{position:absolute;left:10px;top:10px;width:180px;height:35px}</style><input id=field><script>addEventListener("input",()=>top.postMessage({dummy:field.value},"*"))</script>');
    if (req.url.startsWith('/middle')) return res.end(`<style>body{margin:0}iframe{position:absolute;left:0;top:0;width:300px;height:100px;border:0}</style><iframe src="${base}/child"></iframe>`);
    const src = req.url.includes('sameprocess') ? `http://127.0.0.1:${other.address().port}/child`
      : opaque + (req.url.includes('nested') ? '/middle' : '/child');
    res.end(`<style>body{margin:0}iframe{position:absolute;left:20px;top:120px;width:340px;height:130px;border:0}input{position:absolute;left:20px;top:20px}</style><input id=topfield><iframe id=frame src="${src}"></iframe><script>window.dummy='';addEventListener('message',e=>dummy=e.data.dummy)</script>`);
  };
  const server = createServer(handler), other = createServer(handler);
  await Promise.all([new Promise(resolve => server.listen(0, '127.0.0.1', resolve)), new Promise(resolve => other.listen(0, '127.0.0.1', resolve))]);
  const chrome = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome-stable', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--site-per-process', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${directory}`], { stdio: 'ignore' });
  let remote, connection, handoff, messages = [], current = true;
  t.after(async () => {
    releaseNavigation?.(); await connection?.close(); remote?.close(); await handoff?.close();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => other.close(resolve))]);
    if (chrome.exitCode === null) { const exit = once(chrome, 'exit'); chrome.kill('SIGTERM'); await Promise.race([exit, pause(3000)]); if (chrome.exitCode === null) chrome.kill('SIGKILL'); }
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  const port = await until(async () => (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0], 'browser startup');
  const base = `http://127.0.0.1:${port}`, site = `http://127.0.0.1:${server.address().port}`;
  const tab = await (await fetch(`${base}/json/new?${encodeURIComponent(site)}`, { method: 'PUT' })).json();
  remote = await new CdpConnection().connect(tab.webSocketDebuggerUrl);
  await remote.send('Page.enable'); await remote.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  const evaluate = async expression => { const r = await remote.send('Runtime.evaluate', { expression, returnByValue: true }); if (r.exceptionDetails) throw new Error('fixture evaluation failed'); return r.result.value; };
  const backend = new CdpBrowser({ fixture: base });
  let metadata;
  async function open(mode) {
    await connection?.close(); connection = null;
    await remote.send('Page.navigate', { url: site + '/' + mode });
    await until(() => evaluate('document.readyState === "complete"'), mode + ' page load');
    connection = await backend.open({ profile: 'fixture', targetId: tab.id }, { onFrame() {}, onClose() {}, onMetadata(value) { if (value.interactions) metadata = value.interactions; } });
    await connection.input({ kind: 'click', x: 80 / 800, y: 145 / 600 });
    return connection;
  }
  const activate = () => connection.input({ kind: 'nativeKeyboardOpen', document: metadata.document }).then(result => result.keyboard.token);
  const edit = (token, text = 'dummy') => connection.input({ kind: 'nativeEdit', keyboardToken: token, operation: 'insert', text });
  async function serverSession() {
    await connection?.close(); connection = null;
    handoff = new HandoffServer({ backend, isBindingCurrent: () => current }); await handoff.start();
    const invite = await handoff.createShare({ owner: 'owner', profile: 'fixture', targetId: tab.id });
    const inviteBase = handoff.localUrl + '/s/' + invite.id;
    const post = (action, data = {}) => fetch(inviteBase + '/' + action, { method: 'POST', headers: { origin: handoff.localUrl, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(data) });
    let cookie;
    const claimed = await post('claim', { token: new URL(invite.url).hash.slice(8) }); cookie = claimed.headers.get('set-cookie').split(';')[0];
    const ws = new WebSocket(inviteBase.replace('http:', 'ws:') + '/stream', { headers: { cookie, origin: handoff.localUrl } });
    ws.on('error', () => {}); t.after(() => ws.terminate());
    messages = []; ws.on('message', raw => {
      const msg = JSON.parse(String(raw)); messages.push(msg);
      if (msg.displayId) ws.send(JSON.stringify({ type: 'displayAck', connectionId: msg.connectionId, displayId: msg.displayId, visibility: 'visible' }));
    });
    await until(() => messages.find(msg => msg.type === 'ready'), 'server stream ready');
    const entry = handoff.streams.get(invite.id);
    await post('control');
    let sequence = 0;
    async function input(event, wait = true) {
      const id = ++sequence;
      ws.send(JSON.stringify({ type: 'input', id, connectionId: entry.connectionId, controlId: handoff.store.get(invite.id).controlId, event }));
      if (wait) return until(() => messages.find(msg => msg.id === id && ['inputAck', 'error'].includes(msg.type)), 'input ACK');
    }
    await input({ kind: 'click', x: 80 / 800, y: 145 / 600 });
    const doc = entry.display.currentMetadata.interactions.document;
    const activated = await input({ kind: 'nativeKeyboardOpen', document: doc });
    assert.ok(activated.keyboard?.token, JSON.stringify(activated));
    return { server: handoff, ws, post, entry, input, token: activated.keyboard.token, close: async () => { ws.terminate(); await handoff.close(); handoff = null; } };
  }
  return { open, activate, edit, evaluate, remote, site, serverSession, releaseNavigation: () => releaseNavigation?.(), connection: () => connection, drift: () => { current = false; } };
}

test('native Keyboard supports OOPIF, nested OOPIF and same-process cross-origin frames', async t => {
  const ctx = await fixture(t);
  for (const mode of ['opaque', 'nested', 'sameprocess']) {
    await ctx.open(mode); const token = await ctx.activate();
    await ctx.edit(token, mode + ' 😀 日本');
    await until(async()=>await ctx.evaluate('dummy')===mode+' 😀 日本','cross-process dummy input message');
    assert.equal(await ctx.evaluate('dummy'), mode + ' 😀 日本');
    await ctx.edit(token, ' twice'); await until(async()=>await ctx.evaluate('dummy')===mode+' 😀 日本 twice','second cross-process dummy input message'); assert.equal(await ctx.evaluate('dummy'), mode + ' 😀 日本 twice');
  }
});

test('native frame capability rejects top focus, replacement, process swap and navigation start', async t => {
  const ctx = await fixture(t);
  for (const change of ['top-focus', 'replacement', 'swap', 'navigation-start']) {
    await ctx.open('opaque'); const token = await ctx.activate();
    if (change === 'top-focus') await ctx.evaluate('topfield.focus()');
    if (change === 'replacement') await ctx.evaluate('frame.outerHTML=frame.outerHTML');
    if (change === 'swap') await ctx.evaluate('frame.src="/child"');
    if (change === 'navigation-start') await ctx.evaluate('frame.src=frame.src.replace("/child","/slow-child")');
    await pause(60);
    await assert.rejects(ctx.edit(token, 'STALE'), /frame|keyboard|changed/i);
    assert.equal(await ctx.evaluate('dummy'), '');
    if (change === 'navigation-start') ctx.releaseNavigation();
  }
});

for (const action of ['release', 'done', 'disconnect', 'drift']) test(`real server revokes an in-validation native edit on ${action}`, async t => {
  const ctx = await fixture(t); await ctx.open('opaque');
  const session = await ctx.serverSession();
  const original = CdpConnection.prototype.send, held = deferred(), entered = deferred();
  let hold = true;
  CdpConnection.prototype.send = async function(method, params, childSession) {
    if (hold && method === 'DOM.getFrameOwner') { hold = false; entered.resolve(); await held.promise; }
    return original.call(this, method, params, childSession);
  };
  try {
    await session.input({ kind: 'nativeEdit', keyboardToken: session.token, operation: 'insert', text: 'STALE' }, false);
    await entered.promise;
    if (action === 'disconnect') session.ws.terminate();
    else if (action === 'drift') { ctx.drift(); await session.post('release'); }
    else await session.post(action);
    await pause(15); held.resolve(); await session.entry.queue;
    assert.equal(await ctx.evaluate('dummy'), '', 'revocation during validation sends zero text to the page');
  } finally {
    held.resolve(); CdpConnection.prototype.send = original; await session.close();
  }
});

for (const operation of ['activate', 'edit']) test(`OOPIF navigation while ${operation} validation is pending denies late text`, async t => {
  const ctx = await fixture(t); await ctx.open('opaque'); const token = await ctx.activate();
  const original = CdpConnection.prototype.send, entered = deferred(), held = deferred(); let hold = true;
  CdpConnection.prototype.send = async function(method, params, sessionId) {
    if (hold && method === 'DOM.getFrameOwner') { hold = false; entered.resolve(); await held.promise; }
    return original.call(this, method, params, sessionId);
  };
  try {
    const pending = operation === 'activate' ? ctx.activate() : ctx.edit(token, 'STALE');
    await entered.promise;
    await ctx.evaluate('frame.src=frame.src.replace("/child","/slow-child")');
    await pause(30); held.resolve();
    await assert.rejects(pending, /frame|keyboard|changed/i);
    await assert.rejects(ctx.edit(token, 'LATE'), /frame|keyboard|changed/i);
    assert.equal(await ctx.evaluate('dummy'), '');
  } finally { held.resolve(); ctx.releaseNavigation(); CdpConnection.prototype.send = original; }
});

test('native focus-changing keys revoke before any subsequent queued typing', async t => {
  const ctx = await fixture(t); await ctx.open('opaque'); const token = await ctx.activate();
  const result = await ctx.connection().input({ kind: 'nativeEdit', keyboardToken: token, operation: 'key', key: 'Tab' });
  assert.equal(result.keyboard, null);
  await assert.rejects(ctx.edit(token, 'STALE'), /frame|keyboard|changed/i);
  assert.equal(await ctx.evaluate('dummy'), '');
});

test('a dispatched native text timeout remains uncertain and blocks automation without retry', async t => {
  const ctx = await fixture(t); await ctx.open('opaque'); const session = await ctx.serverSession();
  const original = CdpConnection.prototype.send; let dispatches = 0;
  CdpConnection.prototype.send = function(method, params, sessionId) {
    if (method === 'Input.insertText') {
      dispatches++; this.commandTimeoutMs = 60;
      const emit = this.socket.emit;
      this.socket.emit = function(event, ...args) {
        if (event === 'message') {
          const message = JSON.parse(String(args[0]));
          if (message.id && message.result && !message.method) return true;
        }
        return emit.call(this, event, ...args);
      };
    }
    return original.call(this, method, params, sessionId);
  };
  try {
    await session.input({ kind: 'nativeEdit', keyboardToken: session.token, operation: 'insert', text: 'DELIVERED_WITHOUT_ACK' }, false);
    await until(() => session.server.store.gate.poisonReason, 'uncertain native input poisons gate');
    assert.equal(await ctx.evaluate('dummy'), 'DELIVERED_WITHOUT_ACK', 'browser accepted the command although its ACK was lost');
    assert.equal(dispatches, 1);
    assert.throws(() => session.server.store.gate.enter('agent'), /uncertain|recovery/i);
  } finally { CdpConnection.prototype.send = original; await session.close(); }
});

test('old manual tokens do not survive watch mode and explicit control reacquisition', async t => {
  const ctx = await fixture(t); await ctx.open('opaque'); const session = await ctx.serverSession();
  try {
    await session.post('release'); await session.entry.queue;
    assert.equal(session.server.store.get(session.entry.share.id).mode, 'watch');
    await session.post('control');
    const reply = await session.input({ kind: 'nativeEdit', keyboardToken: session.token, operation: 'insert', text: 'OLD_LEASE' });
    assert.equal(reply.type, 'error');
    assert.equal(await ctx.evaluate('dummy'), '');
    assert.equal(session.server.store.gate.poisonReason, null, 'known stale capability rejection does not poison the gate');
  } finally { await session.close(); }
});

test('watch mode cannot mint a native keyboard capability', async t => {
  const ctx = await fixture(t); await ctx.open('opaque'); const session = await ctx.serverSession();
  try {
    await session.post('release'); await session.entry.queue;
    const document = session.entry.display.currentMetadata.interactions.document;
    const reply = await session.input({ kind: 'nativeKeyboardOpen', document });
    assert.equal(reply.type, 'error'); assert.equal(Object.hasOwn(reply, 'keyboard'), false);
    assert.equal(await ctx.evaluate('dummy'), '');
  } finally { await session.close(); }
});
