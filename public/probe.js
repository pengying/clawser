import { accelerate, movePointer, followPointer } from './trackpad.js';
const screen = document.getElementById('screen');
const control = document.getElementById('control');
const done = document.getElementById('done');
const status = document.getElementById('status');
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
const bar = document.getElementById('bar');
const barTab = document.getElementById('bar-tab');
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
  setBarState('watching');
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
    setBarState(config.mode === 'watch' ? 'watching' : 'control');
    control.disabled = config.mode !== 'watch' || config.permission === 'watch';
    controlReady = config.mode !== 'watch';
    updateInputControls();
    updateDisplay();
    if (!modeRestored) { modeRestored = true; setInputMode(storedMode(), { restore: true }); }
    if (inputMode === 'trackpad' && !pointer) { placePointer(); drawPointer(); }
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
    if (config.mode !== 'watch') showBar();
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
  showBar();
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
    if (controlReady && !accessEnded && next === activeConnection) { hideBar(); barTab.focus(); }
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
  for (const id of ['keyboard', 'paste']) document.getElementById(id).disabled = !controlReady || accessEnded;
  document.getElementById('copy').disabled = !controlReady || accessEnded;
  // A gesture belongs to the control state it began in, so any change cancels it.
  cancelTouchInput();
  if (!controlReady || accessEnded) keyboardInput.blur();
  updateQuickActions();
  drawPointer();
}

function framebufferSize() {
  const canvas = screen.querySelector('canvas');
  return canvas?.width && canvas?.height ? { width: canvas.width, height: canvas.height } : null;
}

function fitScale(size) {
  return Math.min(1, viewport.clientWidth / size.width, viewport.clientHeight / size.height);
}

// The bar's height with the sheet closed. A transform hides the bar, so this is the same whether it is shown or hidden.
function closedBarHeight() {
  const sheet = sheetOpen() ? moreSheet.getBoundingClientRect().height + parseFloat(getComputedStyle(moreSheet).marginTop) : 0;
  return Math.round(bar.getBoundingClientRect().height - sheet);
}

// Only change the mount dimensions. noVNC's autoscale updates both its display
// and framebuffer-coordinate conversion; the canvas is never independently zoomed.
// Past Fit the stage has a fixed band of room above the screen, one closed bar tall, so at the top of the scroll
// the screen's first row sits just below the bar. Showing, hiding or opening the bar never changes the band.
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
  const room = zoomMode === 'fit' ? 0 : closedBarHeight();
  const stageWidth = Math.max(width, viewport.clientWidth), stageHeight = Math.max(height + room, viewport.clientHeight);
  const left = (stageWidth - width) / 2, top = Math.max(room, (stageHeight - height) / 2);
  stage.style.width = stageWidth + 'px';
  stage.style.height = stageHeight + 'px';
  Object.assign(screen.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
  if (activeConnection) activeConnection.instance.scaleViewport = true;
  viewport.scrollLeft = zoomMode === 'fit' ? 0 : left + pixel.x * displayScale - point.x;
  viewport.scrollTop = zoomMode === 'fit' ? 0 : top + pixel.y * displayScale - point.y;
  const label = document.getElementById('zoom-level');
  label.value = zoomMode === 'fit' ? 'Fit' : Math.round(displayScale * 100) + '%';
  label.dataset.scale = String(displayScale);
  drawPointer();
  document.getElementById('zoom-toggle').setAttribute('aria-label', zoomMode === 'fit' ? 'Actual size' : 'Fit to screen');
}

function zoomTo(scale, anchor) {
  zoomMode = scale;
  updateDisplay(anchor);
}

// In Trackpad the view then scrolls to keep the pointer in sight, as it does while the pointer moves.
function zoomFromSheet(scale) {
  zoomTo(scale);
  if (inputMode === 'trackpad') followView();
}
document.getElementById('zoom-toggle').addEventListener('click', () => zoomFromSheet(zoomMode === 'fit' ? 1 : 'fit'));
document.getElementById('zoom-in').addEventListener('click', () => zoomFromSheet(displayScale * 1.25));
document.getElementById('zoom-out').addEventListener('click', () => zoomFromSheet(displayScale / 1.25));
new ResizeObserver(() => { updateDisplay(); clampPointer(); }).observe(viewport);
new MutationObserver(() => { updateDisplay(); clampPointer(); }).observe(screen, { childList: true, subtree: true, attributes: true, attributeFilter: ['width', 'height'] });

function visibleBounds() {
  const visual = window.visualViewport;
  const style = getComputedStyle(document.documentElement);
  const safe = edge => parseFloat(style.getPropertyValue(`--safe-${edge}`)) || 0;
  return { left: (visual?.offsetLeft || 0) + safe('left'), top: (visual?.offsetTop || 0) + safe('top'),
    width: (visual?.width || innerWidth) - safe('left') - safe('right'),
    height: (visual?.height || innerHeight) - safe('top') - safe('bottom') };
}

function barHidden() { return bar.classList.contains('bar-hidden'); }
// While watching, Take control is the one thing to do, so the bar stays down.
// A hidden bar is inert: its buttons leave the focus order, and a tap during the slide reaches the tab beneath.
function hideBar() {
  if (!controlReady || barHidden()) return;
  closeSheet();
  bar.classList.add('bar-hidden');
  bar.inert = true;
  barTab.hidden = false;
}
function showBar() {
  if (!barHidden()) return;
  bar.classList.remove('bar-hidden');
  bar.inert = false;
  barTab.hidden = true;
  hideQuickActions();
}
const moreButton = document.getElementById('more'), moreSheet = document.getElementById('more-sheet');
function sheetOpen() { return !moreSheet.hidden; }
function openSheet() {
  showBar();
  moreSheet.hidden = false;
  moreButton.setAttribute('aria-expanded', 'true');
}
function closeSheet() {
  moreSheet.hidden = true;
  moreButton.setAttribute('aria-expanded', 'false');
}
moreButton.addEventListener('click', () => (sheetOpen() ? closeSheet() : openSheet()));
function setHint(mode) {
  const mac = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform);
  document.getElementById('hint').textContent = usesMouse ? (mac ? '⌘C to copy · ⌘V to paste' : 'Ctrl+C to copy · Ctrl+V to paste')
    : mode === 'trackpad' ? 'Slide to move · tap to click · two fingers to right-click or scroll'
    : 'Swipe to scroll · pinch to zoom · hold, then drag';
}
// Status pop-ups sit just under the bar's real bottom edge, which moves when the sheet opens.
new ResizeObserver(() => document.documentElement.style.setProperty('--bar-h', bar.offsetHeight + 'px')).observe(bar);
// The mode switch is one stop in the focus order, on its checked segment, so the tab lands there and never on the other one.
barTab.addEventListener('click', () => {
  showBar();
  [...bar.querySelectorAll('button')].find(button => !button.disabled && button.getClientRects().length &&
    !button.matches('[role=radio]:not([aria-checked="true"])'))?.focus();
});
// A pull down on the tab shows the bar as well. The touchend then cancels the click, so focus does not jump a second time.
let tabPull;
barTab.addEventListener('touchstart', event => { tabPull = { y: event.touches[0].clientY, done: false }; }, { passive: true });
barTab.addEventListener('touchmove', event => {
  if (!tabPull || tabPull.done || !event.touches.length || event.touches[0].clientY - tabPull.y < 12) return;
  tabPull.done = true;
  showBar();
}, { passive: true });
barTab.addEventListener('touchend', event => { if (tabPull?.done && event.cancelable) event.preventDefault(); tabPull = undefined; }, { passive: false });
barTab.addEventListener('touchcancel', () => { tabPull = undefined; });
// A phone or tablet reports a coarse pointer or touch points. Anything else has a mouse and a real keyboard.
// A laptop with a touch screen counts as touch and keeps the phone controls.
const usesMouse = !matchMedia('(any-pointer: coarse)').matches && !(navigator.maxTouchPoints > 0);
if (usesMouse) setHint('touch');
function setBarState(state) {
  const inControl = state === 'control';
  const badge = document.getElementById('bar-status');
  badge.dataset.state = state;
  badge.setAttribute('aria-label', inControl ? 'In control' : 'Watching');
  document.getElementById('icon-watching').hidden = inControl;
  document.getElementById('icon-control').hidden = !inControl;
  control.hidden = inControl;
  document.getElementById('input-mode').hidden = !inControl || usesMouse;
  document.getElementById('keyboard').hidden = !inControl || usesMouse;
}
window.visualViewport?.addEventListener('resize', placeQuickActions);
window.visualViewport?.addEventListener('scroll', placeQuickActions);

// Messages pop up under the bar and fade after a few seconds. One that needs the owner stays until the next message.
const lastingStatus = /could not|failed|ended|another tab|Retry|close this tab/i;
let statusTimer;
function popUpStatus() {
  clearTimeout(statusTimer);
  status.classList.remove('faded');
  if (!lastingStatus.test(status.textContent)) statusTimer = setTimeout(() => status.classList.add('faded'), 4000);
}
new MutationObserver(popUpStatus).observe(status, { childList: true, characterData: true, subtree: true });
popUpStatus();

function sendChord(keysym, code) {
  if (!controlReady || accessEnded) return;
  const instance = activeConnection.instance;
  instance.sendKey(0xffe3, 'ControlLeft', true);
  instance.sendKey(keysym, code);
  instance.sendKey(0xffe3, 'ControlLeft', false);
}

// noVNC cancels every key on its canvas, which stops the browser's own copy and paste. On a Mac it also sends Cmd
// as Alt. Cmd or Ctrl with C or V therefore runs the viewer's Copy or Paste instead.
let shortcutPaste;
function releaseHeldKeys() {
  const keyboard = activeConnection?.instance?._keyboard;
  if (keyboard?._keyDownList) keyboard._allKeysUp();
}
window.addEventListener('keydown', (event) => {
  if (!controlReady || accessEnded || !activeConnection || event.altKey || event.shiftKey) return;
  if (!(event.ctrlKey || event.metaKey) || (event.ctrlKey && event.metaKey)) return;
  if (event.code !== 'KeyC' && event.code !== 'KeyV') return;
  if (event.target !== canvasEl() && !screen.contains(event.target)) return;
  // The modifier's own keydown already reached the agent's browser. Releasing it keeps the chord clean.
  releaseHeldKeys();
  event.stopImmediatePropagation();
  // Each key repeat would paste or copy again.
  if (event.repeat) { event.preventDefault(); return; }
  if (event.code === 'KeyC') { event.preventDefault(); void copyToDevice(); return; }
  // The default stays, which lets the browser fire its own paste event with this device's clipboard. Safari skips
  // that event on a page with no editable focus. The timer then falls back to an explicit clipboard read.
  clearTimeout(shortcutPaste);
  shortcutPaste = setTimeout(() => { shortcutPaste = undefined; void pasteFromDevice(); }, 150);
}, true);
window.addEventListener('keyup', (event) => {
  if (!(event.ctrlKey || event.metaKey) || (event.code !== 'KeyC' && event.code !== 'KeyV')) return;
  if (!controlReady || accessEnded || !activeConnection) return;
  // noVNC never saw the keydown. It gets no keyup either.
  event.stopImmediatePropagation();
}, true);
window.addEventListener('paste', (event) => {
  if (shortcutPaste === undefined) return;
  const text = event.clipboardData?.getData('text/plain') ?? '';
  // An empty paste can mean the browser withheld the text. The explicit read then gets its turn.
  if (!text) return;
  clearTimeout(shortcutPaste); shortcutPaste = undefined;
  event.preventDefault();
  pasteText(text).catch((error) => {
    if (accessEnded) return;
    status.textContent = 'Paste failed: ' + ''.concat(error.message);
    showClipboard(text, true);
  });
}, true);

const clipboardDialog = document.getElementById('clipboard-dialog');
const clipboardText = document.getElementById('clipboard-text');
function keepClipboardVisible() {
  if (!clipboardDialog.open) return;
  // The on-screen keyboard can shrink only visualViewport, leaving the native
  // dialog's layout-viewport centering and CSS viewport units unchanged.
  const bounds = visibleBounds();
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
  const bounds = visibleBounds(), rect = quickActions.getBoundingClientRect(), gap = 12;
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
  const touch = touchCount;
  focusCheck = (async () => {
    let answer;
    for (const wait of [150, 350]) {
      await new Promise(resolve => setTimeout(resolve, wait));
      if (!controlReady || accessEnded || connection !== activeConnection) return;
      try { answer = await post('focus'); } catch { return; }
      if (answer.kind !== 'none' || answer.selected) break;
    }
    if (!controlReady || accessEnded || connection !== activeConnection) return;
    // A finger still sliding after a hold is dragging, and the bar would sit in its way.
    if (offer && offer.touch === touchCount && !touchGesture?.dragging) offerQuickActions(offer.x, offer.y, answer);
    if (!keyboard) return;
    // After a newer touch this answer is out of date. That touch decides an open keyboard, for example one the address bar opened.
    if (touch !== touchCount && document.activeElement === keyboardInput) return;
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
// Chrome's address bar, in the agent's screen pixels. Setup runs Chrome maximized at 96 dpi. The bar is then the row
// under the tab strip, between the reload button and the profile button, at the same pixels on any screen width.
// OpenClaw's browser tool turns on Chrome's focus emulation, and then the page reports focus even while the address bar
// has it. The focus check cannot see this bar, so where the finger lands decides it.
const addressBar = { top: 46, bottom: 80, left: 122, fromRight: 210 };
function onAddressBar(fb) {
  const size = framebufferSize();
  return Boolean(size && fb) && fb.y >= addressBar.top && fb.y <= addressBar.bottom && fb.x >= addressBar.left && fb.x <= size.width - addressBar.fromRight;
}
// A tap on the address bar opens the URL keyboard straight away. A double tap there selects a word, so it also offers Copy and Paste.
function tapAddressBar(at, repeat) {
  openKeyboard('url');
  autoKeyboard = true;
  if (repeat) offerQuickActions(at.x, at.y, { kind: 'editable', selected: true });
}
// The Copy / Paste bar for a hold or a drag. fb is where it started, at is where the bar goes.
// A drag that started in the address bar selected text there.
function offerAfterHold(at, fb, dragged) {
  if (onAddressBar(fb)) { offerQuickActions(at.x, at.y, { kind: 'editable', selected: dragged }); return; }
  checkFocusAfterTap(0, { keyboard: false, offer: { x: at.x, y: at.y, touch: touchCount } });
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
const holdDelayMs = 250;
const midpoint = (touches) => ({ x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2 });
const touchDistance = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
function mouseOptions(x, y, buttons, button = 0) {
  return { bubbles: true, cancelable: true, clientX: x, clientY: y, button, buttons };
}

// Trackpad mode. pointer is the on-screen arrow in framebuffer pixels, fractions allowed.
let inputMode = 'touch';
let pointer = null;
let lastTouchTapFb = null;
let padGesture;
const pointerEl = document.getElementById('pointer');
const canvasEl = () => screen.querySelector('canvas');
const toScreen = fb => { const r = canvasEl().getBoundingClientRect(); return { x: r.left + fb.x * displayScale, y: r.top + fb.y * displayScale }; };
const toFramebuffer = pt => { const r = canvasEl().getBoundingClientRect(); return { x: (pt.x - r.left) / displayScale, y: (pt.y - r.top) / displayScale }; };
function drawPointer() {
  const show = inputMode === 'trackpad' && controlReady && !accessEnded && pointer && canvasEl();
  pointerEl.toggleAttribute('hidden', !show);
  if (!show) return;
  const at = toScreen(pointer);
  pointerEl.style.transform = `translate(${at.x - 1.5}px, ${at.y - 1.5}px)`;
}
const MODE_KEY = 'clawser.inputMode', HINT_KEY = 'clawser.trackpadHintShown';
let modeRestored = false, hintTimer, hintHide;
function storedMode() {
  if (usesMouse) return 'touch';
  try { return localStorage.getItem(MODE_KEY) === 'trackpad' ? 'trackpad' : 'touch'; } catch { return 'touch'; }
}
function showTrackpadHint() {
  try { if (localStorage.getItem(HINT_KEY) === '1') return; } catch { /* An unreadable store means the hint shows this once. */ }
  try { localStorage.setItem(HINT_KEY, '1'); } catch { /* Nothing to remember it with. */ }
  const el = document.getElementById('trackpad-hint');
  clearTimeout(hintTimer); clearTimeout(hintHide);
  el.classList.remove('faded');
  el.hidden = false;
  hintTimer = setTimeout(() => { el.classList.add('faded'); hintHide = setTimeout(() => { el.hidden = true; }, 350); }, 5000);
}
for (const [id, mode] of [['mode-touch', 'touch'], ['mode-trackpad', 'trackpad']]) {
  document.getElementById(id).addEventListener('click', () => { if (inputMode !== mode) setInputMode(mode); });
}
document.getElementById('input-mode').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const mode = inputMode === 'touch' ? 'trackpad' : 'touch';
  setInputMode(mode);
  document.getElementById('mode-' + mode).focus();
});
function setInputMode(next, { restore = false } = {}) {
  inputMode = next;
  for (const mode of ['touch', 'trackpad']) {
    const button = document.getElementById('mode-' + mode);
    button.setAttribute('aria-checked', String(mode === next));
    button.tabIndex = mode === next ? 0 : -1;
  }
  setHint(next);
  if (!restore) {
    try { localStorage.setItem(MODE_KEY, next); } catch { /* The switch still works for this page. */ }
    if (next === 'trackpad') showTrackpadHint();
  }
  cancelTouchInput();
  lastPadTap = undefined;
  if (next === 'trackpad') placePointer();
  drawPointer();
}
// The last Touch tap since the pointer was placed wins; else keep the pointer; else the center of the visible area.
function placePointer() {
  if (!framebufferSize()) return;
  if (lastTouchTapFb) {
    pointer = movePointer(lastTouchTapFb, { dx: 0, dy: 0 }, displayScale, framebufferSize());
    lastTouchTapFb = null;
  } else if (!pointer) {
    const b = visibleBounds();
    pointer = movePointer(toFramebuffer({ x: b.left + b.width / 2, y: b.top + b.height / 2 }), { dx: 0, dy: 0 }, displayScale, framebufferSize());
  }
}
viewport.addEventListener('scroll', drawPointer);
function clampPointer() {
  if (inputMode !== 'trackpad' || !pointer || !framebufferSize()) return;
  pointer = movePointer(pointer, { dx: 0, dy: 0 }, displayScale, framebufferSize());
  drawPointer();
  followView();
}
// Turning the phone moves everything under the finger, so a gesture in progress ends there and lets go of any button.
let landscape = innerWidth > innerHeight;
window.addEventListener('resize', () => {
  if ((innerWidth > innerHeight) === landscape) return;
  landscape = !landscape;
  cancelTouchInput();
});
window.addEventListener('resize', clampPointer);
window.visualViewport?.addEventListener('resize', clampPointer);
function sendButton(x, y, button, down) {
  const buttons = button === 2 ? 2 : 1;
  // On a dropped connection the canvas may be gone. The mouseup then only clears noVNC's capture. The desktop button is let go by
  // the supervisor: retiring the control actor runs xproof.settle, which releases every held key and button.
  const at = canvasEl() ? toScreen({ x, y }) : { x: 0, y: 0 };
  if (down) canvasEl().dispatchEvent(new PointerEvent('mousedown', mouseOptions(at.x, at.y, buttons, button)));
  // Route up through window so noVNC also removes its capture overlay.
  else window.dispatchEvent(new PointerEvent('mouseup', mouseOptions(at.x, at.y, 0, button)));
}
function movePointerTo(x, y, buttons = 0) {
  pointer = movePointer({ x, y }, { dx: 0, dy: 0 }, displayScale, framebufferSize());
  drawPointer();
  if (!controlReady || accessEnded) return;
  const at = toScreen(pointer);
  canvasEl().dispatchEvent(new PointerEvent('mousemove', mouseOptions(at.x, at.y, buttons)));
}

const padDecideSlop = 8, padDragSlop = 8, padDragMs = 250;
const padTapMs = 250, padDoubleMs = 350, padMoveSlop = 4, padTapSlop = 8, padTwoSlop = 10;
let lastPadTap;
function trackpadTouch(type, touches) {
  const now = performance.now();
  if (type === 'touchstart') {
    if (!pointer) { placePointer(); drawPointer(); }
    if (!pointer) return;
    if (!padGesture) {
      // chained: the finger landed soon after a tap, so a move makes this a drag with the left button held.
      padGesture = { at: now, start: { ...pointer }, starts: new Map(), last: null, moved: false, two: false, travel: 0,
        chained: Boolean(lastPadTap && now - lastPadTap < padDoubleMs), held: false, mode: undefined };
      padGesture.last = { x: touches[0].clientX, y: touches[0].clientY, at: now };
    }
    if (touches.length >= 2) {
      // A finger that lands again restarts the midpoint, so the slide never jumps.
      if (!padGesture.mode) { padGesture.distance = touchDistance(touches); padGesture.mid0 = midpoint(touches); }
      padGesture.mid = midpoint(touches);
      padGesture.last = { x: touches[0].clientX, y: touches[0].clientY, at: now };
      padGesture.two = true; lastPadTap = undefined;
    }
    for (const t of touches) if (!padGesture.starts.has(t.identifier)) padGesture.starts.set(t.identifier, { x: t.clientX, y: t.clientY });
    return;
  }
  const gesture = padGesture;
  if (!gesture) return;
  if (type === 'touchmove') {
    for (const t of touches) {
      const s = gesture.starts.get(t.identifier);
      if (s) gesture.travel = Math.max(gesture.travel, Math.hypot(t.clientX - s.x, t.clientY - s.y));
    }
    if (gesture.two && (touches.length >= 2 || !gesture.held)) {
      if (touches.length < 2 || !gesture.distance) return;
      const mid = midpoint(touches), delta = Math.abs(touchDistance(touches) - gesture.distance);
      const travel = Math.hypot(mid.x - gesture.mid0.x, mid.y - gesture.mid0.y);
      // Decided once, the first time spread or midpoint travel passes a few px: spread wins ties. A held drag never slides.
      if (!gesture.mode && Math.max(delta, travel) > padDecideSlop) {
        if (delta >= travel) gesture.mode = 'pinch';
        else if (!gesture.held) {
          const at = toScreen(pointer);
          gesture.scroll = { canvas: canvasEl(), x: at.x, y: at.y, wheelX: gesture.mid0.x - gesture.mid.x, wheelY: gesture.mid0.y - gesture.mid.y, scrolled: false };
          gesture.mode = 'slide';
        }
      }
      if (gesture.mode === 'pinch') {
        releasePad(gesture);
        padGesture = undefined;
        beginPinch(touches);
        return;
      }
      if (gesture.mode === 'slide' && controlReady && !accessEnded) {
        gesture.scroll.wheelX += gesture.mid.x - mid.x;
        gesture.scroll.wheelY += gesture.mid.y - mid.y;
        scrollTouch(gesture.scroll);
      }
      gesture.mid = mid;
      gesture.last = { x: touches[0].clientX, y: touches[0].clientY, at: now };
      return;
    }
    const t = touches[0], dx = t.clientX - gesture.last.x, dy = t.clientY - gesture.last.y, dt = now - gesture.last.at;
    gesture.last = { x: t.clientX, y: t.clientY, at: now };
    const s = gesture.starts.get(t.identifier);
    if (gesture.chained && !gesture.held) {
      // A contact right after a tap stays undecided: nothing moves and nothing is sent until it is clearly a drag.
      gesture.sumX = (gesture.sumX || 0) + dx; gesture.sumY = (gesture.sumY || 0) + dy;
      const travel = s ? Math.hypot(t.clientX - s.x, t.clientY - s.y) : 0;
      if (!(travel > padDragSlop || (travel > padMoveSlop && now - gesture.at >= padDragMs))) return;
      gesture.moved = true;
      lastPadTap = undefined;
      if (!controlReady || accessEnded) return;
      sendButton(pointer.x, pointer.y, 0, true);
      gesture.held = true;
      const next = movePointer(pointer, accelerate(gesture.sumX, gesture.sumY, now - gesture.at), displayScale, framebufferSize());
      movePointerTo(next.x, next.y, 1);
      followView();
      return;
    }
    if (!gesture.moved && s && Math.hypot(t.clientX - s.x, t.clientY - s.y) > padMoveSlop) gesture.moved = true;
    if (gesture.moved) {
      lastPadTap = undefined;
      const next = movePointer(pointer, accelerate(dx, dy, dt), displayScale, framebufferSize());
      movePointerTo(next.x, next.y, gesture.held ? 1 : 0);
      followView();
    }
    return;
  }
  if (touches.length) {
    // The remaining finger carries on from where it is, with no jump.
    gesture.last = { x: touches[0].clientX, y: touches[0].clientY, at: now };
    if (touches.length >= 2) gesture.mid = midpoint(touches);
    return;
  }
  padGesture = undefined;
  if (gesture.held) {
    releasePad(gesture);
    if (controlReady && !accessEnded) offerAfterHold(toScreen(pointer), gesture.start, true);
    return;
  }
  if (gesture.chained && gesture.moved) return;
  if ((!gesture.chained || gesture.two) && now - gesture.at > padTapMs) return;
  if (gesture.two) {
    if (gesture.travel > padTwoSlop) return;
    sendButton(pointer.x, pointer.y, 2, true);
    sendButton(pointer.x, pointer.y, 2, false);
    return;
  }
  if (gesture.travel > padTapSlop) return;
  // A jittery tap clicks where the pointer was when the finger landed.
  if (pointer.x !== gesture.start.x || pointer.y !== gesture.start.y) movePointerTo(gesture.start.x, gesture.start.y);
  // It landed soon after a tap, so it is the second click of a double click however long it rested.
  const second = gesture.chained;
  lastPadTap = second ? undefined : now;
  sendButton(pointer.x, pointer.y, 0, true);
  sendButton(pointer.x, pointer.y, 0, false);
  const at = toScreen(pointer);
  if (onAddressBar(pointer)) { tapAddressBar(at, second); return; }
  checkFocusAfterTap(pointer.y, second ? { offer: { x: at.x, y: at.y, touch: touchCount } } : {});
}
// The one place a held Trackpad button comes up. Every path that ends a gesture or a session reaches it.
function releasePad(gesture) {
  if (!gesture?.held) return;
  gesture.held = false;
  sendButton(pointer.x, pointer.y, 0, false);
}
// When zoomed past Fit the view scrolls to keep the pointer 40 px inside the visible area below the bar.
function followView() {
  const size = framebufferSize();
  if (!pointer || !size || !(displayScale > fitScale(size) + 0.001)) return;
  const b = visibleBounds(), top = Math.max(b.top, barHidden() ? 0 : bar.getBoundingClientRect().bottom);
  const { dx, dy } = followPointer(toScreen(pointer), { left: b.left, top, width: b.width, height: b.top + b.height - top }, 40);
  if (!dx && !dy) return;
  viewport.scrollLeft += dx;
  viewport.scrollTop += dy;
  drawPointer();
}
const holdsButton = gesture => gesture.kind === 'hold';
function beginHold(gesture) {
  if (gesture !== touchGesture || gesture.moved || !controlReady || accessEnded) return;
  gesture.kind = 'hold';
  gesture.remoteDown = true;
  gesture.fb = toFramebuffer(gesture);
  gesture.canvas.dispatchEvent(new PointerEvent('mousedown', mouseOptions(gesture.x, gesture.y, 1)));
  // As on Android, Copy or Paste shows while the finger is still down. Sliding instead hides it and drags.
  offerAfterHold(gesture, gesture.fb, false);
}
function releaseTouchDrag(gesture = touchGesture) {
  clearTimeout(gesture?.holdTimer);
  if (!gesture?.remoteDown) return;
  gesture.remoteDown = false;
  // Route up through noVNC's window capture proxy so it also removes the
  // capture overlay and flushes any queued held-button movement.
  window.dispatchEvent(new PointerEvent('mouseup', mouseOptions(gesture.lastX, gesture.lastY, 0)));
}
function cancelTouchInput() {
  releaseTouchDrag();
  releasePad(padGesture);
  touchGesture = undefined;
  padGesture = undefined;
}
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelTouchInput(); });
function beginPinch(touches) {
  releaseTouchDrag();
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

// The touch path already handled the viewer's own synthetic events and the mouse events a phone fires after a tap.
viewport.addEventListener('mousedown', (event) => {
  if (!usesMouse || !event.isTrusted || event.button !== 0) return;
  if (sheetOpen()) { closeSheet(); event.preventDefault(); event.stopImmediatePropagation(); return; }
  if (controlReady && !accessEnded && !barHidden()) hideBar();
}, true);

// Fingers whose touchstart landed on the page. One that started on the bar or the tab stays in event.touches
// while it is down, so gestures read only these and a resting finger on the bar never becomes a second finger.
const pageTouches = new Set();
// A held button shows noVNC's capture overlay over everything, so a second finger then lands on it, not the viewport.
const onPage = target => target instanceof Node && (viewport.contains(target) || target.id === 'noVNC_mouse_capture_elem');

// Capture touch before noVNC's gesture recognizer. Listen at window because
// native dragging creates a capture overlay outside the viewport, and a second
// finger can start on that overlay. Ordinary desktop mouse events are untouched.
for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) window.addEventListener(type, (event) => {
  const changed = [...event.changedTouches];
  const ours = changed.filter(t => (type === 'touchstart' ? onPage(t.target) : pageTouches.has(t.identifier)));
  if (type === 'touchstart') {
    // Phones reuse touch ids, so drop any whose end never arrived before counting the new finger.
    const down = new Set([...event.touches].map(t => t.identifier));
    for (const id of pageTouches) if (!down.has(id)) pageTouches.delete(id);
    // A new finger may reuse the id of one whose end went to a removed overlay. An id that lands off the page is dropped too.
    for (const t of changed) if (!ours.includes(t)) pageTouches.delete(t.identifier);
    for (const t of ours) pageTouches.add(t.identifier);
  } else if (type !== 'touchmove') for (const t of changed) pageTouches.delete(t.identifier);
  if (!touchGesture && !padGesture && !event.composedPath().includes(viewport)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (type === 'touchcancel') { cancelTouchInput(); return; }
  // A finger that started on the bar or the tab neither starts, joins nor ends a page gesture.
  if (!ours.length) return;
  const touches = [...event.touches].filter(t => pageTouches.has(t.identifier));
  if (type === 'touchstart') {
    touchCount++;
    hideQuickActions();
    // While the sheet is open a tap on the page only closes it. The whole gesture is swallowed.
    if (touchGesture?.swallowed) return;
    if (sheetOpen() && !touchGesture && !padGesture) { closeSheet(); touchGesture = { swallowed: true }; return; }
    // The first touch on the page in control tucks the bar away, and the same gesture carries on below. Focus stays where it is.
    if (controlReady && !accessEnded && !barHidden() && !touchGesture && !padGesture) hideBar();
    if (padGesture || (!touchGesture && inputMode === 'trackpad' && controlReady && !accessEnded)) return trackpadTouch(type, touches);
    if (touches.length >= 2) beginPinch(touches);
    else if (!touchGesture) {
      const canvas = screen.querySelector('canvas'), size = framebufferSize();
      if (!canvas || !size) return;
      const kind = displayScale > fitScale(size) + 0.001 ? 'pan' : 'scroll';
      touchGesture = { pinch: false, kind, canvas, x: touches[0].clientX, y: touches[0].clientY,
        lastX: touches[0].clientX, lastY: touches[0].clientY,
        left: viewport.scrollLeft, top: viewport.scrollTop, moved: false, wheelX: 0, wheelY: 0 };
      if (controlReady && !accessEnded) touchGesture.holdTimer = setTimeout(beginHold, holdDelayMs, touchGesture);
    }
    return;
  }
  if (padGesture) return trackpadTouch(type, touches);
  if (!touchGesture) return;
  if (type === 'touchmove') {
    if (touchGesture.swallowed) return;
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
        if (!gesture.dragging && Math.hypot(x - gesture.x, y - gesture.y) > 8) { gesture.dragging = true; hideQuickActions(); }
        if (gesture.remoteDown) window.dispatchEvent(new PointerEvent('mousemove', mouseOptions(x, y, 1)));
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
  if (gesture.swallowed) return;
  if (holdsButton(gesture) && controlReady && !accessEnded) offerAfterHold({ x: gesture.lastX, y: gesture.lastY }, gesture.fb, Boolean(gesture.dragging));
  if (gesture.pinch || holdsButton(gesture) || gesture.moved || !controlReady || accessEnded) return;
  const point = repeatTapPoint(gesture);
  lastTouchTapFb = toFramebuffer(point);
  gesture.canvas.dispatchEvent(new PointerEvent('mousedown', mouseOptions(point.x, point.y, 1)));
  // noVNC's window capture proxy must receive mouseup to release its overlay.
  window.dispatchEvent(new PointerEvent('mouseup', mouseOptions(point.x, point.y, 0)));
  if (onAddressBar(lastTouchTapFb)) { tapAddressBar(point, point.repeat); return; }
  checkFocusAfterTap((point.y - gesture.canvas.getBoundingClientRect().top) / displayScale, point.repeat ? { offer: { x: point.x, y: point.y, touch: touchCount } } : {});
}, { capture: true, passive: false });

// probe.js is a module, so tests reach these through window. Each does only what the owner can do with a tap.
window.__viewer = { hideBar, showBar, barHidden, zoomTo, openSheet, closeSheet, sheetOpen, setHint, setInputMode, pointer: () => pointer,
  // Test hooks: flip control without a reconnect, and read which gestures are alive.
  setControlReady(value) { controlReady = value; updateInputControls(); drawPointer(); },
  gestures: () => ({ touch: Boolean(touchGesture), pad: Boolean(padGesture) }) };
