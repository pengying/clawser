// Disposable local feasibility check; never attaches to a user browser.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpConnection } from '../src/cdp.mjs';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = await mkdtemp(join(tmpdir(), 'handoff-interaction-spike-'));
const server = createServer((_q, r) => r.end(`<!doctype html><style>body{height:2200px;margin:0}input{position:absolute;left:40px;top:80px;width:300px}#drag{position:absolute;left:40px;top:180px;width:70px;height:70px;background:green}#drop{position:absolute;left:300px;top:180px;width:100px;height:100px;background:lightblue}</style><input type=range id=range min=0 max=100 value=0><div id=drag draggable=true>drag</div><div id=drop>drop</div><script>drag.ondragstart=e=>e.dataTransfer.setData('text/plain','test');drop.ondragover=e=>e.preventDefault();drop.ondrop=e=>{e.preventDefault();document.body.dataset.dropped='yes'}</script>`));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const child = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome-stable', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`], { stdio: 'ignore' });
let cdp;
try {
  let port;
  for (let n = 0; n < 100 && !port; n++) { try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { await pause(50); } }
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.address().port}`)}`, { method: 'PUT' })).json();
  cdp = await new CdpConnection().connect(tab.webSocketDebuggerUrl);
  const value = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  for (let n = 0; n < 100 && !(await value('Boolean(document.getElementById("range"))')); n++) await pause(30);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 60, y: 90, id: 1 }] });
  for (let x = 80; x <= 320; x += 20) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 90, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  console.log('native touch range:', await value('range.value'));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 600, y: 500, id: 1 }] });
  for (let y = 480; y >= 200; y -= 20) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 600, y, id: 1 }] }); await pause(10); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await pause(100); console.log('native touch scroll:', await value('scrollY'));
  await value('scrollTo(0,0)'); await pause(100);
  let dragData;
  cdp.on('Input.dragIntercepted', (event) => { dragData = event.data; });
  await cdp.send('Input.setInterceptDrags', { enabled: true });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 70, y: 210, button: 'left', buttons: 1, clickCount: 1 });
  let entered = false;
  for (let x = 80; x <= 340; x += 20) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: 210, button: 'left', buttons: 1 });
    await pause(10);
    if (dragData) { await cdp.send('Input.dispatchDragEvent', { type: entered ? 'dragOver' : 'dragEnter', x, y: 210, data: dragData }); entered = true; }
  }
  if (dragData) { await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: 340, y: 210, data: dragData }); await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: 340, y: 210, data: dragData }); }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 340, y: 210, button: 'left', buttons: 0, clickCount: 1 });
  console.log('HTML drag intercepted:', Boolean(dragData), 'dropped:', await value('document.body.dataset.dropped'));
} finally {
  cdp?.close(); child.kill('SIGTERM'); await new Promise((r) => server.close(r));
  await pause(200); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
