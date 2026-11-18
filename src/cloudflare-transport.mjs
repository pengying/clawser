import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
function startupError(stage, code) { return new Error('Cloudflare startup failed (' + stage + ': ' + code + ')'); }
function processCode(child) { return Number.isInteger(child.exitCode) ? 'EXIT_' + child.exitCode : 'PROCESS_EXIT'; }
const CONFIG_NAME = 'quick-tunnel.yml', PID_NAME = 'cloudflared.pid', RECEIPT_NAME = 'transport.json';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Transport routing only. The viewer gateway remains responsible for auth.
export class CloudflareTransport extends EventEmitter {
  constructor({ binaryPath, stateDir, startupTimeoutMs = 60_000, spawnImpl = spawn, probeImpl, dnsProbeImpl, probePath = '/browser/assets/probe.css', procRoot = '/proc', killImpl = (pid, signal) => process.kill(pid, signal) } = {}) {
    super();
    if (!isAbsolute(binaryPath || '') || !isAbsolute(stateDir || '')) throw new Error('Cloudflare transport requires absolute binary/state paths');
    if (!['/browser/assets/probe.css', '/assets/style.css'].includes(probePath)) throw new Error('Invalid public transport readiness asset');
    Object.assign(this, { binaryPath, stateDir, startupTimeoutMs, spawnImpl, procRoot, killImpl, stops: 0 });
    this.probe = probeImpl || (async (origin, signal) => {
      const response = await fetch(origin + probePath, { signal, redirect: 'error' });
      await response.body?.cancel();
      if (!response.ok) throw Object.assign(new Error('HTTP health response unsuccessful'), { code: 'HTTP_' + response.status });
      return true;
    });
    this.dnsProbe = dnsProbeImpl || (async (origin, signal) => {
      // Quick Tunnel edge registration can precede DNS publication. Avoid an
      // early OS lookup caching NXDOMAIN for the newly allocated hostname.
      const name = new URL(origin).hostname;
      const response = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=A', {
        headers: { accept: 'application/dns-json' }, signal,
      });
      if (!response.ok) throw Object.assign(new Error('DNS service response unsuccessful'), { code: 'HTTP_' + response.status });
      const result = await response.json();
      if (Number.isInteger(result.Status) && result.Status !== 0) throw Object.assign(new Error('DNS response not ready'), { code: 'DNS_STATUS_' + result.Status });
      return result.Status === 0 && result.Answer?.some(answer => answer.type === 1 || answer.type === 28) === true;
    });
  }
  // A parent killed without its shutdown (SIGKILL, OOM, a Gateway outside systemd) leaves its cloudflared running,
  // still forwarding an old public address to this viewer port. Only a process whose command line proves it is
  // this transport's own cloudflared is stopped: same binary path, this state folder's config and a loopback target.
  async ownCloudflared(pid) {
    if (!Number.isSafeInteger(pid) || pid < 2 || pid === process.pid) return false;
    let argv;
    try { argv = (await readFile(join(this.procRoot, String(pid), 'cmdline'))).toString('utf8').split('\0'); } catch { return false; }
    const value = flag => { const at = argv.indexOf(flag); return at === -1 ? undefined : argv[at + 1]; };
    return argv[0] === this.binaryPath && argv[1] === 'tunnel' && value('--config') === join(this.stateDir, CONFIG_NAME) && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value('--url') ?? '');
  }
  async reapOrphans() {
    if (this.reaping) return this.reaping;
    this.reaping = (async () => {
      const pids = new Set();
      for (const name of [PID_NAME, RECEIPT_NAME]) {
        try { const { pid } = JSON.parse(await readFile(join(this.stateDir, name), 'utf8')); if (Number.isSafeInteger(pid) && pid !== this.child?.pid) pids.add(pid); } catch {}
      }
      for (const pid of pids) {
        for (const [signal, waitMs] of [['SIGTERM', 2000], ['SIGKILL', 1000]]) {
          if (!await this.ownCloudflared(pid)) break;
          try { this.killImpl(pid, signal); } catch { break; }
          for (const deadline = Date.now() + waitMs; Date.now() < deadline && await this.ownCloudflared(pid);) await sleep(50);
        }
      }
      await this.forgetPid(pids);
    })().finally(() => { this.reaping = undefined; });
    return this.reaping;
  }
  // Removes the pid record only while it still names one of `pids`, never a newer child's.
  async forgetPid(pids) {
    const path = join(this.stateDir, PID_NAME);
    try { const { pid } = JSON.parse(await readFile(path, 'utf8')); if (pids.has(pid) && !await this.ownCloudflared(pid)) await rm(path, { force: true }); } catch {}
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
    // A stop() during these awaits must also prevent the spawn.
    const stops = this.stops, halted = () => {
      if (this.closed) throw new Error('Cloudflare transport is closed');
      if (this.stops !== stops) throw startupError('closed', 'ABORTED');
    };
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    halted();
    await this.reapOrphans();
    halted();
    const config = join(this.stateDir, CONFIG_NAME);
    await writeFile(config, '{}\n', { mode: 0o600 });
    halted();
    const child = this.child = this.spawnImpl(this.binaryPath, ['tunnel', '--config', config, '--no-autoupdate', '--metrics', '127.0.0.1:0', '--url', 'http://127.0.0.1:' + this.port], { stdio: ['ignore', 'pipe', 'pipe'] });
    // Recorded at once, so a parent that dies during the minute-long startup still leaves a pid to reap.
    const recorded = Number.isSafeInteger(child.pid) ? writeFile(join(this.stateDir, PID_NAME), JSON.stringify({ pid: child.pid, startedAt: Date.now() }) + '\n', { mode: 0o600 }).catch(() => {}) : Promise.resolve();
    child.once('exit', () => { void recorded.then(() => this.forgetPid(new Set([child.pid]))); });
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
          await writeFile(join(this.stateDir, RECEIPT_NAME), JSON.stringify({ pid: child.pid, origin, port: this.port, startedAt: Date.now() }) + '\n', { mode: 0o600 });
          if (this.closed || child.exitCode !== null || child.signalCode !== null) { stage = 'process'; lastCode = processCode(child); throw startupError(stage, lastCode); }
          this.origin = origin; resolve(origin);
        } catch (error) { reject(startupError(stage, safeErrorCode(error, lastCode))); }
      };
      child.stdout?.on('data', consume); child.stderr?.on('data', consume);
      child.once('error', fail);
      child.once('exit', () => {
        // A child that stop() let go is no failure, but its pending startup still settles now.
        fail();
        if (this.child !== child) return;
        const hadOrigin = Boolean(this.origin); this.origin = undefined;
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
  // Stops the tunnel while idle. Unlike close(), a later ensure() starts a new one, at a new address.
  // The exit is intended, so it emits no failure, and a startup in progress fails at once.
  async stop() {
    if (this.closed) return this.closePromise;
    const child = this.child;
    this.stops++; this.child = undefined; this.origin = undefined; this.opening = undefined;
    this.startupAbort?.abort();
    await this.stopChild(child);
  }
  get running() { return Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null); }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.origin = undefined;
    this.startupAbort?.abort();
    const work = this.stopChild(this.child); this.closePromise = work;
    try { return await work; } catch (error) { if (this.closePromise === work) this.closePromise = undefined; throw error; }
  }
}
