import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CdpConnection } from '../src/cdp.mjs';

const chromePath = process.env.CHROME_BIN || '/usr/bin/google-chrome-stable';
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('phone picker renders literal options and provides safe local select/color controls', { skip: !existsSync(chromePath) }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'handoff-picker-ui-'));
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/assets/picker.js') {
        response.setHeader('Content-Type', 'text/javascript');
        return response.end(await readFile(new URL('../public/picker.js', import.meta.url)));
      }
      if (request.url === '/assets/style.css') {
        response.setHeader('Content-Type', 'text/css');
        return response.end(await readFile(new URL('../public/style.css', import.meta.url)));
      }
      if (request.url === '/assets/viewer.js') {
        response.setHeader('Content-Type', 'text/javascript');
        return response.end('');
      }
      response.setHeader('Content-Type', 'text/html');
      response.end((await readFile(new URL('../public/index.html', import.meta.url), 'utf8')).replace(
        '</body>',
        `<script type="module">
          import { NativePickerUI } from '/assets/picker.js';
          window.actions = [];
          window.picker = new NativePickerUI({
            onApply: (detail) => actions.push({ type: 'apply', detail }),
            onCancel: () => {
              window.cancelActiveToken = picker.active?.token;
              actions.push({ type: 'cancel' });
            },
          });
        </script></body>`,
      ));
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const chrome = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank',
  ], { stdio: 'ignore' });
  let cdp;
  t.after(async () => {
    cdp?.close();
    chrome.kill('SIGTERM');
    await new Promise((resolve) => server.close(resolve));
    await pause(100);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  let port;
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    try { port = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
    catch { await pause(30); }
  }
  assert.ok(port, 'Chromium started');
  const browserBase = `http://127.0.0.1:${port}`;
  const page = await (await fetch(`${browserBase}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.address().port}`)}`, { method: 'PUT' })).json();
  cdp = await new CdpConnection().connect(page.webSocketDebuggerUrl);
  const evaluate = async (expression) => {
    const reply = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text);
    return reply.result.value;
  };
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate('Boolean(window.picker)')) break;
    await pause(20);
  }
  assert.equal(await evaluate('picker.active'), null);

  const single = {
    kind: 'select', token: 'a'.repeat(32), document: 'b'.repeat(32), id: `${'b'.repeat(32)}:4`,
    options: [
      { index: 0, label: '<img id="injected"> literal', group: 'Safe group', disabled: false, selected: true },
      { index: 1, label: 'Disabled', disabled: true, selected: false },
      { index: 2, label: 'Third', disabled: false, selected: false },
    ],
  };
  await evaluate(`picker.show(${JSON.stringify(single)})`);
  assert.deepEqual(await evaluate(`({
    open: document.querySelector('#nativePicker').open,
    active: picker.active?.token,
    injected: Boolean(document.querySelector('#injected')),
    first: document.querySelector('.picker-option').textContent,
    disabled: document.querySelectorAll('.picker-option')[1].disabled,
  })`), { open: true, active: single.token, injected: false, first: single.options[0].label, disabled: true });
  const replacementSingle = { ...single, token: 'e'.repeat(32), options: [{ index: 41, label: 'Current choice' }] };
  await evaluate(`(() => {
    window.detachedOption = document.querySelectorAll('.picker-option')[2];
    picker.show(${JSON.stringify(replacementSingle)});
    detachedOption.click();
  })()`);
  assert.deepEqual(await evaluate(`({ actions, active: picker.active?.token, currentDisabled: document.querySelector('.picker-option').disabled })`), {
    actions: [], active: replacementSingle.token, currentDisabled: false,
  }, 'a detached option from an earlier show cannot apply or busy-lock the current picker');
  await evaluate(`document.querySelector('.picker-option').click()`);
  assert.deepEqual(await evaluate('actions'), [{ type: 'apply', detail: { indices: [41] } }], 'the current option still applies');
  await evaluate(`picker.setBusy(false); picker.close(); actions.length = 0; picker.show(${JSON.stringify(single)})`);
  await evaluate(`document.querySelectorAll('.picker-option')[2].click(); document.querySelectorAll('.picker-option')[2].click()`);
  assert.deepEqual(await evaluate('actions'), [{ type: 'apply', detail: { indices: [2] } }], 'single selection applies once and locks while pending');
  assert.equal(await evaluate(`picker.active.token`), single.token);
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  assert.equal(await evaluate('actions.length'), 1, 'busy picker ignores Escape');
  await evaluate('picker.setBusy(false); picker.close()');
  assert.deepEqual(await evaluate('({ active: picker.active, actions })'), { active: null, actions: [{ type: 'apply', detail: { indices: [2] } }] }, 'programmatic close is silent');

  const multiple = {
    ...single, token: 'c'.repeat(32), multiple: true,
    options: [
      { index: 3, label: 'Three', selected: true },
      { index: 8, label: 'Eight', selected: false },
      { index: 13, label: 'Thirteen', selected: true, disabled: true },
    ],
  };
  await evaluate(`picker.show(${JSON.stringify(multiple)}); document.querySelectorAll('.picker-option input')[1].click(); document.querySelector('.picker-apply').click()`);
  assert.deepEqual(await evaluate('actions.at(-1)'), { type: 'apply', detail: { indices: [3, 8, 13] } });
  await evaluate('picker.setBusy(false); document.querySelector(".picker-cancel").click()');
  assert.deepEqual(await evaluate('actions.at(-1)'), { type: 'cancel' });
  assert.equal(await evaluate('cancelActiveToken'), multiple.token, 'cancel callback can inspect the active descriptor');
  assert.equal(await evaluate('picker.active'), null);

  const color = { kind: 'color', token: 'd'.repeat(32), document: 'b'.repeat(32), id: `${'b'.repeat(32)}:7`, value: '#123456' };
  const replacementColor = { ...color, token: 'f'.repeat(32), value: '#654321' };
  await evaluate(`(() => {
    picker.show(${JSON.stringify(color)});
    window.detachedColor = document.querySelector('.picker-color');
    window.detachedHex = document.querySelector('.picker-hex');
    picker.show(${JSON.stringify(replacementColor)});
    const currentHex = document.querySelector('.picker-hex');
    currentHex.value = 'bad';
    currentHex.dispatchEvent(new Event('input', { bubbles: true }));
    detachedColor.value = '#abcdef';
    detachedColor.dispatchEvent(new Event('input', { bubbles: true }));
    detachedHex.value = 'fedcba';
    detachedHex.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  assert.deepEqual(await evaluate(`({
    active: picker.active?.token,
    disabled: document.querySelector('.picker-apply').disabled,
    hex: document.querySelector('.picker-hex').value,
    swatch: document.querySelector('.picker-color').value,
  })`), { active: replacementColor.token, disabled: true, hex: 'bad', swatch: '#654321' }, 'detached color controls cannot alter current validity or values');
  await evaluate('picker.close()');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 289, deviceScaleFactor: 1, mobile: true });
  await evaluate(`(() => { picker.show(${JSON.stringify(color)}); const hex = document.querySelector('.picker-hex'); hex.focus(); hex.select(); })()`);
  assert.deepEqual(await evaluate(`(() => {
    const dialog = document.querySelector('#nativePicker').getBoundingClientRect();
    const actions = document.querySelector('.picker-actions').getBoundingClientRect();
    return {
      compact: dialog.height <= 60 && Math.abs(actions.top - dialog.top) < 8,
      visibleTop: document.querySelector('#nativePicker').style.getPropertyValue('--picker-visible-top'),
    };
  })()`), { compact: true, visibleTop: `${await evaluate('visualViewport.offsetTop')}px` }, 'landscape keyboard focus compacts and anchors all color actions to the visual viewport');
  await cdp.send('Input.insertText', { text: 'Aa00fF' });
  assert.deepEqual(await evaluate(`({ value: document.querySelector('.picker-hex').value, swatch: document.querySelector('.picker-color').value, disabled: document.querySelector('.picker-apply').disabled })`), {
    value: 'Aa00fF', swatch: '#aa00ff', disabled: false,
  }, 'six-digit hex accepts normal keyboard typing and updates the local swatch');
  await evaluate(`document.querySelector('.picker-apply').click()`);
  assert.deepEqual(await evaluate('actions.at(-1)'), { type: 'apply', detail: { color: '#aa00ff' } });
  await evaluate(`(() => { picker.setBusy(false); picker.show(${JSON.stringify(color)}); const hex = document.querySelector('.picker-hex'); hex.value = 'nope'; hex.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.equal(await evaluate('document.querySelector(".picker-apply").disabled'), true, 'invalid color cannot be applied');
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  assert.deepEqual(await evaluate('actions.at(-1)'), { type: 'cancel' }, 'Escape is a local cancel');
  assert.equal(await evaluate('picker.active'), null);
});
