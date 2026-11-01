import net from 'node:net';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const STARTING = { ready: false, phase: 'starting' };
const REPLY_LIMIT = 8_000_000;

export function supervisorRequest(socketPath, payload, { timeoutMs = 20_000, connect = options => net.connect(options) } = {}) {
  const op = payload?.op;
  return new Promise((accept, reject) => {
    const socket = connect({ path: socketPath });
    const chunks = [];
    let size = 0, connected = false, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : accept(value);
    };
    const timer = setTimeout(() => finish(new Error('desktop ' + op + ' timed out')), timeoutMs);
    socket.once('connect', () => { connected = true; socket.end(JSON.stringify(payload)); });
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > REPLY_LIMIT) return finish(new Error('desktop ' + op + ' reply exceeds limit'));
      chunks.push(chunk);
    });
    socket.once('end', () => {
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return finish(new Error('desktop ' + op + ' returned an invalid reply')); }
      if (result?.error) return finish(new Error('desktop ' + op + ': ' + result.error));
      finish(undefined, result);
    });
    socket.on('error', error => {
      if (!connected && op === 'status' && ['ENOENT', 'ECONNREFUSED'].includes(error.code)) return finish(undefined, { ...STARTING });
      finish(error);
    });
  });
}

// localhost can resolve to ::1 while Chrome listens only on 127.0.0.1.
function loopbackOrigin(value) {
  let url;
  try { url = new URL(value); } catch { url = undefined; }
  if (!url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Desktop CDP must be http://127.0.0.1:<port> without credentials or query');
  return url.origin;
}

export class HostDesktopRuntime {
  constructor({ stateDir, controlSocket, cdpUrl, testHeartbeatTimeoutMs } = {}) {
    if (controlSocket === undefined) throw new Error('Desktop runtime config is from an older Clawser; rerun openclaw clawser setup');
    if (typeof controlSocket !== 'string' || !isAbsolute(controlSocket) || /[\x00-\x1f\x7f]/.test(controlSocket)) throw new Error('Desktop control socket must be an absolute path');
    if (typeof stateDir !== 'string' || !stateDir) throw new Error('Desktop runtime state directory is required');
    this.cdpUrl = loopbackOrigin(cdpUrl);
    this.controlSocket = controlSocket;
    this.stateDir = resolve(stateDir);
    this.heartbeatTimeoutMs = testHeartbeatTimeoutMs ?? 30000;
    if (!Number.isInteger(this.heartbeatTimeoutMs) || this.heartbeatTimeoutMs < 1000 || this.heartbeatTimeoutMs > 30000) throw new Error('invalid trusted heartbeat test timeout');
  }
  async locked(fn) {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const lock = this.stateDir + '/operation.lock';
    try { await mkdir(lock, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') throw new Error('desktop operation is locked; reconcile the owning process before retry'); throw e; }
    try {
      const processStartTicks = await readFile('/proc/self/stat', 'utf8').then(stat => stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19], () => undefined);
      await writeFile(`${lock}/owner.json`, JSON.stringify({ pid: process.pid, processStartTicks, createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
      return await fn();
    } finally { await rm(lock, { recursive: true, force: true }); }
  }
  rpc(op, fields = {}) { return this.locked(() => this.rpcDirect(op, fields)); }
  rpcDirect(op, fields = {}) { return supervisorRequest(this.controlSocket, { op, ...fields }); }
  async ensure() { return { cdpUrl: this.cdpUrl, persistent: true }; }
  // Read-only health checks must not contend with input retirement.
  status() { return this.rpcDirect('status'); }
  async tabs() { const response = await fetch(this.cdpUrl + '/json/list', { signal: AbortSignal.timeout(5000) }); if (!response.ok) throw new Error('CDP tabs unavailable'); return response.json(); }
  startViewer({ leaseId, role = 'watch', expiresAt }) { return this.rpc('startViewer', { leaseId, role, expiresAt }); }
  promoteViewer({ leaseId }) { return this.rpc('promoteViewer', { leaseId }); }
  stopViewerAndSettle({ leaseId, mayBeWritable }) { return this.rpc('stopViewerAndSettle', { leaseId, mayBeWritable }); }
  heartbeatViewer({ leaseId, epoch } = {}) {
    if (typeof leaseId !== 'string' || !leaseId || !Number.isSafeInteger(epoch) || epoch < 1) throw new Error('heartbeat requires a lease ID and exact actor epoch');
    // Heartbeats are read/refresh operations, independent of the mutation lock.
    return this.rpcDirect('heartbeatViewer', { leaseId, epoch });
  }
  clipboardRead({ leaseId, epoch } = {}) { return this.rpc('clipboardRead', { leaseId, epoch }); }
  clipboardWrite(text, { leaseId, epoch } = {}) { if (typeof text !== 'string' || Buffer.byteLength(text) > 1_048_576) throw new Error('invalid clipboard text size'); return this.rpc('clipboardWrite', { text, leaseId, epoch }); }
}
