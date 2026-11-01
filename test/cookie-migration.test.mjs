import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { closeBrowser, exportCookies, flushCookies, importCookies } from '../src/cookie-migration.mjs';

const COOKIES = [
  { name: 'SID', value: 'sid-secret-value', domain: '.google.com', path: '/', expires: 1893456000, size: 19, httpOnly: true, secure: true, session: false,
    sameSite: 'None', priority: 'High', sourceScheme: 'Secure', sourcePort: 443 },
  { name: 'cart', value: 'cart-secret-value', domain: 'shop.example', path: '/basket', expires: -1, size: 21, httpOnly: false, secure: false, session: true,
    priority: 'Medium', sourceScheme: 'NonSecure', sourcePort: 80 },
  { name: 'chip', value: 'chip-secret-value', domain: 'embed.example', path: '/', expires: 1893456000, size: 21, httpOnly: true, secure: true, session: false,
    sameSite: 'None', priority: 'Low', sourceScheme: 'Secure', sourcePort: 443, partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: false } },
];

async function folder(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'clawser-cookies-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// A browser-target CDP server on a free loopback port, and a d.fetch that answers its /json/version.
async function browser(t, { reply = () => ({}), version } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const port = server.address().port, cdpUrl = `http://127.0.0.1:${port}`, commands = [], connections = [], logs = [];
  server.on('connection', (socket, request) => {
    connections.push(request.url);
    socket.on('message', raw => {
      const command = JSON.parse(String(raw));
      commands.push(command);
      const result = reply(command, socket);
      if (result !== undefined) socket.send(JSON.stringify({ id: command.id, ...result.error ? { error: result.error } : { result } }));
    });
  });
  t.after(() => { for (const client of server.clients) client.terminate(); server.close(); });
  const d = {
    fs, sleep: async () => {}, log: message => logs.push(message),
    fetch: async (url, options) => {
      assert.equal(url, cdpUrl + '/json/version');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(version ? version(port) : { Browser: 'Chrome/149', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/abc` });
    },
  };
  return { cdpUrl, port, commands, connections, logs, d };
}

test("exportCookies writes the browser's cookies to a 0600 file and never logs them", async t => {
  const b = await browser(t, { reply: command => command.method === 'Storage.getCookies' ? { cookies: COOKIES } : {} });
  const dir = await folder(t);
  const result = await exportCookies(b.cdpUrl, dir, b.d);
  assert.deepEqual(result, { path: join(dir, 'cookies.json'), count: 3 });
  assert.deepEqual(b.connections, ['/devtools/browser/abc']);
  assert.deepEqual(b.commands.map(command => command.method), ['Storage.getCookies']);
  assert.equal(Object.hasOwn(b.commands[0], 'sessionId'), false, 'a browser-target command carries no sessionId');
  assert.equal((await fs.stat(result.path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await fs.readFile(result.path, 'utf8')), COOKIES);
  const logged = b.logs.join('\n');
  for (const text of COOKIES.flatMap(cookie => [cookie.name, cookie.value, cookie.domain])) assert.equal(logged.includes(text), false, 'logged ' + text.length + ' cookie characters');
  // The export never overwrites a file already in the folder.
  await assert.rejects(exportCookies(b.cdpUrl, dir, b.d), { code: 'EEXIST' });
});

test('importCookies sends CookieParams in batches of 500 and keeps expires only for persistent cookies', async t => {
  const b = await browser(t);
  const many = Array.from({ length: 1201 }, (_, i) => ({ ...COOKIES[i % 3], name: 'c' + i }));
  const path = join(await folder(t), 'cookies.json');
  await fs.writeFile(path, JSON.stringify(many), { mode: 0o600 });
  assert.deepEqual(await importCookies(b.cdpUrl, path, b.d), { count: 1201 });
  assert.deepEqual(b.connections, ['/devtools/browser/abc']);
  assert.deepEqual(b.commands.map(command => [command.method, command.params.cookies.length]), [['Storage.setCookies', 500], ['Storage.setCookies', 500], ['Storage.setCookies', 201]]);
  assert.equal(b.commands.some(command => Object.hasOwn(command, 'sessionId')), false);
  const params = b.commands.flatMap(command => command.params.cookies);
  assert.deepEqual(params.map(param => param.name), many.map(cookie => cookie.name));
  assert.deepEqual(params[0], { name: 'c0', value: 'sid-secret-value', domain: '.google.com', path: '/', secure: true, httpOnly: true, sameSite: 'None', priority: 'High',
    sourceScheme: 'Secure', sourcePort: 443, expires: 1893456000 });
  assert.deepEqual(params[1], { name: 'c1', value: 'cart-secret-value', domain: 'shop.example', path: '/basket', secure: false, httpOnly: false, priority: 'Medium',
    sourceScheme: 'NonSecure', sourcePort: 80 });
  assert.deepEqual(params[2].partitionKey, { topLevelSite: 'https://top.example', hasCrossSiteAncestor: false });
  assert.equal(params[2].expires, 1893456000);
  assert.ok(params.every(param => !Object.hasOwn(param, 'size') && !Object.hasOwn(param, 'session')));
  assert.ok(params.filter((_, i) => i % 3 === 1).every(param => !Object.hasOwn(param, 'expires')), 'session cookies carry no expires');
});

test('closeBrowser treats a disconnect before the reply as success', async t => {
  const b = await browser(t, { reply: (command, socket) => { if (command.method === 'Browser.close') socket.terminate(); } });
  await closeBrowser(b.cdpUrl, b.d);
  assert.deepEqual(b.commands.map(command => command.method), ['Browser.close']);
  assert.equal(Object.hasOwn(b.commands[0], 'sessionId'), false);
  // A browser that answers with an error did not close.
  const refused = await browser(t, { reply: () => ({ error: { message: 'Not allowed' } }) });
  await assert.rejects(closeBrowser(refused.cdpUrl, refused.d), { message: 'Browser command failed' });
});

test('flushCookies waits for the browser to go away and come back, or gives up after 60 seconds', async t => {
  const b = await browser(t, { reply: (command, socket) => socket.terminate() });
  const answer = b.d.fetch, seen = [];
  // The first answer is closeBrowser's endpoint check; the polls then see the browser up, gone, and back.
  const sequence = ['ok', 'ok', 'fail', 'ok'];
  b.d.fetch = async (url, options) => {
    const state = sequence[seen.length] ?? 'unexpected';
    seen.push(state);
    if (state === 'fail') throw new TypeError('fetch failed');
    return answer(url, options);
  };
  await flushCookies(b.cdpUrl, b.d);
  assert.deepEqual(seen, sequence);
  assert.deepEqual(b.commands.map(command => command.method), ['Browser.close']);

  const never = await browser(t, { reply: (command, socket) => socket.terminate() });
  let fetches = 0, sleeps = 0;
  const up = never.d.fetch;
  never.d.fetch = async (url, options) => { fetches++; return up(url, options); };
  never.d.sleep = async ms => { assert.equal(ms, 250); sleeps++; };
  await assert.rejects(flushCookies(never.cdpUrl, never.d), { message: 'The browser did not come back within 60 seconds after saving cookies.' });
  assert.equal(fetches, 1 + 240, 'one endpoint check, then ceil(60000 / 250) polls');
  assert.ok(sleeps >= 239 && sleeps <= 240, String(sleeps));
});

test('cookie calls refuse a browser endpoint that is not this loopback browser', async t => {
  for (const endpoint of [port => `ws://127.0.0.1:${port + 1}/devtools/browser/abc`, port => `ws://192.0.2.7:${port}/devtools/browser/abc`, port => `ws://127.0.0.1:${port}/devtools/page/abc`]) {
    const b = await browser(t, { version: port => ({ Browser: 'Chrome/149', webSocketDebuggerUrl: endpoint(port) }) });
    const dir = await folder(t);
    await assert.rejects(exportCookies(b.cdpUrl, dir, b.d), { message: 'Invalid Chromium browser endpoint' }, endpoint(b.port));
    assert.deepEqual(b.connections, []);
    assert.deepEqual(b.commands, []);
    assert.deepEqual(await fs.readdir(dir), []);
  }
});
