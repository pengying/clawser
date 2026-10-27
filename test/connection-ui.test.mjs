import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CdpConnection } from '../src/cdp.mjs';

const chromePath = process.env.CHROME_BIN || '/usr/bin/google-chrome-stable';
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function openFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'handoff-connection-ui-'));
  let chrome, chromeClosed, cdp, server, chromeFailure, chromeStderr = '';
  t.after(async () => {
    cdp?.close();
    if (chrome?.pid) {
      const waitForExit = async () => {
        let timer;
        try { await Promise.race([chromeClosed, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); }
        finally { clearTimeout(timer); }
      };
      if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGTERM');
      await waitForExit();
      if (chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill('SIGKILL');
        await waitForExit();
      }
    }
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const fixtureScript = String.raw`<script>
    (() => {
      const config = ${JSON.stringify(options)};
      const realSetTimeout = window.setTimeout.bind(window);
      const realSetInterval = window.setInterval.bind(window);
      // Post-ready recovery tests keep the real startup allowance; unrelated
      // image scheduling must not retire their fixture before fault injection.
      window.setTimeout = (callback, delay, ...args) => {
        // readDuringStartup uses a 10-second setTimeout for its state request.
        // The Done test leaves only its first read pending until parent abort.
        if (config.holdInitialStateDeadline && delay === 10000 && fixture.stateCalls === 0) return 0;
        return realSetTimeout(callback,
          config.realStartupDeadline && delay === 12000 ? delay : Math.min(delay, 70), ...args);
      };
      window.setInterval = (callback, delay, ...args) => realSetInterval(callback, Math.min(delay, 20), ...args);
      AbortSignal.timeout = () => {
        const controller = new AbortController();
        realSetTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), 70);
        return controller.signal;
      };
      const state = { id: 'share', mode: 'watch', version: 1, permission: 'control', expiresAt: Date.now() + 60000, recoveryRequired: false };
      window.fixture = {
        state, sockets: [], socketPlans: config.socketPlans || ['healthy'], pollMode: config.pollMode || 'ok',
        stateCalls: 0, claimCalls: 0, images: 0, activeStateFetches: 0, maxActiveStateFetches: 0, abortedStateFetches: 0,
      };
      if (config.firstImageDelay) {
        window.Image = function FixtureImage() {
          const image = document.createElement('canvas'); image.width = image.height = 1;
          Object.defineProperties(image, {
            naturalWidth: { value: 1 }, naturalHeight: { value: 1 },
            src: { set() { const delay = fixture.images++ === 0 ? config.firstImageDelay : 0; realSetTimeout(() => image.onload?.(), delay); } },
          });
          return image;
        };
      }
      const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      const hang = (init, stateRequest = false) => {
        if (stateRequest) {
          fixture.activeStateFetches++;
          fixture.maxActiveStateFetches = Math.max(fixture.maxActiveStateFetches, fixture.activeStateFetches);
        }
        return new Promise((resolve, reject) => {
          const abort = () => {
            if (stateRequest) { fixture.activeStateFetches--; fixture.abortedStateFetches++; }
            fixture.lastAbortName = init.signal?.reason?.name;
            reject(init.signal?.reason || new DOMException('Aborted', 'AbortError'));
          };
          if (init.signal?.aborted) abort();
          else init.signal?.addEventListener('abort', abort, { once: true });
        });
      };
      window.fetch = async (url, init = {}) => {
        if (init.method === 'POST' && String(url).endsWith('/claim')) {
          fixture.claimCalls++;
          if (config.claimMode === 'lost') { fixture.claimSucceeded = true; return hang(init); }
          return response(fixture.state);
        }
        if (init.method === 'POST') return response({ mode: 'ended' });
        fixture.stateCalls++;
        if (fixture.claimSucceeded) return response(fixture.state);
        const initialStep = config.initialSequence?.[fixture.stateCalls - 1];
        if (initialStep === 'hang') return hang(init, true);
        if (initialStep === 'body-hang') return { ok: true, status: 200, json: () => hang(init, true) };
        if (Number.isInteger(initialStep)) return response({ error: 'fixture state response' }, initialStep);
        if (!config.initialSequence && fixture.stateCalls === 1) return response(fixture.state);
        if (fixture.pollMode === 'hang') {
          return hang(init, true);
        }
        if (fixture.pollMode === 'status') return response({ error: 'temporary state failure' }, fixture.stateStatus || 503);
        if (fixture.pollMode === 'deferred' && !fixture.deferredCreated) {
          fixture.deferredCreated = true;
          return new Promise((resolve) => { fixture.resolveDeferredState = (next) => resolve(response(next)); });
        }
        return response(fixture.state);
      };
      class FixtureSocket {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        constructor() {
          this.plan = fixture.socketPlans[fixture.sockets.length] || fixture.socketPlans.at(-1) || 'healthy';
          this.behavior = this.plan.replace(/-stuck$/, '');
          this.readyState = this.behavior === 'connecting' ? FixtureSocket.CONNECTING : FixtureSocket.OPEN;
          fixture.sockets.push(this);
          if (this.behavior === 'ready' || this.behavior === 'healthy' || this.behavior === 'frame-first') queueMicrotask(() => {
            if (this.readyState !== FixtureSocket.OPEN) return;
            if (this.behavior !== 'frame-first') this.emit({ type: 'ready', ...fixture.state, connectionId: 'connection-' + fixture.sockets.indexOf(this), inputWindow: 1 });
            if (this.behavior === 'ready') return;
            this.emit({ type: 'metadata', interactions: { document: 'document', regions: [] } });
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
            this.emit({ type: 'frame', displayId: 1, connectionId: 'connection-' + fixture.sockets.indexOf(this), data: canvas.toDataURL('image/jpeg').split(',')[1] });
          });
        }
        emit(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
        send() {}
        close() {
          if (this.readyState === FixtureSocket.CLOSED) return;
          if (this.plan.endsWith('-stuck')) { this.readyState = FixtureSocket.CLOSING; return; }
          this.readyState = FixtureSocket.CLOSED;
          queueMicrotask(() => this.onclose?.({ code: 1006 }));
        }
      }
      window.WebSocket = FixtureSocket;
    })();
  </script>`;
  server = createServer(async (request, response) => {
    try {
      if (request.url === '/assets/viewer.js' || request.url === '/assets/editing.js' || request.url === '/assets/picker.js') {
        response.setHeader('Content-Type', 'text/javascript');
        return response.end(await readFile(new URL(`../public/${request.url.slice('/assets/'.length)}`, import.meta.url)));
      }
      if (request.url === '/assets/style.css') {
        response.setHeader('Content-Type', 'text/css');
        return response.end(await readFile(new URL('../public/style.css', import.meta.url)));
      }
      response.setHeader('Content-Type', 'text/html');
      response.end((await readFile(new URL('../public/index.html', import.meta.url), 'utf8')).replace(
        '<script type="module" src="/assets/viewer.js"></script>',
        `${fixtureScript}<script type="module" src="/assets/viewer.js"></script>`,
      ));
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  chrome = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', bytes => { chromeStderr = (chromeStderr + bytes).slice(-4096); });
  chrome.on('error', error => { chromeFailure = error.message; });
  chrome.on('exit', (code, signal) => { chromeFailure = `exit ${signal || code}`; });
  chromeClosed = new Promise(resolve => chrome.once('close', resolve));
  let port;
  const deadline = performance.now() + 15_000;
  while (!port && performance.now() < deadline) {
    if (chromeFailure) assert.fail(`Chromium failed before debugging was ready (${chromeFailure}): ${chromeStderr}`);
    try {
      const candidate = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      if (/^[1-9]\d{0,4}$/.test(candidate) && Number(candidate) <= 65535) port = candidate;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!port) await Promise.race([pause(30), chromeClosed]);
  }
  assert.ok(port, `Chromium did not publish a debugging port within 15 seconds: ${chromeStderr}`);
  const fragment = options.invite ? '#invite=fixture-invite' : '';
  const page = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.address().port}/${fragment}`)}`, { method: 'PUT' })).json();
  cdp = await new CdpConnection().connect(page.webSocketDebuggerUrl);
  const evaluate = async (expression) => {
    const reply = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text);
    return reply.result.value;
  };
  const waitFor = async (expression, description) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      if (await evaluate(`Boolean(window.fixture) && Boolean(${expression})`)) return;
      await pause(25);
    }
    assert.fail(description);
  };
  return { evaluate, waitFor };
}

test('socket startup reconnects when ready or the first decoded frame never arrives', { skip: !existsSync(chromePath) }, async (t) => {
  const { evaluate, waitFor } = await openFixture(t, { socketPlans: ['connecting', 'frame-first', 'ready', 'healthy'] });
  await waitFor('fixture.sockets.length >= 4 && document.querySelector("#control")?.disabled === false', 'viewer recovered from startup ordering and liveness stalls');
  assert.deepEqual(await evaluate('fixture.sockets.slice(0, 4).map(socket => socket.readyState)'), [3, 3, 3, 1]);
});

test('startup locally retires a socket that stays CLOSING without an onclose callback', { skip: !existsSync(chromePath) }, async (t) => {
  const { evaluate, waitFor } = await openFixture(t, { socketPlans: ['connecting-stuck', 'healthy'] });
  await waitFor('fixture.sockets.length >= 2 && document.querySelector("#control")?.disabled === false', 'viewer retired the half-open generation and reconnected');
  assert.deepEqual(await evaluate('fixture.sockets.slice(0, 2).map(socket => socket.readyState)'), [2, 1]);
});

test('a late frame decode cannot cancel retirement of a CLOSING startup socket', { skip: !existsSync(chromePath) }, async (t) => {
  const { evaluate, waitFor } = await openFixture(t, { socketPlans: ['healthy-stuck', 'healthy'], firstImageDelay: 100 });
  await waitFor('fixture.sockets.length >= 2 && document.querySelector("#control")?.disabled === false', 'late decode was ignored and replacement became ready');
  assert.deepEqual(await evaluate('fixture.sockets.slice(0, 2).map(socket => socket.readyState)'), [2, 1]);
});

test('post-ready input failure retires a socket that remains CLOSING', { skip: !existsSync(chromePath) }, async (t) => {
  const { evaluate, waitFor } = await openFixture(t, { socketPlans: ['healthy-stuck', 'healthy'], firstImageDelay: 100, realStartupDeadline: true });
  await waitFor('fixture.sockets.length === 1 && document.querySelector("#control")?.disabled === false', 'initial stream became interactive');
  await evaluate(`fixture.sockets[0].emit({ type: 'error', error: 'Browser input failed.', recoveryRequired: false })`);
  await waitFor('fixture.sockets.length >= 2 && document.querySelector("#control")?.disabled === false', 'input failure retired the half-open stream and reconnected in watch');
  assert.deepEqual(await evaluate(`({
    sockets: fixture.sockets.slice(0, 2).map(socket => socket.readyState),
    badge: document.querySelector('#badge').textContent,
    recovery: document.querySelector('#badge').textContent === 'RECOVERY REQUIRED',
  })`), { sockets: [2, 1], badge: 'WATCH MODE', recovery: false });
});

test('periodic state checks are deadline-bounded and single-flight', { skip: !existsSync(chromePath) }, async (t) => {
  const { evaluate, waitFor } = await openFixture(t, { pollMode: 'hang' });
  await waitFor('fixture.abortedStateFetches >= 2', 'hung state requests were aborted and retried');
  assert.equal(await evaluate('fixture.maxActiveStateFetches'), 1, 'polls never overlap');
  assert.equal(await evaluate('document.querySelector("#finished").hidden'), true, 'timeouts are transient');
});

test('transient state failures keep watching while definitive auth failure ends access', { skip: !existsSync(chromePath) }, async (t) => {
  const { evaluate, waitFor } = await openFixture(t, { pollMode: 'status' });
  await waitFor('fixture.stateCalls >= 2', 'a transient check completed');
  assert.equal(await evaluate('document.querySelector("#finished").hidden'), true, '503 does not end the invitation');
  await evaluate('fixture.stateStatus = 401');
  await waitFor('!document.querySelector("#finished").hidden', '401 ended the viewer');
});

test('state work started on an old socket cannot restore control after reconnect or Done', { skip: !existsSync(chromePath) }, async (t) => {
  const { evaluate, waitFor } = await openFixture(t, { pollMode: 'deferred', socketPlans: ['healthy', 'healthy'] });
  await waitFor('Boolean(fixture.resolveDeferredState) && document.querySelector("#control")?.disabled === false', 'old-socket state request is pending');
  await evaluate('fixture.sockets[0].close()');
  await waitFor('fixture.sockets.length >= 2 && document.querySelector("#control").disabled === false', 'watch reconnect completed');
  await evaluate(`fixture.resolveDeferredState({ ...fixture.state, mode: 'control', version: 99, controlId: 'old-control' })`);
  await pause(50);
  assert.deepEqual(await evaluate(`({ badge: document.querySelector('#badge').textContent, releaseHidden: document.querySelector('#release').hidden })`), {
    badge: 'WATCH MODE', releaseHidden: true,
  }, 'the old state response cannot re-enable control on the replacement socket');
  await evaluate('document.querySelector("#done").click()');
  await waitFor('!document.querySelector("#finished").hidden', 'Done completed');
  await evaluate(`fixture.sockets[0].emit({ type: 'ready', ...fixture.state, mode: 'control', version: 100, controlId: 'older-control', connectionId: 'old' })`);
  await pause(100);
  assert.equal(await evaluate('fixture.sockets.length'), 2, 'stale callbacks cannot reopen a stream after Done');
  assert.equal(await evaluate('document.querySelector("#viewer").hidden'), true);
});

test('initial transient state failures retry without losing the in-memory invitation', { skip: !existsSync(chromePath) }, async (t) => {
  const { evaluate, waitFor } = await openFixture(t, { invite: true, initialSequence: ['hang', 'body-hang', 503, 401] });
  await waitFor('fixture.claimCalls === 1 && fixture.sockets.length === 1 && document.querySelector("#control")?.disabled === false', 'initial state recovered and claimed once');
  assert.equal(await evaluate('fixture.stateCalls >= 4'), true);
  assert.equal(await evaluate('location.hash'), '', 'the fragment remains absent from browser history');
});

test('a lost claim response recovers through authenticated state without replaying claim', { skip: !existsSync(chromePath) }, async (t) => {
  const { evaluate, waitFor } = await openFixture(t, { invite: true, initialSequence: [401], claimMode: 'lost' });
  await waitFor('fixture.sockets.length === 1 && document.querySelector("#control")?.disabled === false', 'cookie-authenticated state recovered the ambiguous claim');
  assert.equal(await evaluate('fixture.claimCalls'), 1, 'claim POST is never replayed');
  assert.equal(await evaluate('fixture.stateCalls >= 2'), true, 'state GET resolves ambiguous claim outcome');
});

test('Done aborts a pending initial state request and prevents later startup', { skip: !existsSync(chromePath) }, async (t) => {
  const { evaluate, waitFor } = await openFixture(t, { initialSequence: ['hang'], holdInitialStateDeadline: true });
  await waitFor('fixture.activeStateFetches === 1', 'initial state request is pending');
  // CDP scheduling can take longer than the fixture's accelerated deadline.
  await pause(150);
  assert.deepEqual(await evaluate('({ active: fixture.activeStateFetches, aborted: fixture.abortedStateFetches, calls: fixture.stateCalls })'),
    { active: 1, aborted: 0, calls: 1 }, 'the initial request remains pending until Done');
  await evaluate('document.querySelector("#done").click()');
  await waitFor('!document.querySelector("#finished").hidden && fixture.lastAbortName', 'Done canceled initial startup');
  assert.equal(await evaluate('fixture.lastAbortName'), 'AbortError');
  await pause(150);
  assert.equal(await evaluate('fixture.sockets.length'), 0, 'no stream opens after Done');
});
