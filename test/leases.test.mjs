import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LeaseStore, ControlGate } from '../src/leases.mjs';

const target = { profile: 'demo', targetId: 'tab1' };
function setup() {
  let now = 1000;
  const gate = new ControlGate();
  const store = new LeaseStore({ now: () => now, gate });
  const invite = store.create({ owner: 'owner', target, ttlMs: 5000, permission: 'control' });
  return { store, gate, invite, tick: (ms) => { now += ms; store.sweep(); } };
}

test('control epochs and state versions distinguish delayed packets and state polls', async () => {
  const { store, invite } = setup();
  const session = store.claim(invite.id, invite.secret), share = store.authorize(invite.id, session.secret);
  await store.takeControl(share);
  const first = store.state(share);
  assert.match(first.controlId, /^[a-f0-9]{32}$/);
  store.releaseControl(share);
  assert.ok(store.state(share).version > first.version);
  await store.takeControl(share);
  assert.notEqual(store.state(share).controlId, first.controlId);
});

test('public state reports whether operator recovery is required', () => {
  const { store, gate, invite } = setup();
  const session = store.claim(invite.id, invite.secret);
  const share = store.authorize(invite.id, session.secret);
  assert.equal(store.state(share).recoveryRequired, false);
  gate.poison();
  assert.equal(store.state(share).recoveryRequired, true);
});

test('a poisoned gate refuses new control links but still allows watch-only diagnostics', () => {
  const { store, gate } = setup();
  gate.poison();
  assert.throws(() => store.create({ owner: 'owner', target: { ...target, targetId: 'control-tab' } }), /restart|recovery/i);
  const watch = store.create({ owner: 'owner', target: { ...target, targetId: 'watch-tab' }, permission: 'watch' });
  assert.match(watch.id, /^[a-f0-9]{32}$/);
});

test('invitation is one-use, secret is not stored in plaintext, and claim is scoped', () => {
  const { store, invite } = setup();
  assert.throws(() => store.claim(invite.id, 'wrong'), /invalid/i);
  const claimed = store.claim(invite.id, invite.secret);
  assert.equal(store.authorize(invite.id, claimed.secret).id, invite.id);
  assert.throws(() => store.claim(invite.id, invite.secret), /claimed/i);
  assert.throws(() => store.authorize('other', claimed.secret), /invalid/i);
  assert.ok(!JSON.stringify([...store.shares.values()]).includes(invite.secret));
});

test('absolute expiry revokes watch and control and notifies attached transports', async () => {
  const { store, gate, invite, tick } = setup();
  const viewer = store.claim(invite.id, invite.secret);
  await store.takeControl(store.authorize(invite.id, viewer.secret));
  let ended;
  store.on('ended', (event) => { ended = event; });
  tick(5001);
  assert.throws(() => store.authorize(invite.id, viewer.secret), /invalid|expired/i);
  assert.equal(gate.locked, false);
  assert.equal(ended.reason, 'expired');
});

test('watch-only cannot escalate and owner revocation cannot cross sessions', async () => {
  const { store } = setup();
  const invite = store.create({ owner: 'owner', target: { ...target, targetId: 'tab2' }, ttlMs: 5000, permission: 'watch' });
  const viewer = store.claim(invite.id, invite.secret);
  await assert.rejects(store.takeControl(store.authorize(invite.id, viewer.secret)), /watch.only/i);
  assert.throws(() => store.revoke(invite.id, 'someone-else'), /owner/i);
  store.revoke(invite.id, 'owner');
  assert.throws(() => store.authorize(invite.id, viewer.secret), /invalid/i);
});

test('takeover blocks new agent calls and drains existing calls before allowing input', async () => {
  const { store, gate, invite } = setup();
  gate.enter('inflight');
  const viewer = store.claim(invite.id, invite.secret);
  const share = store.authorize(invite.id, viewer.secret);
  const pending = store.takeControl(share);
  assert.equal(gate.locked, true);
  assert.equal(share.mode, 'pending');
  assert.throws(() => gate.enter('new'), /control/i);
  gate.leave('inflight');
  await pending;
  assert.equal(share.mode, 'control');
  store.releaseControl(share);
  assert.equal(gate.locked, false);
  assert.equal(share.mode, 'watch');
});

test('revocation during takeover drain cannot later grant input', async () => {
  const { store, gate, invite } = setup();
  gate.enter('slow-call');
  const viewer = store.claim(invite.id, invite.secret);
  const share = store.authorize(invite.id, viewer.secret);
  const pending = store.takeControl(share);
  store.revoke(invite.id, 'owner');
  gate.leave('slow-call');
  await assert.rejects(pending, /ended|cancel/i);
  assert.equal(gate.locked, false);
});

test('a second share cannot capture the same tab and a second controller cannot steal control', async () => {
  const { store, invite } = setup();
  assert.throws(() => store.create({ owner: 'other', target, ttlMs: 5000 }), /already/i);
  const a = store.claim(invite.id, invite.secret);
  const bInvite = store.create({ owner: 'owner', target: { ...target, targetId: 'tab2' }, ttlMs: 5000, permission: 'control' });
  const b = store.claim(bInvite.id, bInvite.secret);
  await store.takeControl(store.authorize(invite.id, a.secret));
  await assert.rejects(store.takeControl(store.authorize(bInvite.id, b.secret)), /another|control/i);
});

test('release waits for already-dispatched human input before allowing agent actions', async () => {
  const gate = new ControlGate();
  await gate.acquire('human');
  gate.beginInput('human');
  gate.release('human');
  assert.equal(gate.locked, true);
  assert.throws(() => gate.beginInput('human'), /ended/i);
  assert.throws(() => gate.enter('agent'), /control/i);
  gate.endInput('human');
  assert.equal(gate.locked, false);
  gate.enter('agent');
});
