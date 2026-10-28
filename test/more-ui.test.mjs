import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpConnection } from '../src/cdp.mjs';
import { HandoffServer } from '../src/server.mjs';

const chromePath = process.env.CHROME_BIN || '/usr/bin/google-chrome-stable';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('More dismisses on outside mouse and touch while preserving local controls and remote input', { skip: !existsSync(chromePath) }, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'handoff-more-ui-'));
  const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let cdp, server;
  t.after(async () => {
    await server?.close(); cdp?.close();
    if (chrome.exitCode === null && chrome.signalCode === null) { const exited = once(chrome, 'exit'); chrome.kill('SIGTERM'); await exited; }
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  let port;
  for (let n = 0; n < 100 && !port; n++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { await pause(25); }
  }
  assert.ok(port, 'disposable Chromium starts');
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  cdp = await new CdpConnection().connect(tab.webSocketDebuggerUrl);
  const evaluate = async expression => {
    const reply = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(reply.exceptionDetails, undefined); return reply.result.value;
  };
  const waitFor = async (check, description) => {
    for (let n = 0; n < 100; n++) { if (await check()) return; await pause(20); }
    assert.fail(description);
  };
  const frame = await evaluate('(()=>{const c=document.createElement("canvas");c.width=1280;c.height=720;return c.toDataURL("image/jpeg").split(",")[1]})()');
  const inputs = [], field = { id: 'fixture-field', document: 'fixture-document', kind: 'editable', x: .7, y: 0, width: .3, height: .5, inputMode: 'text' };
  let focus = null;
  server = new HandoffServer({ backend: {
    async list() { return [{ targetId: 'fixture', title: 'Fixture', url: 'https://example.test/' }]; },
    async open(_target, callbacks) {
      const metadata = () => callbacks.onMetadata({ interactions: { document: field.document, regions: [field], focus, timestamp: Date.now() } });
      metadata(); callbacks.onFrame({ type: 'frame', data: frame, width: 1280, height: 720 });
      const timer = setInterval(metadata, 250);
      return {
        async input(event) {
          inputs.push(event);
          if (event.kind === 'click') focus = { ...field, token: 'a'.repeat(32) };
          metadata(); return { focus };
        },
        async close() { clearInterval(timer); },
      };
    },
  } });
  await server.start();
  const invite = await server.createShare({ owner: 'fixture-owner', profile: 'fixture', targetId: 'fixture' });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await cdp.send('Page.navigate', { url: invite.url });
  await waitFor(() => evaluate('document.querySelector("#control")?.disabled === false'), 'viewer connects');
  const center = selector => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  const mouse = async point => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const touch = async point => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const click = async selector => mouse(await center(selector));
  const isOpen = () => evaluate('!document.querySelector("#panel").hidden');
  const open = async () => { await click('#menu'); assert.equal(await isOpen(), true); };
  await click('#control');
  await waitFor(() => evaluate('document.querySelector("#badge").textContent === "YOU HAVE CONTROL"'), 'control is ready');
  for (const gesture of [mouse, touch]) {
    await open();
    const before = inputs.length;
    const point = await evaluate('(()=>{const r=document.querySelector("#screen").getBoundingClientRect();return{x:r.left+r.width*.9,y:r.top+r.height*.1}})()');
    await gesture(point);
    assert.equal(await isOpen(), false, 'outside gesture dismisses More');
    assert.equal(await evaluate('document.querySelector("#menu").getAttribute("aria-expanded")'), 'false');
    await waitFor(() => Promise.resolve(inputs.length > before), 'outside canvas tap reaches the remote browser');
    assert.equal(inputs.length, before + 1, 'dismissal preserves exactly one intended remote action');
    assert.equal(inputs[before].kind, 'click');
    assert.ok(Math.abs(inputs[before].x - .9) < .001 && Math.abs(inputs[before].y - .1) < .001, 'dismissal preserves canvas coordinates');
    await waitFor(() => evaluate('document.activeElement.id === "text"'), 'outside field tap still focuses the typing proxy');
    await cdp.send('Input.insertText', { text: 'fixture' });
    await waitFor(() => Promise.resolve(inputs.length === before + 2), 'typing still reaches the confirmed field');
    assert.deepEqual(inputs[before + 1], { kind: 'edit', focusToken: 'a'.repeat(32), operation: 'insert', text: 'fixture' });
  }
  await open();
  const beforeControls = inputs.length;
  await click('#zoomIn');
  assert.equal(await isOpen(), true, 'inside zoom controls keep the menu open');
  assert.match(await evaluate('document.querySelector("#zoomReset").textContent'), /125%/);
  await click('#zoomReset'); await click('#dragMode');
  assert.equal(await evaluate('document.querySelector("#dragMode").getAttribute("aria-pressed")'), 'true', 'inside drag control remains usable');
  await click('#dragMode');
  assert.equal(inputs.length, beforeControls, 'menu controls never create remote pointer input');
  await click('#keyboardButton');
  assert.equal(await isOpen(), false, 'outside toolbar action dismisses More');
  assert.equal(await evaluate('document.activeElement.id'), 'text', 'keyboard action keeps its intended proxy focus');
  await waitFor(() => Promise.resolve(inputs.length === beforeControls + 1), 'keyboard confirmation remains functional');
  assert.equal(inputs.at(-1).kind, 'focus');
  await open(); await click('#menu');
  assert.equal(await isOpen(), false, 'More still toggles itself closed');
  const beforeBlank = inputs.length;
  await open(); await touch({ x: 20, y: 300 });
  assert.equal(await isOpen(), false, 'touching outside the canvas and menu dismisses More');
  assert.equal(inputs.length, beforeBlank, 'blank viewer space creates no remote action');
  await click('#done');
  await waitFor(() => evaluate('!document.querySelector("#finished").hidden'), 'Done still ends access');
});
