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

test('recovery-required input errors latch a durable banner and disable takeover', { skip: !existsSync(chromePath) }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'handoff-recovery-ui-'));
  const fixtureScript = String.raw`<script>
    (() => {
      const state = { id: 'share', mode: 'watch', version: 1, permission: 'control', expiresAt: Date.now() + 60000, recoveryRequired: false };
      window.fixture = { state, sockets: [] };
      window.fetch = async () => new Response(JSON.stringify(fixture.state), { status: 200, headers: { 'Content-Type': 'application/json' } });
      class FixtureSocket {
        static OPEN = 1;
        constructor() {
          this.readyState = FixtureSocket.OPEN;
          fixture.sockets.push(this);
          queueMicrotask(() => this.readyState === FixtureSocket.OPEN && this.emit({ type: 'ready', ...fixture.state, connectionId: 'connection', inputWindow: 1 }));
          queueMicrotask(() => this.readyState === FixtureSocket.OPEN && this.emit({ type: 'metadata', interactions: { document: 'document', regions: [] } }));
          queueMicrotask(() => {
            if (this.readyState !== FixtureSocket.OPEN) return;
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
            this.emit({ type: 'frame', displayId: 1, connectionId: 'connection', data: canvas.toDataURL('image/jpeg').split(',')[1] });
          });
        }
        emit(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
        send(data) { if (JSON.parse(data).type === 'input') fixture.inputCount = (fixture.inputCount || 0) + 1; }
        close() {
          if (this.readyState !== FixtureSocket.OPEN) return;
          this.readyState = 3;
          queueMicrotask(() => this.onclose?.({ code: 1006 }));
        }
      }
      window.WebSocket = FixtureSocket;
    })();
  </script>`;
  const server = createServer(async (request, response) => {
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
  const chrome = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank',
  ], { stdio: 'ignore' });
  let cdp;
  t.after(async () => {
    cdp?.close(); chrome.kill('SIGTERM');
    await new Promise((resolve) => server.close(resolve));
    await pause(100);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  let port;
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    try { port = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
    catch { await pause(30); }
  }
  assert.ok(port, 'Chromium started');
  const page = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.address().port}`)}`, { method: 'PUT' })).json();
  cdp = await new CdpConnection().connect(page.webSocketDebuggerUrl);
  const evaluate = async (expression) => {
    const reply = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text);
    return reply.result.value;
  };
  const waitFor = async (expression, description) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      if (await evaluate(expression)) return;
      await pause(25);
    }
    assert.fail(description);
  };

  await waitFor('window.fixture?.sockets.length === 1 && document.querySelector("#control")?.disabled === false', 'takeover became available');
  await evaluate(`fixture.sockets.at(-1).emit({ type: 'error', error: 'The tab was closed.', recoveryRequired: false })`);
  await waitFor('fixture.sockets.length >= 2 && document.querySelector("#control").disabled === false', 'an ordinary definitive error did not poison takeover');

  await evaluate(`(() => {
    fixture.state.version = 0;
    fixture.sockets.at(-1).emit({ type: 'error', error: 'Browser input outcome uncertain.', recoveryRequired: true });
  })()`);
  await waitFor('fixture.sockets.length >= 3', 'the viewer reconnected after the uncertain input error');
  await pause(2200);
  assert.deepEqual(await evaluate(`({
    badge: document.querySelector('#badge').textContent,
    button: document.querySelector('#control').textContent,
    disabled: document.querySelector('#control').disabled,
    status: document.querySelector('#status').textContent,
    error: document.querySelector('#status').classList.contains('error'),
    doneDisabled: document.querySelector('#done').disabled,
  })`), {
    badge: 'RECOVERY REQUIRED',
    button: 'Recovery required',
    disabled: true,
    status: 'Browser stopped responding to input. Control is paused until the browser is reset. Ask for a new link.',
    error: true,
    doneDisabled: false,
  });
  await evaluate(`(() => {
    fixture.sockets.at(-1).emit({ type: 'ready', ...fixture.state, mode: 'control', version: 50, controlId: 'stale-control', connectionId: 'connection', recoveryRequired: false });
    document.querySelector('[data-key=Escape]').click();
  })()`);
  assert.equal(await evaluate('fixture.inputCount || 0'), 0, 'a stale control state cannot dispatch input after recovery is latched');
  await evaluate(`(() => {
    const originalFetch = window.fetch;
    window.fetch = async (url, ...args) => {
      if (String(url).endsWith('/done')) {
        fixture.sockets.at(-1).onclose({ code: 4001 });
        await new Promise(resolve => setTimeout(resolve, 100));
        return new Response(JSON.stringify({ mode: 'ended' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url, ...args);
    };
    document.querySelector('#done').click();
  })()`);
  await waitFor('!document.querySelector("#finished").hidden', 'Done still ends access during recovery');
  assert.equal(await evaluate('document.querySelector("#endTitle").textContent'), 'Access ended.', 'a terminal socket close must not claim a successful handback during recovery');
  assert.match(await evaluate('document.querySelector("#endMessage").textContent'), /recovery is still required/i, 'Done must not claim the agent can resume while the gate is poisoned');
  await pause(150);
  assert.match(await evaluate('document.querySelector("#endMessage").textContent'), /recovery is still required/i, 'the later HTTP response preserves the same recovery explanation');
});
