// Disposable demo. Explicit --funnel enables a temporary, dedicated public route.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpBrowser, CdpConnection } from '../src/cdp.mjs';
import { HandoffServer } from '../src/server.mjs';
import { FunnelTransport } from '../src/funnel.mjs';
const directory = await mkdtemp(join(tmpdir(), 'browser-handoff-demo-'));
const ttlSeconds = Number(process.argv.find((v) => v.startsWith('--ttl='))?.split('=')[1] || 900);
if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 1800) throw new Error('Demo lifetime must be 60–1800 seconds');
let chrome, browser, transport, stopping = false, timer;
const fixture = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><html><head><title>Isolated handoff demo</title><style>body{margin:0;background:#f4f7f8;color:#16313c;font:22px system-ui}main{max-width:680px;margin:auto;padding:42px 32px}h1{font-size:42px;letter-spacing:-2px}p{line-height:1.6;color:#526973}input,button{font:22px system-ui;padding:16px;border:1px solid #b9ccd1;border-radius:10px}input{display:block;width:90%;margin:12px 0 22px}button{background:#89e4ca;color:#16313c;cursor:pointer}output{display:block;margin:24px 0;color:#17624c}footer{margin-top:500px;border-top:1px solid #b9ccd1;padding-top:24px;font-size:18px}</style></head><body><main><p>DISPOSABLE TEST BROWSER</p><h1>You're in control.</h1><p>This is an isolated demo, not your signed-in browser. Take control in the viewer, tap the field, and send some text.</p><label>Try typing<input id="field" placeholder="Tap here first"></label><button id="counter">Click me · 0</button><output id="out">Waiting for your input…</output><footer>You reached the bottom. Touch scrolling works.</footer></main><script>let n=0;document.querySelector('#counter').onclick=e=>e.target.textContent='Click me · '+(++n);document.querySelector('#field').oninput=e=>document.querySelector('#out').textContent=e.target.value||'Waiting for your input…';</script></body></html>`);
});
async function stop() {
  if (stopping) return; stopping = true; clearTimeout(timer);
  await browser?.close();
  let cleanupError;
  try { await transport?.close(); } catch (error) { cleanupError = error; }
  if (fixture.listening) await new Promise((resolve) => fixture.close(resolve));
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = once(chrome, 'exit'); chrome.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGKILL');
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  if (cleanupError) { console.error(cleanupError.message); process.exitCode = 1; }
  else console.log('Demo stopped; its unchanged Funnel route was removed.');
}
try {
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  chrome = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome-stable', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!port) throw new Error('Disposable Chrome did not start');
  const cdpBase = `http://127.0.0.1:${port}`;
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
  const tab = await (await fetch(`${cdpBase}/json/new?${encodeURIComponent(fixtureUrl)}`, { method: 'PUT' })).json();
  const cdp = await new CdpConnection().connect(tab.webSocketDebuggerUrl);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false }); cdp.close();
  browser = new HandoffServer({ backend: new CdpBrowser({ demo: cdpBase }) });
  await browser.start();
  if (process.argv.includes('--funnel')) {
    transport = new FunnelTransport();
    browser.setPublicBase(await transport.open(Number(new URL(browser.localUrl).port)));
  }
  const invite = await browser.createShare({ owner: 'disposable-demo', profile: 'demo', targetId: tab.id, ttlMs: ttlSeconds * 1000 });
  const output = process.env.HANDOFF_DEMO_INVITE_FILE || join(directory, 'invite.json');
  await writeFile(output, JSON.stringify(invite), { mode: 0o600 });
  console.log(`Demo ready; private invitation file: ${output}; lifetime ${ttlSeconds}s.`);
  timer = setTimeout(() => void stop(), ttlSeconds * 1000 + 5000);
  browser.store.on('ended', (event) => { if (event.reason === 'done') setTimeout(() => void stop(), 1500); });
  process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
} catch (error) { console.error(error.message); process.exitCode = 1; await stop(); }
