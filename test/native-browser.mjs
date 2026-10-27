// Real local Chromium acceptance checks for native interaction capabilities.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpBrowser, CdpConnection } from '../src/cdp.mjs';
import { EditingBridge } from '../public/editing.js';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const directory = await mkdtemp(join(tmpdir(), 'handoff-native-qa-'));
const fixture = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/geometry/overflow-child') return res.end('<style>body{height:900px;margin:0;background:white}input{position:absolute;left:30px;width:180px;height:40px;border:0;padding:0;background:lime}#partial{top:270px;width:100px;height:60px}#hidden{top:350px}</style><input id=partial value=PRIVATE_PARTIAL><input id=hidden value=PRIVATE_HIDDEN>');
  if (req.url === '/geometry/overflow') return res.end('<style>body{margin:0;background:white}iframe{position:absolute;left:80px;top:80px;width:250px;height:100px;border:4px solid blue;transform:scale(1.5);transform-origin:top left}#field{position:absolute;left:131px;top:311px;width:350px;height:70px;border:0;padding:0;background:red}</style><iframe src=/geometry/overflow-child></iframe><input id=field value=PRIVATE_GEOMETRY>');
  if (req.url === '/geometry/child') return res.end('<style>body{margin:0;background:white}input{position:absolute;left:30px;top:30px;width:140px;height:30px;border:0;padding:0;background:red}</style><input id=field value=PRIVATE_GEOMETRY>');
  if (req.url === '/geometry/frame') return res.end('<style>body{margin:0;background:white}iframe{position:absolute;left:80px;top:80px;width:250px;height:120px;border:0;transform:scale(2);transform-origin:top left}</style><iframe src=/geometry/child></iframe>');
  if (req.url === '/geometry') return res.end('<style>body{height:2400px;margin:0;background:white}input{position:absolute;left:80px;top:120px;width:300px;height:50px;border:0;padding:0;background:red}</style><input id=field value=PRIVATE_GEOMETRY>');
  return res.end(`<!doctype html><style>body{height:2400px;margin:0}input,textarea{position:absolute;left:40px;width:300px;height:30px}#range{top:80px}#field{top:350px}#password{top:400px}#area{top:450px}#drag{position:absolute;left:40px;top:180px;width:70px;height:70px;background:green}#drop{position:absolute;left:300px;top:180px;width:100px;height:100px;background:lightblue}</style><input type=range id=range value=0><input id=field value=PRIVATE_EXISTING_TEXT><input id=password type=password value=PRIVATE_PASSWORD><textarea id=area></textarea><div id=drag draggable=true>drag</div><div id=drop>drop</div><script>drag.ondragstart=e=>e.dataTransfer.setData('text/plain','test');drop.ondragover=e=>e.preventDefault();drop.ondrop=e=>{e.preventDefault();document.body.dataset.dropped='yes'};document.addEventListener('pointerdown',e=>document.body.dataset.pointerType=e.pointerType);document.addEventListener('click',()=>window.clickCount=(window.clickCount||0)+1)</script>`);
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const chrome = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome-stable', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${directory}`], { stdio: 'ignore' });
let cdp, connection, metadata = {}, frameSeen = false;
const evaluate = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
async function until(fn, label) { for (let n = 0; n < 100; n++) { try { if (await fn()) return; } catch {} await pause(30); } throw new Error('Timed out: ' + label); }
try {
  let port; await until(async () => { port = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return port; }, 'browser start');
  const base = `http://127.0.0.1:${port}`;
  const tab = await (await fetch(`${base}/json/new?${encodeURIComponent(`http://127.0.0.1:${fixture.address().port}`)}`, { method: 'PUT' })).json();
  cdp = await new CdpConnection().connect(tab.webSocketDebuggerUrl);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 2, mobile: false });
  await until(() => evaluate('Boolean(document.getElementById("field"))'), 'fixture');
  connection = await new CdpBrowser({ demo: base }).open({ profile: 'demo', targetId: tab.id }, { onFrame() { frameSeen = true; }, onMetadata: (next) => Object.assign(metadata, next), onClose() {} });
  await until(() => frameSeen && metadata.interactions?.regions?.some((r) => r.kind === 'editable'), 'value-free editable map and frame coordinates');
  assert.ok(!JSON.stringify(metadata).includes('PRIVATE_'), 'metadata must not include text/password values');
  const pointer = (phase, x, y, pointerType = 'touch', gesture = 1) => connection.input({ kind: 'pointer', phase, pointerType, gesture, x: x / 800, y: y / 600 });
  await pointer('down', 60, 90);
  assert.equal(await evaluate('document.body.dataset.pointerType'), 'touch');
  for (let x = 80; x <= 320; x += 20) await pointer('move', x, 90);
  await pointer('up', 320, 90);
  assert.ok(Number(await evaluate('range.value')) > 80, 'native touch drags range thumb');
  assert.equal(await evaluate('document.elementFromPoint(70,210)?.id'), 'drag', 'drag begins on the visible source after scrolling');
  await pointer('down', 70, 210, 'mouse', 3);
  for (let x = 80; x <= 340; x += 20) await pointer('move', x, 210, 'mouse', 3);
  await pointer('up', 340, 210, 'mouse', 3);
  assert.equal(await evaluate('document.body.dataset.dropped'), 'yes', 'HTML5 drag reaches drop target');
  await evaluate('delete document.body.dataset.dropped');
  await pointer('down', 70, 210, 'mouse', 6);
  for (let x = 80; x <= 340; x += 20) await pointer('move', x, 210, 'mouse', 6);
  await connection.cancelGesture();
  assert.equal(await evaluate('document.body.dataset.dropped'), undefined, 'canceled HTML drag must not drop on its target');
  const result = await connection.input({ kind: 'click', x: 100 / 800, y: 365 / 600 });
  assert.ok(result.focus?.token, 'tap acknowledgment confirms editable focus without its value');
  await connection.input({ kind: 'edit', operation: 'insert', text: 'z', focusToken: result.focus.token });
  assert.ok((await evaluate('field.value')).includes('z'));
  await connection.input({ kind: 'edit', operation: 'backspace', focusToken: result.focus.token });
  await evaluate('password.focus()');
  await assert.rejects(connection.input({ kind: 'edit', operation: 'insert', text: 'WRONG_FIELD', focusToken: result.focus.token }), /focus|field/i);
  assert.equal(await evaluate('password.value'), 'PRIVATE_PASSWORD', 'stale focus cannot redirect buffered typing');
  const beforeCancel = await evaluate('window.clickCount || 0');
  await evaluate(`window.cancelEvents=[];window.cancelPointer=null;window.unwantedMouseEvents=[];
    document.addEventListener('pointerdown', e=>{cancelPointer=e.pointerId;document.body.setPointerCapture(e.pointerId)},{once:true});
    for(const type of ['pointerup','pointercancel']) document.addEventListener(type,e=>cancelEvents.push(e.type));
    for(const type of ['auxclick','contextmenu']) document.addEventListener(type,e=>unwantedMouseEvents.push(e.type));`);
  await pointer('down', 600, 400, 'mouse', 4); await connection.cancelGesture();
  assert.equal(await evaluate('document.body.hasPointerCapture(cancelPointer)'), false, 'cancellation releases page pointer capture before the agent can resume');
  assert.equal(await evaluate('cancelEvents.length'), 1, 'page receives one terminal pointer event');
  assert.deepEqual(await evaluate('unwantedMouseEvents'), [], 'cancellation must not fabricate auxiliary clicks or context menus');
  assert.equal(await evaluate('window.clickCount || 0'), beforeCancel, 'cancellation must not synthesize a click');
  await connection.input({ kind: 'click', x: 600 / 800, y: 400 / 600 });
  assert.equal(await evaluate('window.clickCount || 0'), beforeCancel + 1, 'button state is usable after cancellation');
  await pointer('down', 600, 500, 'touch', 5);
  for (let y = 480; y >= 200; y -= 20) { await pointer('move', 600, y, 'touch', 5); await pause(10); }
  await pointer('up', 600, 200, 'touch', 5);
  await until(() => evaluate('scrollY > 50'), 'native touch scrolling');
  await connection.close(); connection = null;
  const geometryFailures = [];
  for (const spec of [
    { name: 'DPR1', dpr: 1 }, { name: 'DPR2', dpr: 2 },
    { name: 'scrolled', dpr: 2, scroll: true },
    { name: 'page scale 2', dpr: 2, scale: 2 },
    { name: 'page scale 2 with visual viewport pan', dpr: 2, scale: 2, pan: true },
    { name: 'same-origin scaled iframe', dpr: 2, frame: true },
    { name: 'scrolled iframe clips hidden fields away from a visible parent field', dpr: 2, clip: true },
  ]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: spec.dpr, mobile: false });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${fixture.address().port}/geometry${spec.frame ? '/frame' : spec.clip ? '/overflow' : ''}` });
    const field = spec.frame ? 'document.querySelector("iframe").contentDocument.getElementById("field")' : 'document.getElementById("field")';
    await until(() => evaluate(`Boolean(${field})`), spec.name + ' fixture');
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: spec.scale || 1 });
    if (spec.clip) {
      await until(() => evaluate('Boolean(document.querySelector("iframe")?.contentDocument?.getElementById("hidden"))'), 'overflowing child fixture');
      await evaluate('document.querySelector("iframe").contentWindow.scrollTo(0,200)');
      assert.equal(await evaluate('document.querySelector("iframe").contentWindow.scrollY'), 200);
    }
    if (spec.scroll) await evaluate("field.style.top='1400px';scrollTo(0,1100)");
    if (spec.pan) {
      await evaluate("field.style.left='430px';field.style.top='350px';field.focus();field.blur()");
      await until(() => evaluate('visualViewport.offsetLeft > 0 && visualViewport.offsetTop > 0'), 'zoomed visual viewport really pans');
    }
    let imageFrame, map;
    connection = await new CdpBrowser({ demo: base }).open({ profile: 'demo', targetId: tab.id }, {
      onFrame: (next) => { imageFrame = next; },
      onMetadata: (next) => { if (next.interactions) map = next.interactions; }, onClose() {},
    });
    await until(() => imageFrame && map?.regions.some((r) => r.kind === 'editable'), spec.name + ' image and metadata');
    // Derive the tap from the actual streamed red input pixels, independently of
    // both the collector rectangles and the backend coordinate conversion.
    const hit = await evaluate(`(async () => {
      const image = new Image(); image.src = ${JSON.stringify('data:image/jpeg;base64,' + imageFrame.data)}; await image.decode();
      const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      let left = image.width, right = -1, top = image.height, bottom = -1;
      for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
        const n = (y * image.width + x) * 4;
        if (pixels[n] > 170 && pixels[n + 1] < 75 && pixels[n + 2] < 75) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
      }
      if (right < left) throw new Error('The red test field is not visible in the stream');
      return { x: (left + right) / 2 / image.width, y: (top + bottom) / 2 / image.height };
    })()`);
    const region = map.regions.filter((r) => r.kind === 'editable' && hit.x >= r.x && hit.x <= r.x + r.width && hit.y >= r.y && hit.y <= r.y + r.height)
      .sort((a, b) => a.width * a.height - b.width * b.height)[0];
    const contains = Boolean(region);
    const clicked = await connection.input({ kind: 'click', ...hit });
    await evaluate(`${field}.blur()`);
    await connection.input({ kind: 'pointer', phase: 'down', pointerType: 'touch', gesture: 1, ...hit });
    const touched = await connection.input({ kind: 'pointer', phase: 'up', pointerType: 'touch', gesture: 1, ...hit });
    if (!contains || !clicked.focus || !touched.focus) geometryFailures.push({ case: spec.name, metadataContainsTap: contains, clickFocused: Boolean(clicked.focus), touchFocused: Boolean(touched.focus) });
    if (spec.clip && region && touched.focus) {
      const edits = [], rejected = [], bridge = new EditingBridge({ emit: (edit) => edits.push(edit), reject: (error) => rejected.push(error) });
      bridge.start({ ...region, document: map.document }, 1); bridge.edit('insert', 'BRIDGE_TYPED'); bridge.confirm(1, touched.focus);
      const clip = await evaluate(`(() => {
        const frame = document.querySelector('iframe'), r = frame.getBoundingClientRect(), sx = r.width / frame.offsetWidth, sy = r.height / frame.offsetHeight;
        return { x: (r.left + frame.clientLeft * sx) / innerWidth, y: (r.top + frame.clientTop * sy) / innerHeight, width: frame.clientWidth * sx / innerWidth, height: frame.clientHeight * sy / innerHeight };
      })()`);
      const childRegions = map.regions.filter((r) => r.id !== touched.focus.id);
      const clipped = childRegions.length === 1 && childRegions.every((r) => r.x >= clip.x && r.y >= clip.y && r.x + r.width <= clip.x + clip.width + 1e-9 && r.y + r.height <= clip.y + clip.height + 1e-9);
      if (rejected.length || edits.length !== 1 || !clipped) geometryFailures.push({ case: spec.name, bridgeRejectedVisibleField: Boolean(rejected.length), bufferedEdits: edits.length, childRegionsClipped: clipped });
      if (edits.length) {
        await connection.input(edits[0]);
        assert.equal(await evaluate(`${field}.value.includes('BRIDGE_TYPED')`), true, 'the real keyboard bridge types into the visible parent field');
      }
    }
    if (touched.focus) {
      await connection.input({ kind: 'edit', operation: 'insert', text: 'GEOMETRY_TYPED', focusToken: touched.focus.token });
      assert.equal(await evaluate(`${field}.value.includes('GEOMETRY_TYPED')`), true, spec.name + ' accepts a confirmed-field edit');
      await evaluate(`${field}.blur()`);
      await assert.rejects(connection.input({ kind: 'edit', operation: 'insert', text: 'WRONG_FIELD', focusToken: touched.focus.token }), /focus|field/i);
      assert.equal(await evaluate(`${field}.value.includes('WRONG_FIELD')`), false, spec.name + ' keeps stale-focus denial');
    }
    assert.ok(!JSON.stringify(map).includes('PRIVATE_'), spec.name + ' map is value-free');
    await connection.close(); connection = null;
  }
  assert.deepEqual(geometryFailures, [], 'streamed pixels, editable rectangles and CDP input must use the same geometry');
  console.log('PASS: value-free editable map, native range/scroll, HTML5 drag, focus-bound direct edit, stale-focus denial, no-click cancellation, DPR/scroll geometry, remote page zoom/pan, scaled same-origin iframe geometry, and iframe-clipped keyboard field selection.');
} finally {
  await connection?.close(); cdp?.close(); chrome.kill('SIGTERM');
  await new Promise((resolve) => fixture.close(resolve)); await pause(200);
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
