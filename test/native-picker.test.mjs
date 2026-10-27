import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpBrowser, CdpConnection } from '../src/cdp.mjs';
import { interactionCollector } from '../src/interaction-metadata.mjs';

const picker = await import('../src/native-picker.mjs').catch(() => null);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('native picker fixed-action module is available', () => {
  assert.ok(picker, 'src/native-picker.mjs must provide the fixed isolated-world picker actions');
});

test('isolated picker capabilities expose bounded labels and reject stale or unavailable choices', async (t) => {
  if (!picker) return;
  const directory = await mkdtemp(join(tmpdir(), 'handoff-picker-qa-'));
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><style>
      select,input{display:block;width:240px;height:40px;margin:12px}
      #hidden{display:none}
    </style>
    <select id=single><option value=PRIVATE_A>Alpha</option><optgroup label="Group"><option value=PRIVATE_B>Bravo</option><option value=PRIVATE_D disabled>Disabled</option></optgroup><option id=hidden value=PRIVATE_H>Hidden secret</option></select>
    <select id=multi multiple><option value=PRIVATE_M0 selected>Zero</option><option value=PRIVATE_M1 disabled selected>Locked</option><option hidden value=PRIVATE_M2 selected>Hidden locked</option><option value=PRIVATE_M3>Three</option></select>
    <input id=color type=color value="#123456">
    <iframe id=frame srcdoc="<select id='framed'><option>Frame one</option><option>Frame two</option></select>"></iframe>
    <div id=host></div>
    <button id=other>other</button>
    <fieldset disabled><select id=fieldsetDisabled><option>Unavailable</option></select></fieldset>
    <script>
      host.attachShadow({mode:'open'}).innerHTML='<select id="shadowed"><option>Shadow one</option><option>Shadow two</option></select>';
      for (const node of document.querySelectorAll('select,input')) for (const type of ['input','change']) node.addEventListener(type,()=>document.body.dataset[type]=(Number(document.body.dataset[type]||0)+1));
    </script>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const chrome = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${directory}`,
  ], { stdio: 'ignore' });
  let cdp, browserConnection;
  t.after(async () => {
    await browserConnection?.close();
    cdp?.close(); chrome.kill('SIGTERM');
    await new Promise((resolve) => server.close(resolve));
    await pause(100);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  let port;
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    try { port = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { await pause(25); }
  }
  assert.ok(port, 'Chrome started with a disposable profile');
  const base = `http://127.0.0.1:${port}`;
  const tab = await (await fetch(`${base}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.address().port}`)}`, { method: 'PUT' })).json();
  cdp = await new CdpConnection().connect(tab.webSocketDebuggerUrl);
  const evaluate = async (expression, contextId) => {
    const result = await cdp.send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Evaluation failed');
    return result.result.value;
  };
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate('document.readyState === "complete" && Boolean(document.querySelector("#frame")?.contentDocument?.querySelector("select"))')) break;
    await pause(25);
  }
  const tree = await cdp.send('Page.getFrameTree');
  const world = await cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'openclaw-picker-test' });
  const contextId = world.executionContextId, document = 'a'.repeat(32);
  const collect = () => evaluate(interactionCollector(document), contextId);
  let map = await collect();
  assert.deepEqual(new Set(map.regions.filter((region) => region.kind === 'picker').map((region) => region.pickerType)), new Set(['select', 'color']));
  assert.equal(JSON.stringify(map).includes('PRIVATE_'), false, 'passive metadata never includes option or color values');
  assert.equal(map.regions.filter((region) => region.kind === 'picker').length, 5, 'controls disabled by an ancestor fieldset are absent');
  const byDomId = async (domId) => {
    const regions = (await collect()).regions.filter((region) => region.kind === 'picker');
    const order = ['single', 'multi', 'color', 'framed', 'shadowed'];
    return regions[order.indexOf(domId)];
  };
  const single = await byDomId('single');
  let descriptor = await evaluate(picker.pickerOpen(document, single.id), contextId);
  assert.deepEqual(descriptor.options, [
    { index: 0, label: 'Alpha', disabled: false, selected: true },
    { index: 1, label: 'Bravo', group: 'Group', disabled: false, selected: false },
    { index: 2, label: 'Disabled', group: 'Group', disabled: true, selected: false },
  ]);
  assert.equal(JSON.stringify(descriptor).includes('PRIVATE_'), false, 'requested select descriptor excludes option values');
  map = await collect();
  assert.equal(map.pickerFocus, single.id, 'collector confirms the focused capability without descriptor data');
  await assert.rejects(evaluate(picker.pickerApply(descriptor.token, { indices: [2] }), contextId), /disabled|unavailable/i);
  assert.equal(await evaluate('single.selectedIndex'), 0, 'a rejected choice does not mutate selection');

  descriptor = await evaluate(picker.pickerOpen(document, single.id), contextId);
  await evaluate(picker.pickerApply(descriptor.token, { indices: [1] }), contextId);
  assert.deepEqual(await evaluate('({selected:single.selectedIndex,input:document.body.dataset.input,change:document.body.dataset.change})'), { selected: 1, input: '1', change: '1' });
  await assert.rejects(evaluate(picker.pickerApply(descriptor.token, { indices: [0] }), contextId), /token|capability/i, 'apply tokens are one-use');

  descriptor = await evaluate(picker.pickerOpen(document, single.id), contextId);
  await evaluate(picker.pickerApply(descriptor.token, { indices: [1] }), contextId);
  assert.deepEqual(await evaluate('({input:document.body.dataset.input,change:document.body.dataset.change})'), { input: '1', change: '1' }, 'an unchanged single selection emits no events');
  await assert.rejects(evaluate(picker.pickerApply(descriptor.token, { indices: [1] }), contextId), /token|capability/i, 'an unchanged apply still consumes its token');

  descriptor = await evaluate(picker.pickerOpen(document, single.id), contextId);
  await evaluate('single.selectedIndex=0');
  await assert.rejects(evaluate(picker.pickerApply(descriptor.token, { indices: [1] }), contextId), /changed|stale/i);
  assert.equal(await evaluate('single.selectedIndex'), 0);

  descriptor = await evaluate(picker.pickerOpen(document, single.id), contextId);
  await evaluate('single.options[1].replaceWith(single.options[1].cloneNode(true))');
  await assert.rejects(evaluate(picker.pickerApply(descriptor.token, { indices: [1] }), contextId), /changed|stale/i, 'replacement with identical public text is stale');

  await evaluate(`other.focus();single.addEventListener('focus',()=>single.selectedIndex=1,{once:true})`);
  descriptor = await evaluate(picker.pickerOpen(document, single.id), contextId);
  assert.equal(descriptor.options.find((option) => option.index === 1).selected, true, 'descriptor snapshots state after synchronous focus handlers');
  await evaluate(picker.pickerCancel(descriptor.token), contextId);

  descriptor = await evaluate(picker.pickerOpen(document, single.id), contextId);
  await evaluate(`(()=>{const old=single.querySelector('optgroup'),fresh=document.createElement('optgroup');fresh.label=old.label;fresh.append(...old.children);old.replaceWith(fresh)})()`);
  await assert.rejects(evaluate(picker.pickerApply(descriptor.token, { indices: [0] }), contextId), /changed|stale/i, 'moving the same options into a replacement group is stale');

  const multi = await byDomId('multi');
  descriptor = await evaluate(picker.pickerOpen(document, multi.id), contextId);
  assert.equal(descriptor.multiple, true);
  await evaluate('multi.multiple=false');
  await assert.rejects(evaluate(picker.pickerApply(descriptor.token, { indices: [3] }), contextId), /changed|stale/i, 'control mode changes are stale');
  assert.deepEqual(await evaluate('[...multi.options].filter(option=>option.selected).map(option=>option.index)'), [0], 'stale mode rejection happens before backend mutation');
  await evaluate('multi.multiple=true;multi.options[0].selected=true;multi.options[1].selected=true;multi.options[2].selected=true');
  descriptor = await evaluate(picker.pickerOpen(document, multi.id), contextId);
  await evaluate(picker.pickerApply(descriptor.token, { indices: [1, 3] }), contextId);
  assert.deepEqual(await evaluate('[...multi.options].filter(option=>option.selected).map(option=>option.index)'), [1, 2, 3], 'unavailable selected options are preserved whether or not the UI echoes a disabled checked choice');
  const multiEvents = await evaluate('({input:document.body.dataset.input,change:document.body.dataset.change})');
  descriptor = await evaluate(picker.pickerOpen(document, multi.id), contextId);
  await evaluate(picker.pickerApply(descriptor.token, { indices: [1, 3] }), contextId);
  assert.deepEqual(await evaluate('({input:document.body.dataset.input,change:document.body.dataset.change})'), multiEvents, 'an unchanged effective multi-selection emits no events');

  const color = await byDomId('color');
  descriptor = await evaluate(picker.pickerOpen(document, color.id), contextId);
  assert.equal(descriptor.value, '#123456');
  await evaluate(picker.pickerApply(descriptor.token, { color: '#abcdef' }), contextId);
  assert.equal(await evaluate('color.value'), '#abcdef');
  const colorEvents = await evaluate('({input:document.body.dataset.input,change:document.body.dataset.change})');
  descriptor = await evaluate(picker.pickerOpen(document, color.id), contextId);
  await evaluate(picker.pickerApply(descriptor.token, { color: '#abcdef' }), contextId);
  assert.deepEqual(await evaluate('({input:document.body.dataset.input,change:document.body.dataset.change})'), colorEvents, 'an unchanged color emits no events');
  await assert.rejects(evaluate(picker.pickerApply(descriptor.token, { color: '#abcdef' }), contextId), /token|capability/i, 'an unchanged color apply still consumes its token');

  descriptor = await evaluate(picker.pickerOpen(document, color.id), contextId);
  await evaluate('other.focus()'); await collect();
  await assert.rejects(evaluate(picker.pickerApply(descriptor.token, { color: '#000000' }), contextId), /token|capability|focus/i);
  assert.equal(await evaluate('color.value'), '#abcdef');

  descriptor = await evaluate(picker.pickerOpen(document, color.id), contextId);
  await evaluate('color.value="#111111"');
  await assert.rejects(evaluate(picker.pickerApply(descriptor.token, { color: '#000000' }), contextId), /changed|stale/i);
  assert.equal(await evaluate('color.value'), '#111111', 'stale color rejection does not overwrite the newer value');
  await evaluate('color.value="#abcdef";color.setAttribute("colorspace","display-p3")');
  await assert.rejects(evaluate(picker.pickerOpen(document, color.id), contextId), /unsupported/i);
  await evaluate('color.removeAttribute("colorspace")');

  descriptor = await evaluate(picker.pickerOpen(document, color.id), contextId);
  await evaluate('color.style.display="none"');
  assert.equal((await collect()).pickerFocus, null, 'a picker that leaves the visible control map invalidates its capability');
  await evaluate('color.style.display=""');
  await assert.rejects(evaluate(picker.pickerApply(descriptor.token, { color: '#000000' }), contextId), /token|capability/i);

  const first = await evaluate(picker.pickerOpen(document, single.id), contextId);
  const second = await evaluate(picker.pickerOpen(document, color.id), contextId);
  await assert.rejects(evaluate(picker.pickerApply(first.token, { indices: [0] }), contextId), /token|capability/i, 'opening another picker replaces the sole strong capability');
  assert.equal(await evaluate(picker.pickerCancel(second.token), contextId), null);
  await assert.rejects(evaluate(picker.pickerApply(second.token, { color: '#000000' }), contextId), /token|capability/i, 'cancel invalidates its token');

  for (const id of ['framed', 'shadowed']) {
    const region = await byDomId(id);
    descriptor = await evaluate(picker.pickerOpen(document, region.id), contextId);
    assert.equal(descriptor.kind, 'select', `${id} resolves through existing opaque IDs`);
    if (id === 'shadowed') {
      await evaluate('host.inert=true');
      await assert.rejects(evaluate(picker.pickerApply(descriptor.token, { indices: [1] }), contextId), /hidden|stale|focus|changed/i, 'inert hosts invalidate controls across the shadow boundary');
      await evaluate('host.inert=false');
    } else assert.equal(await evaluate(picker.pickerCancel(descriptor.token), contextId), null);
  }

  cdp.close(); cdp = null;
  let interactions;
  browserConnection = await new CdpBrowser({ demo: base }).open({ profile: 'demo', targetId: tab.id }, {
    onFrame() {}, onClose() {}, onMetadata(next) { if (next.interactions) interactions = next.interactions; },
  });
  for (let attempt = 0; attempt < 100 && !interactions?.regions.some((region) => region.pickerType === 'color'); attempt++) await pause(25);
  const backendColor = interactions.regions.find((region) => region.kind === 'picker' && region.pickerType === 'color');
  const opened = await browserConnection.input({ kind: 'pickerOpen', document: interactions.document, regionId: backendColor.id });
  assert.equal(opened.picker.value, '#abcdef');
  assert.deepEqual(interactions.pickerFocus, { id: backendColor.id, document: interactions.document, token: opened.picker.token });
  const ownerCancel = browserConnection.cancelPicker();
  await assert.rejects(browserConnection.input({ kind: 'pickerApply', pickerToken: opened.picker.token, color: '#000000' }), /token|capability/i, 'owner cleanup revokes Node authority synchronously');
  await ownerCancel;
  assert.equal(interactions.pickerFocus, null);

  const firstDocument = interactions.document;
  await browserConnection.close(); browserConnection = null; interactions = null;
  browserConnection = await new CdpBrowser({ demo: base }).open({ profile: 'demo', targetId: tab.id }, {
    onFrame() {}, onClose() {}, onMetadata(next) { if (next.interactions) interactions = next.interactions; },
  });
  for (let attempt = 0; attempt < 100 && !interactions?.regions.some((region) => region.pickerType === 'color'); attempt++) await pause(25);
  assert.notEqual(interactions.document, firstDocument, 'a retained named isolated world is rebound to the new backend document capability');
  const reconnectedColor = interactions.regions.find((region) => region.kind === 'picker' && region.pickerType === 'color');
  const reconnected = await browserConnection.input({ kind: 'pickerOpen', document: interactions.document, regionId: reconnectedColor.id });
  assert.equal(reconnected.picker.value, '#abcdef', 'the same unchanged tab accepts picker open after backend reconnect');
  const replacement = await browserConnection.input({ kind: 'pickerOpen', document: interactions.document, regionId: reconnectedColor.id });
  assert.notEqual(replacement.picker.token, reconnected.picker.token);
  assert.deepEqual(await browserConnection.input({ kind: 'pickerCancel', pickerToken: reconnected.picker.token }), { picker: null }, 'a benign stale cancel is idempotent');
  assert.equal(interactions.pickerFocus.token, replacement.picker.token, 'stale cancel cannot invalidate the newer capability');
  assert.deepEqual(await browserConnection.input({ kind: 'pickerApply', pickerToken: replacement.picker.token, color: '#fedcba' }), { picker: null });
});
