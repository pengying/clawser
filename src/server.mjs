import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { LeaseStore } from './leases.mjs';
import { validateInput } from './cdp.mjs';
import { DisplayStream } from './display-stream.mjs';
import { ComparisonProxy } from './comparison-proxy.mjs';

const MAX_BODY = 16_384;
const PUBLIC = new URL('../public/', import.meta.url);
const assets = new Map([['/assets/viewer.js', ['viewer.js', 'text/javascript']], ['/assets/editing.js', ['editing.js', 'text/javascript']], ['/assets/picker.js', ['picker.js', 'text/javascript']], ['/assets/style.css', ['style.css', 'text/css']]]);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function security(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
}
function json(res, status, value) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
}
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail('JSON required', 415);
  if (Number(req.headers['content-length']) > MAX_BODY) { req.resume(); throw fail('Payload too large', 413); }
  let size = 0, chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw fail('Payload too large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail('Invalid JSON'); }
}
const cookie = (req) => (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('handoff='))?.slice(8);

export class HandoffServer {
  streams = new Map();
  closing = new Set();
  constructor({ backend, store = new LeaseStore(), publicBaseUrl, comparisonProxyUrl, isBindingCurrent = () => true } = {}) {
    this.backend = backend; this.store = store; this.isBindingCurrent = isBindingCurrent;
    this.comparisonProxy = comparisonProxyUrl ? new ComparisonProxy(comparisonProxyUrl) : null;
    this.setPublicBase(publicBaseUrl);
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY, perMessageDeflate: false });
    this.server = createServer((req, res) => { void this.handle(req, res); });
    this.server.headersTimeout = 10_000; this.server.requestTimeout = 15_000;
    this.server.maxConnections = 128;
    this.requestWindow = { at: Date.now(), count: 0 };
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.store.on('release', (share) => { const entry = this.streams.get(share.id); if (entry) this.cancelEntry(entry); });
    this.store.on('ended', ({ id }) => this.stopStream(id));
  }
  bindingCurrent() {
    if (this.bindingFailed) return false;
    let current = false;
    try { current = this.isBindingCurrent() === true; } catch {}
    if (current) return true;
    // Latch before retirement: the source guard may itself end shares and
    // synchronously reenter stream cleanup. Never discard pending input fences.
    this.bindingFailed = true;
    for (const entry of this.streams.values()) {
      entry.accepting = false; entry.connection?.stopCaptureAssist?.(); entry.connection?.revokeKeyboard?.();
      if (entry.ws.readyState < WebSocket.CLOSING) entry.ws.close(4003, 'browser_configuration_changed');
    }
    return false;
  }
  requireBinding() { if (!this.bindingCurrent()) throw fail('Browser configuration changed', 409); }
  setPublicBase(value) {
    if (!value) { this.publicBaseUrl = undefined; return; }
    const url = new URL(value);
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!localHttp && url.protocol !== 'https:') || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
      throw new Error('Public base must be an HTTPS origin (or loopback HTTP for development)');
    this.publicBaseUrl = url.origin;
  }
  async start({ port = 0 } = {}) {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', resolve);
    });
    this.localUrl = 'http://127.0.0.1:' + this.server.address().port;
    this.expiry = setInterval(() => this.store.sweep(), 100); this.expiry.unref();
    this.ping = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (!ws.alive) { ws.terminate(); continue; }
        ws.alive = false; ws.ping();
      }
    }, 10_000); this.ping.unref();
    return this.localUrl;
  }
  originAllowed(req) { return [this.publicBaseUrl || this.localUrl].includes(req.headers.origin); }
  viewerMetrics(id) { return this.streams.get(id)?.display?.snapshot() || null; }
  async createShare({ owner, profile, targetId, permission = 'control', ttlMs = 300_000 }) {
    this.requireBinding();
    const tab = (await this.backend.list(profile)).find((tab) => tab.targetId === targetId);
    this.requireBinding();
    if (!tab) throw new Error('Selected HTTP(S) tab is unavailable');
    const invite = this.store.create({ owner, target: { profile, targetId }, permission, ttlMs });
    const url = (this.publicBaseUrl || this.localUrl) + '/s/' + invite.id + '/#invite=' + invite.secret;
    return { id: invite.id, url, expiresAt: invite.expiresAt, permission, title: tab.title };
  }
  async handle(req, res) {
    security(res);
    try {
      if (Date.now() - this.requestWindow.at > 1000) this.requestWindow = { at: Date.now(), count: 0 };
      if (++this.requestWindow.count > 100) { req.resume(); throw fail('Request rate exceeded', 429); }
      if (this.comparisonProxy?.matches(req.url)) { this.comparisonProxy.handle(req, res); return; }
      const path = new URL(req.url, 'http://localhost').pathname;
      const asset = assets.get(path);
      const route = path.match(/^\/s\/([a-f0-9]{32})\/(claim|state|control|release|done)?$/);
      if (req.method === 'GET' && (asset || route && !route[2])) {
        const [file, type] = asset || ['index.html', 'text/html'];
        const data = await readFile(new URL(file, PUBLIC));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(data); return;
      }
      if (!route) throw fail('Not found', 404);
      const [, id, action] = route;
      this.requireBinding();
      if (req.method === 'POST') {
        if (!this.originAllowed(req)) throw fail('Origin rejected', 403);
        const input = await body(req);
        this.requireBinding();
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Invalid request');
        if (action === 'claim') {
          let session;
          try { session = this.store.claim(id, input.token); } catch { throw fail('Invalid, claimed, or expired invitation', 401); }
          const secure = (this.publicBaseUrl || this.localUrl).startsWith('https:') ? '; Secure' : '';
          res.setHeader('Set-Cookie', 'handoff=' + session.secret + '; Path=/s/' + id + '/; HttpOnly; SameSite=Strict; Max-Age=' + Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)) + secure);
          json(res, 200, this.store.state(this.store.authorize(id, session.secret))); return;
        }
      } else if (req.method !== 'GET' || action !== 'state') throw fail('Method not allowed', 405);
      let share;
      try { share = this.store.authorize(id, cookie(req)); } catch { throw fail('Invalid or expired viewer session', 401); }
      if (req.method === 'GET') { json(res, 200, this.store.state(share)); return; }
      if (action === 'control') {
        if (share.permission !== 'control') throw fail('Watch-only invitation', 403);
        if (this.store.gate.poisonReason) throw Object.assign(fail(this.store.gate.poisonReason, 409), { recoveryRequired: true });
        const entry = this.streams.get(id);
        if (!entry?.ready || entry.failed || entry.ws.readyState !== WebSocket.OPEN) throw fail('Browser stream is not ready. Wait for the view to connect before taking control.', 409);
        try {
          await this.store.takeControl(share);
          this.requireBinding();
          if (this.streams.get(id) !== entry || !entry.ready || entry.failed || entry.ws.readyState !== WebSocket.OPEN) {
            this.store.releaseControl(share); throw new Error('Browser connection changed. Take control again after reconnecting.');
          }
          entry.accepting = true;
        } catch (error) { throw Object.assign(fail(error.message, 409), { recoveryRequired: Boolean(this.store.gate.poisonReason) }); }
      } else if (action === 'release') this.store.releaseControl(share);
      else if (action === 'done') { this.store.end(share, 'done'); json(res, 200, { mode: 'ended' }); return; }
      else throw fail('Not found', 404);
      json(res, 200, this.store.state(share));
    } catch (error) { json(res, error.status || 400, { error: error.status ? error.message : 'Request unavailable', ...(error.recoveryRequired === true ? { recoveryRequired: true } : {}) }); }
  }
  upgrade(req, socket, head) {
    if (this.comparisonProxy?.matches(req.url)) { this.comparisonProxy.upgrade(req, socket, head); return; }
    let share;
    try {
      this.requireBinding();
      const route = new URL(req.url, 'http://localhost').pathname.match(/^\/s\/([a-f0-9]{32})\/stream$/);
      if (!route || !this.originAllowed(req) || this.streams.has(route[1])) throw new Error('Denied');
      share = this.store.authorize(route[1], cookie(req));
    } catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ws.alive = true; ws.on('pong', () => { ws.alive = true; }); ws.on('error', () => {});
      const entry = { ws, share, connectionId: randomBytes(16).toString('hex'), lastInput: 0, ready: false, accepting: false, failed: false, executing: false, queue: Promise.resolve(), pending: 0, gestureHeld: false };
      this.streams.set(share.id, entry);
      const send = (value) => {
        if (!this.bindingCurrent() || ws.readyState !== WebSocket.OPEN) return false;
        // Receiver pacing bounds normal display traffic; a non-reading peer
        // must also be unable to accumulate unlimited control/error replies.
        if (ws.bufferedAmount > 1_000_000) { ws.terminate(); return false; }
        ws.send(JSON.stringify(value)); return true;
      };
      const alive = () => { try { this.store.current(share); return true; } catch { return false; } };
      entry.display = new DisplayStream({ connectionId: entry.connectionId, send,
        canSend: () => ws.readyState === WebSocket.OPEN && alive() && !entry.executing, lastInputId: () => entry.lastInput });
      ws.on('close', () => {
        entry.display.close();
        if (this.streams.get(share.id) !== entry) return;
        this.store.releaseControl(share);
        void this.cleanup(entry);
      });
      ws.on('message', (raw, binary) => {
        if (entry.failed) return;
        if (binary || entry.pending >= 20) { ws.close(1008, 'input_limit'); return; }
        let inputs, packet;
        const reply = (type, extra = {}) => send({ type, id: packet?.id, connectionId: entry.connectionId, controlId: packet?.controlId, ...extra });
        const rejectInput = (message) => {
          entry.failed = true; entry.accepting = false; entry.connection?.stopCaptureAssist?.();
          if (!entry.failureReplied) { entry.failureReplied = true; reply('error', { error: message, recoveryRequired: Boolean(this.store.gate.poisonReason) }); }
          if (ws.readyState < WebSocket.CLOSING) ws.close(4003, 'input_failed');
        };
        try {
          packet = JSON.parse(String(raw));
          if (packet.type === 'displayAck') { entry.display.ack(packet); entry.connection?.captureDemandChanged?.(); return; }
          if (packet.type === 'captureVisibility') {
            if (packet.connectionId !== entry.connectionId || !['visible', 'hidden'].includes(packet.visibility)) throw new Error();
            entry.display.visibility = packet.visibility; entry.connection?.captureDemandChanged?.(); return;
          }
          if (packet.type !== 'input') throw new Error();
          if (share.mode !== 'control') { rejectInput('Take control before sending input'); void this.cancelEntry(entry).catch(() => this.store.gate.poison()); return; }
          if (packet.connectionId !== entry.connectionId || packet.controlId !== share.controlId || !Number.isSafeInteger(packet.id) || packet.id <= entry.lastInput) {
            rejectInput('Stale input generation or sequence'); void this.cancelEntry(entry).catch(() => this.store.gate.poison()); return;
          }
          entry.lastInput = packet.id;
          if (Object.hasOwn(packet, 'events')) {
            if (Object.hasOwn(packet, 'event') || !Array.isArray(packet.events) || !packet.events.length || packet.events.length > 8) throw new Error();
            inputs = packet.events.map(validateInput);
            if (!inputs.every((event) => event.kind === 'edit' && event.focusToken === inputs[0].focusToken &&
              ['insert', 'backspace', 'delete'].includes(event.operation) && (event.operation !== 'insert' || event.text.length <= 256))) throw new Error();
          } else inputs = [validateInput(packet.event)];
        } catch {
          rejectInput('Invalid input');
          void this.cancelEntry(entry).catch(() => this.store.gate.poison());
          return;
        }
        entry.pending++;
        const receivedAt = performance.now();
        entry.queue = entry.queue.then(async () => {
          if (!this.bindingCurrent() || entry.failed || !alive() || ws.readyState !== WebSocket.OPEN || !entry.ready || !entry.accepting || share.mode !== 'control' || packet.controlId !== share.controlId)
            throw new Error('Take control before sending input');
          entry.executing = true;
          this.store.gate.beginInput(share.id);
          const startedAt = performance.now();
          entry.display.record('serverInputQueueMs', startedAt - receivedAt);
          let currentInput;
          try {
            let result;
            for (const input of inputs) {
              // A batch saves network round trips, not browser checks. Stop
              // between edits if handback, expiry, or disconnect occurred.
              if (!this.bindingCurrent() || entry.failed || !alive() || ws.readyState !== WebSocket.OPEN || !entry.ready || !entry.accepting || share.mode !== 'control' || packet.controlId !== share.controlId)
                throw Object.assign(new Error('Take control before sending input'), { definitive: true });
              if (input.kind === 'pointer' && input.phase === 'down') {
                if (entry.gestureHeld) throw Object.assign(new Error('A gesture is already active'), { definitive: true });
                this.store.gate.beginInput(share.id); entry.gestureHeld = true;
              }
              currentInput = input;
              result = await entry.connection.input(input);
              if (input.kind === 'pointer' && ['up', 'cancel'].includes(input.phase) && entry.gestureHeld) {
                entry.gestureHeld = false; this.store.gate.endInput(share.id);
              }
            }
            reply('inputAck', { ...(result && Object.hasOwn(result, 'focus') ? { focus: result.focus } : {}),
              ...(result && Object.hasOwn(result, 'picker') ? { picker: result.picker } : {}),
              ...(result && Object.hasOwn(result, 'keyboard') ? { keyboard: result.keyboard } : {}) });
          }
          catch (error) {
            if (!error.definitive) {
              const method = error.method || 'unknown';
              const command = `${method}`;
              const code = error.causeCode || 'unknown';
              const cause = `${code}`;
              const causeMethod = error.causeMethod || 'unknown';
              const causeCommand = `${causeMethod}`;
              const inputKind = currentInput?.kind || 'unknown';
              const kind = `${inputKind}`;
              const inputPhase = currentInput?.phase || 'none';
              const phase = `${inputPhase}`;
              console.warn('Browser Handoff input transport failed; command=' + command + '; cause=' + cause + '; causeCommand=' + causeCommand + '; kind=' + kind + '; phase=' + phase);
              this.store.gate.poison();
              rejectInput('Input outcome uncertain. Agent browser actions remain blocked; operator recovery required.');
              await this.closeConnection(entry);
              throw new Error('Input outcome uncertain. Agent browser actions remain blocked; operator recovery required.');
            }
            rejectInput(error.message);
            await this.cancelHeld(entry);
            throw error;
          }
          finally { entry.display.record('serverInputWorkMs', performance.now() - startedAt); this.store.gate.endInput(share.id); }
        }).catch((error) => rejectInput(error.message)).finally(() => { entry.executing = false; entry.pending--; entry.display.flush(); });
      });
      entry.opening = this.backend.open(share.target, {
        getCaptureState: () => ({
          live: this.bindingCurrent() && this.streams.get(share.id) === entry && alive() && !entry.failed &&
            !this.store.gate.poisonReason && ws.readyState === WebSocket.OPEN,
          // A running human input may itself need a concurrent compositor paint.
          // Only reader visibility/ACK/buffer demand gates capture work here.
          demand: entry.ready && entry.display.visibility === 'visible' && !entry.display.inFlight && ws.bufferedAmount < 64_000,
          control: entry.accepting && share.mode === 'control' ? share.controlId : null,
        }),
        isInputAllowed: () => this.bindingCurrent() && !entry.failed && alive() && ws.readyState === WebSocket.OPEN && entry.ready && entry.accepting && share.mode === 'control',
        onFrame: (frame) => { if (!this.bindingCurrent()) return; if (alive()) entry.display.frame(frame); else ws.close(4001, 'expired'); },
        onMetadata: (metadata) => { if (!this.bindingCurrent()) return; if (alive()) entry.display.metadata(metadata); },
        onClose: () => {
          if (ws.readyState >= WebSocket.CLOSING) return;
          if (entry.executing || entry.gestureHeld) {
            this.store.gate.poison(); entry.failed = true; entry.accepting = false;
            if (!entry.failureReplied) {
              entry.failureReplied = true;
              send({ type: 'error', connectionId: entry.connectionId, recoveryRequired: true,
                error: 'Input outcome uncertain. Agent browser actions remain blocked; operator recovery required.' });
            }
            ws.close(4003, 'input_failed');
          } else ws.close(4002, 'browser_closed');
        },
      }).then((connection) => {
        entry.connection = connection;
        // Do not await cleanup from opening: cleanup itself waits for opening.
        if (!alive() || ws.readyState !== WebSocket.OPEN) { void this.cleanup(entry); return; }
        entry.ready = true; entry.connection?.captureDemandChanged?.(); send({ type: 'ready', connectionId: entry.connectionId, inputWindow: 4, ...this.store.state(share) });
      }).catch(() => { ws.close(4002, 'browser_unavailable'); });
    });
  }
  async closeConnection(entry) {
    try { await entry.connection?.close(); }
    catch { this.store.gate.poison(); }
  }
  async cancelHeld(entry) {
    if (!entry.gestureHeld) return;
    try {
      if (typeof entry.connection?.cancelGesture !== 'function') throw new Error('Gesture cleanup unavailable');
      await entry.connection.cancelGesture();
    } catch {
      this.store.gate.poison();
      await this.closeConnection(entry);
    } finally {
      entry.gestureHeld = false;
      this.store.gate.endInput(entry.share.id);
    }
  }
  cancelEntry(entry) {
    entry.accepting = false;
    entry.connection?.releaseCaptureControl?.();
    entry.connection?.revokeKeyboard?.();
    if (entry.cancelQueued) return entry.cancelQueued;
    entry.queue = entry.queue.catch(() => { this.store.gate.poison(); }).then(async () => {
      await this.cancelHeld(entry);
      await entry.connection?.cancelPicker?.();
    });
    const work = entry.queue;
    entry.cancelQueued = work.finally(() => { entry.cancelQueued = null; });
    return entry.cancelQueued;
  }
  cleanup(entry) {
    if (entry.cleanup) return entry.cleanup;
    entry.ready = entry.accepting = false;
    entry.connection?.stopCaptureAssist?.();
    const work = entry.cleanup = (async () => {
      await entry.opening;
      await this.cancelEntry(entry);
      await this.closeConnection(entry);
    })().catch(() => { this.store.gate.poison(); }).finally(() => {
      // Keep the reservation until the old contact AND capture have settled.
      if (this.streams.get(entry.share.id) === entry) this.streams.delete(entry.share.id);
      this.closing.delete(work);
    });
    this.closing.add(work);
    return work;
  }
  stopStream(id) {
    const entry = this.streams.get(id);
    if (entry) { entry.ready = false; entry.ws.close(4001, 'ended'); }
  }
  async close() {
    clearInterval(this.expiry); clearInterval(this.ping);
    this.comparisonProxy?.close();
    this.store.close();
    const entries = [...this.streams.values()];
    for (const entry of entries) { entry.ws.terminate(); this.cleanup(entry); }
    await Promise.allSettled(entries.map((entry) => entry.opening));
    await Promise.allSettled([...this.closing]);
    this.wss.close();
    if (this.server.listening) await new Promise((resolve) => this.server.close(resolve));
  }
}
