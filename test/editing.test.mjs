import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditingBridge, TextComposer } from '../public/editing.js';

test('hardware navigation keys use the same confirmed-field token and pending buffer as text', () => {
  const sent = [], bridge = new EditingBridge({ emit: (event) => sent.push(event), reject: assert.fail });
  bridge.start({ document: 'doc', id: 'field' }, 1);
  bridge.key('ArrowLeft'); assert.equal(sent.length, 0);
  bridge.confirm(1, { document: 'doc', id: 'field', token: 'a'.repeat(32) });
  assert.deepEqual(sent, [{ kind: 'edit', operation: 'key', key: 'ArrowLeft', focusToken: 'a'.repeat(32) }]);
});

test('keyboard intents wait for the matching field acknowledgment and cannot replay after clear', () => {
  const sent = [], errors = [];
  const bridge = new EditingBridge({ emit: (event) => sent.push(event), reject: (error) => errors.push(error) });
  bridge.start({ document: 'doc', id: 'field' }, 7);
  bridge.edit('insert', 'hello'); assert.equal(sent.length, 0);
  bridge.confirm(6, { document: 'doc', id: 'field', token: 'a'.repeat(32) });
  assert.equal(sent.length, 0);
  bridge.confirm(7, { document: 'doc', id: 'other', token: 'b'.repeat(32) });
  assert.equal(sent.length, 0); assert.equal(errors.length, 1);
  bridge.start({ document: 'doc', id: 'field' }, 8); bridge.edit('insert', 'new');
  bridge.confirm(8, { document: 'doc', id: 'field', token: 'a'.repeat(32) });
  assert.equal(sent[0].text, 'new'); bridge.clear(); bridge.edit('insert', 'lost');
  assert.equal(sent.length, 1);
});

test('composition emits exactly one committed insertion and handles an empty-buffer Backspace', () => {
  const edits = [], composer = new TextComposer((operation, text) => edits.push({ operation, text }));
  const event = (inputType, data, extra = {}) => ({ inputType, data, preventDefault() {}, ...extra });
  composer.compositionStart();
  composer.beforeInput(event('insertCompositionText', 'に', { isComposing: true }));
  composer.beforeInput(event('insertCompositionText', '日本', { isComposing: true }));
  assert.equal(edits.length, 0);
  composer.compositionEnd('日本'); composer.input(event('insertText', '日本'), '日本');
  assert.deepEqual(edits, [{ operation: 'insert', text: '日本' }]);
  composer.beforeInput(event('deleteContentBackward', null));
  composer.input(event('deleteContentBackward', null), '');
  assert.equal(edits.at(-1).operation, 'backspace');
  composer.clear(); composer.compositionEnd('');
  assert.equal(edits.length, 2);
});

test('Android backward deletion commits once when input follows a cancelable beforeinput', () => {
  const edits = [], composer = new TextComposer((operation, text) => edits.push({ operation, text }));
  composer.beforeInput({ inputType: 'deleteContentBackward', cancelable: true, preventDefault() {} });
  composer.input({ inputType: 'deleteContentBackward', cancelable: false }, '');
  assert.deepEqual(edits, [{ operation: 'backspace', text: undefined }], 'one native Backspace must not delete twice');
});

test('Backspace during IME composition only changes local preedit', () => {
  const edits = [], composer = new TextComposer((operation, text) => edits.push({ operation, text }));
  composer.compositionStart();
  composer.beforeInput({ inputType: 'deleteContentBackward', isComposing: true, cancelable: false });
  composer.input({ inputType: 'deleteContentBackward', isComposing: true }, 'に');
  assert.deepEqual(edits, [], 'preedit deletion must not erase committed remote text');
  composer.compositionEnd('に');
  composer.input({ inputType: 'insertText', data: 'に' }, 'に');
  assert.deepEqual(edits, [{ operation: 'insert', text: 'に' }]);
});

test('stale focus metadata invalidates confirmed typing and buffered text is bounded', () => {
  const sent = [], errors = [];
  const bridge = new EditingBridge({ emit: (event) => sent.push(event), reject: (error) => errors.push(error) });
  bridge.start({ document: 'doc', id: 'field' }, 1);
  bridge.confirm(1, { document: 'doc', id: 'field', token: 'a'.repeat(32) });
  bridge.observe({ document: 'other', focus: null }); bridge.edit('insert', 'wrong');
  assert.equal(sent.length, 0);
  bridge.start({ document: 'doc', id: 'field' }, 2);
  bridge.edit('insert', 'x'.repeat(100000));
  assert.equal(bridge.active, false); assert.ok(errors.length >= 1);
});

test('non-cancelable keyboard events commit only from their input fallback', () => {
  const edits = [], composer = new TextComposer((operation, text) => edits.push({ operation, text }));
  for (const [inputType, data, value] of [
    ['insertText', 'a', '\u200ba'],
    ['deleteContentBackward', null, ''],
    ['insertLineBreak', null, '\u200b\n'],
  ]) {
    let prevented = false;
    const handled = composer.beforeInput({ inputType, data, cancelable: false, preventDefault() { prevented = true; } });
    assert.equal(handled, false, 'an uncancelable mutation must be handled by input, not beforeinput');
    assert.equal(prevented, false);
    composer.input({ inputType, data }, value);
  }
  assert.deepEqual(edits, [{ operation: 'insert', text: 'a' }, { operation: 'backspace', text: undefined }, { operation: 'enter', text: undefined }]);
});

test('uncancelable autocorrect replacement is rejected without appending replacement text', () => {
  const edits = [], errors = [], composer = new TextComposer((...edit) => edits.push(edit), (message) => errors.push(message));
  assert.equal(composer.beforeInput({ inputType: 'insertReplacementText', data: 'the', cancelable: false, preventDefault() {} }), false);
  composer.input({ inputType: 'insertReplacementText', data: 'the' }, 'the');
  assert.deepEqual(edits, []);
  assert.equal(errors.length, 1);
  composer.beforeInput({ inputType: 'insertText', data: 'x', cancelable: true, preventDefault() {} });
  assert.deepEqual(edits, [['insert', 'x']], 'ordinary typing resumes after rejected replacement');
});

test('composition final beforeinput insertion is not committed again', () => {
  const edits = [], composer = new TextComposer((...edit) => edits.push(edit));
  composer.compositionStart(); composer.compositionEnd('日本');
  composer.beforeInput({ inputType: 'insertText', data: '日本', cancelable: true, preventDefault() {} });
  assert.deepEqual(edits, [['insert', '日本']]);
  composer.beforeInput({ inputType: 'insertText', data: '本', cancelable: true, preventDefault() {} });
  assert.deepEqual(edits, [['insert', '日本'], ['insert', '本']]);
});

test('explicit manual keyboard buffers until its separate token ACK and survives focus-null metadata', async () => {
  const { NativeKeyboardBridge } = await import('../public/editing.js');
  const sent = [], errors = [];
  const bridge = new NativeKeyboardBridge({ emit: event => sent.push(event), reject: error => errors.push(error) });
  bridge.start({ document: 'doc' }, 1); bridge.edit('insert', 'manual 😀');
  assert.deepEqual(sent, []);
  bridge.confirm(1, { document: 'doc', token: 'a'.repeat(32) });
  assert.deepEqual(sent, [{ kind: 'nativeEdit', keyboardToken: 'a'.repeat(32), operation: 'insert', text: 'manual 😀' }]);
  bridge.observe({ document: 'doc', focus: null, keyboard: { document: 'doc', token: 'a'.repeat(32) } });
  bridge.edit('backspace'); assert.equal(sent.length, 2); assert.equal(errors.length, 0);
  bridge.observe({ document: 'doc', focus: null, keyboard: null });
  bridge.edit('insert', 'stale'); assert.equal(sent.length, 2); assert.equal(errors.length, 1);
});
