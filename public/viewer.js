import { EditingBridge, NativeKeyboardBridge, TextComposer } from '/assets/editing.js';
import { NativePickerUI } from '/assets/picker.js';
const $ = (id) => document.getElementById(id);
const base = location.pathname.replace(/\/$/, '');
let invite = new URLSearchParams(location.hash.slice(1)).get('invite');
history.replaceState(null, '', location.pathname);
let socket, state, connectionId, captureConnectionId, ended = false, rendering = false, frameSeen = false, reconnectTimer, connectionTimer, poll, latestInputTiming, recoveryRequired = false, bootstrapController;
let connectionGeneration = 0, statePollInFlight = false;
let closeStream = () => { try { socket?.close(); } catch {} };
let inputQueue = [], inputWindow = 1, sequence = 0, intentSequence = 0, zoom = 1, gestureSequence = 0, pickerIntent = null;
const inputPending = new Map();
let interactions = null, interactionsAt = 0, dragOnce = false, remoteGesture = null, down, pinch, ignoreSingle = false;
const pointers = new Map(), canvas = $('screen'), ctx = canvas.getContext('2d'), viewport = document.querySelector('.viewport');
const proxies = [$('text'), $('passwordProxy'), $('multilineProxy')];
const sentinel = '\u200b';
const stateTimeoutMs = 10_000, startupTimeoutMs = 12_000, closeGraceMs = 2_000, startupRetryMs = 1_000;
const definitiveStateStatuses = new Set([401, 403, 404, 410]);
const recoveryStatus = 'Browser stopped responding to input. Control is paused until the browser is reset. Ask for a new link.';
function latchRecovery(value) { if (value?.recoveryRequired === true) recoveryRequired = true; }
function status(message, error = false) {
  if (recoveryRequired && !ended) { message = recoveryStatus; error = true; }
  if ($('status').textContent !== message) $('status').textContent = message;
  $('status').classList.toggle('error', error);
}
function wipeProxies() { for (const proxy of proxies) { proxy.value = ''; proxy.blur(); } }
const bridge = new EditingBridge({ emit: (event) => input(event), reject: (message) => { composer.clear(); wipeProxies(); status(message, true); } });
const nativeBridge = new NativeKeyboardBridge({ emit: (event) => input(event), reject: (message) => { composer.clear(); wipeProxies(); status(message, true); } });
const typingBridge = () => nativeBridge.active ? nativeBridge : bridge;
const composer = new TextComposer((operation, text) => typingBridge().edit(operation, text), (message) => status(message, true));
function clearTyping() { bridge.clear(); nativeBridge.clear(); composer.clear(); wipeProxies(); }
const pickerUI = new NativePickerUI({
  onApply(choice) {
    const descriptor = pickerUI.active;
    if (!descriptor) return;
    const localId = input({ kind: 'pickerApply', pickerToken: descriptor.token, ...choice });
    if (localId) pickerIntent = { localId, action: 'apply', token: descriptor.token };
    else clearPicker();
  },
  onCancel() { clearPicker(true); },
});
function clearPicker(notify = false) {
  const token = pickerUI.active?.token;
  pickerIntent = null; pickerUI.close();
  if (notify && token) input({ kind: 'pickerCancel', pickerToken: token });
}
function openPicker(region) {
  clearTyping(); clearPicker();
  const localId = input({ kind: 'pickerOpen', document: region.document, regionId: region.id });
  if (localId) pickerIntent = { localId, action: 'open', region };
}
function confirmPicker(localId, descriptor) {
  if (!pickerIntent || pickerIntent.localId !== localId || state?.mode !== 'control') return;
  const intent = pickerIntent; pickerIntent = null;
  if (intent.action === 'apply') { if (pickerUI.active?.token === intent.token) pickerUI.close(); return; }
  if (!descriptor || descriptor.id !== intent.region.id || descriptor.document !== intent.region.document || descriptor.kind !== intent.region.pickerType) {
    failInput('The picker changed before it could open. Reconnecting…'); return;
  }
  pickerUI.show(descriptor);
}
function resetProxy(proxy) { if (!composer.composing) { proxy.value = sentinel; try { proxy.setSelectionRange(1, 1); } catch {} } }
function beginTyping(field, confirmationId) {
  if (!confirmationId || state?.mode !== 'control') return;
  clearTyping(); bridge.start(field, confirmationId);
  const proxy = field.password ? $('passwordProxy') : field.multiline ? $('multilineProxy') : $('text');
  proxy.inputMode = field.inputMode || 'text'; resetProxy(proxy);
  // Must stay synchronous in the trusted tap handler for mobile Safari.
  proxy.focus({ preventScroll: true });
}
for (const proxy of proxies) {
  proxy.addEventListener('beforeinput', (event) => {
    // Gboard can move the caret back to zero after an input callback. Restore
    // the local sentinel before the next deletion so it produces one input.
    if (event.inputType === 'deleteContentBackward' && !event.isComposing) resetProxy(proxy);
    if (composer.beforeInput(event)) resetProxy(proxy);
  });
  proxy.addEventListener('input', (event) => { if (composer.input(event, proxy.value)) resetProxy(proxy); });
  proxy.addEventListener('compositionstart', () => composer.compositionStart());
  proxy.addEventListener('compositionend', (event) => { composer.compositionEnd(event.data); resetProxy(proxy); });
  proxy.addEventListener('paste', (event) => {
    if (composer.composing) return;
    const text = event.clipboardData?.getData('text/plain');
    if (typeof text === 'string') { event.preventDefault(); typingBridge().edit('insert', text); resetProxy(proxy); }
  });
  proxy.addEventListener('keydown', (event) => {
    if (event.isComposing || composer.composing) return;
    if (event.key === 'Enter') { event.preventDefault(); typingBridge().edit('enter'); }
    else if (['Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); typingBridge().key(event.key);
    }
  });
}
function syncViewport() {
  const visible = window.visualViewport;
  document.documentElement.style.setProperty('--visible-height', `${visible?.height || innerHeight}px`);
  document.documentElement.style.setProperty('--keyboard-inset', Math.max(0, innerHeight - (visible?.height || innerHeight) - (visible?.offsetTop || 0)) + 'px');
}
window.visualViewport?.addEventListener('resize', syncViewport);
window.visualViewport?.addEventListener('scroll', syncViewport);
window.addEventListener('resize', syncViewport); syncViewport();
function zoomTo(value, anchor = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }) {
  const previous = zoom;
  zoom = Math.max(1, Math.min(4, value));
  const x = (viewport.scrollLeft + anchor.x) / previous, y = (viewport.scrollTop + anchor.y) / previous;
  canvas.style.width = (zoom * 100) + '%';
  viewport.scrollLeft = x * zoom - anchor.x; viewport.scrollTop = y * zoom - anchor.y;
  $('zoomReset').textContent = zoom === 1 ? 'Fit width' : Math.round(zoom * 100) + '% · reset';
}
$('zoomIn').onclick = () => zoomTo(zoom * 1.25);
$('zoomOut').onclick = () => zoomTo(zoom / 1.25);
$('zoomReset').onclick = () => { zoomTo(1, { x: 0, y: 0 }); viewport.scrollTo(0, 0); };
function setPanelOpen(open) {
  $('panel').hidden = !open; $('menu').setAttribute('aria-expanded', String(open));
}
$('menu').onclick = () => setPanelOpen($('panel').hidden);
document.addEventListener('pointerdown', (event) => {
  if ($('panel').hidden) return;
  const path = event.composedPath();
  if (!path.includes($('panel')) && !path.includes($('menu'))) setPanelOpen(false);
}, { capture: true });
$('dragMode').onclick = () => { dragOnce = !dragOnce; $('dragMode').setAttribute('aria-pressed', String(dragOnce)); $('dragMode').textContent = dragOnce ? 'Drag enabled for next gesture' : 'Drag once'; };
$('keyboardButton').onclick = () => {
  if (!interactions?.document || performance.now() - interactionsAt > 1500) { status('Tap a visible text field first.', true); return; }
  if (interactions.focus) {
    const id = input({ kind: 'focus' }); beginTyping(interactions.focus, id); return;
  }
  // Only this explicit Keyboard action can request native typing for an opaque
  // frame. A tap/focus-null metadata snapshot never activates this capability.
  clearTyping(); clearPicker();
  const id = input({ kind: 'nativeKeyboardOpen', document: interactions.document });
  if (!id) return;
  nativeBridge.start({ document: interactions.document }, id);
  const proxy = $('text'); proxy.inputMode = 'text'; resetProxy(proxy); proxy.focus({ preventScroll: true });
};
$('fullscreen').hidden = !document.fullscreenEnabled;
$('fullscreen').onclick = async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
  catch { status('Full screen is unavailable here. The view fills the available area.', true); }
};
async function request(action, data = {}) {
  const response = await fetch(`${base}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(15_000) });
  const result = await response.json();
  if (!response.ok) {
    latchRecovery(result); if (result.recoveryRequired === true) update();
    const error = new Error(result.error || 'Request failed'); error.recoveryRequired = result.recoveryRequired === true; throw error;
  }
  return result;
}
async function readState() {
  const response = await fetch(base + '/state', { signal: AbortSignal.timeout(stateTimeoutMs) });
  if (response.ok) return { value: await response.json() };
  if (definitiveStateStatuses.has(response.status)) return { ended: true };
  return { transient: true };
}
async function readDuringStartup(url, options, parentSignal, timeoutMs = stateTimeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abort(); else parentSignal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return { response, value: response.ok ? await response.json() : undefined };
  }
  finally { clearTimeout(timer); parentSignal.removeEventListener('abort', abort); }
}
function startupPause(signal) {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, startupRetryMs);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}
function clearInputs() {
  inputQueue = [];
  for (const pending of inputPending.values()) clearTimeout(pending.timer);
  inputPending.clear(); clearPicker();
}
function clearGestures() { pointers.clear(); remoteGesture = down = pinch = null; ignoreSingle = false; }
function update(next = state) {
  latchRecovery(next);
  if (next?.version < (state?.version ?? -1)) { if (recoveryRequired) update(state); return; }
  if (state?.controlId !== next?.controlId) { clearInputs(); clearTyping(); clearGestures(); }
  state = next;
  const streamReady = Boolean(connectionId) && socket?.readyState === WebSocket.OPEN;
  const control = !recoveryRequired && next?.mode === 'control' && streamReady;
  if (!control) { clearInputs(); clearTyping(); clearGestures(); }
  for (const proxy of proxies) proxy.disabled = !control;
  $('keyboard').hidden = $('keyboardButton').hidden = $('release').hidden = !control;
  $('control').hidden = control;
  $('control').disabled = recoveryRequired || !streamReady || !frameSeen || !interactions || next?.mode !== 'watch' || next?.permission !== 'control';
  $('control').textContent = recoveryRequired ? 'Recovery required' : next?.permission === 'watch' ? 'Watch-only link' : 'Take control';
  $('badge').textContent = recoveryRequired ? 'RECOVERY REQUIRED' : control ? 'YOU HAVE CONTROL' : 'WATCH MODE';
  canvas.style.cursor = control ? 'crosshair' : 'default';
  if (next?.mode === 'pending') status('Waiting for the agent’s current browser action…');
  else if (control) status('You have control. Tap fields to type; swipe or drag to interact.');
  else if (socket?.readyState === WebSocket.OPEN) status('Watching. Take control to interact.');
}
function finish(message) {
  if (ended) return;
  if (recoveryRequired) {
    $('endTitle').textContent = 'Access ended.';
    message = 'Your access has ended. Browser recovery is still required before the agent can continue. Ask for a new link.';
  }
  ended = true; bootstrapController?.abort(); bootstrapController = null; connectionGeneration++; clearInterval(poll); clearTimeout(reconnectTimer); clearTimeout(connectionTimer); clearInputs(); clearTyping(); clearGestures();
  canvas.width = canvas.height = 1;
  $('viewer').hidden = true; $('finished').hidden = false;
  document.body.classList.remove('viewer-active'); $('endMessage').textContent = message;
  socket?.close(); status('Access ended.');
}
function metadata(msg) {
  if (msg.title) $('title').textContent = msg.title;
  if (msg.url) $('url').textContent = msg.url;
  if (msg.interactions) {
    interactions = msg.interactions; interactionsAt = performance.now();
    bridge.observe(interactions); nativeBridge.observe(interactions);
    if (pickerUI.active && (pickerUI.active.document !== interactions.document || pickerUI.active.token !== interactions.pickerFocus?.token)) clearPicker();
    update();
  }
}
function acknowledgeDisplay(ws, msg, decodeMs = 0) {
  if (ws !== socket || ended || ws.readyState !== WebSocket.OPEN || !Number.isSafeInteger(msg.displayId)) return;
  ws.send(JSON.stringify({ type: 'displayAck', connectionId: msg.connectionId, displayId: msg.displayId, decodeMs,
    visibility: document.visibilityState, ...(latestInputTiming ? { inputTiming: latestInputTiming } : {}) }));
}
function reconnectLater() {
  clearTimeout(reconnectTimer);
  const generation = connectionGeneration;
  reconnectTimer = setTimeout(async () => {
    if (ended || generation !== connectionGeneration || state?.mode !== 'watch') return;
    let result;
    try { result = await readState(); } catch {}
    if (ended || generation !== connectionGeneration) return;
    if (result?.ended) { finish('Your viewer session has ended.'); return; }
    if (result?.value) update(result.value);
    if (!ended && generation === connectionGeneration && state?.mode === 'watch') connect();
  }, 1500);
}
function connect() {
  if (ended || state?.mode !== 'watch') return;
  clearTimeout(connectionTimer);
  const generation = ++connectionGeneration;
  frameSeen = rendering = false; connectionId = captureConnectionId = null; sequence = intentSequence = 0; inputWindow = 1; interactions = latestInputTiming = null;
  let ws;
  try { ws = socket = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + base + '/stream'); }
  catch {
    socket = null; connectionGeneration++; status('Unable to connect to the browser stream. Retrying…', true); reconnectLater(); return;
  }
  let readySeen = false, closing = false;
  const current = () => !ended && generation === connectionGeneration && ws === socket;
  const retire = (code) => {
    if (!current()) return;
    clearTimeout(connectionTimer); connectionGeneration++;
    clearInputs(); clearTyping(); clearGestures(); interactions = null; frameSeen = false; connectionId = captureConnectionId = null;
    update({ ...state, mode: 'watch', controlId: undefined });
    if (code === 4001) { finish('This invitation expired, was revoked, or was finished.'); return; }
    if (code === 4002) { finish('The selected browser tab is no longer available.'); return; }
    status('Connection interrupted. Reconnecting in watch mode…', true);
    reconnectLater();
  };
  const beginClose = (message) => {
    if (!current() || closing) return;
    closing = true;
    if (message) status(message, true);
    try { ws.close(); } catch {}
    if (current()) { clearTimeout(connectionTimer); connectionTimer = setTimeout(() => retire(), closeGraceMs); }
  };
  closeStream = beginClose;
  const armStartupDeadline = (message) => {
    clearTimeout(connectionTimer);
    connectionTimer = setTimeout(() => {
      if (!current()) return;
      beginClose(message);
    }, startupTimeoutMs);
  };
  armStartupDeadline('Browser stream did not become ready. Reconnecting…');
  ws.onmessage = ({ data }) => {
    if (!current() || closing) return;
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (['ready', 'metadata', 'frame'].includes(msg.type) && /^[a-f0-9]{32}$/.test(msg.connectionId || ''))
      captureConnectionId = msg.connectionId;
    if (msg.type === 'ready') {
      connectionId = msg.connectionId; inputWindow = Number.isSafeInteger(msg.inputWindow) ? Math.max(1, Math.min(4, msg.inputWindow)) : 1; update(msg);
      if (!readySeen) {
        readySeen = true;
        if (frameSeen) clearTimeout(connectionTimer);
        else armStartupDeadline('The browser image did not arrive. Reconnecting…');
      }
    }
    if (msg.type === 'metadata') { metadata(msg); acknowledgeDisplay(ws, msg); }
    if (msg.type === 'error') { failInput(msg.error || 'Browser input failed. Reconnecting…', msg.recoveryRequired === true); return; }
    if (msg.type === 'inputAck') {
      const acknowledged = inputPending.get(msg.id);
      const matching = acknowledged && msg.connectionId === acknowledged.connectionId && msg.controlId === acknowledged.controlId;
      if (matching) {
        inputPending.delete(msg.id); clearTimeout(acknowledged.timer);
        if (!latestInputTiming || acknowledged.id > latestInputTiming.id)
          latestInputTiming = { id: acknowledged.id, queueMs: acknowledged.queueMs, roundTripMs: performance.now() - acknowledged.sentAt };
        if (Object.hasOwn(msg, 'focus')) bridge.confirm(acknowledged.localId, msg.focus);
        if (Object.hasOwn(msg, 'keyboard')) {
          if (msg.keyboard) nativeBridge.confirm(acknowledged.localId, msg.keyboard);
          else if (nativeBridge.active) clearTyping();
        }
        if (Object.hasOwn(msg, 'picker')) confirmPicker(acknowledged.localId, msg.picker);
        flushInputs();
      }
    }
    if (msg.type === 'frame' && !rendering) {
      // Apply metadata in wire order, before asynchronous image decoding can
      // let a later focus acknowledgement overtake this snapshot.
      if (msg.metadata) metadata(msg.metadata);
      rendering = true; const image = new Image(), decodeStarted = performance.now();
      image.onload = () => {
        if (!current() || closing) return;
        rendering = false;
        if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) { canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; }
        ctx.drawImage(image, 0, 0); $('loading').hidden = true; frameSeen = true; if (readySeen) clearTimeout(connectionTimer); update();
        acknowledgeDisplay(ws, msg, performance.now() - decodeStarted);
      };
      image.onerror = () => {
        if (!current() || closing) return;
        rendering = false; beginClose('Unable to display the browser image. Reconnecting…');
      };
      image.src = `data:image/jpeg;base64,${msg.data}`;
    }
  };
  ws.onclose = ({ code }) => retire(code);
  ws.onerror = () => beginClose('Unable to connect to the browser stream. Reconnecting…');
}
async function pollState() {
  if (ended || statePollInFlight) return;
  statePollInFlight = true;
  const generation = connectionGeneration, observedSocket = socket;
  try {
    const result = await readState();
    if (ended || generation !== connectionGeneration || observedSocket !== socket) return;
    if (result.ended) { finish('Your viewer session has ended.'); return; }
    if (result.value) {
      update(result.value);
      if (!ended && state?.mode === 'watch' && (!socket || socket.readyState === WebSocket.CLOSED)) connect();
    }
  } catch {}
  finally { statePollInFlight = false; }
}
async function start() {
  connect();
  poll = setInterval(pollState, 2000);
}
async function openViewer() {
  const controller = bootstrapController = new AbortController();
  let claimAttempted = false, nextState;
  while (!ended && bootstrapController === controller && !controller.signal.aborted) {
    let result;
    try { result = await readDuringStartup(base + '/state', {}, controller.signal); }
    catch {
      if (controller.signal.aborted) return;
      status('Browser connection is taking longer than expected. Retrying…', true); await startupPause(controller.signal); continue;
    }
    if (ended || bootstrapController !== controller || controller.signal.aborted) return;
    const { response } = result;
    if (response.ok) { nextState = result.value; break; }
    if (response.status === 401 && invite && !claimAttempted) {
      claimAttempted = true;
      try {
        const claimed = await readDuringStartup(base + '/claim', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invite }),
        }, controller.signal, 15_000);
        if (ended || bootstrapController !== controller || controller.signal.aborted) return;
        if (claimed.response.ok) { nextState = claimed.value; break; }
        else if (definitiveStateStatuses.has(claimed.response.status)) {
          $('endTitle').textContent = 'Unable to open browser view.';
          finish('This invitation is missing, expired, or claimed elsewhere. Ask for a new link.'); return;
        }
      } catch { if (controller.signal.aborted) return; }
      status('Confirming the browser invitation. Retrying safely…', true); await startupPause(controller.signal); continue;
    }
    if (definitiveStateStatuses.has(response.status)) {
      $('endTitle').textContent = 'Unable to open browser view.';
      finish('This invitation is missing, expired, or claimed elsewhere. Ask for a new link.'); return;
    }
    status('Browser view is temporarily unavailable. Retrying…', true); await startupPause(controller.signal);
  }
  if (!nextState || ended || bootstrapController !== controller || controller.signal.aborted) return;
  bootstrapController = null; state = nextState; update(state); invite = null; await start();
}
$('control').onclick = async () => {
  if (recoveryRequired || !connectionId || socket?.readyState !== WebSocket.OPEN || !frameSeen || state?.mode !== 'watch') return;
  $('control').disabled = true; status('Requesting control…');
  try { update(await request('control')); } catch (error) { update(); status(error.message, true); }
};
$('release').onclick = async () => {
  clearInputs(); clearTyping(); clearGestures();
  try { update(await request('release')); } catch (error) { status(error.message, true); }
};
$('done').onclick = async () => {
  clearInputs(); clearTyping(); clearGestures();
  if (bootstrapController) {
    $('endTitle').textContent = 'Access ended.';
    finish('Browser connection was cancelled.'); return;
  }
  try {
    await request('done');
    finish('You’re done. Control has been handed back to the agent.');
  } catch (error) { status(error.message, true); }
};
function failInput(message, requiresRecovery = false) {
  if (requiresRecovery) { recoveryRequired = true; update(); }
  clearInputs(); clearTyping(); clearGestures(); status(message, true); closeStream();
}
function batchableEdit(event) {
  return event?.kind === 'edit' && ['insert', 'backspace', 'delete'].includes(event.operation) &&
    (event.operation !== 'insert' || event.text.length <= 256);
}
function flushInputs() {
  while (inputPending.size < inputWindow && inputQueue.length && !ended && !recoveryRequired && state?.mode === 'control' && socket?.readyState === WebSocket.OPEN && connectionId) {
    const item = inputQueue.shift(), event = item.event;
    if (event.kind === 'scroll') {
      const deltaX = Math.max(-2000, Math.min(2000, event.deltaX)), deltaY = Math.max(-2000, Math.min(2000, event.deltaY));
      if (deltaX !== event.deltaX || deltaY !== event.deltaY) inputQueue.unshift({ localId: ++intentSequence, queuedAt: item.queuedAt, event: { ...event, deltaX: event.deltaX - deltaX, deltaY: event.deltaY - deltaY } });
      event.deltaX = deltaX; event.deltaY = deltaY;
    }
    const events = [event];
    if (batchableEdit(event)) {
      while (events.length < 8 && batchableEdit(inputQueue[0]?.event) && inputQueue[0].event.focusToken === event.focusToken)
        events.push(inputQueue.shift().event);
    }
    const sentAt = performance.now();
    const pending = { id: ++sequence, localId: item.localId, connectionId, controlId: state.controlId, sentAt, queueMs: sentAt - item.queuedAt };
    inputPending.set(pending.id, pending);
    pending.timer = setTimeout(() => { if (inputPending.get(pending.id) === pending) failInput('Browser input was not acknowledged. Reconnecting without control…'); }, 12000);
    try { socket.send(JSON.stringify({ type: 'input', id: pending.id, connectionId, controlId: state.controlId, ...(events.length > 1 ? { events } : { event }) })); }
    catch { failInput('Connection interrupted while sending input. Reconnecting…'); return; }
  }
}
function input(event, preserveMove = false) {
  if (ended || recoveryRequired || state?.mode !== 'control' || socket?.readyState !== WebSocket.OPEN) return null;
  const previous = inputQueue.at(-1);
  if (event.kind === 'scroll' && previous?.event.kind === 'scroll') {
    previous.event.x = event.x; previous.event.y = event.y;
    previous.event.deltaX = Math.max(-1000000, Math.min(1000000, previous.event.deltaX + event.deltaX));
    previous.event.deltaY = Math.max(-1000000, Math.min(1000000, previous.event.deltaY + event.deltaY)); return previous.localId;
  }
  if (event.kind === 'pointer' && event.phase === 'move' && previous?.event.kind === 'pointer' && previous.event.phase === 'move' && previous.event.gesture === event.gesture && !previous.preserveMove) {
    previous.event = { ...event }; return previous.localId;
  }
  if (inputQueue.length >= 32) { failInput('Too much input is waiting. Reconnecting safely; please try again.'); return null; }
  const item = { localId: ++intentSequence, queuedAt: performance.now(), event: { ...event }, preserveMove }; inputQueue.push(item); flushInputs(); return item.localId;
}
for (const button of document.querySelectorAll('[data-key]')) button.onclick = () => input({ kind: 'key', key: button.dataset.key });
function point(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
}
function regionAt(point, kind) {
  if (!interactions || performance.now() - interactionsAt > 1500) return null;
  const candidates = interactions.regions.filter((r) => r.kind === kind && point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height);
  const region = candidates.sort((a, b) => a.width * a.height - b.width * b.height)[0];
  return region ? { ...region, document: interactions.document } : null;
}
function cancelRemote() {
  if (remoteGesture?.sent) input({ kind: 'pointer', phase: 'cancel', pointerType: remoteGesture.type, gesture: remoteGesture.id, ...remoteGesture.point });
  remoteGesture = null; down = null; clearTyping();
}
function pinchMetrics() { const [a, b] = [...pointers.values()]; return { distance: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)), x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }; }
canvas.onpointerdown = (event) => {
  if (!frameSeen) return;
  // Suppress compatibility mousedown: it runs after touch pointerup and would
  // otherwise blur the keyboard proxy focused synchronously by that tap.
  event.preventDefault();
  const location = point(event); clearTyping(); clearPicker();
  canvas.setPointerCapture(event.pointerId); pointers.set(event.pointerId, event);
  if (pointers.size >= 2) { cancelRemote(); ignoreSingle = true; if (pointers.size === 2) pinch = { ...pinchMetrics(), zoom }; return; }
  if (ignoreSingle) return;
  down = { pointerId: event.pointerId, start: event, previous: event, moved: false, moves: 0, field: regionAt(location, 'editable'), picker: regionAt(location, 'picker') };
  if (state?.mode === 'control') {
    const type = event.pointerType === 'touch' && !dragOnce && !regionAt(location, 'drag') ? 'touch' : 'mouse';
    // A tap uses the reliable atomic click path. Native touch contact starts
    // only after movement proves a swipe/drag; hidden Chrome can stall touchStart.
    remoteGesture = { id: ++gestureSequence, type, start: location, point: location, sent: false };
  }
};
canvas.onpointermove = (event) => {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, event);
  if (pointers.size >= 2 && pinch) {
    const next = pinchMetrics(); zoomTo(pinch.zoom * next.distance / pinch.distance, { x: pinch.x, y: pinch.y });
    viewport.scrollLeft -= next.x - pinch.x; viewport.scrollTop -= next.y - pinch.y; pinch = { ...next, zoom }; return;
  }
  if (!down || ignoreSingle) return;
  // Desktop images magnify small finger movements when fitted to a phone.
  // Keep ordinary touch drift local until it clearly becomes a swipe or drag.
  const tapSlop = down.start.pointerType === 'touch' ? 10 : 6;
  if (Math.hypot(event.clientX - down.start.clientX, event.clientY - down.start.clientY) > tapSlop) down.moved = true;
  if (down.moved) {
    if (remoteGesture) {
      if (!remoteGesture.sent) {
        remoteGesture.sent = true;
        if (!input({ kind: 'pointer', phase: 'down', pointerType: remoteGesture.type, gesture: remoteGesture.id, ...remoteGesture.start })) return;
      }
      remoteGesture.point = point(event);
      input({ kind: 'pointer', phase: 'move', pointerType: remoteGesture.type, gesture: remoteGesture.id, ...remoteGesture.point }, down.moves++ === 0);
    } else { viewport.scrollLeft += down.previous.clientX - event.clientX; viewport.scrollTop += down.previous.clientY - event.clientY; }
  }
  down.previous = event;
};
canvas.onpointerup = (event) => {
  const location = point(event), field = down && !down.moved ? down.field : null, picker = down && !down.moved ? down.picker : null;
  if (remoteGesture && !ignoreSingle && pointers.size === 1) {
    const id = picker && !remoteGesture.sent ? null : remoteGesture.sent
      ? input({ kind: 'pointer', phase: 'up', pointerType: remoteGesture.type, gesture: remoteGesture.id, ...location })
      : input({ kind: 'click', ...remoteGesture.start });
    remoteGesture = null;
    if (picker && !id) openPicker(picker);
    else if (field) beginTyping(field, id);
    dragOnce = false; $('dragMode').setAttribute('aria-pressed', 'false'); $('dragMode').textContent = 'Drag once';
  }
  pointers.delete(event.pointerId); down = null;
  if (pointers.size < 2) pinch = null;
  if (!pointers.size) ignoreSingle = false;
};
canvas.onpointercancel = (event) => { cancelRemote(); pointers.delete(event.pointerId); pinch = null; if (!pointers.size) ignoreSingle = false; };
canvas.addEventListener('lostpointercapture', () => { if (remoteGesture) cancelRemote(); });
canvas.addEventListener('wheel', (event) => {
  if (state?.mode !== 'control') return;
  event.preventDefault(); clearTyping(); clearPicker();
  input({ kind: 'scroll', ...point(event), deltaX: Math.max(-2000, Math.min(2000, event.deltaX)), deltaY: Math.max(-2000, Math.min(2000, event.deltaY)) });
}, { passive: false });
function suspend() {
  cancelRemote(); clearTyping();
  // A phone's native chooser may temporarily obscure the page. Keep an open
  // picker; its eventual commit still revalidates control, focus and the token.
  if (pickerIntent?.action === 'open') pickerIntent = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) suspend();
  if (!ended && captureConnectionId && socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ type: 'captureVisibility', connectionId: captureConnectionId, visibility: document.visibilityState }));
});
window.addEventListener('pagehide', () => { suspend(); socket?.close(); });
setInterval(() => { if (state && !ended) $('expiry').textContent = Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1000)) + 's remaining'; }, 1000);
void openViewer();
