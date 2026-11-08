import { CdpConnection, validateCdpUrl } from './cdp.mjs';

const MODES = new Set(['text', 'decimal', 'numeric', 'tel', 'search', 'email', 'url']);
const TEXT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);

// Runs in an isolated world. It returns the kind of the focused element only, never its value, name or position.
function focusProbe(modes, textTypes) {
  let node = document.activeElement;
  for (let depth = 0; depth < 16 && node; depth++) {
    if (node.shadowRoot?.activeElement) { node = node.shadowRoot.activeElement; continue; }
    let inner;
    try { inner = node.contentDocument?.activeElement; } catch {}
    if (inner) { node = inner; continue; }
    break;
  }
  const frame = node?.tagName === 'IFRAME' || node?.tagName === 'FRAME';
  const editable = !!node && !node.disabled && !node.readOnly && (node.tagName === 'TEXTAREA' ||
    node.tagName === 'INPUT' && textTypes.includes(node.type) || node.isContentEditable);
  const inputMode = !editable ? undefined : modes.includes(node.inputMode) ? node.inputMode
    : node.type === 'number' ? 'decimal' : modes.includes(node.type) ? node.type : 'text';
  return { visible: document.visibilityState === 'visible', focused: document.hasFocus(), frame,
    ...(editable ? { inputMode, multiline: node.tagName === 'TEXTAREA' || node.isContentEditable } : {}) };
}
const EXPRESSION = '(' + focusProbe + ')(' + JSON.stringify([...MODES]) + ',' + JSON.stringify([...TEXT_TYPES]) + ')';

async function inspect(target, origin, deadline) {
  const endpoint = new URL(target.webSocketDebuggerUrl);
  if (endpoint.protocol !== 'ws:' || endpoint.host !== new URL(origin).host || endpoint.username || endpoint.password) return undefined;
  const page = new CdpConnection({ commandTimeoutMs: Math.max(100, deadline - Date.now()) });
  try {
    await page.connect(endpoint.href);
    const tree = await page.send('Page.getFrameTree');
    const world = await page.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'clawser-focus' });
    const reply = await page.send('Runtime.evaluate', { expression: EXPRESSION, contextId: world.executionContextId, returnByValue: true });
    return reply.exceptionDetails ? undefined : reply.result?.value;
  } catch { return undefined; } finally { page.close(); }
}

const editable = state => ({ kind: 'editable', inputMode: state.inputMode, multiline: state.multiline });

// Answers one question for the viewer: does the agent's browser have a text field focused, and which keyboard fits it.
// unknown means it could not tell, for example while a JavaScript dialog blocks the page.
export async function readFocus(runtime, { timeoutMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let targets;
  try {
    const origin = validateCdpUrl(runtime.cdpUrl).origin;
    const tabs = await runtime.tabs();
    if (!Array.isArray(tabs) || tabs.length > 1000) return { kind: 'unknown' };
    targets = tabs.filter(tab => (tab?.type === 'page' || tab?.type === 'iframe') && typeof tab.webSocketDebuggerUrl === 'string' &&
      !String(tab.url || '').startsWith('chrome://')).slice(0, 32).map(tab => ({ tab, origin }));
  } catch { return { kind: 'unknown' }; }
  const pages = targets.filter(({ tab }) => tab.type === 'page');
  if (!pages.length) return { kind: 'none' };
  const states = await Promise.all(targets.map(({ tab, origin }) => inspect(tab, origin, deadline)));
  const byId = new Map(targets.map(({ tab }, index) => [tab.id, states[index]]));
  const shown = pages.map(({ tab }) => ({ tab, state: byId.get(tab.id) })).filter(({ state }) => state?.visible);
  if (!shown.length) return { kind: pages.some(({ tab }) => !byId.get(tab.id)) ? 'unknown' : 'none' };
  const front = shown.find(({ state }) => state.focused) || shown[0];
  if (!front.state.focused) return { kind: 'browser-ui' };
  if (front.state.inputMode) return editable(front.state);
  if (!front.state.frame) return { kind: 'none' };
  // A cross-site frame runs as its own target. Its document has focus when one of its fields does.
  const frames = targets.filter(({ tab }) => tab.type === 'iframe').map(({ tab }) => byId.get(tab.id));
  const inner = frames.find(state => state?.focused && state.inputMode);
  if (inner) return editable(inner);
  return { kind: frames.some(state => !state) ? 'unknown' : 'none' };
}
