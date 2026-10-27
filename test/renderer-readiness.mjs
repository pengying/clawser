import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CdpBrowser, CdpConnection } from '../src/cdp.mjs';

const chromePath = process.env.CHROME_BIN || process.env.CHROME || '/usr/bin/google-chrome-stable';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, attempts = 240) {
  let last;
  for (let n = 0; n < attempts; n++) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { last = error; }
    await pause(25);
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}

const fixture = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta charset=utf-8><title>renderer readiness fixture</title>
    <style>body{height:3000px;margin:0;font:20px sans-serif}input{position:absolute;left:80px;top:80px;width:360px;height:60px}</style>
    <input id=field autocomplete=off>
    <script>
      window.fixtureReady = true; window.events = [];
      for (const type of ['touchstart','touchend','pointerdown','pointerup','focusin'])
        document.addEventListener(type, event => events.push({type,target:event.target.id||event.target.tagName}), {passive:true});
    </script>`);
});
await new Promise((resolve, reject) => fixture.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
const fixturePort = fixture.address().port;

let activeTrace;
const originalSend = CdpConnection.prototype.send;
CdpConnection.prototype.send = async function tracedSend(method, params = {}) {
  const started = performance.now();
  try {
    const result = await originalSend.call(this, method, params);
    activeTrace?.push({ method, phase: params.type, durationMs: Number((performance.now() - started).toFixed(3)) });
    return result;
  } catch (error) {
    activeTrace?.push({ method, phase: params.type, durationMs: Number((performance.now() - started).toFixed(3)), error: error.message });
    throw error;
  }
};

async function stopChrome(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  await Promise.race([exited, pause(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await Promise.race([once(child, 'exit'), pause(1000)]);
  }
}

async function runCase(mode) {
  if (mode === 'headed' && (!process.env.WAYLAND_DISPLAY || !process.env.XDG_RUNTIME_DIR))
    throw new Error('headed verification requires explicit WAYLAND_DISPLAY and XDG_RUNTIME_DIR');
  const profileDir = await mkdtemp(join(tmpdir(), `browser-handoff-readiness-${mode}-`));
  let chrome, browser, page, backend, stderr = '';
  try {
    const url = `http://127.0.0.1:${fixturePort}/`;
    const args = [
      '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync',
      '--metrics-recording-only', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`, '--window-size=900,700',
      ...(mode === 'headed' ? ['--ozone-platform=wayland'] : ['--headless=new']), url,
    ];
    chrome = spawn(chromePath, args, { env: process.env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    chrome.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-12000); });
    const port = await until(async () => Number((await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), `${mode} Chrome start`);
    const base = `http://127.0.0.1:${port}`;
    const version = await (await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(3000) })).json();
    browser = await new CdpConnection().connect(version.webSocketDebuggerUrl);
    const target = await until(async () => (await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(3000) })).json())
      .find((candidate) => candidate.type === 'page' && candidate.url === url), `${mode} fixture target`);
    page = await new CdpConnection().connect(target.webSocketDebuggerUrl);
    const evaluate = async (expression) => (await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
    await until(() => evaluate('window.fixtureReady === true'), `${mode} fixture DOM`);
    const { windowId } = await browser.send('Browser.getWindowForTarget', { targetId: target.id });
    let frameSeen = false;
    backend = await new CdpBrowser({ fixture: base }).open({ profile: 'fixture', targetId: target.id }, {
      onFrame() { frameSeen = true; }, onMetadata() {}, onClose() {},
    });
    await until(() => frameSeen, `${mode} first frame`);

    if (mode === 'headed') {
      await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      await until(async () => (await browser.send('Browser.getWindowForTarget', { targetId: target.id })).bounds.windowState === 'minimized', 'headed window minimize');
    }
    await evaluate('scrollTo(0,0)');
    activeTrace = [];
    await backend.input({ kind: 'scroll', x: .7, y: .7, deltaX: 0, deltaY: 180 });
    const wheelTrace = activeTrace; activeTrace = undefined;
    await until(async () => (await evaluate('scrollY')) > 0, `${mode} wheel effect`);
    const wheelScrollY = await evaluate('scrollY');
    const wheelMethods = wheelTrace.filter(({ method }) => ['Browser.getWindowForTarget', 'Browser.setWindowBounds', 'Page.bringToFront', 'Page.captureScreenshot', 'Input.dispatchMouseEvent'].includes(method));
    assert.equal(wheelMethods.at(-1)?.phase, 'mouseWheel');
    if (mode === 'headed') {
      assert.deepEqual(wheelMethods.map(({ method }) => method), [
        'Browser.getWindowForTarget', 'Browser.setWindowBounds', 'Page.bringToFront', 'Page.captureScreenshot', 'Input.dispatchMouseEvent',
      ]);
      assert.equal((await browser.send('Browser.getWindowForTarget', { targetId: target.id })).bounds.windowState, 'normal');
    } else {
      assert.deepEqual(wheelMethods.map(({ method }) => method), ['Browser.getWindowForTarget', 'Page.bringToFront', 'Input.dispatchMouseEvent']);
    }

    let touchTrace;
    if (mode === 'headed') {
      await evaluate("scrollTo(0,0);field.blur();events.length=0");
      await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      await until(async () => (await browser.send('Browser.getWindowForTarget', { targetId: target.id })).bounds.windowState === 'minimized', 'headed touch minimize');
      const point = await evaluate("(()=>{const r=field.getBoundingClientRect();return {x:(r.left+r.right)/2/innerWidth,y:(r.top+r.bottom)/2/innerHeight}})()");
      activeTrace = [];
      await backend.input({ kind: 'pointer', phase: 'down', pointerType: 'touch', gesture: 1, ...point });
      await backend.input({ kind: 'pointer', phase: 'up', pointerType: 'touch', gesture: 1, ...point });
      touchTrace = activeTrace; activeTrace = undefined;
      const state = await evaluate("({focused:document.activeElement===field,events:events.map(({type,target})=>({type,target}))})");
      assert.equal(state.focused, true);
      assert.ok(state.events.some(({ type }) => type === 'touchstart'));
      assert.ok(state.events.some(({ type }) => type === 'touchend'));
      assert.equal(touchTrace.filter(({ method }) => method === 'Browser.getWindowForTarget').length, 1);
      assert.equal(touchTrace.filter(({ method }) => method === 'Browser.setWindowBounds').length, 1);
      assert.equal(touchTrace.filter(({ method }) => method === 'Page.captureScreenshot').length, 1);
    }

    return {
      mode, browser: version.Browser, scrollY: wheelScrollY,
      wheel: wheelMethods.map(({ method, phase, durationMs }) => ({ method, ...(phase ? { phase } : {}), durationMs })),
      ...(touchTrace ? { touch: touchTrace.filter(({ method }) => method.startsWith('Browser.') || method === 'Page.bringToFront' || method === 'Page.captureScreenshot' || method === 'Input.dispatchTouchEvent') } : {}),
    };
  } catch (error) {
    if (stderr) error.message += `\nChrome stderr tail:\n${stderr}`;
    throw error;
  } finally {
    activeTrace = undefined;
    try { await backend?.close(); } catch {}
    page?.close(); browser?.close();
    await stopChrome(chrome);
    await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

try {
  const modes = process.env.READINESS_MODES?.split(',').map((value) => value.trim()).filter(Boolean) || ['headless', 'headed'];
  const results = [];
  for (const mode of modes) results.push(await runCase(mode));
  console.log(JSON.stringify({ status: 'PASS', results }, null, 2));
} finally {
  CdpConnection.prototype.send = originalSend;
  await new Promise((resolve) => fixture.close(resolve));
}
