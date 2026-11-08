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
  <iframe id="frame" src="/inner" style="position:absolute;left:300px;top:10px;width:300px;height:60px"></iframe>
</body>`;
const INNER = '<!doctype html><body style="margin:0"><input id="card" inputmode="numeric" value="4242" style="width:260px;height:24px"></body>';

// A windowed Chrome on a private display, so Chrome's own toolbar exists and can take focus.
async function windowedChrome(t) {
  const display = await startX({ numbered: true });
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(req.url.startsWith('/inner') ? INNER : PAGE); });
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
  const clickElement = async selector => {
    // A field inside a frame reports its box relative to that frame, so add the frame's own offset.
    const box = JSON.parse(await evaluate(`JSON.stringify((() => { const node = ${selector}, r = node.getBoundingClientRect();
      const frame = node.ownerDocument.defaultView.frameElement?.getBoundingClientRect() || { x: 0, y: 0 };
      return { x: frame.x + r.x + 10, y: frame.y + r.y + r.height / 2, left: screenX, top: screenY + outerHeight - innerHeight }; })())`));
    await x(`click(${Math.round(box.left + box.x)}, ${Math.round(box.top + box.y)})`);
  };
  return { runtime: { cdpUrl, tabs }, evaluate, x, clickElement, page, cdpUrl };
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
    await chrome.clickElement(selector);
    const focus = await readFocus(chrome.runtime);
    assert.deepEqual(focus, expected, selector);
    assert.doesNotMatch(JSON.stringify(focus), /hunter2|4242|fixed|name|phone|secret|card/, 'no field contents or names leave the browser');
  }
});

test('Chrome toolbar focus is reported as browser UI, and the page again after Escape', { skip, timeout: 120_000 }, async t => {
  const chrome = await windowedChrome(t);
  await chrome.clickElement('document.getElementById("name")');
  assert.equal((await readFocus(chrome.runtime)).kind, 'editable');
  await chrome.x("key('Control_L', 'l')");
  assert.deepEqual(await readFocus(chrome.runtime), { kind: 'browser-ui' });
  await chrome.x("key('Escape'); key('Escape')");
  await chrome.clickElement('document.getElementById("plain")');
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
