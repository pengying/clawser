const HEX32 = /^[a-f0-9]{32}$/;
const COLOR = /^#[a-f0-9]{6}$/;
const MAX_OPTIONS = 256;

const expression = (request) => `(${nativePickerAction.toString()})(${JSON.stringify(request)})`;

// These builders select one of three fixed isolated-world actions. Viewer data
// is JSON data only; it can never supply script, selectors, or CDP methods.
export function pickerOpen(document, regionId) {
  const index = typeof regionId === 'string' && regionId.length <= 49 ? Number(regionId.slice(33)) : NaN;
  if (!HEX32.test(document) || !Number.isSafeInteger(index) || regionId !== `${document}:${index}` ||
      !/^[a-f0-9]{32}:[1-9][0-9]*$/.test(regionId)) throw new Error('Invalid picker open request');
  return expression({ action: 'open', document, regionId });
}

export function pickerApply(pickerToken, choice) {
  if (!HEX32.test(pickerToken) || !choice || typeof choice !== 'object' || Array.isArray(choice))
    throw new Error('Invalid picker apply request');
  const hasIndices = Object.hasOwn(choice, 'indices'), hasColor = Object.hasOwn(choice, 'color');
  if (hasIndices === hasColor) throw new Error('Invalid picker apply request');
  if (hasIndices && (!Array.isArray(choice.indices) || choice.indices.length > MAX_OPTIONS ||
      choice.indices.some((index, position) => !Number.isSafeInteger(index) || index < 0 || index > 4095 || choice.indices.indexOf(index) !== position)))
    throw new Error('Invalid picker apply request');
  if (hasColor && !COLOR.test(choice.color)) throw new Error('Invalid picker apply request');
  return expression({ action: 'apply', pickerToken, ...(hasIndices ? { indices: choice.indices } : { color: choice.color }) });
}

export function pickerCancel(pickerToken) {
  if (!HEX32.test(pickerToken)) throw new Error('Invalid picker cancel request');
  return expression({ action: 'cancel', pickerToken });
}

function nativePickerAction(request) {
  'use strict';
  const MAX_OPTIONS = 256, MAX_LABEL = 512, MAX_GROUP = 256, MAX_PRIVATE_VALUE = 4096, MAX_TOTAL = 65536;
  const fail = (message) => { throw new Error(message); };
  const state = globalThis.__openclawHandoffMetadata;
  if (!state || typeof state.seed !== 'string' || !(state.ids instanceof WeakMap)) fail('Picker capability is stale');
  const token = () => {
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const active = (root) => {
    let node = root.activeElement;
    for (let depth = 0; depth < 8 && node; depth++) {
      if (node.shadowRoot?.activeElement) { node = node.shadowRoot.activeElement; continue; }
      try { if (node.contentDocument?.activeElement) { node = node.contentDocument.activeElement; continue; } } catch {}
      break;
    }
    return node;
  };
  const parentElement = (node) => node.parentElement || node.getRootNode?.().host || null;
  const locallyVisible = (node) => {
    if (!node?.isConnected || node.hidden || node.closest?.('[hidden],[inert]')) return false;
    for (let current = node; current; current = parentElement(current)) {
      if (current.hidden || current.inert) return false;
      const style = current.ownerDocument.defaultView.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
          style.contentVisibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    const rect = node.getBoundingClientRect(), view = node.ownerDocument.defaultView;
    return rect.width > 1 && rect.height > 1 && rect.right > 0 && rect.bottom > 0 && rect.left < view.innerWidth && rect.top < view.innerHeight;
  };
  const visible = (node) => {
    if (!locallyVisible(node)) return false;
    let view = node.ownerDocument.defaultView;
    for (let depth = 0; depth < 8 && view !== view.top; depth++) {
      let frame;
      try { frame = view.frameElement; } catch { return false; }
      if (!frame || !locallyVisible(frame)) return false;
      view = frame.ownerDocument.defaultView;
    }
    return true;
  };
  const find = (regionId) => {
    let found, inspected = 0, documents = 0;
    const visit = (root, depth = 0) => {
      if (found || depth > 8 || inspected >= 4000) return;
      for (const node of root.querySelectorAll('*')) {
        if (found || ++inspected > 4000) break;
        if (state.ids.get(node) === regionId) { found = node; break; }
        if (node.shadowRoot) visit(node.shadowRoot, depth + 1);
        if (node.tagName === 'IFRAME' && documents < 8) {
          try { if (node.contentDocument) { documents++; visit(node.contentDocument, depth + 1); } } catch {}
        }
      }
    };
    visit(document); return found;
  };
  const optionGroup = (option) => option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement : null;
  const optionHidden = (option) => {
    const group = optionGroup(option);
    if (option.hidden || group?.hidden) return true;
    const style = option.ownerDocument.defaultView.getComputedStyle(option);
    const groupStyle = group && option.ownerDocument.defaultView.getComputedStyle(group);
    return style.display === 'none' || style.visibility === 'hidden' ||
      groupStyle?.display === 'none' || groupStyle?.visibility === 'hidden';
  };
  const optionDisabled = (option) => option.disabled || Boolean(optionGroup(option)?.disabled);
  const opaqueId = (node) => {
    if (node && !state.ids.has(node)) state.ids.set(node, `${state.seed}:option:${token()}`);
    return node ? state.ids.get(node) : null;
  };
  const optionSnapshot = (option, index) => {
    const group = optionGroup(option);
    return {
      id: opaqueId(option), index, value: String(option.value), label: String(option.label),
      group: group ? String(group.label) : null, groupId: opaqueId(group), hidden: optionHidden(option),
      disabled: optionDisabled(option), selected: Boolean(option.selected),
    };
  };
  const snapshotSelect = (node) => {
    if (node.options.length > MAX_OPTIONS) fail('Picker has too many options');
    const options = []; let total = 0;
    for (let index = 0; index < node.options.length; index++) {
      const item = optionSnapshot(node.options[index], index);
      if (item.label.length > MAX_LABEL || (item.group?.length || 0) > MAX_GROUP || item.value.length > MAX_PRIVATE_VALUE)
        fail('Picker option data is too large');
      total += item.label.length + (item.group?.length || 0) + item.value.length;
      if (total > MAX_TOTAL) fail('Picker option data is too large');
      options.push(item);
    }
    return options;
  };
  const sameOption = (before, after) => before.id === after.id && before.index === after.index &&
    before.value === after.value && before.label === after.label && before.group === after.group && before.groupId === after.groupId &&
    before.hidden === after.hidden && before.disabled === after.disabled && before.selected === after.selected;
  const validControl = (node, kind) => node?.isConnected && visible(node) && !node.matches(':disabled') &&
    (kind === 'select' ? node.tagName === 'SELECT' : node.tagName === 'INPUT' && node.type === 'color');
  const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true, composed: true }));

  if (request.action === 'open') {
    state.picker = null;
    if (request.document !== state.seed || typeof request.regionId !== 'string') fail('Picker document changed');
    const node = find(request.regionId);
    const kind = node?.tagName === 'SELECT' ? 'select' : node?.tagName === 'INPUT' && node.type === 'color' ? 'color' : null;
    if (!kind || !validControl(node, kind)) fail('Picker is hidden, disabled, or stale');
    const view = node.ownerDocument.defaultView;
    view.HTMLElement.prototype.focus.call(node, { preventScroll: true });
    if (active(document) !== node || !validControl(node, kind)) fail('Picker could not receive focus');
    let snapshot, descriptor;
    if (kind === 'select') {
      snapshot = snapshotSelect(node);
      descriptor = {
        kind, multiple: Boolean(node.multiple),
        options: snapshot.filter((item) => !item.hidden).map((item) => ({
          index: item.index, label: item.label.replace(/\s+/g, ' ').trim(),
          ...(item.group === null ? {} : { group: item.group.replace(/\s+/g, ' ').trim() }),
          disabled: item.disabled, selected: item.selected,
        })),
      };
    } else {
      const colorspace = node.getAttribute('colorspace');
      if (node.hasAttribute('alpha') || colorspace && colorspace !== 'limited-srgb' || !/^#[a-f0-9]{6}$/.test(node.value))
        fail('Picker color format is unsupported');
      snapshot = node.value;
      descriptor = { kind, value: node.value };
    }
    const pickerToken = token();
    state.picker = { token: pickerToken, document: state.seed, id: request.regionId, kind, node, snapshot,
      ...(kind === 'select' ? { multiple: Boolean(node.multiple) } : {}) };
    return { ...descriptor, token: pickerToken, document: state.seed, id: request.regionId };
  }

  const capability = state.picker;
  if (!capability || request.pickerToken !== capability.token) fail('Picker token is invalid or capability expired');
  if (request.action === 'cancel') { state.picker = null; return null; }
  if (request.action !== 'apply') fail('Unsupported picker action');
  // Any apply attempt consumes the token, including a stale-state rejection.
  state.picker = null;
  const node = capability.node;
  if (capability.document !== state.seed || state.ids.get(node) !== capability.id ||
      !validControl(node, capability.kind) || active(document) !== node)
    fail('Picker focus or control changed');
  if (capability.kind === 'color') {
    if (Object.hasOwn(request, 'indices') || !/^#[a-f0-9]{6}$/.test(request.color || '') ||
        node.hasAttribute('alpha') || node.getAttribute('colorspace') && node.getAttribute('colorspace') !== 'limited-srgb' ||
        node.value !== capability.snapshot) fail('Picker color changed or is unsupported');
    if (node.value === request.color) return null;
    const setter = Object.getOwnPropertyDescriptor(node.ownerDocument.defaultView.HTMLInputElement.prototype, 'value')?.set;
    if (!setter) fail('Picker is unavailable');
    setter.call(node, request.color);
    if (node.value !== request.color) fail('Picker color could not be applied');
    fire(node, 'input'); fire(node, 'change'); return null;
  }
  if (Object.hasOwn(request, 'color') || !Array.isArray(request.indices) || request.indices.length > MAX_OPTIONS ||
      request.indices.some((index, position) => !Number.isSafeInteger(index) || index < 0 || index >= node.options.length || request.indices.indexOf(index) !== position))
    fail('Picker selection is invalid');
  if (Boolean(node.multiple) !== capability.multiple) fail('Picker control changed');
  const current = snapshotSelect(node);
  if (current.length !== capability.snapshot.length || current.some((item, index) => !sameOption(capability.snapshot[index], item)))
    fail('Picker options or selection changed');
  const selected = new Set(request.indices);
  if (!node.multiple && (request.indices.length !== 1 || current[request.indices[0]].hidden || current[request.indices[0]].disabled))
    fail('Picker choice is unavailable');
  if (node.multiple && request.indices.some((index) => (current[index].hidden || current[index].disabled) && !current[index].selected))
    fail('Picker choice is unavailable');
  const expected = current.map((item) => node.multiple && (item.hidden || item.disabled) ? item.selected : selected.has(item.index));
  if (expected.every((value, index) => node.options[index].selected === value)) return null;
  const setter = Object.getOwnPropertyDescriptor(node.ownerDocument.defaultView.HTMLOptionElement.prototype, 'selected')?.set;
  if (!setter) fail('Picker is unavailable');
  for (const item of current) setter.call(node.options[item.index], expected[item.index]);
  if (expected.some((value, index) => node.options[index].selected !== value)) fail('Picker choice could not be applied');
  fire(node, 'input'); fire(node, 'change'); return null;
}
