import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freeDisplay, xauthorityEntry } from '../src/host-display.mjs';

test('the X cookie file is one FamilyWild MIT-MAGIC-COOKIE-1 entry for the display', () => {
  const entry = xauthorityEntry(20, Buffer.alloc(16, 7));
  let at = 0;
  const u16 = () => { const v = entry.readUInt16BE(at); at += 2; return v; };
  const str = () => { const n = u16(); const s = entry.subarray(at, at + n); at += n; return s; };
  assert.equal(u16(), 0xffff);
  assert.equal(str().length, 0);
  assert.equal(str().toString(), '20');
  assert.equal(str().toString(), 'MIT-MAGIC-COOKIE-1');
  assert.deepEqual(str(), Buffer.alloc(16, 7));
  assert.equal(at, entry.length);
  assert.equal(entry.length, 2 + 2 + 0 + 2 + 2 + 2 + 18 + 2 + 16);
});

test('freeDisplay skips displays with a socket or a lock file', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'clawser-display-'));
  const socketDir = join(root, 'sockets'), lockDir = join(root, 'locks');
  await fs.mkdir(socketDir); await fs.mkdir(lockDir);
  await fs.writeFile(join(socketDir, 'X20'), '');
  await fs.writeFile(join(lockDir, '.X21-lock'), '');
  try {
    assert.equal(await freeDisplay(undefined, { socketDir, lockDir }), 22);
    await assert.rejects(freeDisplay(undefined, { to: 21, socketDir, lockDir }), /no free X display/i);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
