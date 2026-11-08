const screen = document.getElementById('screen');
const control = document.getElementById('control');
const done = document.getElementById('done');
const status = document.getElementById('status');
const mode = document.getElementById('mode');
const base = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
const requestTimeoutMs = 12_000;
const assetTimeoutMs = 12_000;
const connectTimeoutMs = 12_000;
const promotionDisconnectMs = 3_000;
const reconnectDelayMs = 5_000;
const accessGone = new Set([401, 403, 404, 410]);
let invite = new URLSearchParams(location.hash.slice(1)).get('invite');
let RFB;
let activeConnection;
let accessEnded = false;
let promoting = false;
let cleanupVerified = false;
let cleanupInFlight;
let failureTask;
let controlReady = false;
let reconnecting = false;
let expiresAt = 0;
let remoteClipboard = '';
const viewport = document.getElementById('viewport');
const stage = document.getElementById('stage');
const toolbar = document.getElementById('toolbar');
const keyboardInput = document.getElementById('keyboard-input');
let zoomMode = 'fit';
let displayScale = 1;

history.replaceState(null, '', location.pathname);

function withDeadline(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function post(action, data = {}) {
  const signal = AbortSignal.timeout(action === 'control' ? 30_000 : requestTimeoutMs);
  let response;
  try {
    response = await fetch(`${base}${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal,
    });
  } catch {
    if (signal.aborted) throw new Error(`${action} request timed out`);
    throw new Error(`${action} request failed`);
  }
  let body;
  try { body = await withDeadline(response.json(), requestTimeoutMs, `${action} response timed out`); }
  catch { throw new Error(action + ' response could not be read'); }
  if (!response.ok) {
    throw Object.assign(new Error(body.mode === 'cleanup_failed'
      ? 'Cleanup could not be verified. Access remains disabled.'
      : body.error || 'The disposable session ended'), { status: response.status });
  }
  return body;
}

async function watchCredentials(retryNetwork) {
  for (;;) {
    try { return await post('credentials'); }
    catch (error) {
      if (accessEnded || accessGone.has(error.status) || (!error.status && (!retryNetwork || Date.now() >= expiresAt))) throw error;
    }
    status.textContent = 'Reconnecting in watch mode…';
    await new Promise(resolve => setTimeout(resolve, reconnectDelayMs));
    if (accessEnded) throw new Error('Viewer access has ended');
  }
}

async function reconnectWatch() {
  if (reconnecting || accessEnded) return;
  reconnecting = true;
  status.textContent = 'Connection interrupted. Reconnecting in watch mode…';
  mode.textContent = 'Private watch session';
  try {
    for (;;) {
      const config = await watchCredentials(true);
      if (accessEnded) return;
      try { await openConnection(config).ready; return; }
      catch (error) { if (accessEnded || Date.now() >= expiresAt) throw error; }
      await new Promise(resolve => setTimeout(resolve, reconnectDelayMs));
    }
  } catch (error) {
    if (!accessEnded) await failAndCleanup(accessGone.has(error.status) ? 'Viewer access ended.' : error.message);
  } finally { reconnecting = false; }
}

function streamUrl(generation) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return protocol + '//' + location.host + base + 'stream/' + generation;
}

function openConnection(config) {
  if (accessEnded) throw new Error('Viewer access has ended');
  if (config.expiresAt) expiresAt = config.expiresAt;
  status.textContent = config.mode === 'watch' ? 'Connecting in watch mode…' : 'Connecting with control…';
  const instance = new RFB(screen, streamUrl(config.generation), { credentials: { password: config.password } });
  instance.scaleViewport = true;
  instance.background = '#080d13';
  instance.resizeSession = false;
  instance.viewOnly = config.mode === 'watch';
  instance.focusOnClick = config.mode !== 'watch';
  let connected = false;
  let readyResolve, readyReject, disconnectedResolve;
  const readyEvent = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const connection = {
    instance,
    capabilities: config.capabilities || {},
    retiring: false,
    disconnected: new Promise((resolve) => { disconnectedResolve = resolve; }),
  };
  instance.addEventListener('connect', () => {
    if (connection.retiring || accessEnded) return;
    connected = true;
    status.textContent = config.mode === 'watch' ? 'Watching. Take control to interact.' : 'Control connected.';
    mode.textContent = config.mode === 'watch' ? 'Private watch session' : 'Private control session';
    control.disabled = config.mode !== 'watch' || config.permission === 'watch';
    controlReady = config.mode !== 'watch';
    updateInputControls();
    updateDisplay();
    readyResolve();
  }, { once: true });
  instance.addEventListener('clipboard', (event) => {
    if (connection.retiring || accessEnded) return;
    remoteClipboard = event.detail.text;
    document.getElementById('copy').disabled = !controlReady || accessEnded;
    status.textContent = 'Selection ready. Use Copy to copy it to this device.';
  });
  instance.addEventListener('disconnect', () => {
    controlReady = false;
    updateInputControls();
    // Losing control puts Take control and the status line back in reach.
    if (config.mode !== 'watch') showToolbar();
    control.disabled = true;
    disconnectedResolve();
    if (!connected) readyReject(Object.assign(new Error('The VNC connection closed before it became ready'), { closedBeforeReady: true }));
    else if (!connection.retiring && !promoting && !accessEnded) void reconnectWatch();
  }, { once: true });
  connection.ready = withDeadline(readyEvent, connectTimeoutMs, 'The VNC connection did not become ready in time').catch((error) => {
    connection.retiring = true;
    try { instance.disconnect(); } catch {}
    throw error;
  });
  activeConnection = connection;
  return connection;
}

async function requestCleanup(context = 'Viewer access ended.') {
  if (cleanupVerified) return true;
  if (cleanupInFlight) return cleanupInFlight;
  cancelTouchInput();
  accessEnded = true;
  controlReady = false;
  updateInputControls();
  control.disabled = true;
  if (activeConnection) {
    activeConnection.retiring = true;
    activeConnection.instance.viewOnly = true;
  }
  done.disabled = true;
  done.textContent = 'Finishing…';
  showToolbar();
  cleanupInFlight = (async () => {
    try {
      const result = await post('done');
      if (result.mode !== 'ended') throw new Error('Cleanup could not be verified');
      cleanupVerified = true;
      if (activeConnection) activeConnection.retiring = true;
      try { activeConnection?.instance.disconnect(); } catch {}
      const outcome = result.disposition === 'retained'
        ? 'Browser returned to the assistant. You can close this tab.'
        : 'Test browser destroyed. You can close this tab.';
      status.textContent = context === 'Cleanup was requested.' ? outcome : context + ' ' + outcome;
      done.textContent = 'Done';
      return true;
    } catch (error) {
      try { activeConnection?.instance.disconnect(); } catch {}
      status.textContent = ''.concat(context) + ' Cleanup could not be verified: ' + ''.concat(error.message) + '.';
      done.disabled = false;
      done.textContent = 'Retry cleanup';
      return false;
    } finally { cleanupInFlight = undefined; }
  })();
  return cleanupInFlight;
}

// The gateway lets one viewer hold the stream, so a second tab's stream closes before it is ready.
// Credentials that still work with the same generation mean the handoff is live in that other tab,
// and cleaning up here would end it there too.
async function streamHeldElsewhere(config) {
  try {
    if ((await post('credentials')).generation !== config.generation) return false;
  } catch { return false; }
  status.textContent = 'This handoff is already open in another tab or window. Use that one, or close it and reload this page.';
  return true;
}

function failAndCleanup(message) {
  if (failureTask) return failureTask;
  cancelTouchInput();
  accessEnded = true;
  controlReady = false;
  updateInputControls();
  control.disabled = true;
  if (activeConnection) activeConnection.retiring = true;
  status.textContent = `${message} Ending viewer access…`;
  failureTask = requestCleanup(message);
  return failureTask;
}

control.addEventListener('click', async () => {
  if (promoting || accessEnded) return;
  promoting = true;
  control.disabled = true;
  status.textContent = 'Switching to control…';
  const previous = activeConnection;
  if (previous) previous.retiring = true;
  try {
    const config = await post('control');
    await withDeadline(previous.disconnected, promotionDisconnectMs, 'The watch connection did not close for control');
    if (accessEnded) return;
    const next = openConnection({ ...config, mode: 'control' });
    await next.ready;
    // Control is what the owner asked for, so give the whole screen to the browser.
    if (controlReady && !accessEnded && next === activeConnection) collapseToolbar();
  } catch (error) {
    try { previous?.instance.disconnect(); } catch {}
    await failAndCleanup(error.message);
  } finally { promoting = false; }
});

done.addEventListener('click', async () => {
  if (cleanupVerified || cleanupInFlight) return;
  if (activeConnection) activeConnection.retiring = true;
  await requestCleanup('Cleanup was requested.');
});

async function bootstrap() {
  try {
    let claimError;
    if (invite) {
      try { await post('claim', { token: invite }); }
      catch (error) { if (error.status !== 401) throw error; claimError = error; }
      invite = undefined;
    }
    if (accessEnded) return;
    const module = await withDeadline(import('/probe/novnc/novnc/core/rfb.js'), assetTimeoutMs, 'Viewer assets did not load in time');
    if (typeof module.default !== 'function') throw new Error('Viewer assets are invalid');
    RFB = module.default;
    if (accessEnded) return;
    const config = await watchCredentials(false).catch((error) => { throw claimError && error.status === 401 ? claimError : error; });
    if (accessEnded) return;
    const connection = openConnection(config);
    try { await connection.ready; }
    catch (error) { if (error.closedBeforeReady && await streamHeldElsewhere(config)) return; throw error; }
  } catch (error) {
    await failAndCleanup(error.message);
  }
}

void bootstrap();

function updateInputControls() {
  for (const id of ['keyboard', 'paste', 'drag-once']) document.getElementById(id).disabled = !controlReady || accessEnded;
  document.getElementById('copy').disabled = !controlReady || accessEnded;
  if (!controlReady || accessEnded) { cancelTouchInput(); keyboardInput.blur(); }
  updateQuickActions();
}

function framebufferSize() {
  const canvas = screen.querySelector('canvas');
  return canvas?.width && canvas?.height ? { width: canvas.width, height: canvas.height } : null;
}

function fitScale(size) {
  return Math.min(1, viewport.clientWidth / size.width, viewport.clientHeight / size.height);
}

// Only change the mount dimensions. noVNC's autoscale updates both its display
// and framebuffer-coordinate conversion; the canvas is never independently zoomed.
function updateDisplay(anchor) {
  const size = framebufferSize();
  if (!size) return;
  const oldRect = screen.getBoundingClientRect();
  const point = anchor || { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
  const pixel = anchor?.pixel || {
    x: (point.x - oldRect.left) / displayScale,
    y: (point.y - oldRect.top) / displayScale,
  };
  displayScale = zoomMode === 'fit' ? fitScale(size) : Math.max(0.1, Math.min(3, Number(zoomMode)));
  const width = size.width * displayScale, height = size.height * displayScale;
  const stageWidth = Math.max(width, viewport.clientWidth), stageHeight = Math.max(height, viewport.clientHeight);
  const left = (stageWidth - width) / 2, top = (stageHeight - height) / 2;
  stage.style.width = stageWidth + 'px';
  stage.style.height = stageHeight + 'px';
  Object.assign(screen.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
  if (activeConnection) activeConnection.instance.scaleViewport = true;
  viewport.scrollLeft = zoomMode === 'fit' ? 0 : left + pixel.x * displayScale - point.x;
  viewport.scrollTop = zoomMode === 'fit' ? 0 : top + pixel.y * displayScale - point.y;
  const label = document.getElementById('zoom-level');
  label.value = Math.round(displayScale * 100) + '%';
  label.dataset.scale = String(displayScale);
  document.getElementById('zoom-fit').setAttribute('aria-pressed', String(zoomMode === 'fit'));
  document.getElementById('zoom-actual').setAttribute('aria-pressed', String(zoomMode === 1));
}

function zoomTo(scale, anchor) {
  zoomMode = scale;
  updateDisplay(anchor);
}

document.getElementById('zoom-fit').addEventListener('click', () => zoomTo('fit'));
document.getElementById('zoom-actual').addEventListener('click', () => zoomTo(1));
document.getElementById('zoom-in').addEventListener('click', () => zoomTo(displayScale * 1.25));
document.getElementById('zoom-out').addEventListener('click', () => zoomTo(displayScale / 1.25));
new ResizeObserver(() => { updateDisplay(); keepToolbarVisible(); }).observe(viewport);
new MutationObserver(() => updateDisplay()).observe(screen, { childList: true, subtree: true, attributes: true, attributeFilter: ['width', 'height'] });

function toolbarBounds() {
  const visual = window.visualViewport;
  const style = getComputedStyle(document.documentElement);
  const safe = edge => parseFloat(style.getPropertyValue(`--safe-${edge}`)) || 0;
  return { left: (visual?.offsetLeft || 0) + safe('left'), top: (visual?.offsetTop || 0) + safe('top'),
    width: (visual?.width || innerWidth) - safe('left') - safe('right'),
    height: (visual?.height || innerHeight) - safe('top') - safe('bottom') };
}

function moveToolbar(left, top) {
  const bounds = toolbarBounds();
  toolbar.style.left = Math.max(bounds.left + 8, Math.min(left, bounds.left + bounds.width - toolbar.offsetWidth - 8)) + 'px';
  toolbar.style.top = Math.max(bounds.top + 8, Math.min(top, bounds.top + bounds.height - toolbar.offsetHeight - 8)) + 'px';
}

function keepToolbarVisible() {
  if (toolbar.hidden) return;
  const bounds = toolbarBounds();
  toolbar.style.maxHeight = Math.max(100, bounds.height - 16) + 'px';
  const rect = toolbar.getBoundingClientRect();
  moveToolbar(rect.left, rect.top);
}

const handle = document.getElementById('drag-handle');
let toolbarDrag;
handle.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const rect = toolbar.getBoundingClientRect();
  toolbarDrag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
  handle.setPointerCapture(event.pointerId);
  event.preventDefault();
});
handle.addEventListener('pointermove', (event) => {
  if (!toolbarDrag) return;
  moveToolbar(toolbarDrag.left + event.clientX - toolbarDrag.x, toolbarDrag.top + event.clientY - toolbarDrag.y);
});
handle.addEventListener('pointerup', () => { toolbarDrag = undefined; });
handle.addEventListener('pointercancel', () => { toolbarDrag = undefined; });
handle.addEventListener('keydown', (event) => {
  const direction = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
  if (!direction) return;
  event.preventDefault();
  const rect = toolbar.getBoundingClientRect();
  moveToolbar(rect.left + direction[0], rect.top + direction[1]);
});

function collapseToolbar() {
  if (toolbar.hidden) return;
  const restore = document.getElementById('restore');
  const rect = toolbar.getBoundingClientRect();
  restore.style.top = Math.max(8, Math.min(rect.top, innerHeight - 52)) + 'px';
  const right = rect.left + rect.width / 2 > innerWidth / 2;
  restore.style.left = right ? 'auto' : '0';
  restore.style.right = right ? '0' : 'auto';
  restore.style.borderRadius = right ? '12px 0 0 12px' : '0 12px 12px 0';
  toolbar.hidden = true;
  restore.hidden = false;
  restore.focus();
}
function showToolbar() {
  if (!toolbar.hidden) return;
  toolbar.hidden = false;
  document.getElementById('restore').hidden = true;
  keepToolbarVisible();
  hideQuickActions();
}
document.getElementById('collapse').addEventListener('click', collapseToolbar);
document.getElementById('restore').addEventListener('click', () => {
  showToolbar();
  document.getElementById('collapse').focus();
});
window.visualViewport?.addEventListener('resize', () => { keepToolbarVisible(); placeQuickActions(); });
window.visualViewport?.addEventListener('scroll', () => { keepToolbarVisible(); placeQuickActions(); });

function sendChord(keysym, code) {
  if (!controlReady || accessEnded) return;
  const instance = activeConnection.instance;
  instance.sendKey(0xffe3, 'ControlLeft', true);
  instance.sendKey(keysym, code);
  instance.sendKey(0xffe3, 'ControlLeft', false);
}

const clipboardDialog = document.getElementById('clipboard-dialog');
const clipboardText = document.getElementById('clipboard-text');
function keepClipboardVisible() {
  if (!clipboardDialog.open) return;
  // The on-screen keyboard can shrink only visualViewport, leaving the native
  // dialog's layout-viewport centering and CSS viewport units unchanged.
  const bounds = toolbarBounds();
  const compact = bounds.height < 120;
  const gutter = compact ? 4 : 8;
  clipboardDialog.classList.toggle('clipboard-compact', compact);
  const width = Math.max(0, Math.min(440, bounds.width - gutter * 2));
  clipboardDialog.style.width = width + 'px';
  clipboardDialog.style.maxHeight = Math.max(0, bounds.height - gutter * 2) + 'px';
  clipboardDialog.style.left = (bounds.left + (bounds.width - width) / 2) + 'px';
  const height = clipboardDialog.getBoundingClientRect().height;
  clipboardDialog.style.top = (bounds.top + Math.max(gutter, (bounds.height - height) / 2)) + 'px';
  if (document.activeElement === clipboardText) {
    const content = clipboardText.parentElement;
    content.scrollTop += clipboardText.getBoundingClientRect().top - content.getBoundingClientRect().top;
  }
}
window.visualViewport?.addEventListener('resize', keepClipboardVisible);
window.visualViewport?.addEventListener('scroll', keepClipboardVisible);
new ResizeObserver(keepClipboardVisible).observe(clipboardDialog);
function showClipboard(text, paste) {
  document.getElementById('clipboard-title').textContent = paste ? 'Paste into browser' : 'Copy from browser';
  document.getElementById('clipboard-help').textContent = paste
    ? 'Paste text here, then choose Paste into browser.'
    : 'Select and copy this text with your device’s copy command.';
  document.getElementById('clipboard-send').hidden = !paste;
  clipboardText.value = text;
  clipboardText.readOnly = !paste;
  clipboardDialog.showModal();
  keepClipboardVisible();
  clipboardText.focus();
  requestAnimationFrame(keepClipboardVisible);
  if (!paste) clipboardText.select();
}

async function pasteText(text) {
  if (!controlReady || accessEnded) return;
  const connection = activeConnection;
  if (connection.capabilities.clipboard === 'utf8') {
    await post('clipboard', { action: 'write', text });
  } else {
    if ([...text].some(character => character.codePointAt(0) > 255)) {
      throw new Error('This session supports plain text clipboard only. Use Keyboard to enter other characters.');
    }
    connection.instance.clipboardPasteFrom(text);
  }
  if (!controlReady || accessEnded || connection !== activeConnection) return;
  sendChord(0x76, 'KeyV');
  status.textContent = 'Text pasted into the browser.';
}

// Returns true once the text reached the browser.
async function pasteFromDevice() {
  if (!controlReady || accessEnded) return false;
  let text;
  try {
    // Never read the local clipboard until the user explicitly chooses Paste.
    text = await navigator.clipboard.readText();
  } catch { if (!accessEnded) showClipboard('', true); return false; }
  try { await pasteText(text); return true; }
  catch (error) {
    if (accessEnded) return false;
    status.textContent = 'Paste failed: ' + ''.concat(error.message);
    showClipboard(text, true);
    return false;
  }
}
document.getElementById('paste').addEventListener('click', () => void pasteFromDevice());
document.getElementById('clipboard-send').addEventListener('click', async () => {
  try {
    await pasteText(clipboardText.value);
    clipboardDialog.close();
  } catch (error) { document.getElementById('clipboard-help').textContent = 'Paste failed: ' + ''.concat(error.message); }
});
// Returns true once the text is on this device's clipboard.
async function copyToDevice() {
  if (!controlReady || accessEnded) return false;
  const connection = activeConnection;
  let text;
  if (connection.capabilities.clipboard === 'utf8') {
    sendChord(0x63, 'KeyC');
    // Let the browser publish Copy to the desktop clipboard before reading it.
    await new Promise(resolve => setTimeout(resolve, 150));
    if (accessEnded || connection !== activeConnection) return;
    try { text = (await post('clipboard', { action: 'read' })).text; }
    catch (error) { if (!accessEnded) status.textContent = 'Copy failed: ' + ''.concat(error.message); return false; }
  } else {
    // Give Chrome's Copy action time to publish the current selection to RFB.
    let listener, timer;
    const selection = new Promise((resolve) => {
      listener = (event) => resolve(event.detail.text);
      connection.instance.addEventListener('clipboard', listener, { once: true });
      timer = setTimeout(() => resolve(remoteClipboard), 400);
    });
    sendChord(0x63, 'KeyC');
    text = await selection;
    clearTimeout(timer);
    connection.instance.removeEventListener('clipboard', listener);
  }
  if (accessEnded || connection !== activeConnection) return false;
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = 'Copied to this device.';
    return true;
  } catch { showClipboard(text, false); return false; }
}
document.getElementById('copy').addEventListener('click', () => void copyToDevice());

// A small Copy / Paste bar, as a phone shows over its own text. It opens only when the owner asks for it the
// way a phone does: a touch and hold, or a double tap. It sits just above the finger, offers Copy when the agent's
// browser has text selected and Paste in a text field, and goes away at the next touch or once used.
const quickActions = document.getElementById('quick-actions');
const quickCopy = document.getElementById('quick-copy');
const quickPaste = document.getElementById('quick-paste');
let quickOffer;
// Counts touches on the browser, so a bar asked for by an earlier touch never opens after a later one.
let touchCount = 0;
function placeQuickActions() {
  if (quickActions.hidden || !quickOffer) return;
  const bounds = toolbarBounds(), rect = quickActions.getBoundingClientRect(), gap = 12;
  const left = Math.max(bounds.left + 8, Math.min(quickOffer.x - rect.width / 2, bounds.left + bounds.width - rect.width - 8));
  // Above the finger, or below it when there is no room above. Always inside the area the keyboard leaves visible.
  let top = quickOffer.y - rect.height - gap;
  if (top < bounds.top + 8) top = quickOffer.y + gap + 24;
  top = Math.max(bounds.top + 8, Math.min(top, bounds.top + bounds.height - rect.height - 8));
  quickActions.style.left = left + 'px';
  quickActions.style.top = top + 'px';
}
function hideQuickActions() {
  quickOffer = undefined;
  quickActions.hidden = true;
}
function offerQuickActions(x, y, answer) {
  const copy = answer.selected === true, paste = answer.kind === 'editable';
  if (!controlReady || accessEnded || (!copy && !paste)) { hideQuickActions(); return; }
  quickOffer = { x, y };
  quickCopy.hidden = !copy;
  quickPaste.hidden = !paste;
  quickActions.hidden = false;
  placeQuickActions();
}
function updateQuickActions() {
  if (!controlReady || accessEnded) hideQuickActions();
}
for (const button of [quickCopy, quickPaste]) {
  // Keep this device's keyboard open, as the Keyboard button does.
  button.addEventListener('pointerdown', event => event.preventDefault());
  button.addEventListener('mousedown', event => event.preventDefault());
}
quickCopy.addEventListener('click', async () => { hideQuickActions(); await copyToDevice(); });
quickPaste.addEventListener('click', async () => { hideQuickActions(); await pasteFromDevice(); });

// A real editable buffer supports Android/Gboard input and IME composition.
// Compare committed code points rather than keycodes or UTF-16 code units.
let keyboardBuffer = '________';
let composing = false;
keyboardInput.value = keyboardBuffer;
function commitKeyboardInput() {
  if (composing || !controlReady || accessEnded) return;
  const before = [...keyboardBuffer], after = [...keyboardInput.value];
  let common = 0;
  while (common < before.length && common < after.length && before[common] === after[common]) common++;
  for (let index = common; index < before.length; index++) activeConnection.instance.sendKey(0xff08, 'Backspace');
  for (let index = common; index < after.length; index++) {
    const point = after[index].codePointAt(0);
    const keysym = point === 10 ? 0xff0d : point === 9 ? 0xff09 : point <= 255 ? point : 0x01000000 | point;
    activeConnection.instance.sendKey(keysym);
  }
  keyboardBuffer = keyboardInput.value;
  if (!keyboardBuffer.length || keyboardBuffer.length > 200) {
    keyboardBuffer = '________';
    keyboardInput.value = keyboardBuffer;
    keyboardInput.setSelectionRange(keyboardBuffer.length, keyboardBuffer.length);
  }
}
keyboardInput.addEventListener('compositionstart', () => { composing = true; });
keyboardInput.addEventListener('compositionend', () => { composing = false; commitKeyboardInput(); });
keyboardInput.addEventListener('input', (event) => { if (!event.isComposing) commitKeyboardInput(); });
keyboardInput.addEventListener('keydown', (event) => {
  if (event.isComposing || composing || !controlReady || accessEnded) return;
  const special = { Enter: 0xff0d, Backspace: 0xff08, Tab: 0xff09, Escape: 0xff1b,
    ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54, Delete: 0xffff }[event.key];
  if (!special) return;
  event.preventDefault();
  activeConnection.instance.sendKey(special, event.code);
});
// Preserve focus until click so the same button can also dismiss the keyboard.
document.getElementById('keyboard').addEventListener('pointerdown', event => event.preventDefault());
function openKeyboard(inputMode = 'text') {
  keyboardInput.inputMode = inputMode;
  if (document.activeElement === keyboardInput) return;
  keyboardInput.focus({ preventScroll: true });
  keyboardInput.setSelectionRange(keyboardInput.value.length, keyboardInput.value.length);
}
document.getElementById('keyboard').addEventListener('click', () => {
  if (!controlReady || accessEnded) return;
  autoKeyboard = false;
  if (document.activeElement === keyboardInput) { keyboardInput.blur(); return; }
  openKeyboard();
});

// After a tap, ask the gateway what the agent's browser focused, and open or close this keyboard to match.
// Phones open a keyboard only shortly after a tap, so this runs once per tap and never on its own.
// It closes only a keyboard it opened itself, never one the owner opened with the Keyboard button.
// A tap that lands while a check is running gets one more check afterwards, so a double tap's selection is seen.
// After a hold or drag the keyboard is left as it is. A hold or a double tap also offers the Copy / Paste bar at offer.
const toolbarBandPx = 100;
let autoKeyboard = false;
let focusCheck, focusRecheck;
function checkFocusAfterTap(framebufferY, { keyboard = true, offer } = {}) {
  const connection = activeConnection;
  if (!connection?.capabilities.focus || !controlReady || accessEnded) return;
  if (focusCheck) { focusRecheck = { framebufferY, keyboard: keyboard || focusRecheck?.keyboard === true, offer: offer || focusRecheck?.offer }; return; }
  focusCheck = (async () => {
    let answer;
    for (const wait of [150, 350]) {
      await new Promise(resolve => setTimeout(resolve, wait));
      if (!controlReady || accessEnded || connection !== activeConnection) return;
      try { answer = await post('focus'); } catch { return; }
      if (answer.kind !== 'none' || answer.selected) break;
    }
    if (!controlReady || accessEnded || connection !== activeConnection) return;
    if (offer && offer.touch === touchCount) offerQuickActions(offer.x, offer.y, answer);
    if (!keyboard) return;
    if (answer.kind === 'editable') { openKeyboard(answer.inputMode); autoKeyboard = true; }
    else if (answer.kind === 'browser-ui' && framebufferY < toolbarBandPx) { openKeyboard('url'); autoKeyboard = true; }
    else if (answer.kind === 'none' && autoKeyboard && document.activeElement === keyboardInput) keyboardInput.blur();
  })().finally(() => {
    focusCheck = undefined;
    const next = focusRecheck;
    focusRecheck = undefined;
    if (next) checkFocusAfterTap(next.framebufferY, next);
  });
}
keyboardInput.addEventListener('focus', () => {
  document.getElementById('keyboard').setAttribute('aria-pressed', 'true');
  if (activeConnection) activeConnection.instance.focusOnClick = false;
});
keyboardInput.addEventListener('blur', () => {
  autoKeyboard = false;
  document.getElementById('keyboard').setAttribute('aria-pressed', 'false');
  if (activeConnection) activeConnection.instance.focusOnClick = controlReady;
});

let touchGesture;
let dragOnce = false;
const holdDelayMs = 250;
const midpoint = (touches) => ({ x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2 });
const touchDistance = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
function setDragOnce(enabled) {
  dragOnce = enabled;
  document.getElementById('drag-once').setAttribute('aria-pressed', String(enabled));
}
document.getElementById('drag-once').addEventListener('click', () => {
  if (!controlReady || accessEnded) return;
  setDragOnce(!dragOnce);
  status.textContent = dragOnce ? 'Next touch drags in the browser. Lift or pinch to finish.' : 'Swipe to scroll. Pinch to zoom.';
});

function mouseOptions(x, y, buttons) {
  return { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons };
}
const holdsButton = gesture => gesture.kind === 'drag' || gesture.kind === 'hold';
function beginHold(gesture) {
  if (gesture !== touchGesture || gesture.moved || !controlReady || accessEnded) return;
  gesture.kind = 'hold';
  gesture.remoteDown = true;
  status.textContent = 'Holding… Lift to release.';
  gesture.canvas.dispatchEvent(new MouseEvent('mousedown', mouseOptions(gesture.x, gesture.y, 1)));
}
function releaseTouchDrag(gesture = touchGesture) {
  clearTimeout(gesture?.holdTimer);
  if (!gesture?.remoteDown) return;
  gesture.remoteDown = false;
  if (controlReady && !accessEnded) status.textContent = (gesture.kind === 'hold' ? 'Hold released.' : 'Drag finished.') + ' Swipe to scroll. Pinch to zoom.';
  // Route up through noVNC's window capture proxy so it also removes the
  // capture overlay and flushes any queued held-button movement.
  window.dispatchEvent(new MouseEvent('mouseup', mouseOptions(gesture.lastX, gesture.lastY, 0)));
}
function cancelTouchInput() {
  releaseTouchDrag();
  touchGesture = undefined;
  setDragOnce(false);
}
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelTouchInput(); });
function beginPinch(touches) {
  releaseTouchDrag();
  setDragOnce(false);
  const point = midpoint(touches), rect = screen.getBoundingClientRect();
  // Discard scrolling remainders immediately; no wheel event runs on release.
  touchGesture = { pinch: true, distance: touchDistance(touches), scale: displayScale,
    pixel: { x: (point.x - rect.left) / displayScale, y: (point.y - rect.top) / displayScale } };
}
function scrollTouch(gesture) {
  const step = (axis, direction) => {
    // noVNC 1.7 converts each 50px wheel threshold to a native RFB wheel step
    // and clears its accumulator. Keep sub-step movement in this gesture so
    // pinch/cancel can discard it without touching noVNC's private state.
    gesture.canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
      clientX: gesture.x, clientY: gesture.y, buttons: 0, deltaMode: 0,
      deltaX: axis === 'X' ? direction * 50 : 0, deltaY: axis === 'Y' ? direction * 50 : 0 }));
  };
  if (!gesture.scrolled) {
    const axis = Math.abs(gesture.wheelX) > Math.abs(gesture.wheelY) ? 'X' : 'Y';
    step(axis, Math.sign(gesture[`wheel${axis}`]));
    gesture[`wheel${axis}`] = 0;
    gesture.scrolled = true;
  }
  for (const axis of ['X', 'Y']) {
    while (Math.abs(gesture[`wheel${axis}`]) >= 24) {
      const direction = Math.sign(gesture[`wheel${axis}`]);
      step(axis, direction);
      gesture[`wheel${axis}`] -= direction * 24;
    }
  }
}

// Chrome counts a double-click only when both clicks land within a couple of pixels, far finer than two finger taps.
// A second tap soon after and close to the first clicks exactly where the first did, so a double tap selects a word.
const repeatTapMs = 400, repeatTapSlopPx = 12;
let lastTap;
function repeatTapPoint(gesture) {
  const now = performance.now(), view = { scale: displayScale, left: viewport.scrollLeft, top: viewport.scrollTop };
  const repeat = lastTap && now - lastTap.at < repeatTapMs && Math.hypot(gesture.x - lastTap.x, gesture.y - lastTap.y) <= repeatTapSlopPx &&
    lastTap.view.scale === view.scale && lastTap.view.left === view.left && lastTap.view.top === view.top;
  const point = repeat ? { x: lastTap.x, y: lastTap.y, repeat: true } : { x: gesture.x, y: gesture.y };
  // A third tap starts a new pair rather than repeating again.
  lastTap = repeat ? undefined : { ...point, at: now, view };
  return point;
}

// Capture touch before noVNC's gesture recognizer. Listen at window because
// native dragging creates a capture overlay outside the viewport, and a second
// finger can start on that overlay. Ordinary desktop mouse events are untouched.
for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) window.addEventListener(type, (event) => {
  if (!touchGesture && !event.composedPath().includes(viewport)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const touches = event.touches;
  if (type === 'touchcancel') { cancelTouchInput(); return; }
  if (type === 'touchstart') {
    touchCount++;
    hideQuickActions();
    if (touches.length >= 2) beginPinch(touches);
    else if (!touchGesture) {
      const canvas = screen.querySelector('canvas'), size = framebufferSize();
      if (!canvas || !size) return;
      const kind = dragOnce && controlReady && !accessEnded ? 'drag'
        : displayScale > fitScale(size) + 0.001 ? 'pan' : 'scroll';
      touchGesture = { pinch: false, kind, canvas, x: touches[0].clientX, y: touches[0].clientY,
        lastX: touches[0].clientX, lastY: touches[0].clientY,
        left: viewport.scrollLeft, top: viewport.scrollTop, moved: false, wheelX: 0, wheelY: 0 };
      if (kind === 'drag') {
        setDragOnce(false);
        touchGesture.remoteDown = true;
        status.textContent = 'Dragging in the browser. Lift to finish; pinch to cancel.';
        canvas.dispatchEvent(new MouseEvent('mousedown', mouseOptions(touchGesture.x, touchGesture.y, 1)));
      } else if (controlReady && !accessEnded) touchGesture.holdTimer = setTimeout(beginHold, holdDelayMs, touchGesture);
    }
    return;
  }
  if (!touchGesture) return;
  if (type === 'touchmove') {
    if (touches.length >= 2) {
      if (!touchGesture.pinch) beginPinch(touches);
      const center = midpoint(touches);
      zoomTo(touchGesture.scale * touchDistance(touches) / Math.max(1, touchGesture.distance), { ...center, pixel: touchGesture.pixel });
    } else if (!touchGesture.pinch && touches.length) {
      const gesture = touchGesture, x = touches[0].clientX, y = touches[0].clientY;
      gesture.wheelX += gesture.lastX - x;
      gesture.wheelY += gesture.lastY - y;
      gesture.lastX = x; gesture.lastY = y;
      if (holdsButton(gesture)) {
        if (gesture.remoteDown) window.dispatchEvent(new MouseEvent('mousemove', mouseOptions(x, y, 1)));
        return;
      }
      const dx = x - gesture.x, dy = y - gesture.y;
      gesture.moved ||= Math.hypot(dx, dy) > 8;
      if (gesture.moved) clearTimeout(gesture.holdTimer);
      if (gesture.moved && gesture.kind === 'pan') {
        viewport.scrollLeft = gesture.left - dx;
        viewport.scrollTop = gesture.top - dy;
      } else if (gesture.moved && controlReady && !accessEnded) scrollTouch(gesture);
    }
    return;
  }
  if (touches.length) return;
  const gesture = touchGesture;
  releaseTouchDrag(gesture);
  touchGesture = undefined;
  if (holdsButton(gesture) && controlReady && !accessEnded) checkFocusAfterTap(0, { keyboard: false, offer: { x: gesture.lastX, y: gesture.lastY, touch: touchCount } });
  if (gesture.pinch || holdsButton(gesture) || gesture.moved || !controlReady || accessEnded) return;
  const point = repeatTapPoint(gesture);
  gesture.canvas.dispatchEvent(new MouseEvent('mousedown', mouseOptions(point.x, point.y, 1)));
  // noVNC's window capture proxy must receive mouseup to release its overlay.
  window.dispatchEvent(new MouseEvent('mouseup', mouseOptions(point.x, point.y, 0)));
  checkFocusAfterTap((point.y - gesture.canvas.getBoundingClientRect().top) / displayScale, point.repeat ? { offer: { x: point.x, y: point.y, touch: touchCount } } : {});
}, { capture: true, passive: false });
