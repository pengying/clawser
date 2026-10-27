// Fixed, value-free DOM capability. No viewer-provided script/selector is used.
export function interactionCollector(documentId) {
  return `(${collect.toString()})(${JSON.stringify(documentId)})`;
}
function collect(seed) {
  let state = globalThis.__openclawHandoffMetadata;
  if (!state || state.seed !== seed) state = globalThis.__openclawHandoffMetadata = { seed, ids: new WeakMap(), next: 0 };
  const id = (node) => { if (!state.ids.has(node)) state.ids.set(node, state.seed + ':' + (++state.next)); return state.ids.get(node); };
  const regions = []; let inspected = 0, documents = 0, focus = null, pickerFocus = null;
  const viewport = globalThis.visualViewport;
  const scale = viewport?.scale || 1, left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
  const viewWidth = innerWidth / scale, viewHeight = innerHeight / scale;
  const textTypes = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);
  const modes = new Set(['text', 'decimal', 'numeric', 'tel', 'search', 'email', 'url']);
  function active(root) {
    let node = root.activeElement;
    for (let n = 0; n < 8 && node; n++) {
      if (node.shadowRoot?.activeElement) { node = node.shadowRoot.activeElement; continue; }
      try { if (node.contentDocument?.activeElement) { node = node.contentDocument.activeElement; continue; } } catch {}
      break;
    }
    return node;
  }
  const focused = active(document);
  if (state.picker) {
    const picker = state.picker;
    if (!picker.node?.isConnected || picker.document !== state.seed || state.ids.get(picker.node) !== picker.id || focused !== picker.node)
      state.picker = null;
    else pickerFocus = picker.id;
  }
  function visit(root, offsetX = 0, offsetY = 0, scaleX = 1, scaleY = 1, depth = 0, clip = { left, top, right: left + viewWidth, bottom: top + viewHeight }) {
    if (depth > 8 || regions.length >= 128 || inspected >= 4000) return;
    for (const node of root.querySelectorAll('*')) {
      if (++inspected > 4000 || regions.length >= 128) break;
      const rect = node.getBoundingClientRect();
      const x = offsetX + rect.left * scaleX, y = offsetY + rect.top * scaleY;
      const w = rect.width * scaleX, h = rect.height * scaleY;
      const visible = w > 1 && h > 1 && x + w > clip.left && y + h > clip.top && x < clip.right && y < clip.bottom;
      const editable = !node.disabled && !node.readOnly &&
        (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT' && textTypes.has(node.type) || node.isContentEditable && !node.parentElement?.isContentEditable);
      const picker = !node.matches(':disabled') && (node.tagName === 'SELECT' || node.tagName === 'INPUT' && node.type === 'color');
      // Links and images are implicitly draggable in HTML. Ordinary swipes on
      // them must remain native touch scrolling, not automatic mouse dragging.
      const explicitDrag = node.draggable && node.getAttribute('draggable')?.toLowerCase() === 'true';
      if (visible && (editable || picker || explicitDrag)) {
        const style = node.ownerDocument.defaultView.getComputedStyle(node);
        if (style.visibility !== 'hidden' && style.display !== 'none') {
          const x1 = (Math.max(x, clip.left) - left) / viewWidth, y1 = (Math.max(y, clip.top) - top) / viewHeight;
          const x2 = (Math.min(x + w, clip.right) - left) / viewWidth, y2 = (Math.min(y + h, clip.bottom) - top) / viewHeight;
          const region = { id: id(node), x: x1, y: y1, width: x2 - x1, height: y2 - y1, kind: editable ? 'editable' : picker ? 'picker' : 'drag' };
          if (editable) {
            region.password = node.type === 'password'; region.multiline = node.tagName === 'TEXTAREA' || node.isContentEditable;
            region.inputMode = modes.has(node.inputMode) ? node.inputMode : modes.has(node.type) ? node.type : 'text';
            if (focused === node || node.isContentEditable && node.contains(focused)) focus = region.id;
          } else if (picker) region.pickerType = node.tagName === 'SELECT' ? 'select' : 'color';
          regions.push(region);
        }
      }
      if (node.shadowRoot) visit(node.shadowRoot, offsetX, offsetY, scaleX, scaleY, depth + 1, clip);
      if (node.tagName === 'IFRAME' && visible && documents < 8) {
        try {
          const child = node.contentDocument;
          if (child && node.offsetWidth && node.offsetHeight) {
            const childScaleX = scaleX * rect.width / node.offsetWidth, childScaleY = scaleY * rect.height / node.offsetHeight;
            const childX = x + node.clientLeft * childScaleX, childY = y + node.clientTop * childScaleY;
            const childClip = { left: Math.max(clip.left, childX), top: Math.max(clip.top, childY), right: Math.min(clip.right, childX + node.clientWidth * childScaleX), bottom: Math.min(clip.bottom, childY + node.clientHeight * childScaleY) };
            if (childClip.left < childClip.right && childClip.top < childClip.bottom) {
              documents++; visit(child, childX, childY, childScaleX, childScaleY, depth + 1, childClip);
            }
          }
        } catch { /* Cross-origin frames have no implicit page-value access. */ }
      }
    }
  }
  visit(document);
  if (pickerFocus && !regions.some((region) => region.kind === 'picker' && region.id === pickerFocus)) {
    state.picker = null; pickerFocus = null;
  }
  return { document: state.seed, regions, focus, pickerFocus };
}
