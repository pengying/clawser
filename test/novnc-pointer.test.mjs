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
        if (pending[0] === 5) peer.pointers.push({ mask: pending[1], x: pending.readUInt16BE(2), y: pending.readUInt16BE(4) });
      }
      pending = pending.subarray(length);
    }
  });
}

async function fixture(t, { clipboardBridge = false, retained = false } = {}) {
  assert.equal(JSON.parse(await readFile(join(assets, 'package.json'), 'utf8')).version, '1.7.0', 'use the pinned noVNC release');
  const peers = [];
  const clipboardRequests = [];
  let remoteText = '远程复制😀';
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://fixture').pathname;
      if (path.endsWith('/credentials')) {
        response.setHeader('Content-Type', 'application/json');
        return response.end(JSON.stringify({ mode: 'control', password: 'unused', generation: 0, ...(clipboardBridge ? { capabilities: { clipboard: 'utf8' } } : {}) }));
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
      const file = path.endsWith('/probe.css') ? 'probe.css' : path.endsWith('/probe.js') ? 'probe.js' : 'probe.html';
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
        controlsVisible: document.querySelector('.controls').getBoundingClientRect().bottom <= innerHeight,
        screen: { left: document.querySelector('#viewport').getBoundingClientRect().left, top: document.querySelector('#viewport').getBoundingClientRect().top, width: document.querySelector('#viewport').clientWidth, height: document.querySelector('#viewport').clientHeight } };
    })()`);
    await captureEvidence(cdp, `viewer-${scenario.name.replaceAll(' ', '-')}`);
    await evaluate(`document.querySelector('#collapse').click()`);
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
    await evaluate(`document.querySelector('#restore').click()`);
    assert.ok(geometry.doneVisible && geometry.controlsVisible, 'overlay actions remain visible');
    assert.deepEqual(geometry.screen, { left: 0, top: 0, width: scenario.width, height: scenario.height }, 'browser viewport fills the screen');
    assert.ok(geometry.scale <= 1, 'fit never upscales above 100%');
    await evaluate(`document.querySelector('#collapse').click()`);
    assert.equal(await evaluate(`document.querySelector('#toolbar').hidden && !document.querySelector('#restore').hidden`), true, 'collapsed actions leave a restore tab');
    await evaluate(`document.querySelector('#restore').click()`);
    assert.equal(await evaluate(`document.querySelector('#toolbar').hidden`), false);
    await evaluate(`document.querySelector('#zoom-in').click()`);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.ok(await evaluate(`Number(document.querySelector('#zoom-level').dataset.scale) > ${geometry.scale}`), 'zoom button increases the noVNC display scale');
    await evaluate(`document.querySelector('#zoom-fit').click()`);
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
  const toolbarBefore = await evaluate(`(() => { const r=document.querySelector('#toolbar').getBoundingClientRect();return {left:r.left,top:r.top}; })()`);
  const handle = await evaluate(`(() => { const r=document.querySelector('#drag-handle').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...handle });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: handle.x+40, y:handle.y+90 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: handle.x+40, y:handle.y+90 });
  const toolbarAfter = await evaluate(`(() => { const r=document.querySelector('#toolbar').getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom}; })()`);
  assert.ok(toolbarAfter.left >= toolbarBefore.left+30 && toolbarAfter.top >= toolbarBefore.top+80, 'drag handle moves the overlay');
  assert.ok(toolbarAfter.right <= 390 && toolbarAfter.bottom <= 844, 'moved actions remain within the narrow viewport');
  await evaluate(`document.documentElement.style.setProperty('--safe-left', '40px'); for(let n=0;n<10;n++) document.querySelector('#drag-handle').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft'}));`);
  const safePosition = await evaluate(`({ left: document.querySelector('#toolbar').getBoundingClientRect().left, style: document.querySelector('#toolbar').style.left, safe: getComputedStyle(document.documentElement).getPropertyValue('--safe-left'), animation: getComputedStyle(document.querySelector('#toolbar')).translate })`);
  t.diagnostic(JSON.stringify({safePosition}));
  assert.ok(safePosition.left >= 48, 'keyboard repositioning respects the device safe area');
  await evaluate(`document.documentElement.style.removeProperty('--safe-left')`);
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
  await evaluate(`document.querySelector('#keyboard-input').blur(); document.querySelector('#collapse').click()`);
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
  await evaluate(`document.querySelector('#restore').click(); document.querySelector('#done').click()`);
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
  await evaluate(`document.querySelector('#collapse').click()`);
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
  await evaluate(`document.querySelector('#zoom-fit').click()`);
  const beforeSmallPinch = peer.pointers.length;
  await touch('touchStart', [[145, 422]]);
  await touch('touchMove', [[145, 418]]);
  await touch('touchStart', [[145, 418], [245, 418]]);
  await touch('touchMove', [[95, 418], [295, 418]]);
  await touch('touchEnd', []);
  await pause(100);
  assert.equal(peer.pointers.length, beforeSmallPinch, 'pinch before the movement threshold sends no remote input');
  await evaluate(`document.querySelector('#restore').click(); document.querySelector('#done').click()`);
  await waitFor(`document.querySelector('#status').textContent.includes('Test browser destroyed.')`, 'Done completes');
});

test('Drag once sends mapped mouse down/move/up and releases on pinch, cancel and Done', {
  skip: !assets ? 'set NOVNC_ASSETS_DIR to the noVNC 1.7.0 source tree' : !existsSync(chromePath) ? 'Chrome unavailable' : false,
}, async (t) => {
  const { cdp, evaluate, waitFor, peers, url } = await fixture(t);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Page.navigate', { url });
  await waitFor(`document.querySelector('#status')?.textContent === 'Control connected.' && document.querySelector('canvas')?.width === ${width}`, 'RFB connected');
  assert.equal(await evaluate(`Boolean(document.querySelector('#drag-once'))`), true, 'overlay exposes a one-use native drag action');
  await evaluate(`document.querySelector('#zoom-actual').click(); document.querySelector('#collapse').click()`);
  const peer = peers.at(-1);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 1, radiusY: 1, force: 1 })) });
  const arm = async () => {
    await evaluate(`document.querySelector('#drag-once').click()`);
    assert.equal(await evaluate(`document.querySelector('#drag-once').getAttribute('aria-pressed')`), 'true');
  };
  const released = async (before, description) => {
    for (let n = 0; n < 100 && !peer.pointers.slice(before).some(event => event.mask === 0); n++) await pause(10);
    assert.equal(peer.pointers.at(-1)?.mask, 0, description);
    assert.equal(await evaluate('Boolean(document.captureElement)'), false, 'upstream mouse capture is released');
    assert.equal(await evaluate(`document.querySelector('#drag-once').getAttribute('aria-pressed')`), 'false', 'drag mode automatically resets');
  };
  const rect = await evaluate(`(() => {const r=document.querySelector('canvas').getBoundingClientRect();return {left:r.left,top:r.top,scale:Number(document.querySelector('#zoom-level').dataset.scale)};})()`);
  await arm();
  let before = peer.pointers.length;
  await touch('touchStart', [[145, 422]]);
  for (let n = 0; n < 100 && !peer.pointers.slice(before).some(event => event.mask === 1); n++) await pause(10);
  assert.ok(peer.pointers.slice(before).some(event => event.mask === 1), 'armed touch immediately holds the native mouse button');
  await touch('touchMove', [[195, 437]]);
  await touch('touchMove', [[245, 452]]);
  await touch('touchEnd', []);
  await released(before, 'completed drag releases the remote mouse button');
  const events = peer.pointers.slice(before), down = events.find(event => event.mask === 1), up = events.at(-1);
  assert.ok(events.filter(event => event.mask === 1).length >= 2, 'drag includes held-button movement');
  assert.ok(Math.abs(down.x-(145-rect.left)/rect.scale)<=2 && Math.abs(down.y-(422-rect.top)/rect.scale)<=2, 'drag start maps through noVNC scale and pan');
  assert.ok(Math.abs(up.x-(245-rect.left)/rect.scale)<=2 && Math.abs(up.y-(452-rect.top)/rect.scale)<=2, 'drag endpoint maps through noVNC scale and pan');
  before = peer.pointers.length;
  await touch('touchStart', [[195, 422]]);
  await pause(50);
  assert.equal(peer.pointers.length, before, 'the next ordinary touch does not inherit drag mode');
  await touch('touchEnd', []);
  await released(before, 'ordinary tap after drag releases capture');
  await arm(); before = peer.pointers.length;
  await touch('touchStart', [[145, 422]]);
  await touch('touchMove', [[175, 422]]);
  await touch('touchStart', [[175, 422], [245, 422]]);
  await released(before, 'adding a second finger releases the drag before pinch');
  const beforePinch = peer.pointers.length;
  await touch('touchMove', [[125, 422], [295, 422]]);
  await touch('touchEnd', []);
  await pause(100);
  assert.equal(peer.pointers.length, beforePinch, 'post-drag pinch produces no extra mouse or wheel input');
  await arm(); before = peer.pointers.length;
  await touch('touchStart', [[195, 422]]);
  await touch('touchCancel', []);
  await released(before, 'touch cancellation releases the drag');
  await arm(); before = peer.pointers.length;
  await touch('touchStart', [[195, 422]]);
  await evaluate(`document.querySelector('#done').click()`);
  await waitFor(`document.querySelector('#status').textContent.includes('Test browser destroyed.')`, 'Done completes');
  await released(before, 'Done releases the remote button before ending access');
  await touch('touchEnd', []);
});
