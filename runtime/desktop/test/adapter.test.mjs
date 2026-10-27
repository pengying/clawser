import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DesktopRuntime } from '../index.mjs';

function inspection(owner='owner',id='owned',name='openclaw-handoff-desktop') {
  const ports={'9223/tcp':[{HostIp:'127.0.0.1',HostPort:'18810'}],'5900/tcp':[{HostIp:'127.0.0.1',HostPort:'59090'}]};
  return {Id:id,Name:`/${name}`,Config:{Labels:{'openclaw.browser-handoff.desktop':owner}},State:{Running:true},HostConfig:{NetworkMode:`${name}-net`,PortBindings:ports},NetworkSettings:{Ports:ports,Networks:{[`${name}-net`]:{NetworkID:'network-id'}}},Mounts:[{Type:'volume',Name:`${name}-profile`,Destination:'/profile',RW:true}]};
}
async function receipt(stateDir,owner='owner',id='owned',name='openclaw-handoff-desktop') {
  await writeFile(`${stateDir}/ownership.json`,JSON.stringify({name,ownerId:owner,containerId:id,network:`${name}-net`,volume:`${name}-profile`,networkId:'network-id',cdpPort:18810,vncPort:59090}));
}

test('adapter refuses unsafe names, non-loopback endpoints and invalid ports', () => {
  assert.throws(() => new DesktopRuntime({ name: 'other/container' }), /name/);
  assert.throws(() => new DesktopRuntime({ cdpPort: 0 }), /port/i);
  assert.throws(() => new DesktopRuntime({ bindHost: '0.0.0.0' }), /loopback/i);
});

test('clipboard text is sent in stdin only and ownership is verified', async () => {
  const stateDir = await mkdtemp(`${tmpdir()}/desktop-contract-`);
  await receipt(stateDir,'test-receipt','owned-id');
  const calls = [];
  const run = async (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'inspect') return JSON.stringify([inspection('test-receipt','owned-id')]);
    return JSON.stringify({ ok: true, bytes: 18 });
  };
  try {
    const runtime = new DesktopRuntime({stateDir, run, ownerId: 'test-receipt'});
    await runtime.clipboardWrite('秘密🙂\n$(whoami)');
    assert.equal(calls.length, 2);
    assert.ok(calls[1].input.includes('秘密🙂'));
    assert.ok(!calls[1].args.join(' ').includes('秘密'));
    assert.equal(calls[1].args[0], 'exec');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('adapter refuses unowned Docker resources', async () => {
  const stateDir = await mkdtemp(`${tmpdir()}/desktop-contract-`);
  await receipt(stateDir,'expected');
  const runtime = new DesktopRuntime({stateDir, ownerId:'expected', run: async () => JSON.stringify([{Id:'foreign',Config:{Labels:{}},State:{Running:true}}])});
  try { await assert.rejects(runtime.clipboardRead(), /ownership/); }
  finally { await rm(stateDir, {recursive:true,force:true}); }
});

test('viewer deadlines are passed to the runtime and clipboard rejects oversized input', async () => {
  const stateDir=await mkdtemp(`${tmpdir()}/desktop-contract-`);
  await receipt(stateDir);
  const calls=[];
  const run=async(args,input)=>{
    calls.push({args,input});
    if(args[0]==='inspect')return JSON.stringify([inspection()]);
    return JSON.stringify({role:'watch'});
  };
  try {
    const runtime=new DesktopRuntime({stateDir,ownerId:'owner',run});
    const expiresAt=Date.now()+60000;
    await runtime.startViewer({leaseId:'deadline-proof',role:'watch',expiresAt});
    assert.equal(JSON.parse(calls[1].input).expiresAt,expiresAt);
    assert.throws(()=>runtime.clipboardWrite('a'.repeat(1048577)),/size/);
  }finally {await rm(stateDir,{recursive:true,force:true});}
});

test('ensure resumes an owned partial startup without replacing profile resources',async()=>{
  const stateDir=await mkdtemp(`${tmpdir()}/desktop-contract-`);
  const calls=[];
  await writeFile(`${stateDir}/ownership.json`,JSON.stringify({name:'resume-test',ownerId:'resume-owner'}));
  const runtime=new DesktopRuntime({name:'resume-test',stateDir,run:async(args)=>{
    calls.push(args);
    if(args[0]==='inspect')throw new Error('Docker operation failed (1): Error: No such object: resume-test');
    if(args[1]==='inspect')return JSON.stringify([{Labels:{'openclaw.browser-handoff.desktop':'resume-owner'}}]);
    if(args[0]==='create')return 'new-container';
    return '';
  }});
  try {
    assert.equal((await runtime.ensure()).persistent,true);
    assert.equal(calls.filter(c=>c[1]==='create').length,0);
    assert.equal(calls.filter(c=>c[0]==='create').length,1);
  } finally {await rm(stateDir,{recursive:true,force:true});}
});

test('ensure creates absent resources using Docker network not-found responses',async()=>{
  const stateDir=await mkdtemp(`${tmpdir()}/desktop-contract-`);
  const calls=[];
  const runtime=new DesktopRuntime({name:'fresh-test',stateDir,run:async(args)=>{
    calls.push(args);
    if(args[1]==='inspect')throw new Error(args[0]==='network'?'Error response from daemon: network fresh-test-net not found':'get fresh-test-profile: no such volume');
    return args[0]==='create'?'new-container':'';
  }});
  try {await runtime.ensure();assert.equal(calls.filter(c=>c[1]==='create').length,2);}
  finally {await rm(stateDir,{recursive:true,force:true});}
});

test('new containers require the reviewed browser seccomp profile',async()=>{
  const stateDir=await mkdtemp(`${tmpdir()}/desktop-contract-`);
  let create;
  const runtime=new DesktopRuntime({stateDir,run:async(args)=>{
    if(args[1]==='inspect')throw new Error('No such object');
    if(args[0]==='create')create=args;
    return args[0]==='create'?'container-id':'';
  }});
  try {await runtime.ensure();assert.ok(create.some(a=>a.startsWith('seccomp=')&&a.endsWith('/chromium-seccomp.json')));assert.ok(Number(create[create.indexOf('--pids-limit')+1])>=1024);}
  finally {await rm(stateDir,{recursive:true,force:true});}
});

test('shutdown grants Chromium bounded graceful exit before removing its container',async()=>{
  const stateDir=await mkdtemp(`${tmpdir()}/desktop-contract-`),calls=[];
  await receipt(stateDir);
  const runtime=new DesktopRuntime({stateDir,ownerId:'owner',run:async(args)=>{
    calls.push(args);
    if(args[0]==='inspect')return JSON.stringify([inspection()]);
    if(args[1]==='inspect')return JSON.stringify([{Labels:{'openclaw.browser-handoff.desktop':'owner'}}]);
    return '';
  }});
  try {await runtime.shutdown();assert.ok(calls.findIndex(c=>c[0]==='stop')>=0);assert.ok(calls.findIndex(c=>c[0]==='stop')<calls.findIndex(c=>c[0]==='rm'));}
  finally {await rm(stateDir,{recursive:true,force:true});}
});

test('ensure refuses a profile mounted by another running container',async()=>{
  const stateDir=await mkdtemp(`${tmpdir()}/desktop-contract-`);
  const runtime=new DesktopRuntime({stateDir,run:async(args)=>{
    if(args[1]==='inspect')throw new Error('No such object');
    if(args[0]==='ps')return 'foreign-container-id';
    return '';
  }});
  try {await assert.rejects(runtime.ensure(),/profile.*use/i);}
  finally {await rm(stateDir,{recursive:true,force:true});}
});

test('operation lock identifies its process and rejects concurrent operations',async()=>{
  const stateDir=await mkdtemp(`${tmpdir()}/desktop-contract-`);
  const runtime=new DesktopRuntime({stateDir});
  try {
    await runtime.locked(async()=>{
      const owner=JSON.parse(await readFile(`${stateDir}/operation.lock/owner.json`,'utf8'));
      assert.equal(owner.pid,process.pid);assert.match(owner.processStartTicks,/^\d+$/);
      await assert.rejects(runtime.locked(async()=>{}),/locked/);
    });
  }finally {await rm(stateDir,{recursive:true,force:true});}
});

for(const [name,mutate] of [
  ['container ID',i=>{i.Id='replaced';}],
  ['published CDP port',i=>{i.HostConfig.PortBindings['9223/tcp'][0].HostPort='18800';}],
  ['published VNC port',i=>{i.HostConfig.PortBindings['5900/tcp'][0].HostPort='59080';}],
  ['public bind address',i=>{i.HostConfig.PortBindings['9223/tcp'][0].HostIp='0.0.0.0';}],
  ['network ID',i=>{i.NetworkSettings.Networks['openclaw-handoff-desktop-net'].NetworkID='replaced-network';}],
  ['profile volume',i=>{i.Mounts[0].Name='some-other-profile';}],
  ['extra published port',i=>{i.NetworkSettings.Ports['6080/tcp']=[{HostIp:'127.0.0.1',HostPort:'16080'}];}],
]) test(`ownership check rejects drift in ${name}`,async()=>{
  const stateDir=await mkdtemp(`${tmpdir()}/desktop-contract-`);await receipt(stateDir);
  const item=inspection();mutate(item);
  const runtime=new DesktopRuntime({stateDir,run:async()=>JSON.stringify([item])});
  try {await assert.rejects(runtime.status(),/identity|binding|network|profile|ownership/);}
  finally {await rm(stateDir,{recursive:true,force:true});}
});

test('unpublished inherited image ports do not change endpoint identity',async()=>{
  const stateDir=await mkdtemp(`${tmpdir()}/desktop-contract-`);await receipt(stateDir);
  const item=inspection();item.NetworkSettings.Ports={...item.NetworkSettings.Ports,'6080/tcp':null};
  const runtime=new DesktopRuntime({stateDir,run:async args=>args[0]==='inspect'?JSON.stringify([item]):JSON.stringify({ready:true})});
  try {assert.equal((await runtime.status()).ready,true);}
  finally {await rm(stateDir,{recursive:true,force:true});}
});

test('configuration drift is rejected before connecting to any CDP endpoint',async()=>{
  const stateDir=await mkdtemp(`${tmpdir()}/desktop-contract-`);await receipt(stateDir);
  const runtime=new DesktopRuntime({stateDir,cdpPort:18800,run:async()=>JSON.stringify([inspection()])});
  try {await assert.rejects(runtime.tabs(),/binding|configuration|port/);}
  finally {await rm(stateDir,{recursive:true,force:true});}
});

test('heartbeat requires exact actor context and can run while an ordinary operation owns the host lock',async()=>{
  const stateDir=await mkdtemp(`${tmpdir()}/desktop-contract-`);await receipt(stateDir);
  const calls=[];
  const runtime=new DesktopRuntime({stateDir,run:async(args,input)=>{
    calls.push({args,input});
    if(args[0]==='inspect')return JSON.stringify([inspection()]);
    const request=JSON.parse(input);return JSON.stringify({ok:true,leaseId:request.leaseId,epoch:request.epoch,heartbeatDeadline:Date.now()+30000});
  }});
  try {
    await runtime.locked(async()=>{
      const ack=await runtime.heartbeatViewer({leaseId:'active-lease',epoch:4});
      assert.equal(ack.ok,true);assert.equal(ack.leaseId,'active-lease');assert.equal(ack.epoch,4);
    });
    assert.deepEqual(JSON.parse(calls[1].input),{op:'heartbeatViewer',leaseId:'active-lease',epoch:4});
    assert.throws(()=>runtime.heartbeatViewer({leaseId:'active-lease'}),/epoch/);
  }finally {await rm(stateDir,{recursive:true,force:true});}
});

test('trusted watchdog test timeout is bounded and production defaults to thirty seconds',()=>{
  assert.equal(new DesktopRuntime().heartbeatTimeoutMs,30000);
  for(const value of [0,999,30001,NaN,'1000'])assert.throws(()=>new DesktopRuntime({testHeartbeatTimeoutMs:value}),/heartbeat/);
  assert.equal(new DesktopRuntime({testHeartbeatTimeoutMs:1000}).heartbeatTimeoutMs,1000);
});
