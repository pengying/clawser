// Local-only end-to-end QA. No user profile, external website, or Funnel changes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpBrowser, CdpConnection } from '../src/cdp.mjs';
import { HandoffServer } from '../src/server.mjs';

const directory = await mkdtemp(join(tmpdir(), 'browser-handoff-qa-'));
const fixture = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Handoff test page</title><style>body{font:18px system-ui;background:#edf3f5;color:#233447;margin:0;height:1800px}header{background:#d0e6df;padding:24px 40px}h1{font-size:24px;margin:0}#field{position:absolute;left:80px;top:120px;width:300px;height:50px;font:20px system-ui}button{position:absolute;left:80px;top:200px;width:160px;height:50px;font:18px system-ui}output{position:absolute;left:80px;top:280px}#range{position:absolute;left:450px;top:120px;width:280px;height:50px}#drag,#drop{position:absolute;top:230px;width:80px;height:80px;padding:8px;box-sizing:border-box}#drag{left:450px;background:#96c5ad}#drop{left:650px;background:#c6d4e2}#custom{position:absolute;left:450px;top:350px;width:280px;height:40px;background:#d7c6e2;touch-action:none}#thumb{display:block;width:30px;height:40px;background:#79558b;pointer-events:none}</style></head><body><header><h1>Shared browser demo</h1></header><input id="field" aria-label="Example text" placeholder="Click and type here"><button id="counter">Clicks: 0</button><output id="output">Waiting for input</output><input id="range" type="range" value="0" aria-label="Example slider"><div id="drag" draggable="true">Drag me</div><div id="drop">Drop here</div><div id="custom"><span id="thumb"></span></div><a id="ordinaryLink" href="#ordinary" style="position:absolute;left:530px;top:440px;width:210px;height:80px">Ordinary linked content</a><select id="selectFixture" aria-label="Fixture choice" style="position:absolute;left:450px;top:540px;width:180px;height:42px"><option value="PRIVATE_FIRST">First</option><option value="PRIVATE_SECOND">Second</option><optgroup label="Unavailable group" disabled><option value="PRIVATE_DISABLED">Disabled</option></optgroup><option hidden value="PRIVATE_HIDDEN">Hidden choice</option></select><input id="colorFixture" aria-label="Fixture color" type="color" value="#123456" style="position:absolute;left:650px;top:540px;width:90px;height:42px"><script>window.pickerEvents=[];for(const e of [selectFixture,colorFixture])for(const type of ["input","change"])e.addEventListener(type,()=>pickerEvents.push({id:e.id,type}));let n=0;document.querySelector('#counter').onclick=()=>{document.querySelector('#counter').textContent='Clicks: '+(++n);document.body.dataset.clicks=n};document.querySelector('#field').oninput=e=>document.querySelector('#output').textContent=e.target.value;drag.ondragstart=e=>e.dataTransfer.setData('text/plain','fixture');drop.ondragover=e=>e.preventDefault();drop.ondrop=e=>{e.preventDefault();drop.textContent='Dropped';document.body.dataset.dropped='yes'};custom.onpointerdown=e=>{custom.setPointerCapture(e.pointerId);custom.dataset.held='yes'};custom.onpointermove=e=>{if(custom.dataset.held==='yes'){const x=Math.max(0,Math.min(250,e.clientX-custom.getBoundingClientRect().left));thumb.style.transform='translateX('+x+'px)';custom.dataset.position=x}};custom.onpointerup=custom.onpointercancel=()=>delete custom.dataset.held;</script></body></html>`);
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
const launch = (profile) => spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome-stable', [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
  '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const chrome = launch(directory), phoneDirectory = join(directory, 'phone-browser'), phoneChrome = launch(phoneDirectory);
let logs = ''; for (const process of [chrome, phoneChrome]) process.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-4000); });
let handoff, remote, viewer, lastFrame, releaseOpening, sentInputs = [], inputDelay = 0, rejectNextInput = false;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { try { const result = await fn(); if (result) return result; } catch {} await pause(50); }
  throw new Error(`Timed out: ${label}`);
}
const evaluate = async (cdp, expression) => {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error('QA browser evaluation failed');
  return result.result.value;
};
async function click(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
async function clickElement(cdp, id) {
  const rect = await evaluate(cdp, `(()=>{const e=document.getElementById(${JSON.stringify(id)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await click(cdp, rect.x, rect.y);
}
async function clickSelector(cdp, selector) {
  const rect = await evaluate(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await click(cdp, rect.x, rect.y);
}
async function clickRemote(x, y) {
  const point = await evaluate(viewer, `(()=>{const e=document.getElementById('screen');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width*${x}/800,y:r.y+r.height*${y}/600}})()`);
  await click(viewer, point.x, point.y);
}
async function touchRemotePath(points) {
  const rect = await evaluate(viewer, "(()=>{const r=document.getElementById('screen').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()");
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    await viewer.send('Input.dispatchTouchEvent', { type: i ? 'touchMove' : 'touchStart', touchPoints: [{ id: 1, x: rect.x + rect.width * x / 800, y: rect.y + rect.height * y / 600 }] });
  }
  await viewer.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function touchRemoteTapWithJitter(x, y) {
  const rect = await evaluate(viewer, "(()=>{const r=document.getElementById('screen').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()");
  const point = { id: 1, x: rect.x + rect.width * x / 800, y: rect.y + rect.height * y / 600 };
  const sentBeforeTap = await evaluate(viewer, 'qaSockets.at(-1).qaInputCount');
  await viewer.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  assert.equal(await evaluate(viewer, 'qaSockets.at(-1).qaInputCount'), sentBeforeTap, 'a stationary finger press must not start a remote native touch contact');
  await viewer.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y + 7 }] });
  await viewer.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
try {
  const port = await until(async () => (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0], 'Chrome start');
  const cdpBase = `http://127.0.0.1:${port}`;
  const newTab = async (url, endpoint = cdpBase) => (await fetch(`${endpoint}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const target = await newTab(fixtureUrl);
  remote = await new CdpConnection().connect(target.webSocketDebuggerUrl);
  await remote.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 2, mobile: false });
  await until(() => evaluate(remote, "document.getElementById('field') !== null"), 'fixture DOM');
  await evaluate(remote, "document.addEventListener('pointerdown',e=>window.qaPointer={x:e.clientX,y:e.clientY,target:e.target.id})");
  const backend = new CdpBrowser({ demo: cdpBase });
  const originalOpen = backend.open.bind(backend);
  const openingGate = new Promise((resolve) => { releaseOpening = resolve; });
  let holdFirstOpening = true;
  backend.open = async (target, callbacks) => {
    const connection = await originalOpen(target, { ...callbacks, onFrame: (frame) => { lastFrame = { width: frame.width, height: frame.height }; callbacks.onFrame(frame); } });
    const originalInput = connection.input.bind(connection);
    connection.input = async (event) => {
      sentInputs.push(event);
      if (rejectNextInput) { rejectNextInput = false; throw Object.assign(new Error('Definitive test rejection'), { definitive: true }); }
      if (inputDelay) await pause(inputDelay);
      return originalInput(event);
    };
    if (holdFirstOpening) { holdFirstOpening = false; await openingGate; }
    return connection;
  };
  handoff = new HandoffServer({ backend });
  if (process.env.HANDOFF_VIEWER_BASELINE) {
    const handle = handoff.handle.bind(handoff);
    handoff.handle = async (req, res) => {
      if (req.method === 'GET' && req.url === '/assets/viewer.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await readFile(process.env.HANDOFF_VIEWER_BASELINE)); return;
      }
      return handle(req, res);
    };
  }
  await handoff.start();
  const invite = await handoff.createShare({ owner: 'qa', profile: 'demo', targetId: target.id, ttlMs: 120_000 });
  const phonePort = await until(async () => (await readFile(join(phoneDirectory, 'DevToolsActivePort'), 'utf8')).split('\n')[0], 'phone browser start');
  const viewTab = await newTab('about:blank', `http://127.0.0.1:${phonePort}`);
  viewer = await new CdpConnection().connect(viewTab.webSocketDebuggerUrl);
  await viewer.send('Page.enable');
  await viewer.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  // Automatic entry can create its socket before an after-load probe runs.
  await viewer.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.qaPointers=[];window.qaErrors=[];window.qaInputErrors=[];window.qaSockets=[];window.qaPaints=0;window.qaLastFrame=null;const draw=CanvasRenderingContext2D.prototype.drawImage;CanvasRenderingContext2D.prototype.drawImage=function(...args){qaPaints++;return draw.apply(this,args)};addEventListener('error',e=>qaErrors.push(e.message));document.addEventListener('pointerdown',e=>qaPointers.push({x:e.clientX,y:e.clientY,target:e.target.id,primary:e.isPrimary}));document.addEventListener('pointerup',e=>qaPointers.push({up:true,x:e.clientX,y:e.clientY,target:e.target.id}));window.qaMaxInputInFlight=0;const NativeSocket=WebSocket;window.WebSocket=class extends NativeSocket{constructor(...args){super(...args);this.qaPending=new Set();this.qaInputCount=0;qaSockets.push(this);this.addEventListener('close',()=>this.qaPending.clear());this.addEventListener('message',e=>{const m=JSON.parse(e.data);if(['inputAck','error'].includes(m.type))this.qaPending.delete(m.id);if(m.type==='error')qaInputErrors.push(m.error);if(m.type==='frame')qaLastFrame=e.data})}send(data){const m=JSON.parse(data);if(m.type==='input'){this.qaInputCount++;this.qaPending.add(m.id);qaMaxInputInFlight=Math.max(qaMaxInputInFlight,this.qaPending.size)}return super.send(data)}}` });
  await viewer.send('Page.navigate', { url: invite.url });
  await until(() => evaluate(viewer, "document.getElementById('screen') !== null && location.hash === ''"), 'viewer loaded and invite fragment cleared');
  await mkdir('test-artifacts', { recursive: true });
  await until(() => evaluate(viewer, "document.getElementById('screen').width > 1"), 'first frame arrives before backend readiness');
  assert.equal(await evaluate(viewer, "document.getElementById('control').disabled"), true, 'a visible frame must not enable takeover before the stream is ready');
  releaseOpening();
  await until(() => evaluate(viewer, "!document.getElementById('control').disabled"), 'takeover becomes available after stream readiness');
  const oldConnection = handoff.streams.get(invite.id).connectionId;
  await evaluate(viewer, `(()=>{window.qaDisconnectImage=Image;window.Image=function(...args){const image=new qaDisconnectImage(...args);Object.defineProperty(image,'onload',{set(callback){image.addEventListener('load',()=>{window.qaReleaseDisconnectImage=()=>callback.call(image)},{once:true})}});return image}})()`);
  await until(() => !handoff.streams.get(invite.id).display.inFlight, 'old stream display settles');
  handoff.streams.get(invite.id).display.frame(JSON.parse(await evaluate(viewer, 'qaLastFrame')));
  await until(() => evaluate(viewer, "typeof qaReleaseDisconnectImage==='function'"), 'old frame decode callback held before disconnect');
  const paintsBeforeDisconnect = await evaluate(viewer, 'qaPaints');
  handoff.streams.get(invite.id).ws.terminate();
  await until(() => evaluate(viewer, "document.getElementById('status').textContent.includes('Connection interrupted')"), 'network interruption reaches the viewer');
  await evaluate(viewer, 'qaReleaseDisconnectImage();window.Image=qaDisconnectImage');
  assert.equal(await evaluate(viewer, 'qaPaints'), paintsBeforeDisconnect, 'a decoded old-generation image cannot draw after disconnect');
  assert.equal(await evaluate(viewer, "document.getElementById('control').disabled"), true, 'a late frame cannot re-enable takeover on a disconnected socket');
  await until(async () => handoff.streams.get(invite.id)?.connectionId !== oldConnection && handoff.streams.get(invite.id)?.ready && !(await evaluate(viewer, "document.getElementById('control').disabled")), 'fresh stream reconnects and restores takeover');
  const beforeDecodeFailure = handoff.streams.get(invite.id).connectionId;
  handoff.streams.get(invite.id).display.frame({ type: 'frame', data: 'invalid-jpeg', width: 800, height: 600 });
  await until(async () => handoff.streams.get(invite.id)?.connectionId !== beforeDecodeFailure && handoff.streams.get(invite.id)?.ready && !(await evaluate(viewer, "document.getElementById('control').disabled")), 'a failed image decode reconnects and restores live frames');
  assert.equal(handoff.store.get(invite.id).mode, 'watch', 'image recovery never silently grants control');
  assert.equal(await evaluate(viewer, "document.getElementById('claim')"), null, 'the invitation landing button is removed');
  const landing = await viewer.send('Page.captureScreenshot', { format: 'png' });
  await writeFile('test-artifacts/mobile-direct-view.png', Buffer.from(landing.data, 'base64'));
  const stage = await evaluate(viewer, "(()=>{const r=document.querySelector('.viewport').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,vw:innerWidth,vh:innerHeight}})()");
  assert.ok(Math.abs(stage.x) < 1 && Math.abs(stage.y) < 1 && Math.abs(stage.w-stage.vw) < 1 && Math.abs(stage.h-stage.vh) < 1, 'browser stage fills the phone viewport without reserved header or toolbar space');
  assert.equal(await evaluate(viewer, "document.getElementById('panel').hidden"), true, 'controls start collapsed');
  await clickElement(viewer, 'menu');
  await until(() => evaluate(viewer, "!document.getElementById('panel').hidden"), 'floating controls open overlay');
  const fitWidth = await evaluate(viewer, "document.getElementById('screen').getBoundingClientRect().width");
  await clickElement(viewer, 'zoomIn');
  assert.ok((await evaluate(viewer, "document.getElementById('screen').getBoundingClientRect().width")) > fitWidth * 1.1, 'local zoom enlarges remote image');
  await clickElement(viewer, 'zoomReset');
  assert.ok(Math.abs((await evaluate(viewer, "document.getElementById('screen').getBoundingClientRect().width")) - fitWidth) < 1, 'reset returns to fit width');
  await clickElement(viewer, 'menu');
  await viewer.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 100, id: 1 }, { x: 200, y: 100, id: 2 }] });
  await viewer.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 80, y: 100, id: 1 }, { x: 240, y: 100, id: 2 }] });
  await viewer.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.ok((await evaluate(viewer, "document.getElementById('screen').getBoundingClientRect().width")) > fitWidth * 1.3, 'two-finger pinch zooms the view');
  await clickElement(viewer, 'menu'); await clickElement(viewer, 'zoomReset'); await clickElement(viewer, 'menu');
  assert.equal(handoff.store.get(invite.id).mode, 'watch');
  await clickElement(viewer, 'control');
  await until(() => handoff.store.get(invite.id).mode === 'control', 'explicit takeover');
  await clickElement(viewer, 'menu');
  await until(() => evaluate(viewer, "!document.getElementById('keyboard').hidden && document.getElementById('badge').textContent === 'YOU HAVE CONTROL'"), 'viewer control UI ready');
  assert.equal(handoff.store.gate.locked, true);
  // A slow image decoder must not apply an old focus snapshot after a newer
  // input ACK has confirmed the tapped field.
  await evaluate(viewer, `(()=>{window.qaNativeImage=Image;window.qaHoldNextImage=true;window.Image=function(...args){const image=new qaNativeImage(...args);Object.defineProperty(image,'onload',{set(callback){image.addEventListener('load',()=>{if(qaHoldNextImage){qaHoldNextImage=false;window.qaReleaseImage=()=>{qaReleaseImage=null;callback.call(image)}}else callback.call(image)},{once:true})}});return image}})()`);
  const oldFrame = JSON.parse(await evaluate(viewer, 'qaLastFrame'));
  const oldMetadata = handoff.streams.get(invite.id).display.currentMetadata;
  assert.equal(oldMetadata.interactions.focus, null, 'the delayed frame represents the page before a field was focused');
  handoff.streams.get(invite.id).display.frame({ ...oldFrame, metadata: oldMetadata });
  await until(() => evaluate(viewer, "typeof qaReleaseImage==='function'"), 'image decode callback is held');
  await touchRemoteTapWithJitter(200, 145);
  await viewer.send('Input.insertText', { text: 'race' });
  await until(() => evaluate(remote, "field.value==='race'"), 'new focus confirms and typing proceeds while the old image awaits drawing');
  await evaluate(viewer, 'qaReleaseImage();window.Image=qaNativeImage');
  assert.equal(await evaluate(viewer, 'document.activeElement.id'), 'text', 'late image drawing cannot invalidate the newer focused-field confirmation');
  await viewer.send('Input.insertText', { text: ' ok' });
  await until(() => evaluate(remote, "field.value==='race ok'"), 'typing remains active after the delayed image is drawn');
  await handoff.streams.get(invite.id).queue;
  await evaluate(remote, "field.value='';field.setSelectionRange(0,0)");
  rejectNextInput = true;
  await clickRemote(200, 145);
  await until(() => evaluate(viewer, "qaInputErrors.includes('Definitive test rejection')"), 'definitive input rejection reaches viewer');
  await until(() => evaluate(viewer, "!document.getElementById('control').disabled"), 'failed input reconnects without retaining control');
  assert.equal(handoff.store.get(invite.id).mode, 'watch');
  await clickElement(viewer, 'control');
  await until(() => evaluate(viewer, "document.getElementById('badge').textContent === 'YOU HAVE CONTROL'"), 'explicit takeover after rejected input');
  await pause(1700); // Exceed the hit-map freshness limit while the page is idle.
  await touchRemoteTapWithJitter(200, 145);
  assert.equal(await evaluate(viewer, "document.activeElement.id"), 'text', 'minor finger drift must still open the phone keyboard for a field');
  await until(() => evaluate(remote, "document.activeElement.id === 'field'"), 'real phone touch focuses the remote text field');
  await until(() => handoff.store.gate.humanInputs === 0, 'text-field touch is fully acknowledged');
  assert.equal(await evaluate(viewer, "document.activeElement.id"), 'text', 'touch compatibility mouse events must not dismiss the phone keyboard');
  await until(() => evaluate(remote, "document.activeElement.id === 'field'"), 'mapped click at DPR2');
  await until(() => evaluate(viewer, "document.activeElement.id === 'text'"), 'field tap synchronously focuses native-keyboard proxy');
  await viewer.send('Input.insertText', { text: 'Hello from the phone viewer' });
  await until(() => evaluate(remote, "document.getElementById('field').value === 'Hello from the phone viewer'"), 'remote text insertion');
  assert.equal(await evaluate(viewer, "document.getElementById('text').value"), '\u200b', 'proxy retains only an internal deletion sentinel, not typed text');
  await evaluate(viewer, "document.getElementById('text').setSelectionRange(0,0)");
  await viewer.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await viewer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await until(() => evaluate(remote, "document.getElementById('field').value === 'Hello from the phone viewe'"), 'native keyboard Backspace deletes remote text with an otherwise empty proxy');
  await viewer.send('Input.insertText', { text: 'r' });
  await until(() => evaluate(remote, "document.getElementById('field').value === 'Hello from the phone viewer'"), 'native keyboard insertion resumes after deletion');
  // Delay the WebSocket ACK, not browser execution: queued keystrokes should
  // share round trips while retaining every native edit and its order.
  await until(() => evaluate(viewer, 'qaSockets.at(-1).qaPending.size === 0'), 'earlier keyboard acknowledgements settled');
  const typingEntry = handoff.streams.get(invite.id);
  const ackSocket = typingEntry.ws, originalSend = ackSocket.send.bind(ackSocket);
  const pendingAcks = new Set(), typingPackets = [];
  const recordPacket = raw => { const packet = JSON.parse(String(raw)); if (packet.type === 'input') typingPackets.push(packet); };
  ackSocket.on('message', recordPacket);
  ackSocket.send = (data, ...args) => {
    if (JSON.parse(String(data)).type !== 'inputAck') { originalSend(data, ...args); return; }
    const timer = setTimeout(() => { pendingAcks.delete(timer); if (ackSocket.readyState === 1) originalSend(data, ...args); }, 200);
    pendingAcks.add(timer);
  };
  await evaluate(remote, "field.value='';window.qaEditValues=[];field.oninput=()=>qaEditValues.push(field.value)");
  const phrase = 'abcdefghijklmnopqrst', typingStart = performance.now();
  for (const ch of phrase) { await viewer.send('Input.insertText', { text: ch }); await pause(50); }
  await viewer.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await viewer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await viewer.send('Input.insertText', { text: 'Z' });
  const typingEnd = performance.now();
  await until(() => evaluate(remote, "field.value === 'abcdefghijklmnopqrsZ'"), 'typing and Backspace catch up under network latency');
  const typingCaughtUp = performance.now();
  await handoff.streams.get(invite.id).queue;
  await until(() => pendingAcks.size === 0, 'last delayed typing acknowledgement');
  const expectedEdits = [...phrase].map((_, i) => phrase.slice(0, i + 1));
  expectedEdits.push(phrase.slice(0, -1), phrase.slice(0, -1) + 'Z');
  assert.deepEqual(await evaluate(remote, 'qaEditValues'), expectedEdits, 'batched transport preserves every individual native input event and Backspace order');
  console.log(JSON.stringify({ experiment: 'delayed-ack-typing', ackDelayMs: 200, edits: expectedEdits.length, packets: typingPackets.length,
    typingMs: Math.round(typingEnd - typingStart), tailMs: Math.round(typingCaughtUp - typingEnd) }));
  assert.ok((await evaluate(viewer, 'qaMaxInputInFlight')) > 1, 'input progresses without waiting for each preceding acknowledgement');
  assert.ok((await evaluate(viewer, 'qaMaxInputInFlight')) <= 4, 'at most four input packets may be in flight');
  assert.ok(typingPackets.every(packet => !packet.events || packet.events.length <= 8), 'typing batches remain bounded');
  await until(() => evaluate(viewer, 'qaSockets.at(-1).qaPending.size === 0'), 'typing window drains');
  const delayedSend = ackSocket.send, heldReplies = [];
  ackSocket.send = (data, ...args) => { if (JSON.parse(String(data)).type === 'inputAck') heldReplies.push(() => originalSend(data, ...args)); else originalSend(data, ...args); };
  await evaluate(remote, "field.value=''");
  for (const text of ['1','2','3','4']) await viewer.send('Input.insertText', { text });
  await until(() => evaluate(remote, "field.value==='1234'"), 'four ordered edits reach the browser before any ACK is released');
  await viewer.send('Input.insertText', { text: '5' }); await pause(30);
  assert.equal(await evaluate(remote, 'field.value'), '1234', 'the fifth packet waits for a slot in the bounded window');
  ackSocket.send = delayedSend;
  for (const send of heldReplies.reverse()) send();
  await until(() => evaluate(remote, "field.value==='12345'"), 'out-of-order acknowledgements free the correct slots');
  await until(() => evaluate(viewer, 'qaSockets.at(-1).qaPending.size === 0'), 'reordered acknowledgements clear their own timers');
  const boundaryStart = typingPackets.length, largePaste = 'x'.repeat(300);
  await evaluate(remote, "field.value=''");
  for (const text of ['a', 'b', largePaste, 'c']) await viewer.send('Input.insertText', { text });
  await viewer.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await viewer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await viewer.send('Input.insertText', { text: 'd' });
  await until(() => evaluate(remote, `field.value === ${JSON.stringify('ab' + largePaste + 'cd')}`), 'queued typing preserves large-paste and Enter boundaries');
  await handoff.streams.get(invite.id).queue;
  await until(() => pendingAcks.size === 0, 'boundary edit acknowledgements');
  const boundaryPackets = typingPackets.slice(boundaryStart);
  assert.deepEqual(boundaryPackets.flatMap(packet => packet.events || [packet.event]).map(event => [event.operation, event.text]),
    [['insert', 'a'], ['insert', 'b'], ['insert', largePaste], ['insert', 'c'], ['enter', undefined], ['insert', 'd']], 'batch boundaries preserve all operation ordering');
  assert.ok(boundaryPackets.some(packet => packet.event?.text === largePaste), 'large paste remains its own packet');
  assert.ok(boundaryPackets.some(packet => packet.event?.operation === 'enter'), 'Enter remains its own packet');
  await evaluate(remote, "field.value='';field.oninput=()=>{if(field.value==='ab')counter.focus()}");
  for (const text of ['a', 'b', 'c', 'd']) await viewer.send('Input.insertText', { text });
  await until(() => evaluate(remote, "document.activeElement.id === 'counter'"), 'page changes focus during a queued batch');
  await until(() => evaluate(viewer, "document.activeElement.id !== 'text'"), 'focus change clears phone typing state');
  await typingEntry.queue;
  await until(() => pendingAcks.size === 0, 'focus-change acknowledgements settle');
  assert.equal(await evaluate(remote, 'field.value'), 'ab', 'remaining batched edits cannot follow a changed remote focus');
  assert.equal(await evaluate(remote, "document.body.dataset.clicks || '0'"), '0', 'remaining edits cannot activate the newly focused button');
  assert.equal(handoff.store.gate.poisonReason, null, 'known focus rejection keeps the gate healthy');
  ackSocket.send = originalSend; ackSocket.off('message', recordPacket);
  await evaluate(remote, "field.oninput=null;field.value='Hello from the phone viewer';field.setSelectionRange(field.value.length,field.value.length)");
  if (typingEntry.failed || handoff.store.get(invite.id).mode !== 'control') {
    await until(() => evaluate(viewer, "!document.getElementById('control').disabled"), 'focus rejection reconnects in watch mode');
    await clickElement(viewer, 'control');
    await until(() => evaluate(viewer, "document.getElementById('badge').textContent === 'YOU HAVE CONTROL'"), 'explicit takeover after focus rejection');
  }
  await clickRemote(370, 145);
  await until(() => evaluate(remote, "document.activeElement.id === 'field'"), 'typing can start again after an intentional field tap');
  await handoff.streams.get(invite.id).queue;
  await evaluate(remote, 'field.setSelectionRange(field.value.length,field.value.length)');
  await viewer.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
  assert.equal(await evaluate(remote, "document.getElementById('field').value"), 'Hello from the phone viewer', 'IME preedit stays local');
  await viewer.send('Input.insertText', { text: '日本' });
  await until(() => evaluate(remote, "document.getElementById('field').value === 'Hello from the phone viewer日本'"), 'native IME commits once');
  await touchRemoteTapWithJitter(160, 225);
  await until(() => evaluate(remote, "document.body.dataset.clicks === '1'"), 'remote button click');
  await clickRemote(200, 145);
  await until(() => evaluate(remote, "document.activeElement.id === 'field'"), 'refocus remote field');
  await evaluate(viewer, "document.querySelector('[data-key=Tab]').click()");
  await until(() => evaluate(remote, "document.activeElement.id === 'counter'"), 'Tab key moves remote focus');
  await evaluate(viewer, "document.querySelector('[data-key=Enter]').click()");
  await until(() => evaluate(remote, "document.body.dataset.clicks === '2'"), 'Enter activates remote button');
  await clickElement(viewer, 'zoomIn'); await clickElement(viewer, 'zoomIn');
  await touchRemoteTapWithJitter(200, 145);
  assert.equal(await evaluate(viewer, "document.activeElement.id"), 'text', 'finger-drift field taps also activate typing while the phone view is zoomed');
  await viewer.send('Input.insertText', { text: ' zoomed' });
  await until(() => evaluate(remote, "document.getElementById('field').value.includes(' zoomed')"), 'typing reaches the tapped caret through the locally zoomed viewer');
  await clickElement(viewer, 'zoomReset');
  await clickElement(viewer, 'menu');
  const pickerInputsBefore = sentInputs.length;
  await touchRemoteTapWithJitter(520, 560);
  await until(() => evaluate(viewer, "document.getElementById('nativePicker').open"), 'native select opens a local phone dialog');
  const labels = await evaluate(viewer, "[...document.querySelectorAll('#nativePicker .picker-option')].map(e=>e.textContent)");
  assert.deepEqual(labels, ['First','Second','Disabled'], 'only visible choice labels are presented');
  assert.equal(await evaluate(viewer, "document.querySelectorAll('#nativePicker .picker-option')[2].disabled"), true, 'disabled groups remain unavailable');
  await clickSelector(viewer, '#nativePicker .picker-option:nth-of-type(2)');
  await until(() => evaluate(remote, "selectFixture.value === 'PRIVATE_SECOND'"), 'phone dropdown choice reaches the original select');
  await until(() => evaluate(viewer, "!document.getElementById('nativePicker').open"), 'successful choice closes its dialog');
  assert.deepEqual(sentInputs.slice(pickerInputsBefore).map(e=>e.kind), ['pickerOpen','pickerApply'], 'picker taps never open an invisible remote native popup');
  await touchRemoteTapWithJitter(690, 560);
  await until(() => evaluate(viewer, "document.getElementById('nativePicker').open && !!document.querySelector('.picker-hex')"), 'color field opens phone controls');
  assert.equal(await evaluate(viewer, "document.querySelector('.picker-hex').value"), '123456', 'the requested current color initializes the phone control');
  await evaluate(viewer, "Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))");
  assert.equal(await evaluate(viewer, "document.getElementById('nativePicker').open"), true, 'a phone-native chooser obscuring the page does not dismiss its parent picker');
  await evaluate(viewer, "delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))");
  await clickSelector(viewer, '#nativePicker .picker-hex');
  await evaluate(viewer, "document.querySelector('.picker-hex').select()");
  await viewer.send('Input.insertText', { text: '44aaee' });
  assert.equal(await evaluate(remote, 'colorFixture.value'), '#123456', 'local color editing waits for explicit Apply');
  await clickSelector(viewer, '#nativePicker .picker-apply');
  await until(() => evaluate(remote, "colorFixture.value === '#44aaee'"), 'chosen color reaches the original field');
  await until(() => evaluate(viewer, "!document.getElementById('nativePicker').open"), 'successful color closes its dialog');
  assert.deepEqual(await evaluate(remote, 'pickerEvents'), [{id:'selectFixture',type:'input'},{id:'selectFixture',type:'change'},{id:'colorFixture',type:'input'},{id:'colorFixture',type:'change'}], 'both controls dispatch their native change notifications');
  await touchRemoteTapWithJitter(520, 560);
  await until(() => evaluate(viewer, "document.getElementById('nativePicker').open"), 'select reopens');
  await clickSelector(viewer, '#nativePicker .picker-cancel');
  await until(() => evaluate(viewer, "qaSockets.at(-1).qaPending.size === 0"), 'picker cancel settles');
  assert.equal(await evaluate(remote, 'selectFixture.value'), 'PRIVATE_SECOND', 'Cancel leaves the selected value unchanged');
  inputDelay = 180;
  await touchRemoteTapWithJitter(520, 560);
  await clickRemote(200, 145);
  await until(() => evaluate(viewer, 'qaSockets.at(-1).qaPending.size === 0'), 'superseded picker and new field tap settle');
  assert.equal(await evaluate(viewer, "document.getElementById('nativePicker').open"), false, 'an obsolete picker reply cannot reopen a dialog after another tap');
  assert.equal(await evaluate(remote, 'document.activeElement.id'), 'field');
  inputDelay = 0;
  await touchRemoteTapWithJitter(520, 560);
  await until(() => evaluate(viewer, "document.getElementById('nativePicker').open"), 'stale-choice fixture opens');
  await evaluate(remote, "selectFixture.options[1].value='PRIVATE_CHANGED'");
  await clickSelector(viewer, '#nativePicker .picker-option:nth-of-type(1)');
  await until(() => evaluate(viewer, "!document.getElementById('control').disabled"), 'changed picker choices reject and reconnect in watch mode');
  assert.equal(await evaluate(remote, 'selectFixture.selectedIndex'), 1, 'stale choices cannot apply a different selection');
  assert.equal(await evaluate(viewer, "document.getElementById('nativePicker').open"), false, 'input rejection clears the local picker');
  await clickElement(viewer, 'control');
  await until(() => evaluate(viewer, "document.getElementById('badge').textContent === 'YOU HAVE CONTROL'"), 'explicit control after stale picker rejection');
  await until(() => evaluate(viewer, 'qaSockets.at(-1).qaPending.size === 0'), 'all picker input settled before timeout recovery');
  const timeoutEntry = handoff.streams.get(invite.id), timeoutSocket = timeoutEntry.ws;
  const timeoutSend = timeoutSocket.send.bind(timeoutSocket), lostAcks = [], escapesBefore = sentInputs.filter(e => e.kind === 'key' && e.key === 'Escape').length;
  timeoutSocket.send = (data, ...args) => { if (JSON.parse(String(data)).type === 'inputAck') lostAcks.push(String(data)); else timeoutSend(data, ...args); };
  await evaluate(viewer, "window.qaNativeTimeout=setTimeout;window.setTimeout=(fn,ms,...args)=>qaNativeTimeout(fn,ms===12000?150:ms,...args);for(let i=0;i<5;i++)document.querySelector('[data-key=Escape]').click()");
  await until(async () => handoff.streams.get(invite.id)?.connectionId !== timeoutEntry.connectionId && handoff.streams.get(invite.id)?.ready && await evaluate(viewer, "!document.getElementById('control').disabled"), 'missing input acknowledgements reconnect without replay');
  await evaluate(viewer, 'window.setTimeout=qaNativeTimeout');
  assert.equal(sentInputs.filter(e => e.kind === 'key' && e.key === 'Escape').length - escapesBefore, 4, 'only the sent window executed; the unsent fifth input was discarded');
  assert.equal(handoff.store.get(invite.id).mode, 'watch', 'timeout recovery never reacquires control');
  await evaluate(viewer, `qaSockets.at(-2).dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(lostAcks[0])}}))`);
  assert.equal(handoff.store.get(invite.id).mode, 'watch', 'a late old-connection ACK cannot restore input');
  assert.equal(handoff.store.gate.poisonReason, null);
  timeoutSocket.send = timeoutSend;
  await clickElement(viewer, 'control');
  await until(() => evaluate(viewer, "document.getElementById('badge').textContent === 'YOU HAVE CONTROL'"), 'explicit takeover after timeout recovery');
  inputDelay = 60;
  await touchRemotePath([[460,145],[480,145],[520,145],[580,145],[640,145],[710,145]]);
  await until(() => evaluate(remote, 'Number(range.value) > 80'), 'phone gesture drags native slider through the guarded viewer queue');
  await until(() => handoff.store.gate.humanInputs === 0, 'slider gesture ends without a held contact');
  await touchRemotePath([[480,260],[500,260],[540,260],[590,260],[640,260],[690,260]]);
  await until(() => evaluate(remote, "document.body.dataset.dropped === 'yes'"), 'phone gesture performs an HTML drag-and-drop');
  await until(() => handoff.store.gate.humanInputs === 0, 'HTML drag releases its gesture hold');
  await touchRemotePath([[465,370],[485,370],[530,370],[590,370],[650,370],[710,370]]);
  await until(() => evaluate(remote, "Number(custom.dataset.position) > 200 && !custom.dataset.held"), 'native touch drags a custom pointer-driven page element');
  assert.equal(handoff.store.get(invite.id).mode, 'control', 'drags do not disconnect or hand back control');
  inputDelay = 0;
  // A selected shared tab may be in the background on the agent's machine.
  await newTab('about:blank');
  await until(() => evaluate(remote, "document.visibilityState === 'hidden'"), 'remote tab backgrounded');
  assert.equal(await evaluate(remote, "document.getElementById('ordinaryLink').draggable"), true, 'HTML links are implicitly draggable even without explicit opt-in');
  const touch = await evaluate(viewer, "(()=>{const c=document.getElementById('screen');c.scrollIntoView({block:'center'});const r=c.getBoundingClientRect();return {x:r.x+r.width*.7,y:r.y+r.height*.8}})()");
  await viewer.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...touch, id: 1 }] });
  await viewer.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touch.x, y: touch.y - 60, id: 1 }] });
  await viewer.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until(() => evaluate(remote, 'scrollY > 0'), 'swiping ordinary linked content scrolls the remote page rather than dragging the link');
  await evaluate(remote, 'window.scrollTo(0,0)');
  inputDelay = 80;
  const scrollBefore = sentInputs.filter((e) => e.kind === 'scroll').reduce((n, e) => n + e.deltaY, 0);
  await evaluate(viewer, `(()=>{const c=document.getElementById('screen'),r=c.getBoundingClientRect();for(let n=0;n<100;n++)c.dispatchEvent(new WheelEvent('wheel',{clientX:r.x+r.width*.7,clientY:r.y+r.height*.7,deltaY:25,bubbles:true,cancelable:true}))})()`);
  await evaluate(viewer, "document.querySelector('[data-key=Escape]').click()");
  await pause(500);
  assert.equal(handoff.store.get(invite.id).mode, 'control', 'sustained scrolling under latency must not disconnect or hand back control');
  await until(() => evaluate(remote, 'scrollY >= 400'), 'coalesced scrolling reaches remote browser');
  await until(() => sentInputs.filter((e) => e.kind === 'scroll').reduce((n, e) => n + e.deltaY, 0) >= scrollBefore + 2500, 'coalescing preserves total scroll movement across bounded packets');
  assert.ok(sentInputs.filter((e) => e.kind === 'scroll').every((e) => Math.abs(e.deltaY) <= 2000), 'coalesced packets respect server validation');
  await until(() => sentInputs.some((e) => e.kind === 'key' && e.key === 'Escape'), 'a discrete action after split scroll packets preserves wire sequence order');
  inputDelay = 0;
  await evaluate(remote, 'window.scrollTo(0,0)');
  const previousImage = await evaluate(viewer, "document.getElementById('screen').toDataURL()");
  await evaluate(remote, "document.querySelector('header').style.background='#cfe5de'");
  await until(async () => (await evaluate(viewer, "document.getElementById('screen').toDataURL()")) !== previousImage, 'updated frame painted after interaction');
  await evaluate(viewer, 'window.scrollTo(0,0)');
  const capture = await viewer.send('Page.captureScreenshot', { format: 'png' });
  await writeFile('test-artifacts/mobile-control.png', Buffer.from(capture.data, 'base64'));
  assert.ok(!(await evaluate(viewer, 'document.documentElement.scrollWidth > innerWidth')), 'mobile layout must not overflow horizontally');
  await viewer.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await until(() => evaluate(viewer, "Math.round(document.querySelector('.viewport').getBoundingClientRect().height) === innerHeight"), 'stage follows landscape viewport');
  await viewer.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await until(() => evaluate(viewer, "Math.round(document.querySelector('.viewport').getBoundingClientRect().height) === innerHeight"), 'stage returns to portrait viewport');
  await clickElement(viewer, 'release');
  await until(() => handoff.store.get(invite.id).mode === 'watch' && !handoff.store.gate.locked, 'release to agent');
  await clickRemote(160, 225); await pause(100);
  assert.equal(await evaluate(remote, "document.body.dataset.clicks"), '2', 'watch mode must not dispatch input');
  const originalExpiry = handoff.store.get(invite.id).expiresAt;
  await viewer.send('Page.navigate', { url: 'about:blank' });
  await until(() => evaluate(viewer, "location.href === 'about:blank'"), 'leave the claimed viewer document');
  await until(() => !handoff.streams.has(invite.id), 'old viewer stream closes before reopening');
  await viewer.send('Page.navigate', { url: invite.url });
  await until(() => evaluate(viewer, "document.getElementById('screen') && location.hash === ''"), 'original invitation reopened in the same browser');
  await until(() => evaluate(viewer, "!document.getElementById('viewer').hidden || document.getElementById('status').classList.contains('error')"), 'reopened invitation resolves');
  assert.equal(await evaluate(viewer, "document.getElementById('viewer').hidden"), false, 'reopening the original invitation must resume the existing viewer cookie instead of reclaiming the used token');
  await until(() => evaluate(viewer, "document.getElementById('loading').hidden && document.getElementById('screen').width > 1"), 'reopened viewer receives live frames');
  assert.equal(handoff.store.get(invite.id).mode, 'watch', 'reopening does not grant control');
  assert.equal(handoff.store.get(invite.id).expiresAt, originalExpiry, 'resuming the viewer does not renew the absolute invitation expiry');
  const repeatClaim = await fetch(`${handoff.localUrl}/s/${invite.id}/claim`, {
    method: 'POST', headers: { origin: handoff.localUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ token: new URLSearchParams(new URL(invite.url).hash.slice(1)).get('invite') }),
  });
  assert.equal(repeatClaim.status, 401, 'a used invitation still cannot be claimed without the authenticated viewer cookie');
  handoff.store.get(invite.id).expiresAt = Date.now() + 150;
  await until(() => evaluate(viewer, "!document.getElementById('finished').hidden && document.getElementById('screen').width === 1"), 'expiry clears live viewer');
  assert.equal(handoff.store.gate.locked, false);
  await viewer.send('Page.navigate', { url: `${handoff.localUrl}/s/${'0'.repeat(32)}/` });
  await until(() => evaluate(viewer, "document.getElementById('finished') && !document.getElementById('finished').hidden"), 'invalid invitations show a terminal error without a landing page');
  assert.match(await evaluate(viewer, "document.getElementById('endMessage').textContent"), /missing|expired|claimed/i);
  assert.equal(await evaluate(viewer, "document.getElementById('viewer').hidden"), true, 'invalid links cannot show a usable viewer');
  console.log('PASS: mobile invitation, live frames, DPR2 coordinate mapping, explicit takeover, typing, click, Tab/Enter, touch scrolling, watch-mode input denial, release, same-browser invitation reopening, single-use claim denial, and expiry.');
  console.log('Screenshots: test-artifacts/mobile-direct-view.png, test-artifacts/mobile-control.png');
} catch (error) {
  if (viewer && remote) {
    const diagnostics = await Promise.allSettled([evaluate(viewer, "({pointers:window.qaPointers,errors:window.qaErrors,status:document.getElementById('status')?.textContent,end:document.getElementById('endMessage')?.textContent})"), evaluate(remote, "({pointer:window.qaPointer,active:document.activeElement.id,viewport:[innerWidth,innerHeight,devicePixelRatio],visibility:document.visibilityState})")]);
    console.error(JSON.stringify({ lastFrame, sentInputs, gateFault: handoff?.store.gate.poisonReason, diagnostics: diagnostics.map(r=>r.status==='fulfilled'?r.value:String(r.reason)) }));
  }
  if (viewer) {
    try { const image = await viewer.send('Page.captureScreenshot', { format: 'png' }); await mkdir('test-artifacts', { recursive: true }); await writeFile('test-artifacts/failure.png', Buffer.from(image.data, 'base64')); } catch {}
  }
  console.error(error.message);
  process.exitCode = 1;
} finally {
  releaseOpening?.();
  viewer?.close(); remote?.close(); await handoff?.close();
  await new Promise((resolve) => fixture.close(resolve));
  await Promise.all([chrome, phoneChrome].map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit'); child.kill('SIGTERM');
    await Promise.race([exit, pause(3000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }));
  await pause(100);
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
