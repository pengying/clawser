import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { skip, startX } from './xvfb.mjs';

const execute = promisify(execFile);
const proof = new URL('../xproof.py', import.meta.url).pathname;
const fixture = new URL('./input_fixture.py', import.meta.url).pathname;
const clipboard = new URL('../clipboard.py', import.meta.url).pathname;
const python = (() => { try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return false; } catch { return 'needs python3'; } })();

test('xproof reports a missing X library without crashing at import', { skip: python }, async () => {
  // A loader that can't find libXRes stands in for a host without it. Importing xproof must load nothing.
  const script = [
    'import ctypes,json,sys',
    'def fake(name,*a,**k):',
    "    if name=='libXRes.so.1':raise OSError(name+': cannot open shared object file')",
    '    return object()',
    'ctypes.CDLL=fake',
    'sys.path.insert(0,sys.argv[1])',
    'import xproof',
    "print(json.dumps({'displayOk':xproof.display_ok()}))",
    "sys.exit(xproof.main(['xproof','clients']))",
  ].join('\n');
  const failed = await execute('python3', ['-B', '-c', script, dirname(proof)], { env: { PATH: process.env.PATH } }).then(() => assert.fail('xproof exited 0'), error => error);
  assert.equal(failed.code, 1, failed.stderr);
  assert.equal(failed.stderr, 'missing X library libXRes.so.1\n');
  assert.deepEqual(JSON.parse(failed.stdout), { displayOk: false });
});

test('an authorized client sees X clients with PIDs', { skip }, async () => {
  const x = await startX();
  try {
    const list = await x.json('clients');
    assert.ok(Array.isArray(list));
    for (const c of list) assert.ok(Number.isInteger(c.pid) && c.pid > 0);
  } finally { await x.stop(); }
});

test('a client without the cookie is refused', { skip }, async () => {
  const x = await startX();
  try {
    await fs.writeFile(join(x.dir, 'empty'), '');
    await assert.rejects(execute('python3', [proof, 'clients'], { env: { ...x.env, XAUTHORITY: join(x.dir, 'empty') } }), e => e.code !== 0 && /display unavailable/.test(e.stderr));
  } finally { await x.stop(); }
});

test('settle releases a key and button held outside any actor', { skip }, async () => {
  const x = await startX();
  try {
    const holder = spawn('python3', [fixture, 'hold', 'stay'], { env: x.env, stdio: ['pipe', 'pipe', 'inherit'] });
    await new Promise(r => holder.stdout.once('data', r));
    assert.deepEqual(await x.json('held'), { held: true });
    assert.equal((await x.json('settle', '999999')).heldInputCleared, true);
    assert.deepEqual(await x.json('held'), { held: false });
    assert.deepEqual(JSON.parse((await x.run(fixture, 'query')).stdout), { shift: false, button1: false });
    holder.stdin.end();
  } finally { await x.stop(); }
});

test('absent waits for the listed client to disconnect', { skip }, async () => {
  const x = await startX();
  try {
    const client = spawn('python3', ['-c', `
import ctypes as c,os,time
x=c.CDLL('libX11.so.6');x.XOpenDisplay.argtypes=[c.c_char_p];x.XOpenDisplay.restype=c.c_void_p
x.XCloseDisplay.argtypes=[c.c_void_p]
d=x.XOpenDisplay(('unix/'+os.environ['DISPLAY']).encode())
print('up',flush=True);time.sleep(.3);x.XCloseDisplay(d)
`], { env: x.env, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise(r => client.stdout.once('data', r));
    assert.deepEqual(await x.json('absent', String(client.pid)), { xClientsAbsent: true, heldInputCleared: false, xSyncComplete: true });
    assert.ok(!(await x.json('clients')).some(c => c.pid === client.pid));
  } finally { await x.stop(); }
});

test('selection-owner names the clipboard owner\'s PID', { skip }, async () => {
  const x = await startX();
  const owner = spawn('python3', [clipboard, 'own'], { env: x.env, stdio: ['pipe', 'ignore', 'ignore'] });
  try {
    owner.stdin.end('x');
    let got;
    for (let i = 0; i < 50 && !(got = (await x.json('selection-owner')).pid); i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(got, owner.pid);
  } finally { owner.kill(); await x.stop(); }
});
