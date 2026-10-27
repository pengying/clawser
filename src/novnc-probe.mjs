import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { connect as connectTcp, isIPv4 } from 'node:net';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

const PREFIX = '/probe/novnc/';
const PUBLIC = new URL('../public/', import.meta.url);
const MAX_BODY = 4096;
const MAX_BUFFERED = 1024 * 1024;
const token = () => randomBytes(32).toString('base64url');
const digest = (value) => createHash('sha256').update(String(value)).digest();
const matches = (value, expected) => {
  if (typeof value !== 'string' || value.length > 128 || !Buffer.isBuffer(expected)) return false;
  const actual = digest(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const problem = (message, status = 400) => Object.assign(new Error(message), { status });

function security(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
}

function sendJson(res, status, value, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(value));
}

function rejectUpgrade(socket, status, label) {
  if (socket.destroyed) return;
  const text = `${status} ${label}`;
  socket.end(`HTTP/1.1 ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(label)}\r\n\r\n${label}`);
}

async function jsonBody(req, maximum = MAX_BODY) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw problem('JSON required', 415);
  if (Number(req.headers['content-length']) > maximum) { req.resume(); throw problem('Payload too large', 413); }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw problem('Payload too large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw problem('Invalid JSON'); }
}

function cookieValue(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === 'novnc_probe') return value.join('=');
  }
  return undefined;
}

function privateIpv4(host) {
  if (!isIPv4(host)) return false;
  const [first, second] = host.split('.').map(Number);
  return first === 10 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168;
}

function validateOrigin(value, allowLanHttp) {
  const url = new URL(value);
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  // Check the supplied literal too: URL parsing normalizes hex, octal and
  // shortened numeric hostnames into dotted IPv4 addresses.
  const literal = typeof value === 'string' ? /^http:\/\/([0-9.]+)(?::[0-9]+)?\/?$/i.exec(value)?.[1] : undefined;
  const lan = allowLanHttp === true && literal === url.hostname && privateIpv4(literal) && url.port !== '0';
  if ((!loopback && !lan && url.protocol !== 'https:') || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error('Probe public base must be an HTTPS origin, loopback HTTP, or explicitly enabled private IPv4 HTTP origin');
  return url.origin;
}

function rttSummary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction) => sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null;
  return { sampleCount: samples.length, latest: samples.at(-1) ?? null, p50: percentile(0.5), p95: percentile(0.95) };
}

function defaultTcpConnect({ host, port, signal }) {
  return new Promise((resolvePromise, reject) => {
    const socket = connectTcp({ host, port });
    socket.setNoDelay(true);
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => { socket.destroy(); cleanup(); reject(signal.reason || new Error('VNC connection cancelled')); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => { cleanup(); resolvePromise(socket); });
    socket.once('error', (error) => { cleanup(); reject(error); });
  });
}

function validRegistration(registration) {
  const endpoint = registration?.endpoint;
  const credentials = registration?.credentials;
  if (endpoint?.host !== '127.0.0.1' || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535)
    throw new Error('Supervisor must register a fixed loopback VNC endpoint');
  if (typeof credentials?.watch !== 'string' || typeof credentials?.control !== 'string')
    throw new Error('Supervisor did not register both VNC credentials');
  const watch = Buffer.from(credentials.watch).subarray(0, 8);
  const control = Buffer.from(credentials.control).subarray(0, 8);
  if (watch.length !== 8 || control.length !== 8 || timingSafeEqual(watch, control))
    throw new Error('VNC credentials need distinct effective eight-byte values');
  return { endpoint: { host: endpoint.host, port: endpoint.port }, credentials: { watch: credentials.watch, control: credentials.control } };
}

export class NoVncProbeGateway {
  sessions = new Map();
  creations = new Set();
  constructor({ supervisor, publicBaseUrl, allowLanHttp = false, noVncAssetsDir, tcpConnect = defaultTcpConnect, now = Date.now, monotonicNow = () => performance.now(), promotionMs = 10_000, heartbeatMs = 10_000, upstreamConnectMs = 5_000, maxProbes = 8, prefix = PREFIX, completionDisposition, capabilities = {}, onEnded } = {}) {
    for (const method of ['create', 'read', 'register', 'destroy', 'verifyExited']) {
      if (typeof supervisor?.[method] !== 'function') throw new Error(`Probe supervisor requires ${method}()`);
    }
    if (noVncAssetsDir !== undefined && (!isAbsolute(noVncAssetsDir) || !noVncAssetsDir))
      throw new Error('Pinned noVNC assets directory must be absolute');
    this.supervisor = supervisor;
    if (!/^\/[a-z][a-z0-9/-]*\/$/.test(prefix) || prefix.includes('//')) throw new Error('Invalid viewer route prefix');
    if (completionDisposition !== undefined && completionDisposition !== 'retained') throw new Error('Invalid completion disposition');
    this.prefix = prefix;
    this.completionDisposition = completionDisposition;
    this.capabilities = { ...(capabilities.clipboard === 'utf8' ? { clipboard: 'utf8' } : {}) };
    this.onEnded = onEnded;
    this.allowLanHttp = allowLanHttp;
    this.publicBaseUrl = publicBaseUrl ? validateOrigin(publicBaseUrl, allowLanHttp) : undefined;
    const origin = this.publicBaseUrl ? new URL(this.publicBaseUrl) : undefined;
    this.lanHttpOrigin = allowLanHttp === true && origin?.protocol === 'http:' && privateIpv4(origin.hostname) ? origin : undefined;
    this.noVncAssetsDir = noVncAssetsDir ? resolve(noVncAssetsDir) : undefined;
    this.tcpConnect = tcpConnect;
    this.now = now;
    this.monotonicNow = monotonicNow;
    this.promotionMs = promotionMs;
    this.heartbeatMs = heartbeatMs ?? 10_000;
    this.upstreamConnectMs = upstreamConnectMs;
    this.maxProbes = maxProbes;
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_BUFFERED });
    this.server = createServer((req, res) => { void this.handle(req, res); });
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 15_000;
    this.server.maxConnections = 64;
    this.server.on('upgrade', (req, socket, head) => { void this.upgrade(req, socket, head); });
  }

  async start({ port = 19400, host = '127.0.0.1' } = {}) {
    if (this.closed) throw new Error('Probe gateway is closed');
    if (this.lanHttpOrigin
      ? host !== this.lanHttpOrigin.hostname || port !== Number(this.lanHttpOrigin.port || 80)
      : host !== '127.0.0.1') throw new Error('Probe listener must bind loopback or the exact opted-in LAN HTTP origin address and port');
    if (this.server.listening) return this.localUrl;
    await new Promise((resolvePromise, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, resolvePromise);
    });
    this.localUrl = `http://${host}:${this.server.address().port}`;
    this.expiryTimer = setInterval(() => { void this.sweep(); }, 250);
    this.expiryTimer.unref();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.heartbeatTimer.unref();
    return this.localUrl;
  }

  get origin() { return this.publicBaseUrl || this.localUrl; }

  setPublicBase(value) {
    const origin = validateOrigin(value, false);
    if (!origin.startsWith('https:')) throw new Error('Published browser handoff requires HTTPS');
    if (this.lanHttpOrigin) throw new Error('Cannot replace a LAN listener origin');
    if ([...this.sessions.values()].some(session => !['ended', 'cleanup_failed'].includes(session.mode)))
      throw new Error('Cannot change origin while a viewer lease is active');
    this.publicBaseUrl = origin;
  }

  viewerCapabilities(session) {
    return { ...(session.permission === 'watch' ? { permission: 'watch' } : {}),
      ...(Object.keys(this.capabilities).length ? { capabilities: this.capabilities } : {}) };
  }

  async createProbe({ ttlSeconds = 300, permission = 'control' } = {}) {
    if (this.closed) throw new Error('Probe gateway is closed');
    if (!this.localUrl) throw new Error('Probe gateway must be started before creating a probe');
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 1800) throw new Error('Probe lifetime must be between 1 and 1800 seconds');
    if (!['watch', 'control'].includes(permission)) throw new Error('Invalid viewer permission');
    const active = [...this.sessions.values()].filter(({ mode }) => mode !== 'ended');
    if (active.length >= this.maxProbes) throw new Error('Too many active probes');
    const id = randomBytes(16).toString('hex');
    const inviteSecret = token();
    const expiresAt = this.now() + ttlSeconds * 1000;
    const session = { id, expiresAt, permission, mode: 'creating', generation: 0, inviteHash: digest(inviteSecret), attempts: [], clipboardWork: new Set() };
    session.transport = { funnelIngress: false, viewerBytesSent: 0, viewerBytesReceived: 0, peakBufferedAmount: 0, rttSamples: [] };
    this.sessions.set(id, session);
    const creation = this.finishCreation(session, inviteSecret);
    session.creation = creation;
    this.creations.add(creation);
    try {
      return await creation;
    } finally {
      session.creationDone = true;
      this.creations.delete(creation);
    }
  }

  async finishCreation(session, inviteSecret) {
    try {
      const created = await this.supervisor.create({ probeId: session.id, expiresAt: session.expiresAt });
      if (typeof created?.ownedId !== 'string' || !created.ownedId || created.ownedId.length > 256)
        throw new Error('Supervisor did not return an owned instance id');
      session.ownedId = created.ownedId;
      this.throwIfCreationEnded(session);
      const owned = await this.supervisor.read(session.ownedId);
      if (owned?.state !== 'running') throw new Error('Owned VNC server is not running');
      this.throwIfCreationEnded(session);
      const registration = validRegistration(await this.supervisor.register({ probeId: session.id, ownedId: session.ownedId }));
      session.endpoint = registration.endpoint;
      session.credentials = registration.credentials;
      this.throwIfCreationEnded(session);
      session.mode = 'unclaimed';
    } catch (error) {
      const reason = session.endingReason || (this.closed ? 'gateway_shutdown' : session.expiresAt <= this.now() ? 'expired' : 'setup_failed');
      if (session.ownedId) await this.runCleanup(session, reason);
      else this.sessions.delete(session.id);
      const message = reason === 'setup_failed' ? 'Could not create the disposable VNC probe' : `Probe creation ${reason === 'expired' ? 'expired' : 'ended'}`;
      throw Object.assign(new Error(message), { cause: error, probeId: session.id });
    }
    return { id: session.id, url: `${this.origin}${this.prefix}${session.id}/#invite=${inviteSecret}`, expiresAt: session.expiresAt };
  }

  throwIfCreationEnded(session) {
    if (session.endingReason || this.closed || session.expiresAt <= this.now()) {
      session.endingReason ||= this.closed ? 'gateway_shutdown' : 'expired';
      throw new Error('Probe creation ended');
    }
  }

  status(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Unknown probe');
    return {
      id,
      mode: session.mode,
      ...(session.reason ? { reason: session.reason } : {}),
      expiresAt: session.expiresAt,
      ...(this.completionDisposition ? { disposition: this.completionDisposition } : {}),
      transport: {
        route: this.lanHttpOrigin ? 'lan' : this.origin?.startsWith('https:') ? 'https' : 'loopback',
        funnelIngress: session.transport.funnelIngress,
        viewerBytesSent: session.transport.viewerBytesSent,
        viewerBytesReceived: session.transport.viewerBytesReceived,
        peakBufferedAmount: session.transport.peakBufferedAmount,
        // Ping/pong RTT includes queued bytes and browser/network turnaround;
        // it does not measure framebuffer rendering or input-to-paint latency.
        websocketRttMs: rttSummary(session.transport.rttSamples),
      },
      ...(session.mode === 'cleanup_failed' ? { ownedId: session.ownedId } : {}),
    };
  }

  originAllowed(req) { return Boolean(this.origin) && req.headers.origin === this.origin; }

  observeIngress(req, session) {
    // Diagnostic only: callers authenticate before observing this header.
    if (req.headers['tailscale-funnel-request'] === '?1') session.transport.funnelIngress = true;
  }

  observeBuffer(session, ws) {
    session.transport.peakBufferedAmount = Math.max(session.transport.peakBufferedAmount, ws.bufferedAmount);
  }

  sessionFor(id) {
    const session = this.sessions.get(id);
    if (!session) throw problem('Invalid or expired probe', 404);
    return session;
  }

  recordAttempt(session) {
    const cutoff = this.now() - 60_000;
    session.attempts = session.attempts.filter((at) => at > cutoff);
    if (session.attempts.length >= 30) throw problem('Authentication rate exceeded', 429);
    session.attempts.push(this.now());
  }

  authorize(req, session) {
    this.recordAttempt(session);
    if (['ending', 'ended', 'cleanup_failed'].includes(session.mode)) throw problem('Probe access ended', 410);
    if (!matches(cookieValue(req), session.sessionHash)) throw problem('Invalid viewer session', 401);
    if (session.expiresAt <= this.now()) { void this.end(session, 'expired'); throw problem('Probe expired', 410); }
    return session;
  }

  authorizeCleanup(req, session) {
    this.recordAttempt(session);
    if (!matches(cookieValue(req), session.sessionHash)) throw problem('Invalid viewer session', 401);
    return session;
  }

  async handle(req, res) {
    security(res);
    try {
      const url = new URL(req.url, 'http://localhost');
      const page = url.pathname.match(new RegExp(`^${this.prefix}([a-f0-9]{32})/$`));
      const action = url.pathname.match(new RegExp(`^${this.prefix}([a-f0-9]{32})/(claim|credentials|control|done|clipboard)$`));
      if (req.method === 'GET' && page) {
        const session = this.sessionFor(page[1]);
        if (['ending', 'ended', 'cleanup_failed'].includes(session.mode)) throw problem('Probe access ended', 410);
        const data = (await readFile(new URL('probe.html', PUBLIC), 'utf8')).replaceAll(PREFIX, this.prefix);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(data); return;
      }
      if (req.method === 'GET' && url.pathname === `${this.prefix}assets/probe.js`) return await this.servePublic(res, 'probe.js', 'text/javascript');
      if (req.method === 'GET' && url.pathname === `${this.prefix}assets/probe.css`) return await this.servePublic(res, 'probe.css', 'text/css');
      if (req.method === 'GET' && url.pathname.startsWith(`${this.prefix}novnc/`)) return await this.serveNoVnc(res, url.pathname.slice(`${this.prefix}novnc/`.length));
      if (req.method !== 'POST' || !action) { req.resume(); throw problem('Not found', 404); }
      if (!this.originAllowed(req)) { req.resume(); throw problem('Origin denied', 403); }
      const session = this.sessionFor(action[1]);
      const input = await jsonBody(req, action[2] === 'clipboard' ? 128 * 1024 : MAX_BODY);
      if (action[2] === 'claim') {
        this.claim(res, session, input);
        this.observeIngress(req, session);
        return;
      }
      if (action[2] === 'done') {
        this.authorizeCleanup(req, session);
        this.observeIngress(req, session);
        if (session.mode === 'cleanup_failed') await this.retryCleanup(session.id);
        else await this.end(session, 'done');
        const failed = session.mode === 'cleanup_failed';
        return sendJson(res, failed ? 503 : 200, { mode: session.mode, reason: session.reason || 'done',
          ...(this.completionDisposition ? { disposition: this.completionDisposition } : {}) });
      }
      this.authorize(req, session);
      this.observeIngress(req, session);
      if (action[2] === 'credentials') {
        if (session.mode !== 'watch') throw problem('Credentials are unavailable in this state', 409);
        return sendJson(res, 200, { mode: 'watch', password: session.credentials.watch, generation: session.generation, expiresAt: session.expiresAt, ...this.viewerCapabilities(session) });
      }
      if (action[2] === 'control') return await this.takeControl(res, session);
      if (action[2] === 'clipboard') return await this.clipboard(res, session, input);
      throw problem('Not found', 404);
    } catch (error) {
      sendJson(res, error.status || 500, { error: error.status ? error.message : 'Probe request failed' });
    }
  }

  async servePublic(res, name, type) {
    const data = (await readFile(new URL(name, PUBLIC), 'utf8')).replaceAll(PREFIX, this.prefix);
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(data);
  }

  async serveNoVnc(res, relative) {
    if (!this.noVncAssetsDir || !relative || relative.includes('\\') || relative.split('/').includes('..')) throw problem('Not found', 404);
    let decoded;
    try { decoded = decodeURIComponent(relative); } catch { throw problem('Not found', 404); }
    if (!/^[A-Za-z0-9_./-]+\.js$/.test(decoded)) throw problem('Not found', 404);
    const file = resolve(this.noVncAssetsDir, decoded);
    if (!file.startsWith(`${this.noVncAssetsDir}${sep}`)) throw problem('Not found', 404);
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(data);
  }

  claim(res, session, input) {
    this.recordAttempt(session);
    if (session.mode !== 'unclaimed' || !matches(input?.token, session.inviteHash)) throw problem('Invalid, claimed, or expired invitation', 401);
    const secret = token();
    delete session.inviteHash;
    session.sessionHash = digest(secret);
    session.mode = 'watch';
    const seconds = Math.max(0, Math.floor((session.expiresAt - this.now()) / 1000));
    sendJson(res, 200, { mode: 'watch', expiresAt: session.expiresAt }, {
      'Set-Cookie': `novnc_probe=${secret}; Path=${this.prefix}${session.id}/; Max-Age=${seconds}; HttpOnly; ${this.lanHttpOrigin ? '' : 'Secure; '}SameSite=Strict`,
    });
  }

  async takeControl(res, session) {
    if (session.permission !== 'control') throw problem('Watch-only invitation', 403);
    if (session.mode !== 'watch') throw problem('Control request already used', 409);
    if (!session.socket || session.socket.readyState !== WebSocket.OPEN) throw problem('The watch stream is not connected', 409);
    session.mode = 'control-starting';
    session.generation++;
    session.socket.expectedClose = true;
    session.socket.close(4000, 'control promotion');
    if (typeof this.supervisor.promote === 'function') {
      const work = Promise.resolve().then(() => this.supervisor.promote({ ownedId: session.ownedId, probeId: session.id, expiresAt: session.expiresAt }));
      session.promotionWork = work;
      try {
        const registration = validRegistration(await work);
        if (session.mode !== 'control-starting' || this.closed || session.expiresAt <= this.now()) throw problem('Control request ended', 409);
        session.endpoint = registration.endpoint; session.credentials = registration.credentials;
      } catch (error) {
        await this.end(session, 'promotion_failed');
        throw problem(error.status ? error.message : 'Could not take control; browser recovery may be required', 409);
      } finally { if (session.promotionWork === work) session.promotionWork = undefined; }
    }
    if (session.mode !== 'control-starting') throw problem('Control request ended', 409);
    session.mode = 'control-pending';
    session.promotionAvailable = true;
    session.reconnectBy = Math.min(session.expiresAt, this.now() + this.promotionMs);
    session.promotionTimer = setTimeout(() => {
      if (session.mode === 'control-pending') void this.end(session, 'promotion_failed');
    }, Math.max(1, session.reconnectBy - this.now()));
    session.promotionTimer.unref();
    sendJson(res, 200, { mode: 'control-pending', password: session.credentials.control, generation: session.generation, reconnectBy: session.reconnectBy, ...this.viewerCapabilities(session) });
  }

  async clipboard(res, session, input) {
    if (session.mode !== 'control' || this.capabilities.clipboard !== 'utf8') throw problem('Take control before using the clipboard', 409);
    if (!input || !['read', 'write'].includes(input.action)) throw problem('Invalid clipboard action', 400);
    if (input.action === 'write' && typeof input.text !== 'string') throw problem('Clipboard text required', 400);
    if (input.action === 'write' && Buffer.byteLength(input.text, 'utf8') > 65536) throw problem('Clipboard text is too large', 413);
    const generation = session.generation;
    const work = Promise.resolve().then(() => input.action === 'read'
      ? this.supervisor.clipboardRead(session.ownedId)
      : this.supervisor.clipboardWrite(session.ownedId, input.text));
    session.clipboardWork.add(work);
    try {
      const result = await work;
      if (session.mode !== 'control' || session.generation !== generation) throw problem('Clipboard control ended', 409);
      if (input.action === 'read') {
        if (typeof result?.text !== 'string' || Buffer.byteLength(result.text, 'utf8') > 65536) throw problem('Clipboard text is unavailable or too large', 413);
        sendJson(res, 200, { text: result.text });
      } else sendJson(res, 200, { written: true });
    } finally { session.clipboardWork.delete(work); }
  }

  async upgrade(req, socket, head) {
    let session;
    let reserved = false;
    let upstream;
    let attached = false;
    let abandoned = false;
    const controller = new AbortController();
    const onRawClose = () => {
      abandoned = true;
      controller.abort(new Error('Viewer disconnected during VNC connection'));
      if (upstream && !attached) upstream.destroy();
      if (session && reserved && !attached) {
        session.connecting = false;
        const reason = session.mode === 'control-pending' ? 'promotion_failed' : 'unexpected_disconnect';
        void this.end(session, reason);
      }
    };
    socket.once('close', onRawClose);
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const route = path.match(new RegExp(`^${this.prefix}([a-f0-9]{32})/stream/(\\d+)$`));
      if (!route) throw problem('Not found', 404);
      if (!this.originAllowed(req)) throw problem('Origin denied', 403);
      session = this.sessionFor(route[1]);
      this.authorize(req, session);
      this.observeIngress(req, session);
      const generation = Number(route[2]);
      if (!Number.isSafeInteger(generation) || generation !== session.generation) throw problem('Stale stream generation', 409);
      if (session.socket || session.connecting) throw problem('A viewer is already connected', 409);
      if (session.mode === 'control-pending') {
        if (!session.promotionAvailable || this.now() > session.reconnectBy) throw problem('Control promotion expired', 409);
        session.promotionAvailable = false;
      } else if (session.mode !== 'watch') throw problem('Stream unavailable', 409);
      session.connecting = true;
      reserved = true;
      const connectTask = Promise.resolve().then(() => this.tcpConnect({ ...session.endpoint, signal: controller.signal }));
      connectTask.then((late) => { if (abandoned) late?.destroy?.(); }, () => {});
      let timer;
      try {
        upstream = await Promise.race([
          connectTask,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              abandoned = true;
              controller.abort(new Error('VNC connection timed out'));
              reject(problem('VNC server unavailable', 502));
            }, this.upstreamConnectMs);
            timer.unref();
          }),
        ]);
      } catch (error) {
        if (error.status) throw error;
        throw problem('VNC server unavailable', abandoned && socket.destroyed ? 499 : 502);
      } finally { clearTimeout(timer); }
      if (abandoned || socket.destroyed) { upstream?.destroy?.(); throw problem('Viewer disconnected', 499); }
      if (!upstream || typeof upstream.write !== 'function' || typeof upstream.destroy !== 'function') {
        upstream?.destroy?.(); throw problem('VNC server unavailable', 502);
      }
      if (['ending', 'ended', 'cleanup_failed'].includes(session.mode) || generation !== session.generation || session.expiresAt <= this.now()) {
        upstream.destroy(); throw problem('Probe access ended', 410);
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        attached = true;
        socket.off('close', onRawClose);
        this.attach(session, ws, upstream);
      });
    } catch (error) {
      abandoned = true;
      controller.abort(error);
      if (upstream && !attached) upstream.destroy();
      socket.off('close', onRawClose);
      if (session && reserved) {
        session.connecting = false;
        if (!['ending', 'ended', 'cleanup_failed'].includes(session.mode)) {
          const reason = session.mode === 'control-pending' ? 'promotion_failed' : error.status === 499 ? 'unexpected_disconnect' : 'stream_failed';
          void this.end(session, reason);
        }
      }
      rejectUpgrade(socket, error.status || 500, error.status ? error.message : 'Upgrade failed');
    }
  }

  attach(session, ws, upstream) {
    session.connecting = false;
    session.socket = ws;
    session.upstream = upstream;
    ws.probeSession = session;
    ws.alive = true;
    ws.on('pong', () => {
      ws.alive = true;
      if (ws.expectedClose || ws.probePingAt === undefined) return;
      const elapsed = this.monotonicNow() - ws.probePingAt;
      ws.probePingAt = undefined;
      if (!Number.isFinite(elapsed) || elapsed < 0) return;
      session.transport.rttSamples.push(elapsed);
      if (session.transport.rttSamples.length > 32) session.transport.rttSamples.shift();
    });
    if (session.mode === 'control-pending') {
      clearTimeout(session.promotionTimer);
      session.promotionTimer = undefined;
      session.mode = 'control';
    }
    let settled = false;
    const unexpected = () => {
      if (settled) return;
      settled = true;
      const clear = () => {
        if (session.socket === ws) session.socket = undefined;
        if (session.upstream === upstream) session.upstream = undefined;
        upstream.destroy();
      };
      if (ws.expectedClose || ['ending', 'ended', 'cleanup_failed'].includes(session.mode)) { clear(); return; }
      void this.end(session, 'unexpected_disconnect').finally(clear);
    };
    upstream.on('data', (chunk) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      this.observeBuffer(session, ws);
      if (ws.bufferedAmount > MAX_BUFFERED) { ws.terminate(); return; }
      upstream.pause?.();
      session.transport.viewerBytesSent = Math.min(Number.MAX_SAFE_INTEGER, session.transport.viewerBytesSent + chunk.byteLength);
      ws.send(chunk, { binary: true }, () => upstream.resume?.());
      this.observeBuffer(session, ws);
    });
    upstream.once('error', unexpected);
    upstream.once('close', unexpected);
    ws.on('message', (data, isBinary) => {
      if (!isBinary || upstream.destroyed) { ws.close(1003, 'binary RFB required'); return; }
      session.transport.viewerBytesReceived = Math.min(Number.MAX_SAFE_INTEGER, session.transport.viewerBytesReceived + data.byteLength);
      if (!upstream.write(data)) {
        ws._socket?.pause();
        upstream.once('drain', () => ws._socket?.resume());
      }
    });
    ws.once('error', unexpected);
    ws.once('close', unexpected);
  }

  heartbeat() {
    for (const ws of this.wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      this.observeBuffer(ws.probeSession, ws);
      ws.probePingAt = this.monotonicNow();
      try { ws.ping(); this.observeBuffer(ws.probeSession, ws); } catch { ws.terminate(); }
    }
  }

  async end(session, reason) {
    session.reason ||= reason;
    session.endingReason ||= reason;
    if (session.mode === 'ended') return;
    if (session.mode === 'creating' || !session.creationDone && session.creation) {
      session.mode = 'ending';
      await session.creation.catch(() => {});
      return session.cleanupInFlight;
    }
    if (session.mode === 'cleanup_failed') return;
    return this.runCleanup(session, session.reason);
  }

  async runCleanup(session, reason) {
    if (session.cleanupInFlight) return session.cleanupInFlight;
    if (session.mode === 'ended') return;
    session.reason ||= reason;
    session.mode = 'ending';
    delete session.inviteHash;
    clearTimeout(session.promotionTimer);
    if (session.socket) {
      session.socket.expectedClose = true;
      session.socket.terminate();
    }
    session.upstream?.destroy();
    const attempt = (async () => {
      let verified = false;
      try { await this.supervisor.cancelPromotion?.(session.ownedId); } catch {}
      await session.promotionWork?.catch(() => {});
      await Promise.allSettled([...session.clipboardWork]);
      try { await this.supervisor.destroy(session.ownedId, { reason: session.reason }); } catch {}
      try { verified = await this.supervisor.verifyExited(session.ownedId) === true; } catch {}
      session.endpoint = undefined;
      session.credentials = undefined;
      const mode = verified ? 'ended' : 'cleanup_failed';
      try { await this.onEnded?.(session, { ...this.status(session.id), mode }); }
      catch { verified = false; }
      session.mode = verified ? 'ended' : 'cleanup_failed';
    })();
    session.cleanupInFlight = attempt;
    try { await attempt; }
    finally { if (session.cleanupInFlight === attempt) session.cleanupInFlight = undefined; }
  }

  async retryCleanup(id) {
    const session = this.sessionFor(id);
    if (session.mode === 'ended') return { mode: 'ended', reason: session.reason };
    if (session.mode === 'ending') await session.cleanupInFlight;
    else if (session.mode === 'cleanup_failed') await this.runCleanup(session, session.reason || 'cleanup_retry');
    else throw new Error('Cleanup retry is only available after access has ended');
    return { mode: session.mode, reason: session.reason };
  }

  async sweep() {
    const work = [];
    for (const session of this.sessions.values()) {
      if (!['ending', 'ended', 'cleanup_failed'].includes(session.mode) && session.expiresAt <= this.now()) work.push(this.end(session, 'expired'));
    }
    await Promise.allSettled(work);
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      clearInterval(this.expiryTimer); clearInterval(this.heartbeatTimer);
      const work = [];
      for (const session of this.sessions.values()) {
        if (session.mode === 'cleanup_failed') work.push(this.runCleanup(session, session.reason || 'gateway_shutdown'));
        else if (session.mode !== 'ended') work.push(this.end(session, 'gateway_shutdown'));
      }
      await Promise.allSettled(work);
      await Promise.allSettled([...this.creations]);
      for (const ws of this.wss.clients) ws.terminate();
      this.wss.close();
      if (this.server.listening) await new Promise((resolvePromise) => this.server.close(resolvePromise));
    })();
    return this.closePromise;
  }
}

export const noVncProbePrefix = PREFIX;
