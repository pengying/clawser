import { randomBytes } from 'node:crypto';

// This capability grants physical-keyboard semantics within an explicitly
// focused opaque frame. It never asserts editable-field identity or reads a
// field value. CDP focus validation and native input remain separate commands.
const autoAttach = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
  filter: [{ type: 'iframe', exclude: false }, { exclude: true }] };
const focusedOwner = `(() => {
  if (document.readyState !== 'complete' || !document.hasFocus()) throw new Error('Frame lost focus');
  let node = document.activeElement;
  for (let n = 0; n < 8 && node?.shadowRoot?.activeElement; n++) node = node.shadowRoot.activeElement;
  if (node?.shadowRoot?.activeElement) throw new Error('Frame focus depth exceeded');
  return node?.tagName === 'IFRAME' && node.isConnected ? node : null;
})()`;
const failure = () => Object.assign(new Error('Cross-origin frame changed. Tap the frame and choose Keyboard again.'), { definitive: true });
const findFrame = (tree, id) => tree?.frame?.id === id ? tree.frame : tree?.childFrames?.map(child => findFrame(child, id)).find(Boolean);

export class FrameKeyboard {
  constructor(cdp, { document, onChange, isInputAllowed = () => true }) {
    this.isInputAllowed = isInputAllowed; this.cdp = cdp; this.document = document; this.onChange = onChange;
    this.sessions = new Map(); this.loading = new Set(); this.pending = new Set(); this.epoch = 0;
    const owns = session => !session || this.sessions.has(session);
    cdp.onAny('Target.attachedToTarget', (event, parent) => {
      if (!owns(parent) || event.targetInfo?.type !== 'iframe') return;
      // Only descendants auto-attached through this claimed page are owned.
      // Never attach by browser-wide discovery, target URL, or tab order.
      this.revoke();
      if (this.sessions.size >= 64) {
        this.incomplete = true;
        this.track(cdp.send('Target.detachFromTarget', { sessionId: event.sessionId }, parent));
        return;
      }
      const state = { session: event.sessionId, parent, ready: false, generation: 0 };
      this.sessions.set(event.sessionId, state);
      this.track(this.prepare(state));
    });
    cdp.onAny('Target.detachedFromTarget', (event, parent) => {
      if (!owns(parent) || !this.sessions.has(event.sessionId)) return;
      this.revoke();
      const remove = session => {
        for (const child of this.sessions.values()) if (child.parent === session) remove(child.session);
        this.loading.delete(this.sessions.get(session)?.frameId);
        this.sessions.delete(session);
      };
      remove(event.sessionId);
    });
    for (const method of ['Page.frameStartedNavigating', 'Page.frameStartedLoading', 'Page.frameNavigated', 'Page.frameDetached', 'Page.frameAttached']) {
      cdp.onAny(method, (event, session) => {
        if (!owns(session)) return;
        this.revoke();
        const id = event.frameId || event.frame?.id;
        if (method === 'Page.frameDetached' || method === 'Page.frameAttached') this.loading.delete(id);
        else this.loading.add(id);
        const state = this.sessions.get(session);
        if (state && (!state.frameId || id === state.frameId)) { state.ready = false; state.generation++; }
      });
    }
    cdp.onAny('Page.frameStoppedLoading', (event, session) => {
      if (!owns(session)) return;
      this.loading.delete(event.frameId);
      const state = this.sessions.get(session);
      if (state && (!state.frameId || event.frameId === state.frameId)) this.track(this.prepare(state));
    });
  }
  track(work) {
    // An unsupported/incomplete child remains unavailable. The DOM-backed path
    // can continue, but no native token is minted from incomplete observation.
    const pending = work.catch(() => {}).finally(() => this.pending.delete(pending));
    this.pending.add(pending);
  }
  async settled() { while (this.pending.size) await Promise.all([...this.pending]); }
  async start(topFrame) { this.topFrame = topFrame; await this.cdp.send('Target.setAutoAttach', autoAttach); await this.settled(); }
  async observe(state) {
    await this.cdp.send('Page.enable', {}, state.session);
    if (this.sessions.get(state.session) !== state) return;
    await this.cdp.send('Target.setAutoAttach', autoAttach, state.session);
    if (this.sessions.get(state.session) === state) state.observing = true;
  }
  async prepare(state) {
    const generation = state.generation;
    // All readiness attempts share the complete setup phase. Navigation can
    // supersede a frame-tree snapshot, but must never skip recursive attachment.
    await (state.setup ||= this.observe(state));
    if (!state.observing) return;
    const { frameTree } = await this.cdp.send('Page.getFrameTree', {}, state.session);
    if (this.sessions.get(state.session) !== state || generation !== state.generation || !frameTree?.frame?.id) return;
    state.frameId = frameTree.frame.id;
    state.parentFrame = frameTree.frame.parentId;
    if (this.sessions.get(state.session) === state && generation === state.generation && !this.loading.has(state.frameId)) state.ready = true;
  }
  revoke() { this.epoch++; const hadToken = this.active; this.active = null; if (hadToken) this.onChange?.(null); }
  current() { return this.active && { document: this.active.document, token: this.active.token }; }
  check(epoch, document) {
    if (this.incomplete || !this.isInputAllowed() || epoch !== this.epoch || document !== this.document() || this.loading.size) throw failure();
  }
  async path(epoch, document) {
    const path = []; let session, frameId = this.topFrame, opaque = false;
    for (let depth = 0; depth < 9; depth++) {
      this.check(epoch, document);
      const state = session && this.sessions.get(session);
      if (session && (!state?.ready || state.frameId !== frameId)) throw failure();
      const { frameTree } = await this.cdp.send('Page.getFrameTree', {}, session);
      const frame = findFrame(frameTree, frameId);
      if (!frame || !frame.loaderId) throw failure();
      const { executionContextId } = await this.cdp.send('Page.createIsolatedWorld', { frameId, worldName: 'openclaw-handoff-frame-focus' }, session);
      const result = await this.cdp.send('Runtime.evaluate', { expression: focusedOwner, contextId: executionContextId,
        objectGroup: 'openclaw-handoff-frame-focus', returnByValue: false }, session);
      if (result.exceptionDetails) throw failure();
      if (!result.result.objectId) {
        this.check(epoch, document);
        if (!opaque || !path.length) throw failure();
        return JSON.stringify([...path, [frameId, frame.loaderId, session || null]]);
      }
      const objectId = result.result.objectId, ownerSession = session;
      try {
        const { node } = await this.cdp.send('DOM.describeNode', { objectId, depth: 0 }, session);
        if (node.nodeName !== 'IFRAME' || !node.frameId || !node.backendNodeId) throw failure();
        const owner = await this.cdp.send('DOM.getFrameOwner', { frameId: node.frameId }, session);
        if (owner.backendNodeId !== node.backendNodeId) throw failure();
        const privacy = await this.cdp.send('Runtime.callFunctionOn', { objectId,
          functionDeclaration: 'function(){return this.isConnected && this.contentDocument === null}', returnByValue: true }, session);
        if (privacy.exceptionDetails) throw failure();
        opaque ||= privacy.result.value === true;
        const child = findFrame(frameTree, node.frameId);
        let childSession = session;
        if (!child) {
          const candidates = [...this.sessions.values()].filter(candidate => candidate.frameId === node.frameId && candidate.parent === session);
          if (candidates.length !== 1 || !candidates[0].ready || candidates[0].parentFrame !== frameId) throw failure();
          childSession = candidates[0].session;
        } else if (child.parentId !== frameId) throw failure();
        path.push([frameId, frame.loaderId, node.backendNodeId, node.frameId, childSession || null]);
        session = childSession; frameId = node.frameId;
      } finally {
        await this.cdp.send('Runtime.releaseObject', { objectId }, ownerSession).catch(() => {});
      }
    }
    throw failure();
  }
  async activate(document) {
    this.revoke();
    const epoch = this.epoch;
    this.check(epoch, document);
    const path = await this.path(epoch, document);
    this.check(epoch, document);
    this.active = { token: randomBytes(16).toString('hex'), document, epoch, path };
    this.onChange?.(this.current());
    return this.current();
  }
  assert(token) {
    const active = this.active;
    if (!active || active.token !== token) throw failure();
    this.check(active.epoch, active.document);
    return active;
  }
  async validate(token) {
    const active = this.active;
    if (!active || token !== active.token) throw failure();
    this.check(active.epoch, active.document);
    const path = await this.path(active.epoch, active.document);
    this.check(active.epoch, active.document);
    if (this.active !== active || path !== active.path) { this.revoke(); throw failure(); }
    return this.current();
  }
}
