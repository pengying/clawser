import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CdpConnection } from '../src/cdp.mjs';
import { readFocus } from '../src/focus-state.mjs';
import { skip as noX, startX } from '../runtime/desktop/test/xvfb.mjs';

const chromePath = process.env.CHROME_BIN || '/usr/bin/google-chrome-stable';
const hasOpenbox = (() => { try { execFileSync('which', ['openbox'], { stdio: 'ignore' }); return true; } catch { return false; } })();
// Without a window manager, a click never gives Chrome's window keyboard focus. Setup always runs openbox.
const skip = noX || (!existsSync(chromePath) ? 'Chrome unavailable' : !hasOpenbox ? 'needs openbox' : false);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const execute = promisify(execFile);

// The test display is 640x480, so every target sits inside a 640x480 window.
const PAGE = `<!doctype html><body style="margin:0">
  <input id="name" style="position:absolute;left:10px;top:10px;width:260px;height:24px">
  <input id="phone" type="tel" style="position:absolute;left:10px;top:42px;width:260px;height:24px">
  <input id="code" inputmode="numeric" style="position:absolute;left:10px;top:74px;width:260px;height:24px">
  <textarea id="note" style="position:absolute;left:10px;top:106px;width:260px;height:40px"></textarea>
  <div id="rich" contenteditable="true" style="position:absolute;left:10px;top:154px;width:260px;height:24px"></div>
  <input id="secret" type="password" value="hunter2" style="position:absolute;left:10px;top:186px;width:260px;height:24px">
  <button id="plain" style="position:absolute;left:10px;top:218px;width:260px;height:24px">Plain</button>
  <input id="locked" readonly value="fixed" style="position:absolute;left:10px;top:250px;width:260px;height:24px">
  <p id="words" style="position:absolute;left:10px;top:282px;width:260px;margin:0">quiet words to select</p>
  <iframe id="frame" src="/inner" style="position:absolute;left:300px;top:10px;width:300px;height:60px"></iframe>
  <iframe id="cross" src="http://localhost:PORT/inner" style="position:absolute;left:300px;top:90px;width:300px;height:60px"></iframe>
</body>`;
const INNER = '<!doctype html><body style="margin:0"><input id="card" inputmode="numeric" value="4242" style="width:260px;height:24px"></body>';

// A windowed Chrome on a private display, so Chrome's own toolbar exists and can take focus.
async function windowedChrome(t) {
  const display = await startX({ numbered: true });
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(req.url.startsWith('/inner') ? INNER : PAGE.replace('PORT', server.address().port)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = await mkdtemp(join(tmpdir(), 'focus-state-'));
  const wm = spawn('openbox', [], { env: display.env, stdio: 'ignore' });
  await pause(500);
  const chrome = spawn(chromePath, ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--ozone-platform=x11', '--password-store=basic', '--window-position=0,0', '--window-size=640,480',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `http://127.0.0.1:${server.address().port}/`], { env: display.env, stdio: 'ignore' });
  const pages = [];
  t.after(async () => {
    for (const page of pages) page.close();
    if (chrome.exitCode === null && chrome.signalCode === null) { const exited = once(chrome, 'exit'); chrome.kill('SIGTERM'); await exited; }
    if (wm.exitCode === null && wm.signalCode === null) { const exited = once(wm, 'exit'); wm.kill('SIGTERM'); await exited; }
    server.close();
    await display.stop();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let port;
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { await pause(50); }
  }
  assert.ok(port, 'windowed Chrome started');
  const cdpUrl = `http://127.0.0.1:${port}`;
  const tabs = async () => (await fetch(cdpUrl + '/json/list')).json();
  let target;
  for (let attempt = 0; attempt < 200 && !target; attempt++) {
    target = (await tabs()).find(tab => tab.type === 'page' && tab.url.startsWith('http://127.0.0.1'));
    if (!target) await pause(50);
  }
  const page = await new CdpConnection({ commandTimeoutMs: 10_000 }).connect(target.webSocketDebuggerUrl);
  pages.push(page);
  const evaluate = async expression => (await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  for (let attempt = 0; attempt < 200 && !(await evaluate('document.readyState === "complete" && !!document.getElementById("frame").contentDocument?.getElementById("card")')); attempt++) await pause(50);
  for (let attempt = 0; attempt < 200 && !(await evaluate('document.visibilityState === "visible" && document.hasFocus()')); attempt++) await pause(50);
  let crossTarget;
  for (let attempt = 0; attempt < 200 && !crossTarget; attempt++) {
    crossTarget = (await tabs()).find(tab => tab.type === 'iframe' && tab.url.startsWith('http://localhost'));
    if (!crossTarget) await pause(50);
  }
  assert.ok(crossTarget, 'the cross-site frame runs as its own target');
  const cross = await new CdpConnection({ commandTimeoutMs: 10_000 }).connect(crossTarget.webSocketDebuggerUrl);
  pages.push(cross);
  // Focus goes straight to the element. Clicking by screen position depends on how each Chrome build lays out its window.
  const focusElement = async (selector, connection = page) => {
    const reply = await connection.send('Runtime.evaluate', { expression: selector + '.focus()', userGesture: true });
    assert.ok(!reply.exceptionDetails, selector);
    await pause(100);
  };
  // Real X input, as the viewer's taps reach Chrome through x11vnc.
  const x = script => execute('python3', ['-c', `import ctypes,time
x=ctypes.CDLL('libX11.so.6'); t=ctypes.CDLL('libXtst.so.6'); x.XOpenDisplay.restype=ctypes.c_void_p
d=ctypes.c_void_p(x.XOpenDisplay(None))
def key(*names):
  codes=[x.XKeysymToKeycode(d,x.XStringToKeysym(n.encode())) for n in names]
  for c in codes: t.XTestFakeKeyEvent(d,c,1,0)
  for c in reversed(codes): t.XTestFakeKeyEvent(d,c,0,0)
  x.XFlush(d)
def click(px,py):
  t.XTestFakeMotionEvent(d,-1,px,py,0); t.XTestFakeButtonEvent(d,1,1,0); t.XTestFakeButtonEvent(d,1,0,0); x.XFlush(d)
${script}
time.sleep(0.4)`], { env: display.env });
  return { runtime: { cdpUrl, tabs }, evaluate, x, focusElement, page, cross, cdpUrl };
}

test('the focused field is reported with its keyboard type and never its contents', { skip, timeout: 120_000 }, async t => {
  const chrome = await windowedChrome(t);
  const cases = [
    ['document.getElementById("name")', { kind: 'editable', inputMode: 'text', multiline: false }],
    ['document.getElementById("phone")', { kind: 'editable', inputMode: 'tel', multiline: false }],
    ['document.getElementById("code")', { kind: 'editable', inputMode: 'numeric', multiline: false }],
    ['document.getElementById("note")', { kind: 'editable', inputMode: 'text', multiline: true }],
    ['document.getElementById("rich")', { kind: 'editable', inputMode: 'text', multiline: true }],
    ['document.getElementById("secret")', { kind: 'editable', inputMode: 'text', multiline: false }],
    ['document.getElementById("plain")', { kind: 'none' }],
    ['document.getElementById("locked")', { kind: 'none' }],
    ['document.getElementById("frame").contentDocument.getElementById("card")', { kind: 'editable', inputMode: 'numeric', multiline: false }],
  ];
  for (const [selector, expected] of cases) {
    await chrome.focusElement(selector);
    const focus = await readFocus(chrome.runtime);
    assert.deepEqual(focus, expected, selector);
    assert.doesNotMatch(JSON.stringify(focus), /hunter2|4242|fixed|name|phone|secret|card/, 'no field contents or names leave the browser');
  }
  // A cross-site frame, such as a hosted card form, runs as its own target.
  await chrome.focusElement('document.getElementById("card")', chrome.cross);
  assert.deepEqual(await readFocus(chrome.runtime), { kind: 'editable', inputMode: 'numeric', multiline: false }, 'cross-site frame');
  await chrome.focusElement('document.getElementById("plain")');
  assert.deepEqual(await readFocus(chrome.runtime), { kind: 'none' }, 'focus left the cross-site frame');
});

test('selected text is reported as a yes, never as the text', { skip, timeout: 120_000 }, async t => {
  const chrome = await windowedChrome(t);
  const read = async (expected, message) => {
    const focus = await readFocus(chrome.runtime);
    assert.deepEqual(focus, expected, message);
    assert.doesNotMatch(JSON.stringify(focus), /hello|quiet|words|fixed|hunter2/, 'no selected text leaves the browser');
  };
  await chrome.focusElement('document.getElementById("name")');
  await chrome.evaluate('document.getElementById("name").value = "hello world"; document.getElementById("name").setSelectionRange(0, 5)');
  await read({ kind: 'editable', inputMode: 'text', multiline: false, selected: true }, 'part of a field is selected');
  await chrome.evaluate('document.getElementById("name").setSelectionRange(5, 5)');
  await read({ kind: 'editable', inputMode: 'text', multiline: false }, 'a caret is not a selection');
  await chrome.focusElement('document.getElementById("secret")');
  await chrome.evaluate('document.getElementById("secret").select()');
  await read({ kind: 'editable', inputMode: 'text', multiline: false }, 'Chrome never copies from a password field, so offer no Copy');
  await chrome.focusElement('document.getElementById("locked")');
  await chrome.evaluate('document.getElementById("locked").select()');
  await read({ kind: 'none', selected: true }, 'a read-only field can still be copied from');
  await chrome.focusElement('document.getElementById("plain")');
  await chrome.evaluate('getSelection().selectAllChildren(document.getElementById("words"))');
  await read({ kind: 'none', selected: true }, 'page text is selected');
  await chrome.evaluate('getSelection().removeAllRanges()');
  await read({ kind: 'none' }, 'the selection was cleared');
});

test('Chrome toolbar focus is reported as browser UI, and the page again after Escape', { skip, timeout: 120_000 }, async t => {
  const chrome = await windowedChrome(t);
  await chrome.focusElement('document.getElementById("name")');
  assert.equal((await readFocus(chrome.runtime)).kind, 'editable');
  await chrome.x("key('Control_L', 'l')");
  assert.deepEqual(await readFocus(chrome.runtime), { kind: 'browser-ui' });
  await chrome.x("key('Escape'); key('Escape')");
  await chrome.focusElement('document.getElementById("plain")');
  assert.deepEqual(await readFocus(chrome.runtime), { kind: 'none' });
});

test('a page blocked by a JavaScript dialog reports unknown within the deadline', { skip, timeout: 120_000 }, async t => {
  const chrome = await windowedChrome(t);
  await chrome.page.send('Runtime.evaluate', { expression: 'setTimeout(() => prompt("Your name?"), 20)' });
  await pause(600);
  const started = Date.now();
  assert.deepEqual(await readFocus(chrome.runtime, { timeoutMs: 800 }), { kind: 'unknown' });
  assert.ok(Date.now() - started < 2000, 'a blocked page cannot hold the check: ' + (Date.now() - started) + ' ms');
});

test('an unreachable browser reports unknown instead of throwing', async () => {
  assert.deepEqual(await readFocus({ cdpUrl: 'http://127.0.0.1:9', tabs: async () => { throw new Error('CDP tabs unavailable'); } }), { kind: 'unknown' });
  assert.deepEqual(await readFocus({ cdpUrl: 'http://127.0.0.1:9', tabs: async () => [] }), { kind: 'none' });
});
