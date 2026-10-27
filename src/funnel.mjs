import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
const defaultRun = async (args) => (await exec('tailscale', args, { timeout: 15_000, maxBuffer: 1024 * 1024 })).stdout;
const stable = (value) => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v);
function portState(config, port) {
  const select = (object) => Object.fromEntries(Object.entries(object || {}).filter(([key]) => key.endsWith(`:${port}`)));
  const foreground = Object.fromEntries(Object.entries(config.Foreground || {}).map(([id, nested]) => [id, portState(nested, port)])
    .filter(([, state]) => occupied(state)));
  return { tcp: config.TCP?.[port] || null, web: select(config.Web), allowFunnel: select(config.AllowFunnel), foreground };
}
const occupied = (state) => state.tcp || Object.keys(state.web).length || Object.keys(state.allowFunnel).length || Object.keys(state.foreground).length;
const validDns = (value) => typeof value === 'string' && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/i.test(value);
const validPort = (value) => Number.isInteger(value) && value > 0 && value <= 65535;
const expectedState = ({ dnsName, httpsPort, localPort }) => {
  const host = `${dnsName}:${httpsPort}`;
  return { tcp: { HTTPS: true }, web: { [host]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${localPort}` } } } }, allowFunnel: { [host]: true }, foreground: {} };
};

export class FunnelTransport {
  constructor({ httpsPort = 10000, run = defaultRun, ownershipFile } = {}) {
    if (![443, 8443, 10000].includes(httpsPort)) throw new Error('Unsupported Funnel port');
    this.httpsPort = httpsPort; this.run = run; this.ownershipFile = ownershipFile;
  }
  async readOwnership() {
    if (!this.ownershipFile) return null;
    let record;
    try { record = JSON.parse(await readFile(this.ownershipFile, 'utf8')); }
    catch (cause) {
      if (cause.code === 'ENOENT') return null;
      throw new Error('Cannot read Funnel ownership receipt; inspect the plugin state directory before retrying', { cause });
    }
    const keys = ['version', 'owner', 'httpsPort', 'dnsName', 'localPort'];
    if (!record || Object.keys(record).length !== keys.length || !keys.every((key) => Object.hasOwn(record, key)) || record.version !== 1 || record.owner !== 'browser-handoff' || ![443, 8443, 10000].includes(record.httpsPort) || !validDns(record.dnsName) || !validPort(record.localPort))
      throw new Error('Invalid Funnel ownership receipt; inspect the plugin state directory before retrying');
    return record;
  }
  async persistOwnership(record) {
    if (!this.ownershipFile) return;
    const temporary = `${this.ownershipFile}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.ownershipFile), { recursive: true, mode: 0o700 });
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.ownershipFile);
    } catch (cause) {
      throw new Error('Cannot persist Funnel ownership receipt; no route was created', { cause });
    } finally {
      // A private orphaned temp file is not an ownership receipt. Cleanup must
      // not replace the original persistence failure or permit route creation.
      await unlink(temporary).catch(() => {});
    }
  }
  async clearOwnership(invalidate = false) {
    if (!this.ownershipFile) return;
    try {
      if (invalidate) await rename(this.ownershipFile, `${this.ownershipFile}.invalid-${randomUUID()}`);
      else await unlink(this.ownershipFile);
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw new Error('Cannot clear or invalidate Funnel ownership receipt; inspect the plugin state directory', { cause });
    }
  }
  async open(localPort) {
    if (!validPort(localPort)) throw new Error('Invalid local port');
    const status = JSON.parse(await this.run(['serve', 'status', '--json']));
    const receipt = await this.readOwnership();
    if (occupied(portState(status, this.httpsPort)) && !receipt)
      throw new Error(`Funnel port ${this.httpsPort} is occupied; existing configuration was not changed`);
    const self = JSON.parse(await this.run(['status', '--json'])).Self;
    const dns = self?.DNSName?.replace(/\.$/, '');
    if (!validDns(dns)) throw new Error('Tailscale DNS name unavailable');
    const intent = { version: 1, owner: 'browser-handoff', httpsPort: this.httpsPort, dnsName: dns, localPort };
    this.target = `http://127.0.0.1:${localPort}`;
    this.host = `${dns}:${this.httpsPort}`;
    this.expected = expectedState(intent);
    if (receipt) {
      const recordedState = portState(status, receipt.httpsPort);
      if (occupied(recordedState) && stable(recordedState) !== stable(expectedState(receipt))) {
        await this.clearOwnership(true);
        throw new Error('Funnel port configuration changed; ownership receipt invalidated and existing configuration left untouched');
      }
      if (stable(receipt) !== stable(intent)) throw new Error('Funnel ownership receipt does not match configured port, identity, or listener; inspect plugin state before retrying');
    }
    const publicUrl = `https://${dns}${this.httpsPort === 443 ? '' : `:${this.httpsPort}`}`;
    if (occupied(portState(status, this.httpsPort))) {
      if (stable(portState(status, this.httpsPort)) !== stable(this.expected)) throw new Error('Funnel ownership could not be verified');
      this.owned = true;
      return publicUrl;
    }
    await this.persistOwnership(intent);
    // The CLI may apply a mutation and then fail/times out. Track the attempt first.
    this.owned = true;
    try {
      await this.run(['funnel', '--bg', `--https=${this.httpsPort}`, this.target]);
      const observed = JSON.parse(await this.run(['serve', 'status', '--json']));
      if (stable(portState(observed, this.httpsPort)) !== stable(this.expected)) throw new Error('Could not verify isolated Funnel configuration');
    } catch {
      try { await this.close(); }
      catch { throw new Error('Funnel setup failed and cleanup could not verify ownership; inspect Tailscale configuration for unresolved exposure'); }
      throw new Error('Funnel setup failed; attempted route reconciled');
    }
    return publicUrl;
  }
  async close() {
    if (!this.owned) return;
    const status = JSON.parse(await this.run(['serve', 'status', '--json']));
    const current = portState(status, this.httpsPort);
    if (!occupied(current)) { await this.clearOwnership(); this.owned = false; return; }
    if (stable(current) !== stable(this.expected)) {
      this.owned = false;
      await this.clearOwnership(true);
      throw new Error('Funnel port configuration changed; left untouched. Inspect configuration for unresolved exposure.');
    }
    let removalError;
    try { await this.run(['funnel', `--https=${this.httpsPort}`, 'off']); } catch (error) { removalError = error; }
    const after = portState(JSON.parse(await this.run(['serve', 'status', '--json'])), this.httpsPort);
    if (occupied(after)) {
      if (stable(after) !== stable(this.expected)) {
        this.owned = false; await this.clearOwnership(true);
        throw new Error('Funnel configuration changed during cleanup; left untouched and ownership invalidated');
      }
      throw new Error('Funnel route removal was not verified; ownership retained for recovery', { cause: removalError });
    }
    await this.clearOwnership();
    this.owned = false;
  }
}
