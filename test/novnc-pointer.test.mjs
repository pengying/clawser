import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { CdpConnection } from '../src/cdp.mjs';

// Run with NOVNC_ASSETS_DIR pointing at the pinned noVNC 1.7.0 source tree.
// No installed gateway, container, desktop, or existing browser is used.
const assets = process.env.NOVNC_ASSETS_DIR;
const chromePath = process.env.CHROME_BIN || '/usr/bin/google-chrome-stable';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const width = 1280, height = 720;
const targets = [[160, 90], [640, 360], [1120, 630]];
async function captureEvidence(cdp, name) {
  const directory = process.env.NOVNC_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(directory, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
}

function serverInit() {
  const name = Buffer.from('Disposable pointer regression');
  const init = Buffer.alloc(24);
  init.writeUInt16BE(width, 0); init.writeUInt16BE(height, 2);
  init.set([32, 24, 0, 1], 4);
  for (const offset of [8, 10, 12]) init.writeUInt16BE(255, offset);
  init.set([16, 8, 0], 14);
  init.writeUInt32BE(name.length, 20);
  return Buffer.concat([init, name]);
}

function framebuffer() {
  const header = Buffer.alloc(16);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(width, 8); header.writeUInt16BE(height, 10);
  const pixels = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set([32, 48, 64, 0], offset);
  for (const [x, y] of targets) {
    for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
      pixels.set([255, 0, 0, 0], ((y + dy) * width + x + dx) * 4);
    }
  }
  return Buffer.concat([header, pixels]);
}

// Minimal RFB 3.8 peer: real noVNC negotiates and decodes a raw frame, and
// genuine browser mouse events must become the correct six-byte wire packets.
function attachPeer(socket, peers) {
  const peer = { socket, pointers: [], keys: [], clipboards: [], frames: 0 };
  peers.push(peer);
  let pending = Buffer.alloc(0), phase = 'version';
  socket.send(Buffer.from('RFB 003.008\n'));
  socket.on('message', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length) {
      let length;
      if (phase === 'version') {
        length = 12;
        if (pending.length < length) return;
        assert.equal(pending.subarray(0, length).toString(), 'RFB 003.008\n');
        socket.send(Buffer.from([1, 1])); phase = 'security';
      } else if (phase === 'security') {
        length = 1;
        assert.equal(pending[0], 1);
        socket.send(Buffer.alloc(4)); phase = 'init';
      } else if (phase === 'init') {
        length = 1;
        socket.send(serverInit()); phase = 'messages';
      } else {
        switch (pending[0]) {
          case 0: length = 20; break;
          case 2:
            if (pending.length < 4) return;
            length = 4 + pending.readUInt16BE(2) * 4; break;
          case 3: length = 10; break;
          case 4: length = 8; break;
          case 5: length = 6; break;
          case 6:
            if (pending.length < 8) return;
            length = 8 + pending.readUInt32BE(4); break;
          default: assert.fail(`Unexpected client RFB message ${pending[0]}`);
        }
        if (pending.length < length) return;
        if (pending[0] === 0) assert.deepEqual([...pending.subarray(14, 17)], [0, 8, 16], 'raw fixture uses the requested RGB byte order');
        if (pending[0] === 3 && peer.frames++ === 0) socket.send(framebuffer());
        if (pending[0] === 4) peer.keys.push({ down: pending[1], keysym: pending.readUInt32BE(4) });
        if (pending[0] === 6) peer.clipboards.push(pending.subarray(8, length).toString('latin1'));
        if (pending[0] === 5) peer.pointers.push({ mask: pending[1], x: pending.readUInt16BE(2), y: pending.readUInt16BE(4), at: performance.now() });
      }
      pending = pending.subarray(length);
    }
  });
}

// focus, when given, is { answer, requests }: the /focus route returns answer and counts requests.
async function fixture(t, { clipboardBridge = false, retained = false, focus } = {}) {
  assert.equal(JSON.parse(await readFile(join(assets, 'package.json'), 'utf8')).version, '1.7.0', 'use the pinned noVNC release');
  const peers = [];
  const clipboardRequests = [];
  let remoteText = '远程复制😀';
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://fixture').pathname;
      if (path.endsWith('/credentials')) {
        response.setHeader('Content-Type', 'application/json');
        const capabilities = { ...(clipboardBridge ? { clipboard: 'utf8' } : {}), ...(focus ? { focus: true } : {}) };
        return response.end(JSON.stringify({ mode: 'control', password: 'unused', generation: 0, ...(Object.keys(capabilities).length ? { capabilities } : {}) }));
      }
      if (path.endsWith('/focus')) {
        if (!focus) { response.writeHead(404); return response.end('{}'); }
        focus.requests++;
        response.setHeader('Content-Type', 'application/json');
        return response.end(JSON.stringify(focus.answer));
      }
      if (path.endsWith('/clipboard')) {
        let body = ''; for await (const chunk of request) body += chunk;
        const message = JSON.parse(body); clipboardRequests.push(message);
        if (message.action === 'write') remoteText = message.text;
        response.setHeader('Content-Type', 'application/json');
        return response.end(JSON.stringify({ text: remoteText }));
      }
      if (path.endsWith('/done')) return response.end(JSON.stringify({ mode: 'ended', ...(retained ? { disposition: 'retained' } : {}) }));
      const prefix = '/probe/novnc/novnc/';
      if (path.startsWith(prefix)) {
        const file = resolve(assets, path.slice(prefix.length));
        assert.ok(file.startsWith(resolve(assets) + sep));
        response.setHeader('Content-Type', 'text/javascript');
        return response.end(await readFile(file));
      }
      const file = path.endsWith('/probe.css') ? 'probe.css' : path.endsWith('/probe.js') ? 'probe.js' : path.endsWith('/trackpad.js') ? 'trackpad.js' : 'probe.html';
      response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html');
      response.end(await readFile(new URL(`../public/${file}`, import.meta.url)));
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => attachPeer(socket, peers));
  const profile = await mkdtemp(join(tmpdir(), 'novnc-pointer-'));
  let cdp, chrome;
  t.after(async () => {
    cdp?.close();
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = once(chrome, 'exit');
      chrome.kill('SIGTERM');
      await exited;
    }
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  chrome = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let port;
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
    catch { await pause(30); }
  }
  assert.ok(port, 'fresh Chromium started');
  const page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  cdp = await new CdpConnection().connect(page.webSocketDebuggerUrl);
  const evaluate = async (expression) => {
    const reply = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  };
  const waitFor = async (expression, description) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(expression)) return;
      await pause(25);
    }
    assert.fail(description);
  };
  return { cdp, evaluate, waitFor, peers, clipboardRequests, url: `http://127.0.0.1:${server.address().port}/probe/novnc/pointer/` };
}

const scenarios = [
  { name: 'wide', width: 1600, height: 1000, deviceScaleFactor: 1 },
  { name: 'tall', width: 900, height: 1200, deviceScaleFactor: 1 },
  { name: 'narrow', width: 390, height: 844, deviceScaleFactor: 1 },
  { name: 'DPR2', width: 1280, height: 900, deviceScaleFactor: 2 },
  { name: 'live resize', width: 430, height: 932, deviceScaleFactor: 2, resize: true },
];

test('rendered noVNC targets map to framebuffer coordinates on the RFB wire', {
  skip: !assets ? 'set NOVNC_ASSETS_DIR to the noVNC 1.7.0 source tree' : !existsSync(chromePath) ? 'Chrome unavailable' : false,
}, async (t) => {
  const { cdp, evaluate, waitFor, peers, url } = await fixture(t);
  for (const scenario of scenarios) await t.test(scenario.name, async (t) => {
    const metrics = { width: scenario.width, height: scenario.height, deviceScaleFactor: scenario.deviceScaleFactor, mobile: false };
    await cdp.send('Emulation.setDeviceMetricsOverride', scenario.resize ? { ...metrics, width: 1000, height: 800 } : metrics);
    await cdp.send('Page.navigate', { url });
    await waitFor(`document.querySelector('#status')?.textContent === 'Control connected.' && document.querySelector('canvas')?.width === ${width}`, 'real RFB connected');
    await waitFor(`document.querySelector('canvas').getContext('2d').getImageData(160,90,1,1).data[0] === 255`, 'known raw frame decoded');
    const peer = peers.at(-1);
    if (scenario.resize) await cdp.send('Emulation.setDeviceMetricsOverride', metrics);
    // Allow ResizeObserver and noVNC's following animation-frame scale update.
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
    assert.equal(await evaluate(`Boolean(document.querySelector('#viewport'))`), true, 'viewer provides the full-screen zoom viewport');
    const geometry = await evaluate(`(() => {
      const canvas = document.querySelector('canvas');
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(rect.width / ${width}, rect.height / ${height});
      return { left: rect.left + (rect.width - ${width} * scale) / 2,
        top: rect.top + (rect.height - ${height} * scale) / 2, scale,
        canvas: { width: rect.width, height: rect.height },
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        doneVisible: document.querySelector('#done').getBoundingClientRect().bottom <= innerHeight,
        barVisible: document.querySelector('#bar').getBoundingClientRect().bottom <= innerHeight,
        screen: { left: document.querySelector('#viewport').getBoundingClientRect().left, top: document.querySelector('#viewport').getBoundingClientRect().top, width: document.querySelector('#viewport').clientWidth, height: document.querySelector('#viewport').clientHeight } };
    })()`);
    await captureEvidence(cdp, `viewer-${scenario.name.replaceAll(' ', '-')}`);
    await evaluate('__viewer.hideBar()');
    const results = [];
    for (const [x, y] of targets) {
      const before = peer.pointers.length;
      // Browser mouse coordinates are integral CSS pixels. Choose the nearest
      // pixel so downscaling does not add a whole CSS pixel of truncation bias.
      const point = { x: Math.round(geometry.left + x * geometry.scale), y: Math.round(geometry.top + y * geometry.scale), button: 'left', clickCount: 1 };
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...point });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...point });
      for (let attempt = 0; attempt < 80 && !peer.pointers.slice(before).some((event) => event.mask === 1); attempt++) await pause(10);
      const actual = peer.pointers.slice(before).find((event) => event.mask === 1);
      results.push({ target: [x, y], actual: actual ? [actual.x, actual.y] : null,
        error: actual ? [actual.x - x, actual.y - y] : null });
    }
    t.diagnostic(JSON.stringify({ geometry, results }));
    assert.ok(results.every(({ error }) => error && error.every((value) => Math.abs(value) <= 2)), 'visible target clicks must land within two framebuffer pixels');
    assert.ok(geometry.document.width <= geometry.viewport.width && geometry.document.height <= geometry.viewport.height, 'viewer stays within the viewport');
    await evaluate('__viewer.showBar()');
    assert.ok(geometry.doneVisible && geometry.barVisible, 'overlay actions remain visible');
    assert.deepEqual(geometry.screen, { left: 0, top: 0, width: scenario.width, height: scenario.height }, 'browser viewport fills the screen');
    assert.ok(geometry.scale <= 1, 'fit never upscales above 100%');
    await evaluate('__viewer.hideBar()');
    assert.equal(await evaluate(`__viewer.barHidden() && !document.querySelector('#bar-tab').hidden`), true, 'a hidden bar leaves the tab that shows it');
    await evaluate('__viewer.showBar()');
    assert.equal(await evaluate('__viewer.barHidden()'), false);
    await evaluate(`document.querySelector('#zoom-in').click()`);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.ok(await evaluate(`Number(document.querySelector('#zoom-level').dataset.scale) > ${geometry.scale}`), 'zoom button increases the noVNC display scale');
    await evaluate("__viewer.zoomTo('fit')");
    assert.equal(peers.at(-1), peer, 'resizing keeps the RFB session');
    await evaluate(`document.querySelector('#done').click()`);
    await waitFor(`document.querySelector('#status').textContent.includes('Test browser destroyed.')`, 'Done still completes');
  });
});


test('overlay, clipboard, mobile keyboard and pinch keep input intentional', {
  skip: !assets ? 'set NOVNC_ASSETS_DIR to the noVNC 1.7.0 source tree' : !existsSync(chromePath) ? 'Chrome unavailable' : false,
}, async (t) => {
  const { cdp, evaluate, waitFor, peers, url } = await fixture(t);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Page.navigate', { url });
  await waitFor(`document.querySelector('#status')?.textContent === 'Control connected.' && document.querySelector('canvas')?.width === ${width}`, 'real RFB connected');
  const peer = peers.at(-1);
  await evaluate(`window.clipboardReads = 0; window.clipboardWrites = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => { window.clipboardReads++; return 'local paste'; }, writeText: async text => window.clipboardWrites.push(text) } });`);
  assert.equal(await evaluate('window.clipboardReads'), 0, 'local clipboard is never read on connect');
  await evaluate(`document.querySelector('#paste').click()`);
  await waitFor('window.clipboardReads === 1', 'explicit Paste reads local clipboard');
  for (let n = 0; n < 100 && !peer.clipboards.length; n++) await pause(10);
  assert.deepEqual(peer.clipboards, ['local paste'], 'paste transfers text through RFB clipboard');
  assert.ok(peer.keys.some(key => key.down && key.keysym === 0x76), 'Paste sends Ctrl+V after transferring text');
  const cut = Buffer.from('remote selection');
  const packet = Buffer.alloc(8); packet[0] = 3; packet.writeUInt32BE(cut.length, 4);
  peer.socket.send(Buffer.concat([packet, cut]));
  await waitFor(`document.querySelector('#status').textContent.includes('Selection ready')`, 'incoming clipboard is held for Copy');
  assert.deepEqual(await evaluate('window.clipboardWrites'), [], 'incoming clipboard does not overwrite this device clipboard');
  await evaluate(`document.querySelector('#copy').click()`);
  await waitFor('window.clipboardWrites.length === 1', 'Copy writes only after an explicit action');
  assert.deepEqual(await evaluate('window.clipboardWrites'), ['remote selection']);
  await evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => { throw new Error('denied'); } } }); document.querySelector('#paste').click()`);
  await waitFor(`document.querySelector('#clipboard-dialog').open`, 'manual clipboard fallback appears when permission is denied');
  await evaluate(`document.querySelector('#clipboard-text').value = 'manual paste'; document.querySelector('#clipboard-send').click()`);
  for (let n = 0; n < 100 && peer.clipboards.length < 2; n++) await pause(10);
  assert.deepEqual(peer.clipboards, ['local paste', 'manual paste']);
  await evaluate(`document.querySelector('#keyboard').click()`);
  assert.equal(await evaluate(`document.activeElement.id`), 'keyboard-input', 'keyboard button focuses a real editable input');
  const keysBefore = peer.keys.length;
  await evaluate(`(() => { const input = document.querySelector('#keyboard-input'); input.dispatchEvent(new CompositionEvent('compositionstart')); input.value += '中文😀'; input.dispatchEvent(new InputEvent('input', { data: '中文😀', isComposing: true })); })()`);
  await pause(50);
  assert.equal(peer.keys.length, keysBefore, 'composition does not prematurely send partial text');
  await evaluate(`document.querySelector('#keyboard-input').dispatchEvent(new CompositionEvent('compositionend', { data: '中文😀' }))`);
  for (let n = 0; n < 100 && peer.keys.length < keysBefore + 6; n++) await pause(10);
  assert.deepEqual(peer.keys.slice(keysBefore).filter(key => key.down).map(key => key.keysym), [0x1004e2d, 0x1006587, 0x101f600], 'committed Unicode is sent once, preserving supplementary characters');
  await evaluate(`document.querySelector('#keyboard-input').blur(); __viewer.hideBar()`);
  const before = peer.pointers.length, beforeKeys = peer.keys.length;
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 1, radiusY: 1, force: 1 })) });
  const initialScale = await evaluate(`Number(document.querySelector('#zoom-level').dataset.scale)`);
  await touch('touchStart', [[145, 422]]);
  await touch('touchStart', [[145, 422], [245, 422]]);
  await touch('touchMove', [[95, 422], [295, 422]]);
  await touch('touchEnd', []);
  await pause(100);
  assert.ok(await evaluate(`Number(document.querySelector('#zoom-level').dataset.scale)`) > initialScale * 1.8, 'two-finger pinch zooms the display');
  assert.equal(peer.pointers.length, before, 'pinch sends no remote pointer packets');
  assert.equal(peer.keys.length, beforeKeys, 'pinch sends no remote control-wheel keyboard gestures');
  const centerBefore = await evaluate(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return {x:(195-r.left)/Number(document.querySelector('#zoom-level').dataset.scale),y:(422-r.top)/Number(document.querySelector('#zoom-level').dataset.scale)} })()`);
  await touch('touchStart', [[145, 422], [245, 422]]);
  await touch('touchMove', [[120, 422], [270, 422]]);
  await touch('touchEnd', []);
  await pause(100);
  const centerAfter = await evaluate(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return {x:(195-r.left)/Number(document.querySelector('#zoom-level').dataset.scale),y:(422-r.top)/Number(document.querySelector('#zoom-level').dataset.scale)} })()`);
  assert.ok(Math.abs(centerBefore.x-centerAfter.x)<2 && Math.abs(centerBefore.y-centerAfter.y)<2, 'pinch preserves its framebuffer anchor');
  const beforePan = peer.pointers.length;
  const scrollBefore = await evaluate(`document.querySelector('#viewport').scrollLeft`);
  await touch('touchStart', [[195, 422]]); await touch('touchMove', [[145, 422]]); await touch('touchEnd', []);
  assert.ok(await evaluate(`document.querySelector('#viewport').scrollLeft`) > scrollBefore + 40, 'single finger pans a zoomed browser');
  assert.equal(peer.pointers.length, beforePan, 'local panning sends no remote pointer events');
  const afterPan = await evaluate(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return {x:(195-r.left)/Number(document.querySelector('#zoom-level').dataset.scale),y:(422-r.top)/Number(document.querySelector('#zoom-level').dataset.scale)} })()`);
  const beforeTap = peer.pointers.length;
  await touch('touchStart', [[195, 422]]); await touch('touchEnd', []);
  for (let n = 0; n < 100 && !peer.pointers.slice(beforeTap).some(event => event.mask === 1); n++) await pause(10);
  const actual = peer.pointers.slice(beforeTap).find(event => event.mask === 1);
  assert.ok(actual && Math.abs(actual.x-afterPan.x)<2 && Math.abs(actual.y-afterPan.y)<2, 'touch tap after zoom still maps to framebuffer coordinates');
  assert.equal(await evaluate(`Boolean(document.captureElement)`), false, 'touch tap releases noVNC mouse capture for the next gesture');
  await captureEvidence(cdp, 'mobile-pinched-and-panned');
  const beforeSqueeze = peer.pointers.length;
  const scaleBeforeSqueeze = await evaluate(`Number(document.querySelector('#zoom-level').dataset.scale)`);
  await touch('touchStart', [[120, 422], [270, 422]]);
  await touch('touchMove', [[157.5, 422], [232.5, 422]]);
  await touch('touchEnd', []);
  t.diagnostic(JSON.stringify({ scaleBeforeSqueeze, afterSqueeze: await evaluate(`Number(document.querySelector('#zoom-level').dataset.scale)`), captureAfterTap: await evaluate(`({active: Boolean(document.captureElement), proxy: document.querySelector('#noVNC_mouse_capture_elem')?.style.display})`) }));
  await waitFor(`Number(document.querySelector('#zoom-level').dataset.scale) < ${scaleBeforeSqueeze * 0.55}`, 'squeezing zooms out');
  assert.equal(peer.pointers.length, beforeSqueeze, 'squeezing sends no remote pointer events');
  await press({ cdp, evaluate }, '#bar-tab');
  await waitFor('!__viewer.barHidden()', 'a tap on the tab brings the bar back');
  await evaluate(`document.querySelector('#done').click()`);
  await waitFor(`document.querySelector('#status').textContent.includes('Test browser destroyed.')`, 'Done completes');
});


test('UTF-8 clipboard bridge preserves multilingual text and requires explicit actions', {
  skip: !assets ? 'set NOVNC_ASSETS_DIR to the noVNC 1.7.0 source tree' : !existsSync(chromePath) ? 'Chrome unavailable' : false,
}, async (t) => {
  const { cdp, evaluate, waitFor, peers, clipboardRequests, url } = await fixture(t, { clipboardBridge: true, retained: true });
  await cdp.send('Page.navigate', { url });
  await waitFor(`document.querySelector('#status')?.textContent === 'Control connected.' && document.querySelector('canvas')?.width === ${width}`, 'RFB connected');
  await evaluate(String.raw`window.clipboardWrites=[]; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => '你好😀\nline two', writeText: async text => window.clipboardWrites.push(text) } });`);
  assert.deepEqual(clipboardRequests, [], 'no clipboard bridge request on connect');
  await evaluate(`document.querySelector('#copy').click()`);
  await waitFor('window.clipboardWrites.length === 1', 'explicit Copy reads bridge');
  assert.deepEqual(await evaluate('window.clipboardWrites'), ['远程复制😀']);
  assert.deepEqual(clipboardRequests, [{ action: 'read' }]);
  await evaluate(`document.querySelector('#paste').click()`);
  for (let n = 0; n < 100 && clipboardRequests.length < 2; n++) await pause(10);
  assert.deepEqual(clipboardRequests[1], { action: 'write', text: '你好😀\nline two' });
  assert.deepEqual(peers.at(-1).clipboards, [], 'UTF-8 text never goes through lossy legacy RFB clipboard');
  await evaluate(`document.querySelector('#done').click()`);
  await waitFor(`document.querySelector('#status').textContent.includes('Browser returned to the assistant.')`, 'retained Done returns the browser to the assistant');
  assert.equal(await evaluate(`document.querySelector('#keyboard').disabled && document.querySelector('#paste').disabled`), true, 'Done disables remote input');
});

test('clipboard fallback actions stay above the mobile keyboard in portrait and landscape', {
  skip: !assets ? 'set NOVNC_ASSETS_DIR to the noVNC 1.7.0 source tree' : !existsSync(chromePath) ? 'Chrome unavailable' : false,
}, async (t) => {
  const { cdp, evaluate, waitFor, url } = await fixture(t, { clipboardBridge: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 722, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url });
  await waitFor(`document.querySelector('#status')?.textContent === 'Control connected.'`, 'RFB connected');
  await evaluate(`(() => {
    window.clipboardReads = 0;
    window.clipboardWrites = 0;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      readText: async () => { window.clipboardReads++; throw new Error('denied'); },
      writeText: async () => { window.clipboardWrites++; throw new Error('denied'); }
    }});
    window.visibleArea = { width: 390, height: 444, offsetLeft: 0, offsetTop: 0 };
    for (const key of Object.keys(visibleArea)) Object.defineProperty(visualViewport, key, { configurable: true, get: () => visibleArea[key] });
    document.querySelector('#paste').click();
  })()`);
  await waitFor(`document.querySelector('#clipboard-dialog').open`, 'denied clipboard opens manual paste');
  const geometry = () => evaluate(`(() => {
    const rect = element => { const r=element.getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; };
    return { dialog:rect(document.querySelector('#clipboard-dialog')), actions:[...document.querySelectorAll('#clipboard-dialog .actions button')].filter(button => !button.hidden).map(rect),
      content:document.querySelector('.clipboard-content') ? {height:document.querySelector('.clipboard-content').clientHeight,scrollHeight:document.querySelector('.clipboard-content').scrollHeight} : null };
  })()`);
  let actual = await geometry();
  t.diagnostic(JSON.stringify({portrait:actual}));
  assert.ok(actual.dialog.top >= 8 && actual.dialog.bottom <= 436, 'dialog fits the 444px visible viewport above Gboard');
  assert.ok(actual.actions.every(rect => rect.top >= 8 && rect.bottom <= 436), 'Send and Close are visible above the keyboard');
  assert.equal(await evaluate('window.clipboardReads'), 1, 'showing or positioning the fallback adds no clipboard reads');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await evaluate(`Object.assign(visibleArea,{width:844,height:176,offsetLeft:0,offsetTop:24}); document.documentElement.style.setProperty('--safe-left','36px'); document.documentElement.style.setProperty('--safe-right','24px'); document.documentElement.style.setProperty('--safe-top','12px'); document.documentElement.style.setProperty('--safe-bottom','8px'); visualViewport.dispatchEvent(new Event('resize')); visualViewport.dispatchEvent(new Event('scroll'));`);
  actual = await geometry();
  t.diagnostic(JSON.stringify({landscape:actual}));
  assert.ok(actual.dialog.left >= 44 && actual.dialog.right <= 812 && actual.dialog.top >= 44 && actual.dialog.bottom <= 184, 'landscape dialog respects visual viewport offset and safe areas');
  assert.ok(actual.actions.every(rect => rect.top >= 44 && rect.bottom <= 184), 'landscape actions remain visible while content scrolls');
  assert.ok(actual.content && actual.content.scrollHeight > actual.content.height && actual.content.height > 0, 'short viewport scrolls the content rather than covering the actions');
  await captureEvidence(cdp, 'clipboard-landscape-keyboard');
  await evaluate(`Object.assign(visibleArea,{height:65.09,offsetTop:0}); for(const edge of ['left','right','top','bottom']) document.documentElement.style.setProperty('--safe-'+edge,'0px'); visualViewport.dispatchEvent(new Event('resize'));`);
  actual = await geometry();
  t.diagnostic(JSON.stringify({extremeLandscape:actual}));
  assert.ok(actual.actions.every(rect => rect.top >= 4 && rect.bottom <= 61.09 && rect.height >= 44), 'full Gboard landscape keeps 44px actions visible in a 65px viewport');
  await evaluate(`Object.assign(visibleArea,{height:176,offsetTop:24}); document.documentElement.style.setProperty('--safe-top','12px');document.documentElement.style.setProperty('--safe-bottom','8px');visualViewport.dispatchEvent(new Event('resize'));`);
  await evaluate(`document.querySelector('#clipboard-dialog').close(); document.querySelector('#copy').click()`);
  await waitFor(`document.querySelector('#clipboard-dialog').open && document.querySelector('#clipboard-text').readOnly`, 'denied clipboard opens manual copy');
  actual = await geometry();
  assert.equal(actual.actions.length, 1, 'manual Copy keeps Close available');
  assert.ok(actual.actions[0].top >= 44 && actual.actions[0].bottom <= 184, 'manual Copy can be dismissed above the keyboard');
  assert.equal(await evaluate('window.clipboardReads'), 1, 'manual Copy and viewport changes do not read the local clipboard');
  await evaluate(`document.querySelector('#clipboard-dialog').close(); document.querySelector('#done').click()`);
  await waitFor(`document.querySelector('#status').textContent.includes('Test browser destroyed.')`, 'Done completes');
});

test('mobile scrolling reaches RFB before finger-up and stops immediately for pinch', {
  skip: !assets ? 'set NOVNC_ASSETS_DIR to the noVNC 1.7.0 source tree' : !existsSync(chromePath) ? 'Chrome unavailable' : false,
}, async (t) => {
  const { cdp, evaluate, waitFor, peers, url } = await fixture(t);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Page.navigate', { url });
  await waitFor(`document.querySelector('#status')?.textContent === 'Control connected.' && document.querySelector('canvas')?.width === ${width}`, 'RFB connected');
  await evaluate('__viewer.hideBar()');
  const peer = peers.at(-1);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 1, radiusY: 1, force: 1 })) });
  const wheels = () => peer.pointers.filter(event => event.mask & 0x78);
  await touch('touchStart', [[195, 422]]);
  await touch('touchMove', [[195, 410]]);
  for (let n = 0; n < 100 && !wheels().length; n++) await pause(10);
  assert.ok(wheels().length >= 1, 'small one-finger movement scrolls before touchend');
  const firstWheels = wheels().length;
  await touch('touchMove', [[195, 380]]);
  for (let n = 0; n < 100 && wheels().length === firstWheels; n++) await pause(10);
  assert.ok(wheels().length > firstWheels, 'further movement continuously scrolls before release');
  assert.ok(peer.pointers.every(event => (event.mask & 7) === 0), 'scrolling never presses a remote mouse button');
  const beforePinch = peer.pointers.length;
  await touch('touchStart', [[195, 380], [245, 380]]);
  await touch('touchMove', [[145, 380], [295, 380]]);
  await touch('touchEnd', []);
  await pause(100);
  assert.equal(peer.pointers.length, beforePinch, 'second finger immediately stops scrolling with no release replay');
  assert.deepEqual(peer.keys, [], 'pinch never sends remote Ctrl+wheel keys');
  await evaluate("__viewer.zoomTo('fit')");
  const beforeSmallPinch = peer.pointers.length;
  await touch('touchStart', [[145, 422]]);
  await touch('touchMove', [[145, 418]]);
  await touch('touchStart', [[145, 418], [245, 418]]);
  await touch('touchMove', [[95, 418], [295, 418]]);
  await touch('touchEnd', []);
  await pause(100);
  assert.equal(peer.pointers.length, beforeSmallPinch, 'pinch before the movement threshold sends no remote input');
  await press({ cdp, evaluate }, '#bar-tab');
  await waitFor('!__viewer.barHidden()', 'a tap on the tab brings the bar back');
  await evaluate(`document.querySelector('#done').click()`);
  await waitFor(`document.querySelector('#status').textContent.includes('Test browser destroyed.')`, 'Done completes');
});

test('a stationary touch holds the remote button until lift; taps still click and early swipes still scroll', {
  skip: !assets ? 'set NOVNC_ASSETS_DIR to the noVNC 1.7.0 source tree' : !existsSync(chromePath) ? 'Chrome unavailable' : false,
}, async (t) => {
  const { cdp, evaluate, waitFor, peers, url } = await fixture(t);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Page.navigate', { url });
  await waitFor(`document.querySelector('#status')?.textContent === 'Control connected.' && document.querySelector('canvas')?.width === ${width}`, 'RFB connected');
  await evaluate('__viewer.hideBar()');
  const peer = peers.at(-1), status = () => evaluate(`document.querySelector('#status').textContent`);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 1, radiusY: 1, force: 1 })) });
  const pressed = async (before) => {
    for (let n = 0; n < 100 && !peer.pointers.slice(before).some(event => event.mask === 1); n++) await pause(10);
    return peer.pointers.slice(before).find(event => event.mask === 1);
  };
  const rect = await evaluate(`(() => {const r=document.querySelector('canvas').getBoundingClientRect();return {left:r.left,top:r.top,scale:Number(document.querySelector('#zoom-level').dataset.scale)};})()`);
  let before = peer.pointers.length;
  await touch('touchStart', [[195, 422]]);
  await pause(120);
  assert.equal(peer.pointers.length, before, 'a touch sends nothing before the hold delay');
  const down = await pressed(before);
  assert.ok(down, 'a finger kept within the tap slop presses the remote button');
  assert.ok(Math.abs(down.x - (195 - rect.left) / rect.scale) <= 2 && Math.abs(down.y - (422 - rect.top) / rect.scale) <= 2, 'the hold presses at the contact point');
  assert.match(await status(), /^Holding…/);
  for (const point of [[196, 423], [194, 421], [195, 422]]) { await pause(200); await touch('touchMove', [point]); }
  while (performance.now() - down.at < 1100) await pause(20);
  assert.equal(peer.pointers.at(-1).mask, 1, 'the button stays down while the finger rests');
  await touch('touchEnd', []);
  for (let n = 0; n < 100 && peer.pointers.at(-1)?.mask !== 0; n++) await pause(10);
  const held = peer.pointers.slice(before), up = held.at(-1);
  t.diagnostic(JSON.stringify({ heldMs: up.at - down.at, masks: held.map(event => event.mask) }));
  assert.equal(up.mask, 0, 'lifting releases the remote button');
  assert.ok(up.at - down.at >= 1000, 'the remote button is held for the whole second');
  assert.ok(held.slice(1, -1).filter(event => event.mask === 1).length >= 1, 'small jitter is forwarded as held-button movement');
  assert.deepEqual(held.filter(event => event.mask !== 1), [up], 'the hold neither scrolls nor releases early');
  assert.equal(await evaluate('Boolean(document.captureElement)'), false, 'upstream mouse capture is released');
  assert.match(await status(), /^Hold released/);

  before = peer.pointers.length;
  await touch('touchStart', [[195, 422]]); await touch('touchEnd', []);
  await pause(400);
  assert.deepEqual(peer.pointers.slice(before).map(event => event.mask), [1, 0], 'a quick tap is still exactly one click');

  before = peer.pointers.length;
  await touch('touchStart', [[195, 422]]);
  await touch('touchMove', [[195, 400]]);
  await touch('touchMove', [[195, 380]]);
  await pause(400);
  await touch('touchEnd', []);
  await pause(100);
  const swipe = peer.pointers.slice(before);
  assert.ok(swipe.some(event => event.mask & 0x78), 'an early swipe still scrolls');
  assert.ok(swipe.every(event => (event.mask & 7) === 0), 'a finger resting after an early swipe never presses the button');

  before = peer.pointers.length;
  await touch('touchStart', [[195, 422]]);
  assert.ok(await pressed(before), 'a second hold presses again');
  await evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); delete document.hidden;`);
  for (let n = 0; n < 100 && peer.pointers.at(-1)?.mask !== 0; n++) await pause(10);
  assert.equal(peer.pointers.at(-1).mask, 0, 'hiding the page releases a held button');
  await touch('touchEnd', []);
  await pause(100);
  assert.equal(peer.pointers.at(-1).mask, 0, 'the lift after a hidden-page release sends no extra click');

  before = peer.pointers.length;
  await touch('touchStart', [[195, 422]]);
  assert.ok(await pressed(before), 'a third hold presses again');
  await evaluate(`document.querySelector('#done').click()`);
  await waitFor(`document.querySelector('#status').textContent.includes('Test browser destroyed.')`, 'Done completes');
  assert.equal(peer.pointers.at(-1).mask, 0, 'Done releases a held button before ending access');
  await touch('touchEnd', []);
});

// A real touch on one of the viewer's own buttons, as a finger would press it.
async function press({ cdp, evaluate }, selector) {
  const [x, y] = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 0, radiusX: 1, radiusY: 1, force: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function phone(t, focus, options = {}) {
  const ctx = await fixture(t, { focus, ...options });
  await ctx.cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await ctx.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const errors = [];
  await ctx.cdp.send('Runtime.enable');
  ctx.cdp.on('Runtime.exceptionThrown', e => errors.push(JSON.stringify(e.exceptionDetails?.text) + JSON.stringify(e.exceptionDetails?.exception?.description)));
  ctx.cdp.on('Runtime.consoleAPICalled', e => { if (e.type === 'error') errors.push(JSON.stringify(e.args?.map(a => a.value ?? a.description))); });
  for (const source of options.scripts || []) await ctx.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
  await ctx.cdp.send('Page.navigate', { url: ctx.url });
  await ctx.waitFor(`document.querySelector('#status')?.textContent === 'Control connected.' && document.querySelector('canvas')?.width === ${width}`, 'RFB connected');
  await ctx.evaluate('__viewer.hideBar()');
  const touch = (type, points) => ctx.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 1, radiusY: 1, force: 1 })) });
  // Taps at a framebuffer point, so a test can aim at the browser toolbar or the page.
  const tap = async (fx, fy) => {
    const [x, y] = await ctx.evaluate(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(), s = r.width / ${width}; return [r.left + ${fx} * s, r.top + ${fy} * s]; })()`);
    await touch('touchStart', [[x, y]]); await touch('touchEnd', []);
  };
  const keyboard = () => ctx.evaluate(`({ open: document.activeElement?.id === 'keyboard-input', inputMode: document.querySelector('#keyboard-input').inputMode, pressed: document.querySelector('#keyboard').getAttribute('aria-pressed') })`);
  const shown = selector => ctx.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const r = e.getBoundingClientRect(); return !e.hidden && r.width > 0 && r.height > 0; })()`);
  // The phone point for a framebuffer point, then a finger held still there, as for a long press.
  const point = (fx, fy) => ctx.evaluate(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(), s = r.width / ${width}; return [r.left + ${fx} * s, r.top + ${fy} * s]; })()`);
  const hold = async (fx, fy, ms = 450) => { const [x, y] = await point(fx, fy); await touch('touchStart', [[x, y]]); await pause(ms); await touch('touchEnd', []); return [x, y]; };
  const doubleTap = async (fx, fy) => { const [x, y] = await point(fx, fy); for (const dx of [0, 2]) { await touch('touchStart', [[x + dx, y]]); await touch('touchEnd', []); } return [x, y]; };
  const pill = () => ctx.evaluate(`(() => { const e = document.querySelector('#quick-actions'), r = e.getBoundingClientRect();
    return { visible: !e.hidden, copy: !document.querySelector('#quick-copy').hidden, paste: !document.querySelector('#quick-paste').hidden,
      left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, width: r.width }; })()`);
  return { ...ctx, errors, touch, tap, keyboard, press: selector => press(ctx, selector), shown, point, hold, doubleTap, pill };
}
async function trackpadPhone(t) {
  const ctx = await phone(t, undefined);
  await ctx.evaluate("__viewer.setInputMode('trackpad')");
  return ctx;
}
const settle = () => pause(300);
const noVncSkip = !assets ? 'set NOVNC_ASSETS_DIR to the noVNC 1.7.0 source tree' : !existsSync(chromePath) ? 'Chrome unavailable' : false;

test('the ⋯ sheet holds zoom, Copy and Paste as icons, and a tap on the page only closes it', { skip: noVncSkip }, async t => {
  const { evaluate, press, tap, point, peers } = await phone(t, undefined);
  await evaluate('__viewer.showBar()');
  await press('#more');
  assert.equal(await evaluate(`document.querySelector('#more').getAttribute('aria-expanded')`), 'true');
  const sizes = await evaluate(`[...document.querySelectorAll('#more-sheet button')].map(b => { const r = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label'), w: r.width, h: r.height }; })`);
  assert.deepEqual(sizes.map(s => s.label), ['Zoom out', 'Zoom in', 'Actual size', 'Copy', 'Paste']);
  assert.ok(sizes.every(s => s.w >= 44 && s.h >= 44), 'every sheet button is a full finger target');
  await press('#zoom-toggle');
  assert.equal(await evaluate(`Number(document.querySelector('#zoom-level').dataset.scale)`), 1, 'the toggle goes to 100%');
  assert.equal(await evaluate(`document.querySelector('#zoom-toggle').getAttribute('aria-label')`), 'Fit to screen');
  // The brief's tap(960, 900) falls outside the 1280x720 framebuffer, so aim at a point that is on the phone and below the bar.
  const [px, py] = await point(640, 420);
  const barBottom = await evaluate(`document.querySelector('#bar').getBoundingClientRect().bottom`);
  assert.ok(px >= 0 && px <= 390 && py <= 844 && py > barBottom + 4, `the tap point (${px}, ${py}) is on screen below the bar (${barBottom})`);
  const before = peers.at(-1).pointers.length;
  await tap(640, 420);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(peers.at(-1).pointers.length, before, 'a tap on the page while the sheet is open sends nothing');
  assert.equal(await evaluate('__viewer.sheetOpen()'), false, 'that tap closes the sheet');
  assert.equal(await evaluate('__viewer.barHidden()'), false, 'and does not hide the bar');
});

test('a tap that focuses a remote text field opens the keyboard with that field’s layout', { skip: noVncSkip }, async t => {
  const focus = { answer: { kind: 'editable', inputMode: 'tel', multiline: false }, requests: 0 };
  const { tap, keyboard, waitFor, peers } = await phone(t, focus);
  const before = peers.at(-1).pointers.length;
  await tap(640, 400);
  await waitFor(`document.activeElement?.id === 'keyboard-input'`, 'the keyboard opened after the tap');
  assert.deepEqual(await keyboard(), { open: true, inputMode: 'tel', pressed: 'true' });
  assert.ok(peers.at(-1).pointers.slice(before).some(event => event.mask === 1), 'the tap still clicked the remote field');
  assert.ok(focus.requests >= 1);
  focus.answer = { kind: 'editable', inputMode: 'email', multiline: false };
  await tap(640, 500);
  await waitFor(`document.querySelector('#keyboard-input').inputMode === 'email'`, 'a tap on another field switches the layout');
  assert.equal((await keyboard()).open, true);
  focus.answer = { kind: 'none' };
  await tap(640, 600);
  await waitFor(`document.activeElement?.id !== 'keyboard-input'`, 'a tap away from any field closes the keyboard it opened');
});

test('a keyboard the owner opened stays open when a tap lands outside a field', { skip: noVncSkip }, async t => {
  const focus = { answer: { kind: 'none' }, requests: 0 };
  const { tap, keyboard, press, evaluate, waitFor } = await phone(t, focus);
  await press('#bar-tab');
  await waitFor('!__viewer.barHidden()', 'a tap on the tab brings the bar back');
  await evaluate(`document.querySelector('#keyboard').click()`);
  assert.equal((await keyboard()).open, true);
  // The bar stays open, as it is while someone types. This tap lands below it.
  await tap(640, 680);
  for (let n = 0; n < 100 && focus.requests < 1; n++) await pause(20);
  assert.ok(focus.requests >= 1, 'the tap was checked');
  await pause(900);
  assert.equal((await keyboard()).open, true, 'the owner’s keyboard is left alone');
});

test('Chrome’s own toolbar opens the keyboard only for a tap at the top of the browser', { skip: noVncSkip }, async t => {
  const focus = { answer: { kind: 'browser-ui' }, requests: 0 };
  const { tap, keyboard, waitFor } = await phone(t, focus);
  await tap(640, 400);
  for (let n = 0; n < 100 && focus.requests < 1; n++) await pause(20);
  await pause(900);
  assert.equal((await keyboard()).open, false, 'a tap in the page area does not open it for browser UI');
  await tap(400, 60);
  await waitFor(`document.activeElement?.id === 'keyboard-input'`, 'a tap on the address bar opens the keyboard');
  assert.equal((await keyboard()).inputMode, 'url');
});

test('an unknown focus answer, or a viewer without the focus capability, leaves the keyboard alone', { skip: noVncSkip }, async t => {
  await t.test('unknown', async t => {
    const focus = { answer: { kind: 'unknown' }, requests: 0 };
    const { tap, keyboard } = await phone(t, focus);
    await tap(640, 400);
    for (let n = 0; n < 100 && focus.requests < 1; n++) await pause(20);
    await pause(900);
    assert.equal((await keyboard()).open, false);
  });
  await t.test('no capability', async t => {
    const { tap, keyboard, peers } = await phone(t, undefined);
    const before = peers.at(-1).pointers.length;
    await tap(640, 400);
    for (let n = 0; n < 100 && !peers.at(-1).pointers.slice(before).some(event => event.mask === 1); n++) await pause(10);
    await pause(500);
    assert.equal((await keyboard()).open, false);
  });
});

test('a double tap lands both clicks on one spot, so the browser sees a double-click and selects the word', { skip: noVncSkip }, async t => {
  const { tap, peers } = await phone(t, undefined);
  const peer = peers.at(-1);
  const clicks = async (from, count) => {
    for (let n = 0; n < 100 && peer.pointers.slice(from).filter(event => event.mask === 1).length < count; n++) await pause(10);
    return peer.pointers.slice(from).filter(event => event.mask === 1);
  };
  let before = peer.pointers.length;
  // About six CSS pixels apart on this phone, as two taps on one word usually are.
  await tap(640, 400); await tap(660, 412);
  const [first, second] = await clicks(before, 2);
  assert.ok(first && second, 'both taps clicked');
  assert.deepEqual([second.x, second.y], [first.x, first.y], 'the second click repeats the first one’s position');
  await pause(600);
  before = peer.pointers.length;
  await tap(700, 450);
  const [later] = await clicks(before, 1);
  assert.ok(Math.abs(later.x - 700) <= 2 && Math.abs(later.y - 450) <= 2, 'a tap after a pause stays where it landed');
  before = peer.pointers.length;
  await tap(300, 300); await tap(900, 300);
  const [, far] = await clicks(before, 2);
  assert.ok(Math.abs(far.x - 900) <= 2, 'a quick tap somewhere else stays where it landed');
});

test('a plain tap never offers Copy or Paste; a double tap on selected text offers Copy just above the finger', { skip: noVncSkip }, async t => {
  const focus = { answer: { kind: 'none', selected: true }, requests: 0 };
  const { tap, doubleTap, press, pill, evaluate, waitFor, clipboardRequests } = await phone(t, focus, { clipboardBridge: true });
  await evaluate(`window.clipboardWrites = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => '', writeText: async text => window.clipboardWrites.push(text) } })`);
  await tap(640, 400);
  for (let n = 0; n < 100 && focus.requests < 1; n++) await pause(20);
  await pause(700);
  assert.equal((await pill()).visible, false, 'a tap is not a request for Copy');
  await pause(500);
  const [x, y] = await doubleTap(640, 400);
  await waitFor(`!document.querySelector('#quick-actions').hidden`, 'Copy appears after a double tap selects text');
  const bar = await pill();
  assert.deepEqual([bar.copy, bar.paste], [true, false], 'page text offers Copy only');
  assert.ok(bar.height <= 40 && bar.width <= 120, 'a small bar, not a big button: ' + JSON.stringify(bar));
  assert.ok(bar.bottom <= y && y - bar.bottom <= 40 && bar.left <= x && bar.right >= x, 'it sits just above the finger: ' + JSON.stringify({ bar, x, y }));
  await press('#quick-copy');
  await waitFor('window.clipboardWrites.length === 1', 'the selection reached this device');
  assert.deepEqual(clipboardRequests, [{ action: 'read' }]);
  await waitFor(`document.querySelector('#quick-actions').hidden`, 'the bar goes away after copying, as on Android');
  await doubleTap(640, 400);
  await waitFor(`!document.querySelector('#quick-actions').hidden`, 'Copy is offered again');
  await tap(300, 200);
  assert.equal((await pill()).visible, false, 'the next touch on the browser dismisses it');
});

test('touch and hold in a text field offers Paste just above the finger, and a tap in the field does not', { skip: noVncSkip }, async t => {
  const focus = { answer: { kind: 'editable', inputMode: 'text', multiline: false }, requests: 0 };
  const { tap, hold, press, pill, evaluate, waitFor, clipboardRequests, peers } = await phone(t, focus, { clipboardBridge: true });
  await evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => 'from my phone', writeText: async () => {} } })`);
  await tap(640, 400);
  await waitFor(`document.activeElement?.id === 'keyboard-input'`, 'a tap in the field opens the keyboard');
  await pause(700);
  assert.equal((await pill()).visible, false, 'an open keyboard alone does not offer Paste');
  // The phone keyboard covers the lower part of the screen.
  await evaluate(`window.visibleArea = { width: 390, height: 444, offsetLeft: 0, offsetTop: 0 }; for (const key of Object.keys(visibleArea)) Object.defineProperty(visualViewport, key, { configurable: true, get: () => visibleArea[key] }); visualViewport.dispatchEvent(new Event('resize'));`);
  const [x, y] = await hold(640, 300);
  await waitFor(`!document.querySelector('#quick-actions').hidden`, 'Paste appears after a hold in the field');
  const bar = await pill();
  assert.deepEqual([bar.copy, bar.paste], [false, true], 'an empty field offers Paste only');
  assert.ok(bar.height <= 40 && bar.width <= 120, 'a small bar: ' + JSON.stringify(bar));
  assert.ok(bar.bottom <= y && y - bar.bottom <= 40 && bar.left <= x && bar.right >= x, 'just above the finger: ' + JSON.stringify({ bar, x, y }));
  assert.ok(bar.top >= 0 && bar.bottom <= 444, 'above the keyboard');
  const keysBefore = peers.at(-1).keys.length;
  await press('#quick-paste');
  for (let n = 0; n < 100 && clipboardRequests.length < 1; n++) await pause(10);
  assert.deepEqual(clipboardRequests, [{ action: 'write', text: 'from my phone' }]);
  for (let n = 0; n < 100 && !peers.at(-1).keys.slice(keysBefore).some(key => key.down && key.keysym === 0x76); n++) await pause(10);
  assert.ok(peers.at(-1).keys.slice(keysBefore).some(key => key.down && key.keysym === 0x76), 'Ctrl+V reached the browser');
  assert.equal(await evaluate(`document.activeElement?.id`), 'keyboard-input', 'the keyboard stays open for more typing');
  await waitFor(`document.querySelector('#quick-actions').hidden`, 'the bar goes away after pasting');
  focus.answer = { kind: 'editable', inputMode: 'text', multiline: true, selected: true };
  await hold(640, 300);
  await waitFor(`!document.querySelector('#quick-actions').hidden`, 'a hold that selects text in a field offers both');
  assert.deepEqual(await evaluate(`[!document.querySelector('#quick-copy').hidden, !document.querySelector('#quick-paste').hidden]`), [true, true]);
  // A hold near the bottom still keeps the bar on screen, above the keyboard.
  focus.answer = { kind: 'editable', inputMode: 'text', multiline: false };
  await tap(100, 100);
  await hold(640, 690);
  await waitFor(`!document.querySelector('#quick-actions').hidden`, 'Paste for a hold low in the screen');
  const low = await pill();
  assert.ok(low.top >= 0 && low.bottom <= 444, 'kept inside the visible area: ' + JSON.stringify(low));
});

test('Trackpad: sliding moves the pointer without clicking, and a tap clicks at the pointer', { skip: noVncSkip }, async t => {
  const { evaluate, touch, peers } = await trackpadPhone(t);
  const scaleAtFit = await evaluate(`Number(document.querySelector('#zoom-level').dataset.scale)`);
  const peer = peers.at(-1), before = peer.pointers.length;
  const start = await evaluate('__viewer.pointer()');
  await touch('touchStart', [[200, 600]]); await touch('touchMove', [[230, 600]]); await touch('touchMove', [[260, 600]]); await touch('touchEnd', []);
  await settle();
  const moved = await evaluate('__viewer.pointer()');
  assert.ok(moved.x > start.x + 50 / scaleAtFit, 'the pointer moved right by about the finger travel');
  assert.ok(peer.pointers.slice(before).every(e => (e.mask & 7) === 0), 'sliding never presses a button');
  await touch('touchStart', [[100, 700]]); await touch('touchEnd', []);
  await settle();
  const click = peer.pointers.slice(before).filter(e => e.mask === 1);
  assert.equal(click.length, 1);
  assert.ok(Math.abs(click[0].x - moved.x) <= 1 && Math.abs(click[0].y - moved.y) <= 1, 'the tap clicks at the pointer, not under the finger');
});

test('Trackpad: a slide sends hover moves to the desktop with no button', { skip: noVncSkip }, async t => {
  const { evaluate, touch, peers } = await trackpadPhone(t);
  const peer = peers.at(-1), before = peer.pointers.length;
  const start = await evaluate('__viewer.pointer()');
  await touch('touchStart', [[200, 600]]); await touch('touchMove', [[230, 600]]); await touch('touchMove', [[260, 600]]); await touch('touchEnd', []);
  await settle();
  const fresh = peer.pointers.slice(before);
  assert.ok(fresh.some(e => e.mask === 0 && e.x !== Math.floor(start.x)), 'a hover move reached the desktop');
});

test('Trackpad: a two-finger tap right-clicks at the pointer', { skip: noVncSkip }, async t => {
  const { evaluate, touch, peers } = await trackpadPhone(t);
  const peer = peers.at(-1), before = peer.pointers.length;
  const pointer = await evaluate('__viewer.pointer()');
  await touch('touchStart', [[150, 600]]); await touch('touchStart', [[150, 600], [230, 600]]); await touch('touchEnd', []);
  await settle();
  const masks = [];
  for (const e of peer.pointers.slice(before)) if (!(masks.length === 0 && e.mask === 0) && masks.at(-1) !== e.mask) masks.push(e.mask);
  assert.deepEqual(masks, [4, 0]);
  const right = peer.pointers.slice(before).find(e => e.mask === 4);
  assert.ok(Math.abs(right.x - pointer.x) <= 1 && Math.abs(right.y - pointer.y) <= 1, 'the right click lands at the pointer');
});

test('Trackpad: the pointer reaches single desktop pixels at Fit', { skip: noVncSkip }, async t => {
  const { evaluate, touch, peers } = await trackpadPhone(t);
  const peer = peers.at(-1), seen = new Set();
  for (let n = 0; n < 6; n++) {
    await touch('touchStart', [[200, 600]]); await touch('touchMove', [[205, 600]]); await pause(300); await touch('touchEnd', []);
    await settle();
    seen.add(Math.floor((await evaluate('__viewer.pointer()')).x));
  }
  assert.equal(seen.size, 6, 'six slides of 5 px reach six distinct desktop pixels');
  const final = await evaluate('__viewer.pointer()');
  const before = peer.pointers.length;
  await touch('touchStart', [[100, 700]]); await touch('touchEnd', []);
  await settle();
  assert.equal(peer.pointers.slice(before).find(e => e.mask === 1).x, Math.floor(final.x));
});

test('Trackpad: two quick taps land both clicks on one desktop pixel', { skip: noVncSkip }, async t => {
  const { touch, peers } = await trackpadPhone(t);
  const peer = peers.at(-1), before = peer.pointers.length;
  await touch('touchStart', [[100, 700]]); await touch('touchEnd', []);
  await pause(100);
  await touch('touchStart', [[100, 700]]); await touch('touchMove', [[105, 700]]); await touch('touchEnd', []);
  await settle();
  const clicks = peer.pointers.slice(before).filter(e => e.mask === 1);
  assert.equal(clicks.length, 2);
  assert.deepEqual([clicks[0].x, clicks[0].y], [clicks[1].x, clicks[1].y]);
});

test('Trackpad: the pointer shows only in Trackpad mode while in control', { skip: noVncSkip }, async t => {
  const { evaluate, shown, waitFor } = await trackpadPhone(t);
  assert.equal(await shown('#pointer'), true);
  await evaluate("__viewer.setInputMode('touch')");
  assert.equal(await shown('#pointer'), false);
  await evaluate("__viewer.setInputMode('trackpad')");
  assert.equal(await shown('#pointer'), true);
  await evaluate(`document.querySelector('#done').click()`);
  await waitFor(`document.querySelector('#status').textContent.includes('Test browser destroyed.')`, 'Done completes');
  assert.equal(await shown('#pointer'), false, 'the pointer is hidden once access has ended');
});

test('Trackpad: a gesture that began before control was ready does not outlive the change', { skip: noVncSkip }, async t => {
  const { evaluate, touch, press, waitFor, peers } = await trackpadPhone(t);
  const peer = peers.at(-1), before = peer.pointers.length;
  await evaluate('__viewer.setControlReady(false)');
  await touch('touchStart', [[100, 700]]);
  await evaluate('__viewer.setControlReady(true)');
  await touch('touchEnd', []);
  await settle();
  assert.deepEqual(await evaluate('__viewer.gestures()'), { touch: false, pad: false });
  await press('#bar-tab');
  await waitFor('!__viewer.barHidden()', 'the tab still brings the bar back');
  assert.equal(peer.pointers.slice(before).filter(e => e.mask === 1).length, 0, 'no stray click');
});

test('Trackpad: a two-finger gesture that slides sends wheel packets and never a button', { skip: noVncSkip }, async t => {
  const { touch, peers } = await trackpadPhone(t);
  const peer = peers.at(-1), before = peer.pointers.length;
  await touch('touchStart', [[150, 600]]); await touch('touchStart', [[150, 600], [230, 600]]);
  await touch('touchMove', [[150, 640], [230, 640]]); await touch('touchEnd', []);
  await settle();
  assert.ok(peer.pointers.slice(before).every(e => (e.mask & 7) === 0), 'no button packets');
});

const maskRun = (packets) => { const out = []; for (const e of packets) if (!(out.length === 0 && e.mask === 0) && out.at(-1) !== e.mask) out.push(e.mask); return out; };

test('Trackpad: tap then drag holds the left button through the slide and releases on lift.', { skip: noVncSkip }, async t => {
  const { evaluate, touch, peers } = await trackpadPhone(t);
  const peer = peers.at(-1);
  await touch('touchStart', [[100, 700]]); await touch('touchEnd', []);
  await pause(80);
  const first = peer.pointers.length;
  await touch('touchStart', [[100, 700]]);
  for (const x of [120, 140, 160]) await touch('touchMove', [[x, 700]]);
  await touch('touchEnd', []);
  await settle();
  const drag = peer.pointers.slice(first);
  assert.deepEqual(maskRun(drag), [1, 0]);
  const held = drag.filter(e => e.mask === 1);
  assert.ok(new Set(held.map(e => e.x)).size >= 2, 'the held packets moved');
  const pointer = await evaluate('__viewer.pointer()');
  assert.equal(drag.at(-1).x, Math.floor(pointer.x));
  assert.equal(drag.at(-1).mask, 0);
});

test('Trackpad: a quick 6 px second contact double-clicks at one spot, and a 20 px one drags', { skip: noVncSkip }, async t => {
  const { touch, peers } = await trackpadPhone(t);
  const peer = peers.at(-1), before = peer.pointers.length;
  await touch('touchStart', [[100, 700]]); await touch('touchEnd', []);
  await pause(80);
  await touch('touchStart', [[100, 700]]); await touch('touchMove', [[103, 700]]); await touch('touchMove', [[106, 700]]); await touch('touchEnd', []);
  await settle();
  const fresh = peer.pointers.slice(before), presses = fresh.filter(e => e.mask === 1);
  assert.equal(presses.length, 2, 'two clicks');
  assert.deepEqual([presses[0].x, presses[0].y], [presses[1].x, presses[1].y]);
  assert.ok(fresh.every(e => e.mask === 0 || e.mask === 1) && maskRun(fresh).join() === '1,0,1,0', 'no moves while pressed');
  await pause(600);
  const second = peer.pointers.length;
  await touch('touchStart', [[100, 700]]); await touch('touchEnd', []);
  await pause(80);
  await touch('touchStart', [[100, 700]]); await touch('touchMove', [[120, 700]]); await touch('touchMove', [[140, 700]]); await touch('touchEnd', []);
  await settle();
  const drag = peer.pointers.slice(second);
  assert.ok(drag.filter(e => e.mask === 1).length >= 2 && new Set(drag.filter(e => e.mask === 1).map(e => e.x)).size >= 2, 'the 20 px contact dragged');
});

test('Trackpad: a held drag is released by pinch, a hidden page, switching to Touch, Done, and a dropped connection.', { skip: noVncSkip }, async t => {
  const endings = {
    pinch: async ({ touch }) => { await touch('touchStart', [[130, 700], [130, 780]]); await touch('touchMove', [[130, 684], [130, 796]]); await touch('touchEnd', []); },
    hidden: async ({ evaluate }) => { await evaluate("Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange'))"); },
    touch: async ({ evaluate }) => { await evaluate("__viewer.setInputMode('touch')"); },
    done: async ({ evaluate }) => { await evaluate("document.querySelector('#done').click()"); },
    dropped: async ({ peers }) => { peers.at(-1).socket.terminate(); },
  };
  for (const [name, end] of Object.entries(endings)) await t.test(name, async t => {
    const ctx = await trackpadPhone(t);
    const { evaluate, touch, peers } = ctx;
    const peer = peers.at(-1);
    await touch('touchStart', [[100, 700]]); await touch('touchEnd', []);
    await pause(80);
    await touch('touchStart', [[100, 700]]); await touch('touchMove', [[130, 700]]);
    await settle();
    assert.equal(peer.pointers.at(-1).mask, 1, 'the button is held');
    await evaluate("window.__ups = 0; const send = window.dispatchEvent.bind(window); window.dispatchEvent = e => { if (e.type === 'mouseup') window.__ups++; return send(e); }");
    await end(ctx);
    await settle();
    if (name !== 'dropped') assert.equal(peer.pointers.at(-1).mask, 0, 'the release reached the desktop');
    assert.equal(await evaluate('__ups'), 1, 'exactly one release');
    assert.equal(await evaluate('document.captureElement'), null, 'noVNC holds no capture');
    assert.equal((await evaluate('__viewer.gestures()')).pad, false);
  });
});

test('Trackpad: two fingers sliding together scroll at the pointer without pressing a button.', { skip: noVncSkip }, async t => {
  const { evaluate, touch, peers } = await trackpadPhone(t);
  const peer = peers.at(-1), before = peer.pointers.length;
  const scale = await evaluate(`Number(document.querySelector('#zoom-level').dataset.scale)`);
  await touch('touchStart', [[150, 500]]); await touch('touchStart', [[150, 500], [230, 500]]);
  for (let y = 500; y <= 620; y += 20) await touch('touchMove', [[150, y], [230, y]]);
  await touch('touchEnd', []);
  await settle();
  const fresh = peer.pointers.slice(before);
  assert.ok(fresh.some(e => e.mask & 0x78), 'wheel events reached the desktop');
  const at = await evaluate('__viewer.pointer()');
  assert.ok(fresh.filter(e => e.mask & 0x78).every(e => Math.abs(e.x - Math.floor(at.x)) <= 1 && Math.abs(e.y - Math.floor(at.y)) <= 1), 'wheel lands at the pointer');
  assert.ok(fresh.every(e => (e.mask & 7) === 0), 'no button');
  assert.equal(await evaluate(`Number(document.querySelector('#zoom-level').dataset.scale)`), scale);
});

test('Trackpad: a pinch zooms the view as in Touch.', { skip: noVncSkip }, async t => {
  const { evaluate, touch } = await trackpadPhone(t);
  const scale = await evaluate(`Number(document.querySelector('#zoom-level').dataset.scale)`);
  await touch('touchStart', [[150, 500]]); await touch('touchStart', [[150, 500], [230, 500]]);
  for (const d of [100, 120, 140]) await touch('touchMove', [[150, 500], [150 + d, 500]]);
  await touch('touchEnd', []);
  await settle();
  assert.ok(await evaluate(`Number(document.querySelector('#zoom-level').dataset.scale)`) > scale);
});

test('Trackpad: a wide pinch with one finger moving inward zooms and sends no wheel', { skip: noVncSkip }, async t => {
  const { evaluate, touch, peers } = await trackpadPhone(t);
  const peer = peers.at(-1), before = peer.pointers.length;
  const scale = await evaluate(`Number(document.querySelector('#zoom-level').dataset.scale)`);
  await touch('touchStart', [[50, 500]]); await touch('touchStart', [[50, 500], [250, 500]]);
  for (let x = 246; x >= 186; x -= 4) await touch('touchMove', [[50, 500], [x, 500]]);
  await touch('touchEnd', []);
  await settle();
  assert.notEqual(await evaluate(`Number(document.querySelector('#zoom-level').dataset.scale)`), scale);
  assert.ok(peer.pointers.slice(before).every(e => !(e.mask & 0x78)), 'no wheel');
});

test('Trackpad: the pointer is pulled back on screen after a resize.', { skip: noVncSkip }, async t => {
  const { evaluate, touch, cdp } = await trackpadPhone(t);
  await evaluate('__viewer.zoomTo(1)');
  await settle();
  for (let n = 0; n < 8; n++) { await touch('touchStart', [[50, 600]]); await touch('touchMove', [[150, 600]]); await touch('touchMove', [[250, 600]]); await touch('touchMove', [[350, 600]]); await touch('touchEnd', []); await pause(50); }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 300, height: 844, deviceScaleFactor: 2, mobile: true });
  await settle();
  const r = await evaluate(`(() => { const r = document.querySelector('#pointer').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: innerWidth, h: innerHeight }; })()`);
  // The hotspot is 1.5 px inside the glyph; at the far edge of the desktop the arrow body may overhang, so the hotspot must be on screen.
  assert.ok(r.left + 1.5 >= 0 && r.left + 1.5 < r.w && r.top + 1.5 >= 0 && r.top + 1.5 < r.h, 'pointer hotspot inside the window: ' + JSON.stringify(r));
  assert.ok((await evaluate('__viewer.pointer()')).x <= width - 1);
});

test('Touch: a resize does not scroll the view toward a leftover Trackpad pointer', { skip: noVncSkip }, async t => {
  const { evaluate, touch, cdp } = await trackpadPhone(t);
  await evaluate('__viewer.zoomTo(1)');
  await settle();
  for (let n = 0; n < 8; n++) { await touch('touchStart', [[50, 600]]); await touch('touchMove', [[150, 600]]); await touch('touchMove', [[250, 600]]); await touch('touchMove', [[350, 600]]); await touch('touchEnd', []); await pause(50); }
  await evaluate("__viewer.setInputMode('touch')");
  await evaluate("document.querySelector('#viewport').scrollLeft = 0");
  await settle();
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 300, height: 844, deviceScaleFactor: 2, mobile: true });
  await settle();
  assert.equal(await evaluate("document.querySelector('#viewport').scrollLeft"), 0, 'Touch mode keeps the view where the owner left it');
});

test('a tap on the page while in control hides the bar and still clicks there', { skip: noVncSkip }, async t => {
  const { evaluate, tap, point, peers } = await phone(t, undefined);
  await evaluate('__viewer.showBar()');
  // The brief's tap(960, 900) is outside the 1280x720 framebuffer, so aim at a page point below the bar.
  const [px, py] = await point(640, 500);
  const barBottom = await evaluate(`document.querySelector('#bar').getBoundingClientRect().bottom`);
  assert.ok(px >= 0 && px <= 390 && py <= 844 && py > barBottom + 4, `the tap point (${px}, ${py}) is on screen below the bar (${barBottom})`);
  const before = peers.at(-1).pointers.length;
  await tap(640, 500);
  await settle();
  assert.equal(await evaluate('__viewer.barHidden()'), true);
  assert.deepEqual(peers.at(-1).pointers.slice(before).map(e => e.mask), [1, 0], 'the same tap clicked once');
});

test('taps and slides that start on the bar, the sheet or the tab never reach the remote screen', { skip: noVncSkip }, async t => {
  const { evaluate, press, touch, peers } = await phone(t, undefined);
  const peer = peers.at(-1);
  for (const mode of ['touch', 'trackpad']) {
    await evaluate(`__viewer.setInputMode('${mode}')`);
    for (const view of ['fit', 'zoomed']) {
      await evaluate(view === 'fit' ? "__viewer.zoomTo('fit')" : "__viewer.zoomTo(3); document.querySelector('#viewport').scrollTop = 0");
      await settle();
      await evaluate('__viewer.closeSheet(); __viewer.showBar()');
      await settle();
      const before = peer.pointers.length;
      const label = `${mode}, ${view}`;
      // The empty middle of the bar, between the status badge and the centre group.
      const [mx, my] = await evaluate(`(() => { const a = document.querySelector('#bar-status').getBoundingClientRect(), c = document.querySelector('#input-mode').getBoundingClientRect(), row = document.querySelector('.bar-row').getBoundingClientRect(); return [(a.right + c.left) / 2, row.top + row.height / 2]; })()`);
      assert.equal(await evaluate(`document.elementFromPoint(${mx}, ${my}).closest('#bar') !== null`), true, `${label}: the point (${mx}, ${my}) is on the bar`);
      await touch('touchStart', [[mx, my]]); await touch('touchEnd', []);
      await press('#bar-status');
      await press('#more');
      for (const selector of ['#zoom-out', '#zoom-in', '#zoom-toggle']) await press(selector);
      // A slide that starts on the bar and ends on the page.
      await touch('touchStart', [[mx, my]]); await touch('touchMove', [[mx, my + 150]]); await touch('touchMove', [[mx + 40, my + 400]]); await touch('touchEnd', []);
      await evaluate('__viewer.hideBar()');
      const [tx, ty] = await evaluate(`(() => { const r = document.querySelector('#bar-tab').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
      await touch('touchStart', [[tx, ty]]); await touch('touchMove', [[tx, ty + 80]]); await touch('touchEnd', []);
      await settle();
      const leaked = peer.pointers.slice(before);
      assert.deepEqual(leaked.filter(e => (e.mask & 7) || (e.mask & 0x78)), [], `${label}: no button or wheel packet reached the remote screen`);
      assert.deepEqual(await evaluate('__viewer.gestures()'), { touch: false, pad: false }, `${label}: no gesture is left alive`);
    }
  }
});

test('showing and hiding the bar leaves zoom and scroll exactly where they were', { skip: noVncSkip }, async t => {
  const { evaluate } = await phone(t, undefined);
  await evaluate('__viewer.zoomTo(2)');
  await settle();
  await evaluate(`(() => { const v = document.querySelector('#viewport'); v.scrollLeft = 120; v.scrollTop = 90; })()`);
  const state = () => evaluate(`(() => { const v = document.querySelector('#viewport'); return { scale: document.querySelector('#zoom-level').dataset.scale, left: v.scrollLeft, top: v.scrollTop }; })()`);
  const start = await state();
  assert.ok(start.left > 0 && start.top > 0, 'the view is scrolled');
  await evaluate('__viewer.showBar()');
  assert.deepEqual(await state(), start, 'showing the bar changes nothing');
  await evaluate('__viewer.hideBar()');
  assert.deepEqual(await state(), start, 'hiding the bar changes nothing');
  await evaluate('__viewer.showBar()');
  assert.deepEqual(await state(), start, 'showing it again changes nothing');
});

test('the hidden tab brings the bar back with a tap or a pull down', { skip: noVncSkip }, async t => {
  const { evaluate, press, touch, peers } = await phone(t, undefined);
  const before = peers.at(-1).pointers.length;
  const inBar = () => evaluate(`document.querySelector('#bar').contains(document.activeElement) && document.activeElement.tagName === 'BUTTON'`);
  const onTab = async dy => {
    const [x, y] = await evaluate(`(() => { const r = document.querySelector('#bar-tab').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await touch('touchStart', [[x, y]]); await touch('touchMove', [[x, y + dy]]); await touch('touchEnd', []);
    await settle();
  };
  await evaluate('__viewer.hideBar()');
  await press('#bar-tab');
  await settle();
  assert.equal(await evaluate('__viewer.barHidden()'), false, 'a tap shows the bar');
  assert.equal(await inBar(), true, 'a tap moves focus onto a bar button');
  await evaluate('document.activeElement.blur(); __viewer.hideBar()');
  await onTab(30);
  assert.equal(await evaluate('__viewer.barHidden()'), false, 'a pull of 30 px shows the bar');
  assert.equal(await inBar(), false, 'a pull does not also fire the tap click and its focus jump');
  await evaluate('__viewer.hideBar()');
  await onTab(5);
  assert.equal(await evaluate('__viewer.barHidden()'), false, 'a 5 px wobble counts as a tap');
  assert.equal(await inBar(), true, 'the wobble went through the normal click');
  assert.equal(peers.at(-1).pointers.length, before, 'none of these sent a pointer packet');
});

test('the Touch / Trackpad switch sits in the center, and the choice survives a reload', { skip: noVncSkip }, async t => {
  const { evaluate, press, waitFor, cdp, errors } = await phone(t, undefined);
  await evaluate('__viewer.showBar()');
  const center = await evaluate(`(() => { const r = document.querySelector('#input-mode').getBoundingClientRect(); return { mid: r.left + r.width / 2, w: r.width, btns: [...document.querySelectorAll('#input-mode button')].map(b => { const q = b.getBoundingClientRect(); return [q.width, q.height]; }) }; })()`);
  assert.ok(Math.abs(center.mid - 195) <= 1, `the switch is centered (${center.mid})`);
  assert.ok(center.btns.length === 2 && center.btns.every(([w, h]) => w >= 44 && h >= 44), 'both segments are full finger targets');
  assert.equal(await evaluate(`document.querySelector('#mode-touch').getAttribute('aria-checked')`), 'true');
  await press('#mode-trackpad');
  await waitFor(`document.querySelector('#mode-trackpad').getAttribute('aria-checked') === 'true'`, 'Trackpad checked');
  assert.equal(await evaluate(`document.querySelector('#mode-touch').getAttribute('aria-checked')`), 'false');
  assert.equal(await evaluate(`!document.querySelector('#pointer').hidden`), true, 'the pointer is shown');
  assert.equal(await evaluate(`!document.querySelector('#trackpad-hint').hidden`), true, 'the hint is shown');
  assert.equal(await evaluate(`document.querySelector('#trackpad-hint').textContent`), 'Slide to move the pointer. Tap to click. Two\u2011finger tap to right\u2011click.');
  assert.match(await evaluate(`document.querySelector('#status').textContent`), /Control connected\./, 'the hint never writes into the status line');
  await cdp.send('Page.reload');
  await waitFor(`document.querySelector('#status')?.textContent === 'Control connected.' && document.querySelector('canvas')?.width === ${width}`, 'reconnected');
  await waitFor(`document.querySelector('#mode-trackpad').getAttribute('aria-checked') === 'true'`, 'Trackpad restored');
  assert.equal(await evaluate(`document.querySelector('#trackpad-hint').hidden`), true, 'the hint stays hidden after a reload');
  assert.deepEqual(errors, []);
});

test('a broken or missing stored mode falls back to Touch without an error', { skip: noVncSkip }, async t => {
  const checked = id => `document.querySelector('${id}').getAttribute('aria-checked')`;
  const { evaluate, press, waitFor, cdp, errors } = await phone(t, undefined);
  await evaluate(`localStorage.setItem('clawser.inputMode', 'banana')`);
  await cdp.send('Page.reload');
  await waitFor(`document.querySelector('#status')?.textContent === 'Control connected.' && document.querySelector('canvas')?.width === ${width}`, 'reconnected');
  assert.equal(await evaluate(checked('#mode-touch')), 'true', 'banana means Touch');
  assert.equal(await evaluate(checked('#mode-trackpad')), 'false');
  assert.deepEqual(errors, []);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `Storage.prototype.getItem = () => { throw new Error('denied'); }; Storage.prototype.setItem = () => { throw new Error('denied'); };` });
  await cdp.send('Page.reload');
  await waitFor(`document.querySelector('#status')?.textContent === 'Control connected.' && document.querySelector('canvas')?.width === ${width}`, 'reconnected');
  assert.equal(await evaluate(checked('#mode-touch')), 'true', 'a throwing store means Touch');
  await evaluate('__viewer.showBar()');
  await press('#mode-trackpad');
  await waitFor(`${checked('#mode-trackpad')} === 'true'`, 'the switch still works for this page');
  assert.equal(await evaluate(`!document.querySelector('#pointer').hidden`), true);
  assert.deepEqual(errors, []);
});

test('a mode restored from storage does not show the first-time hint', { skip: noVncSkip }, async t => {
  const { evaluate, waitFor, cdp, errors } = await phone(t, undefined);
  await evaluate(`localStorage.setItem('clawser.inputMode', 'trackpad')`);
  await cdp.send('Page.reload');
  await waitFor(`document.querySelector('#status')?.textContent === 'Control connected.' && document.querySelector('canvas')?.width === ${width}`, 'reconnected');
  await waitFor(`document.querySelector('#mode-trackpad').getAttribute('aria-checked') === 'true'`, 'Trackpad restored');
  assert.equal(await evaluate(`!document.querySelector('#pointer').hidden`), true, 'the pointer is shown');
  assert.equal(await evaluate(`document.querySelector('#trackpad-hint').hidden`), true, 'no hint on a restore');
  assert.equal(await evaluate(`localStorage.getItem('clawser.trackpadHintShown')`), null, 'a restore does not use up the hint');
  assert.deepEqual(errors, []);
});
