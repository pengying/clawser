// Field identities are value-free. Local preedit exists only until commit/clear.
export class EditingBridge {
  constructor({ emit, reject }) { this.emit = emit; this.reject = reject; this.clear(); }
  get active() { return Boolean(this.field); }
  start(field, confirmationId) { this.clear(); this.field = field; this.confirmationId = confirmationId; }
  clear() { this.field = null; this.token = null; this.confirmationId = null; this.pending = []; this.characters = 0; }
  fail(message) { this.clear(); this.reject(message); }
  confirm(id, focus) {
    if (!this.active || id !== this.confirmationId) return;
    if (!focus || focus.id !== this.field.id || focus.document !== this.field.document || !/^[a-f0-9]{32}$/.test(focus.token || '')) {
      this.fail('The focused field changed. Tap it again before typing.'); return;
    }
    this.token = focus.token;
    const pending = this.pending; this.pending = []; this.characters = 0;
    for (const edit of pending) this.send(edit);
  }
  observe(map) {
    if (!this.active) return;
    if (map.document !== this.field.document || this.token && map.focus?.token !== this.token)
      this.fail('The focused field changed. Tap it again before typing.');
  }
  edit(operation, text) {
    if (!this.active) return;
    if (operation === 'insert' && (typeof text !== 'string' || text.length > 16384)) { this.fail('That text is too large. Paste a smaller section.'); return; }
    this.queue({ operation, ...(operation === 'insert' ? { text } : {}) });
  }
  key(key) { if (this.active) this.queue({ operation: 'key', key }); }
  queue(edit) {
    if (this.token) { this.send(edit); return; }
    this.characters += edit.text?.length || 0;
    if (this.pending.length >= 32 || this.characters > 16384) { this.fail('The field has not confirmed focus. Tap it again.'); return; }
    this.pending.push(edit);
  }
  send(edit) {
    if (edit.operation !== 'insert') { this.emit({ kind: 'edit', ...edit, focusToken: this.token }); return; }
    let remaining = edit.text;
    while (remaining) {
      let end = Math.min(4096, remaining.length);
      if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
      this.emit({ kind: 'edit', operation: 'insert', text: remaining.slice(0, end), focusToken: this.token });
      remaining = remaining.slice(end);
    }
  }
}

export class TextComposer {
  constructor(emit, reject = () => {}) { this.emit = emit; this.reject = reject; this.clear(); }
  clear() { this.composing = false; this.trailingComposition = null; }
  compositionStart() { this.composing = true; this.trailingComposition = null; }
  compositionEnd(text) { this.composing = false; this.trailingComposition = text || null; if (text) this.emit('insert', text); }
  consumeComposition(event, value) {
    const committed = this.trailingComposition; this.trailingComposition = null;
    return committed !== null && (/Composition/.test(event.inputType || '') ||
      event.inputType === 'insertText' && (event.data === committed || value === committed));
  }
  replacement() { this.reject('Keyboard replacement is unavailable here. Type or paste the replacement.'); }
  beforeInput(event) {
    if (this.composing || event.isComposing) return false;
    // Some mobile keyboard mutations cannot be canceled. Commit those only
    // from input, after the browser actually applies the local mutation.
    if (event.cancelable === false) return false;
    if (this.consumeComposition(event)) { event.preventDefault(); return true; }
    // Android can emit input even after a canceled Backspace beforeinput.
    // Let it remove the local sentinel and commit once from the input event.
    if (event.inputType === 'deleteContentBackward') return false;
    const operation = { deleteContentForward: 'delete', insertLineBreak: 'enter', insertParagraph: 'enter' }[event.inputType];
    if (operation) { event.preventDefault(); this.emit(operation); return true; }
    if (event.inputType === 'insertReplacementText') { event.preventDefault(); this.replacement(); return true; }
    if (event.inputType?.startsWith('insert') && typeof event.data === 'string') {
      event.preventDefault(); if (event.data) this.emit('insert', event.data); return true;
    }
    return false;
  }
  input(event, value) {
    if (this.composing || event.isComposing) return false;
    const text = value.startsWith('\u200b') ? value.slice(1) : value;
    if (this.consumeComposition(event, text)) return true;
    const operation = { deleteContentBackward: 'backspace', deleteContentForward: 'delete', insertLineBreak: 'enter', insertParagraph: 'enter' }[event.inputType];
    if (event.inputType === 'insertReplacementText') this.replacement();
    else if (operation) this.emit(operation);
    else if (text) this.emit('insert', text);
    return true;
  }
}
