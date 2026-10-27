import { request } from 'node:http';

const prefix = '/probe/novnc/';
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function forwardedHeaders(headers, websocket = false) {
  const result = { ...headers };
  const nominated = String(headers.connection || '').split(',').map(value => value.trim().toLowerCase());
  for (const key of [...hopHeaders, ...nominated]) delete result[key];
  if (websocket) { result.connection = 'Upgrade'; result.upgrade = 'websocket'; }
  return result;
}

// The independently authenticated, human-only comparison service is opt-in.
// This adapter has no create/admin endpoint, VNC credential or Docker authority.
export class ComparisonProxy {
  requests = new Set();
  sockets = new Set();
  constructor(value) {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.port || Number(url.port) < 1024 || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash)
      throw new Error('Comparison proxy must be a fixed loopback HTTP origin');
    this.origin = url;
  }
  path(value) {
    try { const url = new URL(value, 'http://localhost'); return url.pathname.startsWith(prefix) ? url.pathname + url.search : null; }
    catch { return null; }
  }
  matches(value) { return this.path(value) !== null; }
  track(socket) {
    this.sockets.add(socket); socket.on('error', () => {});
    socket.once('close', () => this.sockets.delete(socket)); return socket;
  }
  outgoing(req, websocket = false) {
    const path = this.path(req.url);
    if (!path || this.closed) throw new Error('Comparison route unavailable');
    const headers = forwardedHeaders(req.headers, websocket); headers.host = this.origin.host;
    const upstream = request({ hostname: this.origin.hostname.replace(/^\[|\]$/g, ''), port: this.origin.port,
      path, method: websocket ? 'GET' : req.method, headers, agent: false });
    this.requests.add(upstream); upstream.once('close', () => this.requests.delete(upstream));
    upstream.setTimeout(15_000, () => upstream.destroy(new Error('Comparison upstream timeout')));
    return upstream;
  }
  handle(req, res) {
    const failed = () => {
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Comparison service unavailable');
    };
    let upstream;
    try { upstream = this.outgoing(req); } catch { failed(); return; }
    upstream.on('error', failed);
    req.once('aborted', () => upstream.destroy());
    res.once('close', () => upstream.destroy());
    upstream.on('response', response => {
      response.on('error', () => res.destroy());
      res.writeHead(response.statusCode || 502, forwardedHeaders(response.headers));
      response.pipe(res);
    });
    req.pipe(upstream);
  }
  upgrade(req, socket, head) {
    this.track(socket);
    const rejected = (status = 502) => {
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Comparison unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    };
    let upstream, tunnel;
    try { upstream = this.outgoing(req, true); } catch { rejected(); return; }
    socket.once('close', () => { upstream.destroy(); tunnel?.destroy(); });
    upstream.on('error', () => { if (tunnel) socket.destroy(); else rejected(); });
    upstream.on('response', response => { response.resume(); rejected(response.statusCode || 502); });
    upstream.on('upgrade', (response, remote, remoteHead) => {
      tunnel = this.track(remote); upstream.setTimeout(0); remote.setTimeout(0);
      if (this.closed || socket.destroyed) { remote.destroy(); return; }
      const headers = [];
      for (let i = 0; i < response.rawHeaders.length; i += 2) headers.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.once('close', () => socket.destroy());
      remote.on('error', () => socket.destroy());
      socket.on('error', () => remote.destroy());
      remote.pipe(socket); socket.pipe(remote);
    });
    upstream.end();
  }
  close() {
    this.closed = true;
    for (const req of this.requests) req.destroy();
    for (const socket of this.sockets) socket.destroy();
    this.requests.clear(); this.sockets.clear();
  }
}
