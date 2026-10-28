import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizedSession, ownerAuthorized, ownerGuard } from '../src/authorization.mjs';
const group = 'agent:main:googlechat:group:spaces/demo';
const config = { ownerGroupSessions: [group] };
const context = () => ({ senderIsOwner: true, sessionKey: group, sessionId: 'incarnation', requesterSenderId: 'users/owner', inputProvenance: { kind: 'external_user' }, assertInvocationCurrent() {} });
test('group allowlist matches exact base sessions with only valid Google Chat thread suffixes', () => {
  for (const key of [group, group + ':thread:0123456789abcdef01234567']) assert.equal(authorizedSession(key, config.ownerGroupSessions), true, key);
  for (const key of [group + '-other', group + ':thread:', group + ':thread:spaces/other/threads/id', group + ':thread:id:cron:x', group + ':thread:../id', group + ':channel:x']) assert.equal(authorizedSession(key, config.ownerGroupSessions), false, key);
  for (const base of [group + '*', group + ':thread:id', 'agent:main:googlechat:space:spaces/demo', 'agent:main:googlechat:group:spaces/*']) assert.equal(authorizedSession(group, [base]), false, base);
  const channel = 'agent:main:discord:channel:123';
  assert.equal(authorizedSession(channel, [channel]), true);
  assert.equal(authorizedSession(channel + ':thread:456', [channel]), false);
});
test('automated origins and malformed identities never gain authority through operator config', () => {
  const ctx = context();
  for (const suffix of [':subagent:x', ':cron:x', ':hook:x', ':heartbeat:x', ':automation:x', ':automated:x', ':background:x']) {
    const key = group + suffix;
    assert.equal(ownerAuthorized({ ...ctx, sessionKey: key }, { ownerGroupSessions: [key] }), false);
  }
  for (const delta of [{ sessionId: '' }, { sessionId: ' ' }, { sandboxed: true }, { sandbox: {} }, { assertInvocationCurrent: undefined }, { requesterSenderId: '' }, { inputProvenance: { kind: 'external_user', sourceRole: 'subagent' } }, { inputProvenance: { kind: 'external_user', jobId: 'job' } }]) assert.equal(ownerAuthorized({ ...ctx, ...delta }, config), false);
  const direct = { ...ctx, sessionKey: 'agent:main:telegram:direct:1', requesterSenderId: undefined, inputProvenance: undefined };
  assert.equal(ownerAuthorized(direct), true);
  assert.equal(ownerAuthorized({ ...direct, inputProvenance: { kind: 'internal_system', sourceTool: 'exec' } }), true);
  assert.equal(ownerAuthorized({ ...direct, inputProvenance: { kind: 'internal_system', sourceTool: 'heartbeat' } }), true, 'private provenance policy stays backward compatible');
});
test('retained guards reject changed sessions, incarnation and native sender identity', () => {
  for (const delta of [{ sessionId: 'new' }, { sessionKey: group + ':thread:abcdef0123456789abcdef01' }, { requesterSenderId: 'users/other' }]) {
    const ctx = context(), guard = ownerGuard(ctx, config); guard(); Object.assign(ctx, delta);
    assert.throws(guard, /owner|session|identity/i);
  }
  const ctx = context(), guard = ownerGuard(ctx, config); config.ownerGroupSessions = []; assert.throws(guard, /owner/i); config.ownerGroupSessions = [group];
  ctx.assertInvocationCurrent = () => { throw new Error('stale invocation'); }; assert.throws(guard, /stale/);
});
