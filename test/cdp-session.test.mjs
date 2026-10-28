import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { CdpConnection } from '../src/cdp.mjs';

async function fixture(t) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(() => { for (const client of server.clients) client.terminate(); server.close(); });
  const connected = once(server, 'connection');
  const cdp = await new CdpConnection({ commandTimeoutMs: 300 }).connect(`ws://127.0.0.1:${server.address().port}`);
  const [peer] = await connected;
  return { cdp, peer };
}

test('flattened commands and replies correlate both request ID and expected session', async t => {
  const { cdp, peer } = await fixture(t);
  const received = once(peer, 'message');
  let resolved = false;
  const pending = cdp.send('Page.getFrameTree', {}, 'owned-child').then(value => { resolved = true; return value; });
  const [raw] = await received;
  const command = JSON.parse(String(raw));
  assert.equal(command.sessionId, 'owned-child');
  for (const sessionId of [undefined, 'unrelated-child']) peer.send(JSON.stringify({ id: command.id, sessionId, result: { wrong: true } }));
  peer.send(JSON.stringify({ id: command.id + 100, sessionId: 'owned-child', result: { wrong: true } }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(resolved, false, 'wrong-session replies cannot resolve a matching ID');
  peer.send(JSON.stringify({ id: command.id, sessionId: 'owned-child', result: { frameTree: { frame: { id: 'child' } } } }));
  assert.equal((await pending).frameTree.frame.id, 'child');
});

test('root and child event handlers run only for their owned session', async t => {
  const { cdp, peer } = await fixture(t);
  const root = [], child = [], all = [];
  cdp.on('Page.frameNavigated', event => root.push(event.frame.id));
  cdp.on('Page.frameNavigated', event => child.push(event.frame.id), 'owned-child');
  cdp.onAny('Page.frameNavigated', (event, sessionId) => all.push([event.frame.id, sessionId]));
  for (const [frame, sessionId] of [['root', undefined], ['child', 'owned-child'], ['other', 'unrelated-child']])
    peer.send(JSON.stringify({ method: 'Page.frameNavigated', sessionId, params: { frame: { id: frame } } }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(root, ['root']);
  assert.deepEqual(child, ['child']);
  assert.deepEqual(all, [['root', undefined], ['child', 'owned-child'], ['other', 'unrelated-child']]);
});
