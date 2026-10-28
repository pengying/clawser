import { WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { FrameKeyboard } from './frame-keyboard.mjs';
import { interactionCollector } from './interaction-metadata.mjs';
import { pickerOpen, pickerApply, pickerCancel } from './native-picker.mjs';

const KEYS = Object.fromEntries(Object.entries({
  Enter: 13, Tab: 9, Backspace: 8, Escape: 27,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39,
  ArrowDown: 40, Delete: 46, Home: 36, End: 35,
  'Ctrl+A': 65,
}).map(([name, windowsVirtualKeyCode]) => [name, [windowsVirtualKeyCode, name === 'Ctrl+A' ? 'KeyA' : name]]));
const EDIT_OPERATIONS = Object.keys({ insert: true, backspace: true, delete: true, enter: true, key: true });
const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const pickerRegion = (document, regionId) => {
  if (!/^[a-f0-9]{32}$/.test(document || '') || typeof regionId !== 'string' || regionId.length > 49 ||
      !/^[a-f0-9]{32}:[1-9][0-9]*$/.test(regionId)) return false;
  const index = Number(regionId.slice(33));
  return Number.isSafeInteger(index) && regionId === (`${document}` + ':' + index);
};
export function validateInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid input');
  if (event.kind === 'focus') return { kind: 'focus' };
  if (event.kind === 'nativeKeyboardOpen' && /^[a-f0-9]{32}$/.test(event.document || ''))
    return { kind: 'nativeKeyboardOpen', document: event.document };
  if (event.kind === 'nativeEdit' && /^[a-f0-9]{32}$/.test(event.keyboardToken || '') &&
      EDIT_OPERATIONS.includes(event.operation) &&
      (event.operation !== 'insert' || typeof event.text === 'string' && event.text.length <= 4096) &&
      (event.operation !== 'key' || Object.hasOwn(KEYS, event.key)))
    return { kind: 'nativeEdit', keyboardToken: event.keyboardToken, operation: event.operation,
      ...(event.operation === 'insert' ? { text: event.text } : event.operation === 'key' ? { key: event.key } : {}) };
  if (event.kind === 'pickerOpen' && pickerRegion(event.document, event.regionId))
    return { kind: 'pickerOpen', document: event.document, regionId: event.regionId };
  if (event.kind === 'pickerApply' && /^[a-f0-9]{32}$/.test(event.pickerToken || '')) {
    const hasIndices = Object.hasOwn(event, 'indices'), hasColor = Object.hasOwn(event, 'color');
    if (hasIndices !== hasColor && (hasIndices ? Array.isArray(event.indices) && event.indices.length <= 256 &&
        event.indices.every((index, position) => Number.isSafeInteger(index) && index >= 0 && index <= 4095 && event.indices.indexOf(index) === position)
      : /^#[a-f0-9]{6}$/.test(event.color)))
      return { kind: 'pickerApply', pickerToken: event.pickerToken, ...(hasIndices ? { indices: event.indices } : { color: event.color }) };
  }
  if (event.kind === 'pickerCancel' && /^[a-f0-9]{32}$/.test(event.pickerToken || ''))
    return { kind: 'pickerCancel', pickerToken: event.pickerToken };
  if (event.kind === 'edit' && /^[a-f0-9]{32}$/.test(event.focusToken || '') &&
      EDIT_OPERATIONS.includes(event.operation) &&
      (event.operation !== 'insert' || typeof event.text === 'string' && event.text.length <= 4096) &&
      (event.operation !== 'key' || Object.hasOwn(KEYS, event.key)))
    return { kind: 'edit', focusToken: event.focusToken, operation: event.operation, ...(event.operation === 'insert' ? { text: event.text } : event.operation === 'key' ? { key: event.key } : {}) };
  if (event.kind === 'pointer' && ['down', 'move', 'up', 'cancel'].includes(event.phase) &&
      ['touch', 'mouse'].includes(event.pointerType) && Number.isSafeInteger(event.gesture) && event.gesture > 0 &&
      finite(event.x, 0, 1) && finite(event.y, 0, 1))
    return { kind: 'pointer', phase: event.phase, pointerType: event.pointerType, gesture: event.gesture, x: event.x, y: event.y };
  if (event.kind === 'text' && typeof event.text === 'string' && event.text.length <= 4096)
    return { kind: 'text', text: event.text };
  if (event.kind === 'key' && Object.hasOwn(KEYS, event.key)) return { kind: 'key', key: event.key };
  if (['click', 'scroll'].includes(event.kind) && finite(event.x, 0, 1) && finite(event.y, 0, 1)) {
    if (event.kind === 'click') return { kind: 'click', x: event.x, y: event.y };
    if (finite(event.deltaX, -2000, 2000) && finite(event.deltaY, -2000, 2000))
      return { kind: 'scroll', x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY };
  }
  throw new Error('Invalid or unsupported input');
}

export function validateCdpUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('CDP must be a loopback HTTP origin without credentials or query');
  return url;
}
export const isWebPage = (value) => {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
};

export class CdpConnection {
  sequence = 0;
  requests = new Map();
  listeners = new Map();
  constructor({ commandTimeoutMs = 5000 } = {}) { this.commandTimeoutMs = commandTimeoutMs; }
  async connect(url) {
    this.socket = new WebSocket(url, { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 5000 });
    this.socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.id) {
        const entry = this.requests.get(msg.id);
        if (!entry || (msg.sessionId || undefined) !== entry.sessionId) return;
        clearTimeout(entry.timer); this.requests.delete(msg.id);
        if (msg.error) entry.reject(Object.assign(new Error('Browser command failed'), { definitive: true, method: entry.method }));
        else entry.resolve(msg.result);
      } else {
        for (const listener of this.listeners.get(msg.method + ':' + (msg.sessionId || '')) || []) listener(msg.params);
        for (const listener of this.listeners.get(msg.method + ':*') || []) listener(msg.params, msg.sessionId);
      }
    });
    this.socket.on('error', () => { this.firstFailure ||= { code: 'transport_error' }; });
    this.socket.on('close', () => {
      for (const entry of this.requests.values()) {
        clearTimeout(entry.timer);
        entry.reject(Object.assign(new Error('Browser disconnected'), { method: entry.method,
          causeCode: this.firstFailure?.code || 'disconnected', causeMethod: this.firstFailure?.method }));
      }
      this.requests.clear(); this.onClose?.();
    });
    await new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', () => reject(new Error('Browser connection failed')));
    });
    return this;
  }
  on(method, listener, sessionId = '') {
    const key = method + ':' + sessionId;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(listener);
    return () => this.listeners.get(key)?.delete(listener);
  }
  onAny(method, listener) { return this.on(method, listener, '*'); }
  send(method, params = {}, sessionId) {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(Object.assign(new Error('Browser disconnected'), { method,
      causeCode: this.firstFailure?.code || 'disconnected', causeMethod: this.firstFailure?.method }));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        this.firstFailure ||= { code: 'timeout', method };
        reject(Object.assign(new Error('Browser command timed out; outcome uncertain'), { method,
          causeCode: this.firstFailure.code, causeMethod: this.firstFailure.method }));
        this.close();
      }, this.commandTimeoutMs);
      timer.unref();
      this.requests.set(id, { resolve, reject, timer, method, sessionId });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { this.socket?.terminate(); }
}

export class CdpBrowser {
  constructor(profiles) {
    this.profiles = Object.fromEntries(Object.entries(profiles).map(([name, url]) => [name, validateCdpUrl(url)]));
  }
  async list(profile) {
    const base = this.profiles[profile];
    if (!base) throw new Error('Profile is not configured for sharing');
    const res = await fetch(new URL('/json/list', base), { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error('Browser target list unavailable');
    const tabs = await res.json();
    if (!Array.isArray(tabs) || tabs.length > 1000) throw new Error('Invalid browser target list');
    return tabs.filter((tab) => tab.type === 'page' && isWebPage(tab.url)).map((tab) => ({
      targetId: tab.id, title: String(tab.title || '').slice(0, 300), url: tab.url,
      webSocketDebuggerUrl: tab.webSocketDebuggerUrl,
    }));
  }
  async open(target, { onFrame, onClose, onMetadata = () => {}, isInputAllowed = () => true }) {
    const tab = (await this.list(target.profile)).find((tab) => tab.targetId === target.targetId);
    if (!tab) throw new Error('Selected browser tab is unavailable');
    const base = this.profiles[target.profile];
    const wsUrl = new URL(tab.webSocketDebuggerUrl);
    if (wsUrl.protocol !== 'ws:' || wsUrl.host !== base.host || wsUrl.username || wsUrl.password)
      throw new Error('Browser returned a non-local debugging endpoint');
    const cdp = await new CdpConnection().connect(wsUrl);
    let width = 1, height = 1, pageScale = 1, closed = false, url = tab.url, metadataTimer;
    let contextId, documentId = randomBytes(16).toString('hex'), activeFocus, activePicker, latestMap, gesture, dragData, dragEntered = false;
    let metadataQueue = Promise.resolve(), polling = false, keyboard;
    const failure = (message) => Object.assign(new Error(message), { definitive: true });
    const finish = () => { if (!closed) { closed = true; keyboard?.revoke(); clearInterval(metadataTimer); cdp.close(); onClose(); } };
    const collect = () => {
      const work = metadataQueue.catch(() => {}).then(async () => {
        if (closed) throw failure('Browser disconnected');
        const generation = documentId;
        if (!contextId) {
          const tree = await cdp.send('Page.getFrameTree');
          const world = await cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'openclaw-browser-handoff' });
          if (generation !== documentId) throw failure('Page changed; tap the field again');
          contextId = world.executionContextId;
        }
        const result = await cdp.send('Runtime.evaluate', { expression: interactionCollector(documentId), contextId, returnByValue: true });
        if (result.exceptionDetails || generation !== documentId) { contextId = undefined; activeFocus = null; activePicker = null; throw failure('Page changed; tap the field again'); }
        const map = result.result.value;
        latestMap = map;
        const focused = map.regions.find((region) => region.kind === 'editable' && region.id === map.focus);
        if (!focused) activeFocus = null;
        else if (activeFocus?.id !== focused.id || activeFocus?.document !== map.document)
          activeFocus = { ...focused, document: map.document, token: randomBytes(16).toString('hex') };
        if (!activePicker || activePicker.document !== map.document || activePicker.id !== map.pickerFocus) activePicker = null;
        onMetadata({ interactions: { document: map.document, regions: map.regions, focus: activeFocus,
          pickerFocus: activePicker && { ...activePicker }, keyboard: keyboard?.current() || null, timestamp: Date.now() } });
        return activeFocus;
      });
      metadataQueue = work;
      return work;
    };
    const pickerAction = async (expression) => {
      if (!contextId) throw failure('Picker document changed');
      const result = await cdp.send('Runtime.evaluate', { expression, contextId, returnByValue: true });
      if (result.exceptionDetails) throw failure('Picker is unavailable or changed');
      return result.result.value;
    };
    const key = async (name) => {
      const [windowsVirtualKeyCode, code] = KEYS[name];
      const args = { key: name === 'Ctrl+A' ? 'a' : name, code, windowsVirtualKeyCode, modifiers: name === 'Ctrl+A' ? 2 : 0 };
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...args, ...(name === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
      try { await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...args }); }
      catch { cdp.close(); throw new Error('Browser input sequence incomplete'); }
    };
    const prepareForInput = async (event) => {
      const needsRenderer = event.kind === 'click' || event.kind === 'scroll' || (event.kind === 'pointer' && event.phase === 'down');
      let restored = false;
      if (needsRenderer) {
        const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget', { targetId: target.targetId });
        restored = bounds?.windowState === 'minimized';
        if (restored) await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      }
      // Explicit human input activates the target; watch mode never changes
      // local focus. Continuing gesture phases avoid another window-state RTT.
      await cdp.send('Page.bringToFront');
      if (restored) {
        // A restored renderer can acknowledge activation while remaining slow
        // to accept native input. One discarded paint request makes it ready;
        // the input itself is still sent exactly once below.
        await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: false });
      }
    };
    // Screencast dimensions are screen DIPs; CDP input uses visual-viewport CSS
    // pixels. The browser applies visual viewport panning itself.
    const pointOf = (event) => ({ x: Math.min(width - 1, event.x * width) / pageScale, y: Math.min(height - 1, event.y * height) / pageScale });
    const disableDrag = async () => { await cdp.send('Input.setInterceptDrags', { enabled: false }); dragData = null; dragEntered = false; };
    const cancelGesture = async () => {
      if (!gesture) return;
      const current = gesture;
      if (closed) throw new Error('Held browser input could not be released');
      if (current.pointerType === 'touch') await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      else {
        if (dragData) await cdp.send('Input.dispatchDragEvent', { type: 'dragCancel', ...current.point, data: dragData });
        // Mouse drags begin with clickCount 0. A real matching release ends
        // page pointer capture without a click or a fabricated button change.
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...current.point, button: 'left', buttons: 0, clickCount: 0 });
        await disableDrag();
      }
      gesture = null;
    };
    keyboard = new FrameKeyboard(cdp, { document: () => documentId, isInputAllowed, onChange: (token) => {
      if (!closed) onMetadata({ interactions: { document: documentId, regions: latestMap?.regions || [], focus: activeFocus || null,
        pickerFocus: activePicker && { ...activePicker }, keyboard: token, timestamp: Date.now() } });
    } });
    cdp.on('Input.dragIntercepted', ({ data }) => {
      if (!gesture || gesture.pointerType !== 'mouse') return;
      // Drag data stays on the backend; never expose files/page data to the viewer.
      if (data.files?.length || data.items?.length > 64 || JSON.stringify(data).length > 262144) { void cancelGesture().catch(finish); return; }
      dragData = data;
    });
    cdp.onClose = finish;
    cdp.on('Page.frameNavigated', ({ frame }) => {
      if (frame.parentId) return;
      url = frame.url;
      contextId = undefined; documentId = randomBytes(16).toString('hex'); activeFocus = null; activePicker = null; latestMap = null;
      onMetadata({ interactions: { document: documentId, regions: [], focus: null, pickerFocus: null, timestamp: Date.now() } });
      if (!isWebPage(url)) { finish(); return; }
      onMetadata({ url });
    });
    cdp.on('Page.screencastFrame', (frame) => {
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(finish);
      if (!closed && isWebPage(url)) {
        const { deviceWidth, deviceHeight, pageScaleFactor = 1 } = frame.metadata;
        if (!finite(deviceWidth, 1, 100_000) || !finite(deviceHeight, 1, 100_000) || !finite(pageScaleFactor, .01, 100)) return;
        width = deviceWidth; height = deviceHeight; pageScale = pageScaleFactor;
        onFrame({ type: 'frame', data: frame.data, width, height });
      }
    });
    try {
      await cdp.send('Page.enable');
      // Recheck after subscribing: the selected tab could have navigated since /json/list.
      const tree = await cdp.send('Page.getFrameTree');
      url = tree.frameTree.frame.url;
      await keyboard.start(tree.frameTree.frame.id);
      if (!isWebPage(url)) throw new Error('Only HTTP(S) browser pages can be shared');
      onMetadata({ url, title: tab.title });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 });
      // An unchanged background tab may not paint for startScreencast alone.
      // Request the first paint without activating the tab or changing focus.
      await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: false });
      await collect();
      metadataTimer = setInterval(() => {
        if (polling || closed) return;
        polling = true; void collect().catch(() => {}).finally(() => { polling = false; });
      }, 250); metadataTimer.unref();
    } catch (error) { finish(); throw error; }
    return {
      async input(raw) {
        const event = validateInput(raw);
        if (closed) throw new Error('Browser disconnected');
        if (!['nativeKeyboardOpen', 'nativeEdit', 'focus'].includes(event.kind)) keyboard.revoke();
        await prepareForInput(event);
        if (event.kind === 'nativeKeyboardOpen') return { keyboard: await keyboard.activate(event.document) };
        if (event.kind === 'nativeEdit') {
          await keyboard.validate(event.keyboardToken);
          // No asynchronous gap between this final lifecycle/lease check and
          // dispatch. Focus validation and native input still are not atomic.
          keyboard.assert(event.keyboardToken);
          if (event.operation === 'insert') await cdp.send('Input.insertText', { text: event.text });
          else {
            if (event.operation === 'key' || event.operation === 'enter') keyboard.revoke();
            await key(event.operation === 'key' ? event.key : { backspace: 'Backspace', delete: 'Delete', enter: 'Enter' }[event.operation]);
          }
          return { keyboard: keyboard.current() };
        }
        if (event.kind === 'focus') return { focus: await collect() };
        if (event.kind === 'pickerOpen') {
          await collect();
          const region = latestMap?.document === event.document && latestMap.regions.find((candidate) => candidate.id === event.regionId && candidate.kind === 'picker');
          if (!region || event.document !== documentId) throw failure('Picker is hidden, disabled, or stale');
          const descriptor = await pickerAction(pickerOpen(event.document, event.regionId));
          if (!descriptor || descriptor.id !== event.regionId || descriptor.document !== event.document || !/^[a-f0-9]{32}$/.test(descriptor.token || ''))
            throw failure('Picker response is invalid');
          activePicker = { id: descriptor.id, document: descriptor.document, token: descriptor.token };
          await collect();
          if (!activePicker) throw failure('Picker focus changed');
          return { picker: descriptor };
        }
        if (event.kind === 'pickerApply' || event.kind === 'pickerCancel') {
          await collect();
          if (event.kind === 'pickerCancel') {
            // Cancel is an idempotent UI cleanup signal. A delayed cancel for an
            // older dialog must neither fail the stream nor revoke its successor.
            if (!activePicker || activePicker.token !== event.pickerToken) return { picker: null };
            activePicker = null;
            await pickerAction(pickerCancel(event.pickerToken)).catch(() => {});
            await collect().catch(() => {});
            return { picker: null };
          }
          const visible = activePicker && latestMap?.regions.some((region) => region.kind === 'picker' && region.id === activePicker.id);
          if (!activePicker || !visible || activePicker.token !== event.pickerToken) throw failure('Picker token is invalid or capability expired');
          const current = activePicker;
          activePicker = null;
          try {
            await pickerAction(pickerApply(event.pickerToken, Object.hasOwn(event, 'indices') ? { indices: event.indices } : { color: event.color }));
          } finally { await collect().catch(() => {}); }
          if (current.document !== documentId) throw failure('Picker document changed');
          return { picker: null };
        }
        if (event.kind === 'edit') {
          const focus = await collect();
          if (!focus || focus.token !== event.focusToken) throw failure('Focused field changed; tap the field again');
          if (event.operation === 'insert') await cdp.send('Input.insertText', { text: event.text });
          else await key(event.operation === 'key' ? event.key : { backspace: 'Backspace', delete: 'Delete', enter: 'Enter' }[event.operation]);
          return { focus: await collect() };
        }
        if (event.kind === 'pointer') {
          const point = pointOf(event);
          if (event.phase === 'down') {
            if (gesture) throw failure('A gesture is already active');
            if (event.pointerType === 'mouse') await cdp.send('Input.setInterceptDrags', { enabled: true });
            gesture = { id: event.gesture, pointerType: event.pointerType, point };
          } else if (!gesture || gesture.id !== event.gesture || gesture.pointerType !== event.pointerType) throw failure('Gesture is no longer active');
          gesture.point = point;
          if (event.phase === 'cancel') { await cancelGesture(); return { focus: await collect() }; }
          try {
            if (event.pointerType === 'touch') {
              await cdp.send('Input.dispatchTouchEvent', { type: { down: 'touchStart', move: 'touchMove', up: 'touchEnd' }[event.phase], touchPoints: event.phase === 'up' ? [] : [{ ...point, id: 1 }] });
            } else if (event.phase === 'down') {
              await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 0 });
            } else if (event.phase === 'move') {
              await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'left', buttons: 1 });
              if (dragData) { await cdp.send('Input.dispatchDragEvent', { type: dragEntered ? 'dragOver' : 'dragEnter', ...point, data: dragData }); dragEntered = true; }
            } else {
              if (dragData) {
                await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...point, data: dragData });
                await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...point, data: dragData });
              }
              await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 0 });
              await disableDrag();
            }
          } catch (error) {
            if (event.phase === 'down' && error.definitive) { gesture = null; if (event.pointerType === 'mouse') await disableDrag(); }
            throw error;
          }
          if (event.phase === 'up') { gesture = null; return { focus: await collect() }; }
          return {};
        }
        if (event.kind === 'text') { await cdp.send('Input.insertText', { text: event.text }); return; }
        if (event.kind === 'key') {
          await key(event.key); return { focus: await collect() };
        }
        const point = pointOf(event);
        if (event.kind === 'scroll') {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: event.deltaX, deltaY: event.deltaY });
        } else {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
          try { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }); }
          catch { cdp.close(); throw new Error('Browser input sequence incomplete'); }
          return { focus: await collect() };
        }
      },
      cancelGesture,
      revokeKeyboard() { keyboard.revoke(); },
      cancelPicker() {
        // Revoke server-side authority before the optional isolated-world cleanup
        // starts, so a delayed cleanup can never revive or race an apply.
        const current = activePicker; activePicker = null;
        if (!current || closed || !contextId) return Promise.resolve();
        return pickerAction(pickerCancel(current.token)).catch(() => {}).then(() => collect().catch(() => {}));
      },
      async close() {
        keyboard.revoke();
        if (closed) return;
        clearInterval(metadataTimer);
        if (activePicker && contextId) {
          const token = activePicker.token; activePicker = null;
          try { await pickerAction(pickerCancel(token)); } catch {}
        }
        try { await cancelGesture(); }
        finally {
          // A failed input cancellation must still detach this capture. Its
          // rejection remains visible so the caller preserves the poisoned gate.
          try { await cdp.send('Page.stopScreencast'); } catch {}
          finish();
        }
      },
    };
  }
}
