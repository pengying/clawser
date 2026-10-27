import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { desktopControlClient } from '../index.mjs';

test('cold supervisor socket is a not-ready status but never a successful mutation', async t => {
  const directory=await mkdtemp(join(tmpdir(),'desktop-cold-start-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const code=desktopControlClient.replace('/tmp/desktop/control.sock',join(directory,'absent.sock'));
  const run=op=>new Promise(resolve=>{const p=spawn('python3',['-c',code],{stdio:['pipe','pipe','pipe']});let out='';p.stdout.on('data',b=>out+=b);p.stderr.resume();p.on('close',exit=>resolve({exit,out}));p.stdin.end(JSON.stringify({op}));});
  const status=await run('status');assert.equal(status.exit,0);assert.deepEqual(JSON.parse(status.out),{ready:false,phase:'starting'});
  const write=await run('clipboardWrite');assert.notEqual(write.exit,0);assert.equal(write.out,'');
});
