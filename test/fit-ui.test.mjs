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

test('the whole remote page fits on screens wider than the browser and taps still map to it', { skip: !existsSync(chromePath) }, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'handoff-fit-ui-'));
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
  // The CDP screencast is capped at 1600x1200, so a 1920x1080 browser arrives as 1600x900.
  const frame = await evaluate('(()=>{const c=document.createElement("canvas");c.width=1600;c.height=900;return c.toDataURL("image/jpeg").split(",")[1]})()');
  const inputs = [];
  server = new HandoffServer({ backend: {
    async list() { return [{ targetId: 'fixture', title: 'Fixture', url: 'https://example.test/' }]; },
    async open(_target, callbacks) {
      callbacks.onMetadata({ interactions: { document: 'fixture-document', regions: [], focus: null, timestamp: Date.now() } });
      callbacks.onFrame({ type: 'frame', data: frame, width: 1600, height: 900 });
      return { async input(event) { inputs.push(event); return { focus: null }; }, async close() {} };
    },
  } });
  await server.start();
  const invite = await server.createShare({ owner: 'fixture-owner', profile: 'fixture', targetId: 'fixture' });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Page.navigate', { url: invite.url });
  await waitFor(() => evaluate('document.querySelector("#control")?.disabled === false'), 'viewer connects');
  const center = selector => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  const mouse = async point => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  await mouse(await center('#control'));
  await waitFor(() => evaluate('document.querySelector("#badge").textContent === "YOU HAVE CONTROL"'), 'control is ready');
  let innerWidth = 0;
  const innerWidthIs = width => innerWidth === width;
  const layout = async () => { innerWidth = await evaluate('innerWidth'); return evaluate(`(()=>{
    const v = document.querySelector('.viewport'), c = document.querySelector('#screen').getBoundingClientRect(), b = v.getBoundingClientRect();
    const toolbar = document.querySelector('.toolbar').getBoundingClientRect();
    return { left: c.left - b.left, top: c.top - b.top, right: b.right - c.right, bottom: b.bottom - c.bottom,
      width: c.width, height: c.height, aboveToolbar: toolbar.top - c.bottom,
      scrollable: v.scrollHeight > v.clientHeight + 1 || v.scrollWidth > v.clientWidth + 1 };
  })()`); };
  for (const [name, width, height, mobile] of [['phone portrait', 390, 844, true], ['phone landscape', 844, 390, true], ['wide desktop window', 2400, 1250, false]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    let box, previous;
    await waitFor(async () => {
      previous = box; box = await layout();
      return innerWidthIs(width) && JSON.stringify(box) === JSON.stringify(previous);
    }, `${name}: layout settles`);
    assert.equal(box.scrollable, false, `${name}: nothing is cut off at the default zoom`);
    assert.ok(box.left >= -1 && box.top >= -1 && box.right >= -1 && box.bottom >= -1, `${name}: the whole frame is inside the view`);
    assert.ok(Math.abs(box.width / box.height - 16 / 9) < .01, `${name}: the frame keeps its shape`);
    assert.ok(box.aboveToolbar >= -1 || box.width < width / 2, `${name}: the toolbar does not cover the bottom of the page`);
    assert.ok(Math.abs(box.width - width) < 2 || Math.abs(box.aboveToolbar - 12) < 2, `${name}: the frame is as large as fits ${JSON.stringify(box)}`);
    const before = inputs.length;
    const corner = await evaluate('(()=>{const r=document.querySelector("#screen").getBoundingClientRect();return{x:r.left+r.width*.95,y:r.top+r.height*.95}})()');
    await mouse(corner);
    await waitFor(() => Promise.resolve(inputs.length > before), `${name}: a tap near the bottom corner reaches the browser`);
    const tap = inputs.at(-1);
    assert.ok(tap.kind === 'click' && Math.abs(tap.x - .95) < .01 && Math.abs(tap.y - .95) < .01, `${name}: the tap lands where it was aimed`);
  }
});
