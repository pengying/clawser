import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DisplayStream } from '../src/display-stream.mjs';

function fixture(t) {
  let time = 0, canSend = true;
  const sent = [], stream = new DisplayStream({ connectionId: 'private-connection', send: packet => { sent.push(packet); return true; }, canSend: () => canSend, lastInputId: () => 4, now: () => time });
  t.after(() => stream.close());
  const ack = (extra = {}) => stream.ack({ connectionId: 'private-connection', displayId: sent.at(-1).displayId, ...extra });
  return { stream, sent, ack, time: value => { time = value; }, allow: value => { canSend = value; } };
}

test('unchanged metadata keeps a bounded freshness heartbeat', t => {
  const f = fixture(t), metadata = timestamp => ({ title: 'private title', interactions: { document: 'doc', regions: [], focus: null, timestamp } });
  f.stream.metadata(metadata(0)); f.ack();
  for (const time of [250, 500, 750, 999]) { f.time(time); f.stream.metadata(metadata(time)); }
  assert.equal(f.sent.length, 1, 'timestamp-only polls do not send redundant maps');
  f.time(1000); f.stream.metadata(metadata(1000));
  assert.equal(f.sent.length, 2, 'idle field metadata refreshes before the viewer freshness limit');
  f.ack(); f.time(1001); f.stream.metadata({ interactions: { document: 'new-doc', regions: [], focus: null, timestamp: 1001 } });
  assert.equal(f.sent.length, 3, 'document changes are sent immediately');
});

test('input processing can defer and then resume the latest display update', t => {
  const f = fixture(t); f.allow(false);
  f.stream.frame({ type: 'frame', data: 'old' }); f.stream.frame({ type: 'frame', data: 'new' });
  f.stream.metadata({ title: 'title' });
  assert.equal(f.sent.length, 0);
  f.allow(true); f.stream.flush();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].data, 'new'); assert.equal(f.sent[0].metadata.title, 'title');
  assert.equal(f.stream.snapshot().replacedFrames, 1);
});

test('timing reports are bounded, deduplicated and contain no page or input data', t => {
  const f = fixture(t);
  f.stream.metadata({ title: 'private title' }); f.time(20);
  f.ack({ inputTiming: { id: 1, queueMs: 4, roundTripMs: 16 }, visibility: 'visible' });
  f.time(1000); f.stream.metadata({ title: 'private title' });
  f.ack({ inputTiming: { id: 1, queueMs: 999, roundTripMs: 999 } });
  f.time(2000); f.stream.metadata({ title: 'private title' });
  f.ack({ inputTiming: { id: 9, queueMs: 999, roundTripMs: 999 }, visibility: 'private text' });
  f.time(3000); f.stream.metadata({ title: 'private title' });
  f.ack({ inputTiming: { id: 2, queueMs: -1, roundTripMs: 99999999 } });
  for (let n = 0; n < 100; n++) f.stream.record('serverInputWorkMs', n);
  const result = f.stream.snapshot();
  assert.equal(result.clientInputQueueMs.count, 1); assert.equal(result.clientInputQueueMs.latest, 4);
  assert.equal(result.inputAckRoundTripMs.latest, 16); assert.equal(result.visibility, 'visible');
  assert.equal(result.serverInputWorkMs.count, 100); assert.equal(f.stream.metrics.serverInputWorkMs.samples.length, 32);
  assert.doesNotMatch(JSON.stringify(result), /private|title|connectionId|focusToken|text/);
});

test('closing an outstanding display clears pending pixels and ignores later ACKs', t => {
  const f = fixture(t);
  f.stream.frame({ type: 'frame', data: 'first' }); f.stream.frame({ type: 'frame', data: 'last' });
  f.stream.metadata({ title: 'private' }); f.stream.close();
  assert.equal(f.ack(), false); f.stream.frame({ type: 'frame', data: 'after-close' }); f.stream.metadata({ title: 'after-close' });
  assert.equal(f.sent.length, 1); assert.equal(f.stream.latestFrame, null); assert.equal(f.stream.latestMetadata, null);
  assert.deepEqual(f.stream.currentMetadata, {}); assert.equal(f.stream.timer, null);
});
