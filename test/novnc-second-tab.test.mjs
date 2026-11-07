import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpConnection } from '../src/cdp.mjs';
import { NoVncProbeGateway } from '../src/novnc-probe.mjs';

// Run with NOVNC_ASSETS_DIR pointing at the pinned noVNC 1.7.0 source tree.
const assets = process.env.NOVNC_ASSETS_DIR;
const chromePath = process.env.CHROME_BIN || '/usr/bin/google-chrome-stable';
const skip = !assets ? 'set NOVNC_ASSETS_DIR to the noVNC 1.7.0 source tree' : !existsSync(chromePath) ? 'Chrome unavailable' : false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Just enough RFB 3.8 for noVNC to report connect: no security, then a 64x64 ServerInit.
function rfbServer(path) {
  const server = createServer(socket => {
    let phase = 'version';
    socket.on('error', () => {});
    socket.write('RFB 003.008\n');
    socket.on('data', () => {
      if (phase === 'version') { socket.write(Buffer.from([1, 1])); phase = 'security'; }
      else if (phase === 'security') { socket.write(Buffer.alloc(4)); phase = 'init'; }
      else if (phase === 'init') {
        const name = Buffer.from('second tab');
        const init = Buffer.alloc(24);
        init.writeUInt16BE(64, 0); init.writeUInt16BE(64, 2);
        init.set([32, 24, 0, 1], 4);
        for (const offset of [8, 10, 12]) init.writeUInt16BE(255, offset);
        init.set([16, 8, 0], 14);
        init.writeUInt32BE(name.length, 20);
        socket.write(Buffer.concat([init, name]));
        phase = 'messages';
      }
    });
  });
  return new Promise(resolve => server.listen(path, () => resolve(server)));
}

async function chrome(t) {
  const profile = await mkdtemp(join(tmpdir(), 'novnc-tabs-'));
  const child = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const connections = [];
  t.after(async () => {
    for (const cdp of connections) cdp.close();
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let port;
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { await pause(30); }
  }
  assert.ok(port, 'fresh Chromium started');
  // Tabs in one profile share the viewer cookie, like a second tab on the phone.
  return async url => {
    const page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const cdp = await new CdpConnection({ commandTimeoutMs: 30_000 }).connect(page.webSocketDebuggerUrl);
    connections.push(cdp);
    await cdp.send('Page.enable', {});
    await cdp.send('Page.navigate', { url });
    const status = async () => (await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("#status")?.textContent || ""', returnByValue: true })).result.value;
    const waitFor = async (pattern, label) => {
      let last = '';
      for (let attempt = 0; attempt < 300; attempt++) { last = await status(); if (pattern.test(last)) return last; await pause(50); }
      assert.fail(label + '; status was: ' + last);
    };
    return { status, waitFor };
  };
}

test('opening the same handoff in a second tab leaves the first tab connected', { skip, timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'novnc-rfb-'));
  const socketPath = join(directory, 'rfb.sock');
  const rfb = await rfbServer(socketPath);
  let destroys = 0;
  const supervisor = {
    async create({ probeId }) { return { ownedId: probeId }; }, async read() { return { state: 'running' }; },
    async register() { return { endpoint: { path: socketPath }, credentials: { watch: 'watch123', control: 'admin456' } }; },
    async destroy() { destroys++; }, async verifyExited() { return true; },
  };
  const gateway = new NoVncProbeGateway({ supervisor, noVncAssetsDir: assets, prefix: '/browser/', completionDisposition: 'retained', maxProbes: 1 });
  await gateway.start({ port: 0 });
  t.after(async () => { await gateway.close(); rfb.close(); await rm(directory, { recursive: true, force: true }); });
  const invite = await gateway.createProbe({ ttlSeconds: 120, permission: 'control' });
  const open = await chrome(t);

  const first = await open(invite.url);
  await first.waitFor(/Watching/, 'the first tab connected');
  // The same link again, as a second tab or a link preview would load it.
  const second = await open(invite.url);
  const refused = await second.waitFor(/another tab or window|ended|destroyed|returned/i, 'the second tab settled');
  t.diagnostic('second tab: ' + refused);
  await pause(500);

  assert.match(refused, /another tab or window/i, 'the second tab says why it stopped');
  assert.equal(gateway.sessions.get(invite.id)?.mode, 'watch', 'the handoff is still live');
  assert.match(await first.status(), /Watching/, 'the first tab is still watching');
  assert.equal(destroys, 0);
});
