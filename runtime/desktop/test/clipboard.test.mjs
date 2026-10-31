import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { skip, startX } from './xvfb.mjs';

const clipboard = new URL('../clipboard.py', import.meta.url).pathname;
const text = 'Clipboard proof — 中文 🙂\nsecond line';

function run(x, op, input = '') {
  const child = spawn('python3', [clipboard, op], { env: x.env });
  const out = [], err = [];
  child.stdout.on('data', d => out.push(d));
  child.stderr.on('data', d => err.push(d));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
  });
}

async function own(x, value) {
  const child = spawn('python3', [clipboard, 'own'], { env: x.env, stdio: ['pipe', 'ignore', 'inherit'] });
  const exited = new Promise(r => child.once('exit', r));
  child.stdin.end(value);
  for (let i = 0; i < 50; i++) {
    if ((await run(x, 'read')).stdout.equals(Buffer.from(value))) return { child, exited };
    await sleep(100);
  }
  child.kill();
  throw new Error(`helper never served ${JSON.stringify(value)}`);
}

test('text owned by the helper reads back exactly', { skip }, async () => {
  const x = await startX();
  let owner;
  try {
    owner = await own(x, text);
    const got = await run(x, 'read');
    assert.equal(got.code, 0);
    assert.deepEqual(got.stdout, Buffer.from(text));
  } finally { owner?.child.kill(); await x.stop(); }
});

test('the helper is the provable selection owner', { skip }, async () => {
  const x = await startX();
  let owner;
  try {
    owner = await own(x, 'x');
    assert.equal((await x.json('selection-owner')).pid, owner.child.pid);
  } finally { owner?.child.kill(); await x.stop(); }
});

test('a newer owner replaces the old one and the old helper exits', { skip }, async () => {
  const x = await startX();
  const owners = [];
  try {
    owners.push(await own(x, 'first'));
    owners.push(await own(x, 'second'));
    assert.equal(await Promise.race([owners[0].exited, sleep(1000, 'still running')]), 0);
    assert.deepEqual((await run(x, 'read')).stdout, Buffer.from('second'));
  } finally { for (const o of owners) o.child.kill(); await x.stop(); }
});

test('read fails cleanly with no owner', { skip }, async () => {
  const x = await startX();
  try {
    const got = await run(x, 'read');
    assert.equal(got.code, 1);
    assert.equal(got.stderr.trim(), 'clipboard unavailable');
    assert.equal(got.stdout.length, 0);
  } finally { await x.stop(); }
});

test('oversized text is refused', { skip }, async () => {
  const x = await startX();
  try {
    const got = await run(x, 'own', 'a'.repeat(20 * 1024 * 1024));
    assert.equal(got.code, 1);
    assert.equal(got.stderr.trim(), 'clipboard text too large');
    assert.equal((await x.json('selection-owner')).pid, 0);
  } finally { await x.stop(); }
});
