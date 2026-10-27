import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopRpcClient, DesktopRpcServer } from '../src/desktop-rpc.mjs';

test('private RPC correlates concurrent requests and protects the socket', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-rpc-'));
  const path = join(dir, 'desktop.sock');
  const server = new DesktopRpcServer({socketPath:path, handler:async(method, params) => {
    if(method === 'fail') throw new Error('refused');
    await new Promise(resolve => setTimeout(resolve, params.delay || 0));
    return {value:params.value};
  }});
  await server.start(); const client = new DesktopRpcClient(path);
  t.after(async()=>{client.close();await server.close();await rm(dir,{recursive:true,force:true});});
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await Promise.all([client.request('echo',{value:1,delay:20}),client.request('echo',{value:2})]),[{value:1},{value:2}]);
  await assert.rejects(client.request('fail',{}),/refused/);
});

test('disconnect rejects pending admissions without reporting success', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-rpc-')), path=join(dir,'desktop.sock');
  const server = new DesktopRpcServer({socketPath:path,handler:()=>new Promise(()=>{})});
  await server.start(); const client = new DesktopRpcClient(path);
  t.after(async()=>{client.close();await server.close();await rm(dir,{recursive:true,force:true});});
  const request=assert.rejects(client.request('automationEnter',{callKey:'uncertain'}),/disconnect|closed/i);
  await new Promise(resolve=>setTimeout(resolve,20)); await server.close();
  await request;
});

test('malformed and oversized RPC messages are disconnected before dispatch',async t=>{
  const net=await import('node:net');
  const dir=await mkdtemp(join(tmpdir(),'desktop-rpc-')),path=join(dir,'desktop.sock');let calls=0;
  const server=new DesktopRpcServer({socketPath:path,handler:()=>{calls++;return{};}});await server.start();
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  for(const message of ['not json\n','x'.repeat(1024*1024+1)]){
    const socket=net.createConnection(path);socket.on('error',()=>{});
    await new Promise(resolve=>socket.once('connect',resolve));
    const closed=new Promise(resolve=>socket.once('close',resolve));socket.write(message);await closed;
  }
  assert.equal(calls,0);
});

test('RPC server close waits until admitted-call disconnect recovery is durable',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'desktop-rpc-')),path=join(dir,'desktop.sock');let recovered=false;
  const server=new DesktopRpcServer({socketPath:path,handler:async()=>({admitted:true}),onDisconnect:async keys=>{if(keys.includes('call')){await new Promise(resolve=>setTimeout(resolve,20));recovered=true;}}});
  await server.start();const client=new DesktopRpcClient(path);t.after(async()=>{client.close();await server.close();await rm(dir,{recursive:true,force:true});});
  await client.request('automationEnter',{callKey:'call'});await server.close();assert.equal(recovered,true);
});

test('kernel singleton survives a missing socket and concurrent stale-socket starts',async t=>{
  const {spawn}=await import('node:child_process');const {once}=await import('node:events');const {unlink}=await import('node:fs/promises');
  const dir=await mkdtemp(join(tmpdir(),'desktop-rpc-')),path=join(dir,'desktop.sock');
  const stale=spawn(process.execPath,['--input-type=module','-e',"import net from 'node:net';net.createServer().listen(process.argv[1],()=>process.exit(0));",path],{stdio:'ignore'});
  await once(stale,'exit');assert.equal((await stat(path)).isSocket(),true);
  const servers=Array.from({length:6},()=>new DesktopRpcServer({socketPath:path,handler:async()=>({ready:true})}));
  t.after(async()=>{await Promise.all(servers.map(server=>server.close()));await rm(dir,{recursive:true,force:true});});
  const results=await Promise.allSettled(servers.map(server=>server.start()));assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const winner=servers[results.findIndex(result=>result.status==='fulfilled')];
  assert.equal((await stat(path+'.lock')).mode&0o777,0o600);
  // A stale-socket cleanup racing the winner must not allow another gate.
  await unlink(path);
  const restart=new DesktopRpcServer({socketPath:path,handler:async()=>({ready:true})});servers.push(restart);
  await assert.rejects(restart.start(),/already running|lock/i);
  await winner.close();await restart.start();
  const client=new DesktopRpcClient(path);assert.deepEqual(await client.request('health'),{ready:true});client.close();
});

test('singleton remains locked until disconnect recovery has finished',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'desktop-rpc-')),path=join(dir,'desktop.sock');
  let entered,release;const recovering=new Promise(resolve=>{entered=resolve;}),settled=new Promise(resolve=>{release=resolve;});
  const owner=new DesktopRpcServer({socketPath:path,handler:async()=>({admitted:true}),onDisconnect:async()=>{entered();await settled;}});
  const contender=new DesktopRpcServer({socketPath:path,handler:async()=>({ready:true})});await owner.start();const client=new DesktopRpcClient(path);
  t.after(async()=>{release();client.close();await owner.close();await contender.close();await rm(dir,{recursive:true,force:true});});
  await client.request('automationEnter',{callKey:'call'});const closing=owner.close();await recovering;
  await assert.rejects(contender.start(),/already running|lock/i);release();await closing;await contender.start();
});

test('parent process death releases the kernel singleton through pipe EOF',async t=>{
  const {spawn}=await import('node:child_process');const {once}=await import('node:events');
  const dir=await mkdtemp(join(tmpdir(),'desktop-rpc-')),path=join(dir,'desktop.sock');
  const moduleUrl=new URL('../src/desktop-rpc.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {DesktopRpcServer} from ${JSON.stringify(moduleUrl)};const server=new DesktopRpcServer({socketPath:process.argv[1],handler:async()=>({})});await server.start();process.stdout.write('ready\\n');`,path],{stdio:['ignore','pipe','pipe']});
  const ready=await new Promise((resolve,reject)=>{child.stdout.once('data',chunk=>resolve(String(chunk)));child.once('error',reject);child.once('exit',()=>reject(new Error('fixture exited before lock')));});assert.equal(ready,'ready\n');
  const server=new DesktopRpcServer({socketPath:path,handler:async()=>({})});
  t.after(async()=>{child.kill('SIGKILL');await server.close();await rm(dir,{recursive:true,force:true});});
  await assert.rejects(server.start(),/already running|lock/i);const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  const deadline=Date.now()+2000;
  while(true){try{await server.start();break;}catch(error){if(Date.now()>deadline)throw error;await new Promise(resolve=>setTimeout(resolve,10));}}
});
