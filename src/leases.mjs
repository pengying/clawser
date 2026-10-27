import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';

const token = () => randomBytes(32).toString('base64url');
const hash = (s) => createHash('sha256').update(String(s)).digest('hex');
const matches = (s, digest) => typeof s === 'string' && s.length <= 100 &&
  typeof digest === 'string' && timingSafeEqual(Buffer.from(hash(s)), Buffer.from(digest));

export class ControlGate {
  active = new Set();
  holder = null;
  pending = null;
  humanInputs = 0;
  releasing = false;
  poisonReason = null;
  get locked() { return this.holder !== null || this.poisonReason !== null; }
  poison() { this.poisonReason = 'Browser input outcome uncertain. Restart the target browser and reload the plugin before resuming.'; }
  enter(id) {
    if (this.locked) throw new Error(this.poisonReason || 'Browser is under human control; wait for handoff completion, then take a fresh snapshot.');
    this.active.add(id);
  }
  leave(id) {
    this.active.delete(id);
    if (!this.active.size) this.pending?.resolve();
  }
  async acquire(id) {
    if (this.poisonReason) throw new Error(this.poisonReason);
    if (this.holder !== null) throw new Error('Another control request is already active');
    this.holder = id;
    this.releasing = false;
    if (!this.active.size) return;
    let waiter;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Existing browser action did not finish; retry takeover')), 10_000);
        timer.unref();
        waiter = this.pending = {
          resolve: () => { clearTimeout(timer); resolve(); },
          reject: () => { clearTimeout(timer); reject(new Error('Takeover cancelled')); },
        };
      });
      if (this.holder !== id) throw new Error('Takeover cancelled');
    } catch (error) { this.release(id); throw error; }
    finally { if (this.pending === waiter) this.pending = null; }
  }
  release(id) {
    if (this.holder !== id) return;
    this.pending?.reject();
    if (this.humanInputs) { this.releasing = true; return; }
    this.holder = null; this.releasing = false;
  }
  beginInput(id) {
    if (this.poisonReason) throw new Error(this.poisonReason);
    if (this.holder !== id || this.releasing) throw new Error('Control ended');
    this.humanInputs++;
  }
  endInput(id) {
    if (this.holder !== id) return;
    this.humanInputs--;
    if (!this.humanInputs && this.releasing) this.release(id);
  }
}

export class LeaseStore extends EventEmitter {
  shares = new Map();
  constructor({ now = Date.now, gate = new ControlGate(), maxShares = 100 } = {}) {
    super(); Object.assign(this, { now, gate, maxShares });
  }
  create({ owner, target, ttlMs = 300_000, permission = 'control' }) {
    this.sweep();
    if (!owner || !target?.profile || !target?.targetId) throw new Error('Owner and explicit browser target are required');
    if (!Number.isInteger(ttlMs) || ttlMs < 100 || ttlMs > 1_800_000) throw new Error('Invalid lifetime');
    if (!['watch', 'control'].includes(permission)) throw new Error('Invalid permission');
    if (permission === 'control' && this.gate.poisonReason) throw new Error(this.gate.poisonReason);
    if (this.shares.size >= this.maxShares) throw new Error('Too many active shares');
    for (const share of this.shares.values()) {
      if (share.target.profile === target.profile && share.target.targetId === target.targetId)
        throw new Error('This tab is already shared');
    }
    const secret = token(), id = randomBytes(16).toString('hex');
    const share = { id, owner, target: { ...target }, permission, inviteHash: hash(secret),
      expiresAt: this.now() + ttlMs, mode: 'unclaimed', version: 0 };
    this.shares.set(id, share);
    return { id, secret, expiresAt: share.expiresAt };
  }
  get(id) {
    const share = this.shares.get(id);
    if (!share) throw new Error('Invalid or expired share');
    if (share.expiresAt <= this.now()) { this.end(share, 'expired'); throw new Error('Share expired'); }
    return share;
  }
  claim(id, secret) {
    const share = this.get(id);
    if (share.mode !== 'unclaimed') throw new Error('Invitation already claimed');
    if (!matches(secret, share.inviteHash)) throw new Error('Invalid invitation');
    const sessionSecret = token();
    delete share.inviteHash;
    share.sessionHash = hash(sessionSecret); this.change(share, 'watch');
    return { secret: sessionSecret, expiresAt: share.expiresAt };
  }
  authorize(id, secret) {
    const share = this.get(id);
    if (!matches(secret, share.sessionHash)) throw new Error('Invalid viewer session');
    return share;
  }
  async takeControl(share) {
    this.current(share);
    if (share.permission !== 'control') throw new Error('Watch-only invitation');
    if (share.mode !== 'watch') throw new Error('Control request already active');
    this.change(share, 'pending');
    try {
      await this.gate.acquire(share.id);
      this.current(share);
      if (share.mode !== 'pending') throw new Error('Takeover cancelled');
      this.change(share, 'control');
    } catch (error) {
      this.gate.release(share.id);
      if (this.shares.get(share.id) === share) this.change(share, 'watch');
      throw error;
    }
  }
  current(share) {
    if (this.get(share.id) !== share) throw new Error('Share ended');
  }
  change(share, mode) {
    share.mode = mode; share.version++;
    if (mode === 'control') share.controlId = randomBytes(16).toString('hex');
    else delete share.controlId;
    this.emit('state', share);
  }
  releaseControl(share) {
    this.emit('release', share);
    this.gate.release(share.id);
    if (this.shares.get(share.id) === share) this.change(share, 'watch');
  }
  revoke(id, owner) {
    const share = this.get(id);
    if (share.owner !== owner) throw new Error('Share belongs to another owner session');
    this.end(share, 'revoked');
  }
  end(share, reason = 'done') {
    if (!this.shares.delete(share.id)) return;
    this.emit('release', share);
    this.gate.release(share.id); share.mode = 'ended'; share.version++; delete share.controlId;
    delete share.sessionHash; delete share.inviteHash;
    this.emit('ended', { id: share.id, owner: share.owner, reason });
  }
  sweep() {
    for (const share of this.shares.values()) if (share.expiresAt <= this.now()) this.end(share, 'expired');
  }
  close() { for (const share of [...this.shares.values()]) this.end(share, 'shutdown'); }
  state(share) {
    this.current(share);
    return { id: share.id, mode: share.mode, version: share.version, ...(share.controlId ? { controlId: share.controlId } : {}), permission: share.permission,
      expiresAt: share.expiresAt, recoveryRequired: Boolean(this.gate.poisonReason) };
  }
}
