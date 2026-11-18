import net from 'node:net';
import { mkdir, readFile, rename, stat, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const STARTING = { ready: false, phase: 'starting' };
const startTicks = text => text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)[19];

// The operation lock outlives a controller killed mid-operation (SIGKILL, OOM, power loss), and then every later
// operation failed until an operator removed it. Only a controller holding its singleton lock, or the offline
// reconcile helper holding the same lock, takes this one, so a lock whose recorded owner process is gone is stale.
export async function staleOperationLock(lock, { procRoot = '/proc', now = Date.now } = {}) {
  let owner;
  try { owner = JSON.parse(await readFile(lock + '/owner.json', 'utf8')); }
  catch {
    // Owner details are written right after the lock is made; a lock without them for a minute was abandoned there.
    try { return now() - (await stat(lock)).mtimeMs > 60_000; } catch { return false; }
  }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) return false;
  // Without a start time a reused pid can't be told apart, so only a pid nobody holds counts as gone.
  if (typeof owner.processStartTicks !== 'string') { try { process.kill(owner.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }
  try { return startTicks(await readFile(procRoot + '/' + owner.pid + '/stat', 'utf8')) !== owner.processStartTicks; }
  catch (error) { return error.code === 'ENOENT'; }
}
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
    for (let attempt = 0; ; attempt++) {
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (attempt || !await staleOperationLock(lock)) throw new Error('desktop operation is locked; reconcile the owning process before retry');
        // Moved aside first, so the removal can never take a lock someone else just made.
        const aside = lock + '.stale-' + process.pid + '-' + Date.now();
        await rename(lock, aside);
        await rm(aside, { recursive: true, force: true });
      }
    }
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
  // displayGeneration is the lease's own, which lets a restarted supervisor recognise a lease from its earlier boot.
  stopViewerAndSettle({ leaseId, mayBeWritable, displayGeneration }) { return this.rpc('stopViewerAndSettle', { leaseId, mayBeWritable, ...typeof displayGeneration === 'string' ? { displayGeneration } : {} }); }
  heartbeatViewer({ leaseId, epoch } = {}) {
    if (typeof leaseId !== 'string' || !leaseId || !Number.isSafeInteger(epoch) || epoch < 1) throw new Error('heartbeat requires a lease ID and exact actor epoch');
    // Heartbeats are read/refresh operations, independent of the mutation lock.
    return this.rpcDirect('heartbeatViewer', { leaseId, epoch });
  }
  clipboardRead({ leaseId, epoch } = {}) { return this.rpc('clipboardRead', { leaseId, epoch }); }
  clipboardWrite(text, { leaseId, epoch } = {}) { if (typeof text !== 'string' || Buffer.byteLength(text) > 1_048_576) throw new Error('invalid clipboard text size'); return this.rpc('clipboardWrite', { text, leaseId, epoch }); }
}
