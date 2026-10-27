import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const safeErrorCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EISDIR', 'ENOENT', 'EMFILE', 'ENFILE', 'EDQUOT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
function safeErrorCode(error, fallback) {
  // Raw messages/causes may contain the temporary hostname, paths or URLs.
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
    if (safeErrorCodes.has(current.code) || (typeof current.code === 'string' && /^(HTTP_[1-5]\d\d|DNS_STATUS_\d{1,2})$/.test(current.code))) return current.code;
    if (current.name === 'TimeoutError') return 'TIMEOUT';
    if (current.name === 'AbortError') return 'ABORTED';
  }
  return fallback;
}
function startupError(stage, code) { return new Error(`Cloudflare startup failed (${stage}: ${code})`); }
function processCode(child) { return Number.isInteger(child.exitCode) ? `EXIT_${child.exitCode}` : 'PROCESS_EXIT'; }

// Transport routing only. The viewer gateway remains responsible for auth.
export class CloudflareTransport extends EventEmitter {
  constructor({ binaryPath, stateDir, startupTimeoutMs = 60_000, spawnImpl = spawn, probeImpl, dnsProbeImpl } = {}) {
    super();
    if (!isAbsolute(binaryPath || '') || !isAbsolute(stateDir || '')) throw new Error('Cloudflare transport requires absolute binary/state paths');
    Object.assign(this, { binaryPath, stateDir, startupTimeoutMs, spawnImpl });
    this.probe = probeImpl || (async (origin, signal) => {
      const response = await fetch(`${origin}/browser/assets/probe.css`, { signal, redirect: 'error' });
      await response.body?.cancel();
      if (!response.ok) throw Object.assign(new Error('HTTP health response unsuccessful'), { code: `HTTP_${response.status}` });
      return true;
    });
    this.dnsProbe = dnsProbeImpl || (async (origin, signal) => {
      // Quick Tunnel edge registration can precede DNS publication. Avoid an
      // early OS lookup caching NXDOMAIN for the newly allocated hostname.
      const name = new URL(origin).hostname;
      const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=A`, {
        headers: { accept: 'application/dns-json' }, signal,
      });
      if (!response.ok) throw Object.assign(new Error('DNS service response unsuccessful'), { code: `HTTP_${response.status}` });
      const result = await response.json();
      if (Number.isInteger(result.Status) && result.Status !== 0) throw Object.assign(new Error('DNS response not ready'), { code: `DNS_STATUS_${result.Status}` });
      return result.Status === 0 && result.Answer?.some(answer => answer.type === 1 || answer.type === 28) === true;
    });
  }
  async ensure(port) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid private viewer port');
    if (this.closed) throw new Error('Cloudflare transport is closed');
    if (this.port && this.port !== port) throw new Error('Cloudflare target cannot change');
    this.port = port;
    if (this.origin && this.child?.exitCode === null && this.child?.signalCode === null) return this.origin;
    if (this.opening) return this.opening;
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) throw new Error('Previous public transport has not exited');
    const work = this.open(); this.opening = work;
    try { return await work; } finally { if (this.opening === work) this.opening = undefined; }
  }
  async open() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    if (this.closed) throw new Error('Cloudflare transport is closed');
    const config = join(this.stateDir, 'quick-tunnel.yml');
    await writeFile(config, '{}\n', { mode: 0o600 });
    if (this.closed) throw new Error('Cloudflare transport is closed');
    const child = this.child = this.spawnImpl(this.binaryPath, ['tunnel', '--config', config, '--no-autoupdate', '--metrics', '127.0.0.1:0', '--url', `http://127.0.0.1:${this.port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const abort = this.startupAbort = new AbortController(), deadline = Date.now() + this.startupTimeoutMs;
    let output = '', origin, connected = false, settled = false, timer;
    const ready = new Promise((resolve, reject) => {
      const fail = error => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        reject(startupError('connection', safeErrorCode(error, 'UNAVAILABLE')));
      };
      const consume = async chunk => {
        output = (output + chunk.toString()).slice(-16_384);
        origin ||= output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
        connected ||= output.includes('Registered tunnel connection');
        if (!origin || !connected || settled || this.closed || this.child !== child) return;
        settled = true; clearTimeout(timer);
        let stage = 'dns', lastCode = 'DNS_NOT_READY';
        try {
          let reachable = false, dnsReady = false;
          while (!abort.signal.aborted && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
            try {
              const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now())))]);
              if (!dnsReady) dnsReady = await this.dnsProbe(origin, signal);
              if (dnsReady) {
                stage = 'https'; lastCode = 'HTTP_NOT_READY';
                reachable = await this.probe(origin, signal);
              }
            } catch (error) { lastCode = safeErrorCode(error, 'REQUEST_FAILED'); }
            if (reachable) break;
            await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(dnsReady ? 250 : 1000, deadline - Date.now()))));
          }
          if (abort.signal.aborted || this.closed) { stage = 'closed'; lastCode = 'ABORTED'; }
          else if (child.exitCode !== null || child.signalCode !== null) { stage = 'process'; lastCode = processCode(child); }
          if (!reachable || stage === 'closed' || stage === 'process') throw startupError(stage, lastCode);
          stage = 'receipt'; lastCode = 'WRITE_FAILED';
          await writeFile(join(this.stateDir, 'transport.json'), JSON.stringify({ pid: child.pid, origin, port: this.port, startedAt: Date.now() }) + '\n', { mode: 0o600 });
          if (this.closed || child.exitCode !== null || child.signalCode !== null) { stage = 'process'; lastCode = processCode(child); throw startupError(stage, lastCode); }
          this.origin = origin; resolve(origin);
        } catch (error) { reject(startupError(stage, safeErrorCode(error, lastCode))); }
      };
      child.stdout?.on('data', consume); child.stderr?.on('data', consume);
      child.once('error', fail);
      child.once('exit', () => {
        if (this.child !== child) return;
        const hadOrigin = Boolean(this.origin); this.origin = undefined;
        fail();
        if (!this.closed && hadOrigin) this.emit('failure', new Error('Cloudflare tunnel stopped'));
      });
      timer = setTimeout(() => fail({ name: 'TimeoutError' }), this.startupTimeoutMs);
    });
    try { return await ready; }
    catch (error) { await this.stopChild(child); if (this.child === child) this.child = undefined; throw error; }
  }
  async stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve, reject) => {
      let force, limit;
      const done = () => { clearTimeout(force); clearTimeout(limit); resolve(); };
      child.once('exit', done);
      try { child.kill('SIGTERM'); } catch { done(); return; }
      force = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
      limit = setTimeout(() => {
        clearTimeout(force);
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else reject(new Error('Owned Cloudflare process exit could not be verified'));
      }, 3000);
    });
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.origin = undefined;
    this.startupAbort?.abort();
    const work = this.stopChild(this.child); this.closePromise = work;
    try { return await work; } catch (error) { if (this.closePromise === work) this.closePromise = undefined; throw error; }
  }
}
