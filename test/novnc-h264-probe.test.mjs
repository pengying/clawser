import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpConnection } from '../src/cdp.mjs';
import { NoVncProbeGateway } from '../src/novnc-probe.mjs';

// Run with NOVNC_ASSETS_DIR pointing at the pinned noVNC 1.7.0 source tree.
const assets = process.env.NOVNC_ASSETS_DIR;
const chromePath = process.env.CHROME_BIN || '/usr/bin/google-chrome-stable';
const skip = !assets ? 'set NOVNC_ASSETS_DIR to the noVNC 1.7.0 source tree' : !existsSync(chromePath) ? 'Chrome unavailable' : false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Some Android hardware decoders accept the configuration and then never finish a flush.
const HANGING_DECODER = `(() => {
  window.VideoDecoder = class {
    static async isConfigSupported(config) { return { supported: true, config }; }
    constructor() {}
    configure() {}
    decode() {}
    flush() { window.__flushes = (window.__flushes || 0) + 1; return new Promise(() => {}); }
    close() {}
  };
  window.EncodedVideoChunk = class { constructor(init) { Object.assign(this, init); } };
})();`;

async function browser(t, { decoder } = {}) {
  const supervisor = {
    async create({ probeId }) { return { ownedId: probeId }; }, async read() { return { state: 'running' }; },
    async register() { return { endpoint: { path: '/nonexistent.sock' }, credentials: { watch: 'watch123', control: 'admin456' } }; },
    async destroy() {}, async verifyExited() { return true; },
  };
  const gateway = new NoVncProbeGateway({ supervisor, noVncAssetsDir: assets, prefix: '/browser/', completionDisposition: 'retained' });
  await gateway.start({ port: 0 });
  const profile = await mkdtemp(join(tmpdir(), 'novnc-h264-'));
  const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let cdp;
  t.after(async () => {
    cdp?.close();
    if (chrome.exitCode === null && chrome.signalCode === null) { const exited = once(chrome, 'exit'); chrome.kill('SIGTERM'); await exited; }
    await gateway.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let port;
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { await pause(30); }
  }
  assert.ok(port, 'fresh Chromium started');
  const page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  cdp = await new CdpConnection({ commandTimeoutMs: 30_000 }).connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable', {});
  if (decoder) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: decoder });
  // Any same-origin page works as a module host; the viewer's own stylesheet is a real gateway route.
  await cdp.send('Page.navigate', { url: gateway.localUrl + '/browser/assets/probe.css' });
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    if (ready.result.value === 'complete') break;
    await pause(25);
  }
  const evaluate = async expression => {
    const reply = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  };
  return { evaluate };
}

// Imports noVNC's browser feature module from the gateway and reports how long it took.
const IMPORT = `(async () => {
  const started = performance.now();
  const settled = await Promise.race([
    import('/browser/novnc/core/util/browser.js').then(module => ({ loaded: true, h264: module.supportsWebCodecsH264Decode })),
    new Promise(resolve => setTimeout(() => resolve({ loaded: false }), 8000)),
  ]);
  return { ...settled, ms: Math.round(performance.now() - started), flushes: window.__flushes || 0 };
})()`;

test('a hardware decoder that never finishes its flush cannot hold the viewer import', { skip, timeout: 60_000 }, async t => {
  const { evaluate } = await browser(t, { decoder: HANGING_DECODER });
  const result = await evaluate(IMPORT);
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.flushes, 1, 'noVNC probed the decoder');
  assert.equal(result.loaded, true, 'the import finished although the decoder never answered');
  assert.equal(result.h264, false, 'an unanswered probe counts as no H.264 support');
  assert.ok(result.ms < 5000, 'the probe gave up well inside the viewer asset deadline: ' + result.ms + ' ms');
});

test('a browser without WebCodecs still imports promptly with no H.264', { skip, timeout: 60_000 }, async t => {
  const { evaluate } = await browser(t, { decoder: 'delete window.VideoDecoder;' });
  const result = await evaluate(IMPORT);
  assert.deepEqual({ loaded: result.loaded, h264: result.h264, flushes: result.flushes }, { loaded: true, h264: false, flushes: 0 });
  assert.ok(result.ms < 2000, 'no wait without WebCodecs: ' + result.ms + ' ms');
});

// A decoder that answers promptly and delivers the test frame, like desktop Chrome's.
const WORKING_DECODER = `(() => {
  window.VideoDecoder = class {
    static async isConfigSupported(config) { return { supported: true, config }; }
    constructor({ output }) { this.output = output; }
    configure() {}
    decode() { this.pending = true; }
    flush() { window.__flushes = (window.__flushes || 0) + 1; if (this.pending) this.output({ close() {} }); return Promise.resolve(); }
    close() {}
  };
  window.EncodedVideoChunk = class { constructor(init) { Object.assign(this, init); } };
})();`;

test('a decoder that answers keeps H.264 and adds no wait', { skip, timeout: 60_000 }, async t => {
  const { evaluate } = await browser(t, { decoder: WORKING_DECODER });
  const result = await evaluate(IMPORT);
  assert.deepEqual({ loaded: result.loaded, h264: result.h264, flushes: result.flushes }, { loaded: true, h264: true, flushes: 1 });
  assert.ok(result.ms < 1500, 'a prompt answer is not padded to the deadline: ' + result.ms + ' ms');
});

test('a noVNC whose H.264 probe changed is refused instead of served unbounded', { timeout: 30_000 }, async t => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const tree = await mkdtemp(join(tmpdir(), 'novnc-changed-'));
  t.after(() => rm(tree, { recursive: true, force: true }));
  await mkdir(join(tree, 'core/util'), { recursive: true });
  await writeFile(join(tree, 'core/util/browser.js'), 'export let supportsWebCodecsH264Decode = await somethingElse();\n');
  await writeFile(join(tree, 'core/rfb.js'), 'export default class RFB {}\n');
  const supervisor = { async create({ probeId }) { return { ownedId: probeId }; }, async read() { return { state: 'running' }; },
    async register() { return { endpoint: { path: '/x.sock' }, credentials: { watch: 'watch123', control: 'admin456' } }; }, async destroy() {}, async verifyExited() { return true; } };
  const gateway = new NoVncProbeGateway({ supervisor, noVncAssetsDir: tree, prefix: '/browser/' });
  await gateway.start({ port: 0 });
  t.after(() => gateway.close());
  const changed = await fetch(gateway.localUrl + '/browser/novnc/core/util/browser.js');
  assert.notEqual(changed.status, 200);
  assert.doesNotMatch(await changed.text(), /somethingElse/);
  const other = await fetch(gateway.localUrl + '/browser/novnc/core/rfb.js');
  assert.equal(other.status, 200, 'other noVNC files are served unchanged');
  assert.equal(await other.text(), 'export default class RFB {}\n');
});
