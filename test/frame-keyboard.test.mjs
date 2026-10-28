import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameKeyboard } from '../src/frame-keyboard.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
class Browser {
  handlers = new Map(); commands = []; hold = null; opaque = true; focused = true; owner = 7;
  onAny(method, handler) { this.handlers.set(method, handler); }
  event(method, params, session) { this.handlers.get(method)?.(params, session); }
  async send(method, params, session) {
    this.commands.push({ method, params, session });
    if (this.hold?.method === method) { const hold = this.hold; this.hold = null; await hold.promise; }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: session ? 'child' : 'top', ...(session ? { parentId: 'top' } : {}), loaderId: session ? 'child-document' : 'top-document' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: session ? 2 : 1 };
    if (method === 'Runtime.evaluate') return { result: session ? { subtype: 'null', value: null } : this.focused ? { objectId: 'owner' } : { subtype: 'null', value: null } };
    if (method === 'DOM.describeNode') return { node: { nodeName: 'IFRAME', backendNodeId: this.owner, frameId: 'child' } };
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 7 };
    if (method === 'Runtime.callFunctionOn') return { result: { value: this.opaque } };
    return {};
  }
}
async function fixture() {
  const cdp = new Browser(), keyboard = new FrameKeyboard(cdp, { document: () => 'doc', onChange() {} });
  await keyboard.start('top');
  cdp.event('Target.attachedToTarget', { sessionId: 'child-session', targetInfo: { type: 'iframe', targetId: 'child' } });
  await keyboard.settled();
  return { cdp, keyboard };
}

test('manual keyboard uses exact iframe DOM/frame identity and never field focus metadata', async () => {
  const { cdp, keyboard } = await fixture();
  const token = await keyboard.activate('doc');
  assert.deepEqual(Object.keys(token).sort(), ['document', 'token']);
  assert.equal((await keyboard.validate(token.token)).token, token.token);
  assert.ok(cdp.commands.some(c => c.method === 'DOM.getFrameOwner' && c.params.frameId === 'child'));
  assert.ok(cdp.commands.some(c => c.method === 'Target.setAutoAttach' && c.params.filter?.[0]?.type === 'iframe'));
  cdp.owner = 99;
  await assert.rejects(keyboard.validate(token.token), /frame|keyboard/i);
});

test('null focus and same-origin-only frames never activate a manual keyboard', async () => {
  const { cdp, keyboard } = await fixture();
  cdp.focused = false;
  await assert.rejects(keyboard.activate('doc'), /frame|keyboard/i);
  cdp.focused = true; cdp.opaque = false;
  await assert.rejects(keyboard.activate('doc'), /frame|keyboard/i);
});

test('child navigation starts revoke tokens synchronously without parent navigation events', async () => {
  const { cdp, keyboard } = await fixture(), token = await keyboard.activate('doc');
  cdp.event('Page.frameStartedLoading', { frameId: 'child' }, 'child-session');
  await assert.rejects(keyboard.validate(token.token), /frame|keyboard/i);
  await assert.rejects(keyboard.activate('doc'), /frame|keyboard/i);
});

test('navigation during activation or validation cannot return dispatch authority', async () => {
  for (const operation of ['activate', 'validate']) {
    const { cdp, keyboard } = await fixture(), token = await keyboard.activate('doc');
    const hold = deferred(); cdp.hold = { method: 'DOM.getFrameOwner', ...hold };
    const pending = keyboard[operation](operation === 'activate' ? 'doc' : token.token);
    await new Promise(resolve => setImmediate(resolve));
    cdp.event('Page.frameStartedNavigating', { frameId: 'child' }, 'child-session');
    hold.resolve();
    await assert.rejects(pending, /frame|keyboard/i);
  }
});

test('unrelated sessions cannot change readiness or navigation generations', async () => {
  const { cdp, keyboard } = await fixture(), token = await keyboard.activate('doc');
  cdp.event('Page.frameNavigated', { frame: { id: 'elsewhere' } }, 'unrelated-session');
  cdp.event('Target.attachedToTarget', { sessionId: 'popup-session', targetInfo: { type: 'page', targetId: 'popup' } });
  cdp.event('Target.attachedToTarget', { sessionId: 'foreign-child', targetInfo: { type: 'iframe', targetId: 'foreign' } }, 'unrelated-session');
  assert.equal((await keyboard.validate(token.token)).token, token.token);
  assert.equal(cdp.commands.some(c => ['popup-session', 'foreign-child'].includes(c.session)), false);
});

test('revoke, detach, focus leaving the iframe, and document changes reject stale tokens', async () => {
  for (const change of ['revoke', 'detach', 'focus', 'document']) {
    const { cdp, keyboard } = await fixture(), token = await keyboard.activate('doc');
    if (change === 'revoke') keyboard.revoke();
    if (change === 'detach') cdp.event('Target.detachedFromTarget', { sessionId: 'child-session' });
    if (change === 'focus') cdp.focused = false;
    if (change === 'document') keyboard.document = () => 'new-document';
    await assert.rejects(keyboard.validate(token.token), /frame|keyboard/i);
  }
});

test('manual frame observation is bounded and incomplete frame identity stays unavailable', async () => {
  const { cdp, keyboard } = await fixture();
  for (let n = 0; n < 65; n++) cdp.event('Target.attachedToTarget', { sessionId: 'extra-' + n, targetInfo: { type: 'iframe', targetId: 'extra-frame-' + n } });
  await keyboard.settled();
  assert.ok(keyboard.sessions.size <= 64);
  await assert.rejects(keyboard.activate('doc'), /frame|keyboard/i);
});

test('detaching a loading child does not leave a permanent navigation barrier', async () => {
  const { cdp, keyboard } = await fixture();
  cdp.event('Page.frameStartedLoading', { frameId: 'child' }, 'child-session');
  cdp.event('Target.detachedFromTarget', { sessionId: 'child-session' });
  cdp.event('Target.attachedToTarget', { sessionId: 'child-session', targetInfo: { type: 'iframe', targetId: 'child' } });
  await keyboard.settled();
  assert.ok((await keyboard.activate('doc')).token);
});
