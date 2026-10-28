import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopController, observeDesktop, activateDesktopTarget } from '../src/desktop-controller.mjs';

async function setup(t, options={}) {
  const stateDir=await mkdtemp(join(tmpdir(),'desktop-controller-'));
  const events=[];let epoch=0;
  const runtime={cdpUrl:'http://127.0.0.1:18810',ensure:async()=>({cdpUrl:'http://127.0.0.1:18810'}),status:async()=>({ready:true,displayGeneration:'g1',browserGeneration:'g1',browserSandbox:true,authenticatedInternetReady:true}),tabs:async()=>[{id:'tab',type:'page'}],heartbeatViewer:async({leaseId,epoch})=>({ok:true,leaseId,epoch}),startViewer:async({leaseId})=>{events.push('watch');return{leaseId,host:'127.0.0.1',port:59090,password:'watchpass',displayGeneration:'g1',browserGeneration:'g1',role:'watch',epoch:++epoch};},promoteViewer:async({leaseId})=>{events.push('control');return{leaseId,host:'127.0.0.1',port:59090,password:'ctrlpass',displayGeneration:'g1',browserGeneration:'g1',role:'control',epoch:++epoch};},stopViewerAndSettle:async({leaseId,mayBeWritable})=>{events.push('fence');return{readOnly:mayBeWritable===false,inputResetRequired:mayBeWritable!==false,leaseId,displayGeneration:'g1',browserGeneration:'g1',epoch:++epoch,vncProcessesExited:true,xClientsAbsent:true,heldInputCleared:mayBeWritable!==false,xSyncComplete:true};}};
  Object.assign(runtime,options.runtime);
  const controller=new DesktopController({stateDir,profile:'human',runtime,transport:{ensure:async()=>'https://example.test',close:async()=>{}},port:0,activateTarget:async()=>{},observe:async()=>{events.push('observe');return{snapshotObserved:true,displayGeneration:'g1',browserGeneration:'g1'};},...options.controller});
  await controller.start();
  t.after(async()=>{await controller.close();await rm(stateDir,{recursive:true,force:true});});
  return{controller,stateDir,events,runtime};
}
const owner=JSON.stringify(['agent:main:main','session']);

test('tab discovery exposes task identifiers without private debugging sockets or browser infrastructure targets',async t=>{
  const{controller:c}=await setup(t,{runtime:{tabs:async()=>[
    {id:'task',type:'page',title:'Task',url:'https://example.test/',webSocketDebuggerUrl:'ws://127.0.0.1:18810/devtools/page/task'},
    {id:'hidden',type:'page',title:'Omnibox',url:'chrome://omnibox-popup.top-chrome/'},
  ]}});
  assert.deepEqual(await c.request('tabs',{profile:'human'}),{profile:'human',tabs:[{id:'task',targetId:'task',title:'Task',url:'https://example.test/'}]});
});

test('promotion drains automation and fenced completion preserves the browser',async t=>{
  const{controller:c,stateDir,events}=await setup(t);
  await c.request('automationEnter',{callKey:'call'});
  const created=await c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30});
  const promoting=c.supervisor.promote({ownedId:created.id,probeId:created.id});
  await new Promise(resolve=>setTimeout(resolve,10)); assert.deepEqual(events,['watch']);
  await c.request('automationLeave',{callKey:'call'}); await promoting;
  await assert.rejects(c.request('automationEnter',{callKey:'blocked'}),/human control/i);
  const status=await c.request('revoke',{owner,id:created.id});
  assert.equal(status.resumeAllowed,true); assert.deepEqual(events,['watch','control','fence','observe']);
  await c.request('automationEnter',{callKey:'next'}); await c.request('automationLeave',{callKey:'next'});
  const ledger=await readFile(join(stateDir,'ledger.json'),'utf8');
  assert.equal(ledger.includes('watchpass'),false);assert.equal(ledger.includes('ctrlpass'),false);assert.equal(ledger.includes('https://'),false);
});

test('bad fence poisons automation and keeps durable owner recovery',async t=>{
  const{controller:c,stateDir}=await setup(t,{runtime:{stopViewerAndSettle:async()=>({vncProcessesExited:true})}});
  const created=await c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30});
  await c.supervisor.promote({ownedId:created.id,probeId:created.id});
  const ended=await c.request('revoke',{owner,id:created.id}); assert.equal(ended.recoveryRequired,true);assert.equal(ended.resumeAllowed,false);
  await assert.rejects(c.request('automationEnter',{callKey:'blocked'}),/uncertain|recovery/i);
  assert.match(await readFile(join(stateDir,'ledger.json'),'utf8'),/session/);
});

test('restart retains uncertain automation admission and fences incomplete viewers',async t=>{
  const{controller:c,stateDir,events}=await setup(t);
  await c.close();
  await writeFile(join(stateDir,'ledger.json'),JSON.stringify({version:1,calls:{lost:{state:'active'}},leases:{old:{id:'old',owner,profile:'human',permission:'control',state:'control',displayGeneration:'g1'}}}));
  const restarted=new DesktopController({stateDir,profile:'human',runtime:c.runtime,transport:c.transport,port:0,observe:c.observe});
  await restarted.start(); t.after(()=>restarted.close());
  assert.deepEqual(events,['fence','observe']);
  await assert.rejects(restarted.request('automationEnter',{callKey:'new'}),/uncertain|recovery/i);
  const status=await restarted.request('status',{owner,id:'old'}); assert.equal(status.reason,'controller_restart');assert.equal(status.resumeAllowed,false);
});

test('owner mismatch cannot inspect or revoke a retained lease',async t=>{
  const{controller:c}=await setup(t);
  const lease=await c.request('create',{owner,profile:'human',permission:'watch',ttlSeconds:30});
  const wrong=JSON.stringify(['agent:main:main','other']);
  await assert.rejects(c.request('status',{owner:wrong,id:lease.id}),/another owner/);
  await assert.rejects(c.request('revoke',{owner:wrong,id:lease.id}),/another owner/);
  await assert.rejects(c.supervisor.promote({ownedId:lease.id,probeId:lease.id}),/unavailable/);
});

test('automation admission is durable before RPC succeeds and disconnect is uncertain',async t=>{
  const{controller:c,stateDir}=await setup(t);
  const {DesktopRpcClient}=await import('../src/desktop-rpc.mjs');
  const client=new DesktopRpcClient(c.socketPath);
  assert.deepEqual(await client.request('automationEnter',{callKey:'rpc-call'}),{admitted:true});
  assert.equal(JSON.parse(await readFile(join(stateDir,'ledger.json'),'utf8')).calls['rpc-call'].state,'active');
  client.close();
  for(let count=0;count<100&&!c.gate.poisonReason;count++)await new Promise(resolve=>setTimeout(resolve,5));
  await assert.rejects(c.request('automationEnter',{callKey:'new'}),/recovery|uncertain/i);
  await assert.rejects(c.request('automationLeave',{callKey:'rpc-call'}),/recovery|uncertain/i);
});

test('fresh browser generation mismatch does not release automation',async t=>{
  const{controller:c}=await setup(t,{runtime:{stopViewerAndSettle:async({leaseId})=>({leaseId,displayGeneration:'g1',browserGeneration:'browser-before',vncProcessesExited:true,xClientsAbsent:true,heldInputCleared:true,xSyncComplete:true})},controller:{observe:async()=>({snapshotObserved:true,displayGeneration:'g1',browserGeneration:'browser-after'})}});
  const lease=await c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30});
  const ended=await c.request('revoke',{owner,id:lease.id});
  assert.equal(ended.recoveryRequired,true);assert.equal(ended.resumeAllowed,false);
});

test('duplicate admissions are counted only for the same private connection',async t=>{
  const{controller:c}=await setup(t);const same={connectionId:'one'};
  await c.request('automationEnter',{callKey:'duplicate'},same);
  await c.request('automationEnter',{callKey:'duplicate'},same);
  await assert.rejects(c.request('automationEnter',{callKey:'duplicate'},{connectionId:'two'}),/connection|already admitted/);
  await c.request('automationLeave',{callKey:'duplicate'},same);
  assert.equal(c.gate.active.has('duplicate'),true);
  await c.request('automationLeave',{callKey:'duplicate'},same);
  assert.equal(c.gate.active.has('duplicate'),false);
});

test('failed page observation preserves the proven input fence but requires recovery',async t=>{
  const{controller:c}=await setup(t,{controller:{observe:async()=>{throw new Error('Task tab is unavailable');}}});
  const lease=await c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30,targetId:'closed-tab'});
  await c.supervisor.promote({ownedId:lease.id,probeId:lease.id});
  const ended=await c.request('revoke',{owner,id:lease.id});
  assert.equal(ended.inputFenced,true);assert.equal(ended.snapshotObserved,false);assert.equal(ended.recoveryStage,'browser_observation');assert.equal(ended.resumeAllowed,false);
});

test('tunnel failure retires the viewer while keeping the persistent browser',async t=>{
  const {EventEmitter}=await import('node:events');const transport=new EventEmitter();
  transport.ensure=async()=>'https://example.test';transport.close=async()=>{};
  const{controller:c,events}=await setup(t,{controller:{transport}});
  const lease=await c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30});
  transport.emit('failure',new Error('owned tunnel exited'));
  const status=await c.request('wait',{owner,id:lease.id,timeoutSeconds:1});
  assert.equal(status.reason,'tunnel_outage');assert.equal(status.inputFenced,true);assert.equal(status.resumeAllowed,true);assert.deepEqual(events,['watch','fence']);
});

async function viewerClient(t,controller,lease) {
  const {Duplex}=await import('node:stream');
  const {WebSocket}=await import('ws');
  const {once}=await import('node:events');
  class VncSocket extends Duplex {_read(){} _write(_data,_encoding,done){done();}}
  controller.gateway.tcpConnect=async()=>new VncSocket();
  const invitation=new URL(lease.url),base=controller.gateway.localUrl+invitation.pathname;
  const post=(action,body={},cookie)=>fetch(base+action,{method:'POST',headers:{origin:invitation.origin,'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body)});
  const claimed=await post('claim',{token:invitation.hash.slice(8)});assert.equal(claimed.status,200);
  const cookie=claimed.headers.get('set-cookie').split(';')[0];
  return{post:(action,body)=>post(action,body,cookie),open:async generation=>{
    const ws=new WebSocket(base.replace('http:','ws:')+'stream/'+generation,{origin:invitation.origin,headers:{cookie}});
    ws.on('error',()=>{});t.after(()=>ws.terminate());await once(ws,'open');return ws;
  }};
}

test('controller integrates real gateway control credentials, clipboard and durable Done',async t=>{
  let clipboard='';
  const{controller:c,stateDir,events}=await setup(t,{runtime:{clipboardRead:async()=>({text:clipboard}),clipboardWrite:async text=>{clipboard=text;}}});
  const lease=await c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30,targetId:'tab'});
  const viewer=await viewerClient(t,c,lease);
  const watching=await(await viewer.post('credentials')).json();assert.equal(watching.password,'watchpass');await viewer.open(watching.generation);
  const response=await viewer.post('control'),control=await response.json();assert.equal(response.status,200,JSON.stringify(control));assert.equal(control.password,'ctrlpass');
  const registration=c.supervisor.register({ownedId:lease.id});assert.notEqual(registration.credentials.watch.slice(0,8),registration.credentials.control.slice(0,8));
  await viewer.open(control.generation);
  assert.equal((await viewer.post('clipboard',{action:'write',text:'秘密🙂'})).status,200);
  assert.deepEqual(await(await viewer.post('clipboard',{action:'read'})).json(),{text:'秘密🙂'});
  const done=await viewer.post('done');assert.equal(done.status,200);assert.deepEqual(await done.json(),{mode:'ended',reason:'done',disposition:'retained'});
  const status=await c.request('status',{owner,id:lease.id});assert.equal(status.reason,'done');assert.equal(status.resumeAllowed,true);
  const saved=await readFile(join(stateDir,'ledger.json'),'utf8');assert.equal(JSON.parse(saved).leases[lease.id].reason,'done');assert.equal(saved.includes('秘密'),false);
  const completions=await c.request('completions');assert.equal(completions.completions[0].reason,'done');
  assert.deepEqual(events,['watch','control','fence','observe']);
});

test('controller forwards watch-only permission into real gateway authority checks',async t=>{
  const{controller:c,events}=await setup(t);
  const lease=await c.request('create',{owner,profile:'human',permission:'watch',ttlSeconds:30});
  const viewer=await viewerClient(t,c,lease);const watching=await(await viewer.post('credentials')).json();await viewer.open(watching.generation);
  assert.equal((await viewer.post('control')).status,403);assert.deepEqual(events,['watch']);
});

test('a cached fence from the active viewer epoch cannot release automation',async t=>{
  const{controller:c}=await setup(t,{runtime:{stopViewerAndSettle:async({leaseId})=>({leaseId,epoch:1,displayGeneration:'g1',browserGeneration:'g1',vncProcessesExited:true,xClientsAbsent:true,heldInputCleared:true,xSyncComplete:true})}});
  const lease=await c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30});
  const status=await c.request('revoke',{owner,id:lease.id});assert.equal(status.resumeAllowed,false);assert.equal(status.recoveryRequired,true);
});

test('watch Done retires read-only authority without draining an active automation call',async t=>{
  const{controller:c,events}=await setup(t);
  await c.request('automationEnter',{callKey:'long-running'});
  const lease=await c.request('create',{owner,profile:'human',permission:'watch',ttlSeconds:30});
  const viewer=await viewerClient(t,c,lease);
  const persist=c.persist.bind(c);let slowWrite=true;
  c.persist=async()=>{if(slowWrite){slowWrite=false;await new Promise(resolve=>setTimeout(resolve,150));}return persist();};
  // Cleanup must not depend on automation leaving, regardless of disk latency.
  const acquire=c.gate.acquire;let acquisitions=0;
  c.gate.acquire=async()=>{acquisitions++;throw new Error('Read-only retirement must not drain automation');};
  try{
    const response=await viewer.post('done'),result=await response.json();
    assert.equal(response.status,200);assert.deepEqual(result,{mode:'ended',reason:'done',disposition:'retained'});
    assert.equal(acquisitions,0);assert.equal(c.gate.active.has('long-running'),true);assert.ok(c.ledger.calls['long-running']);
  }finally{
    c.gate.acquire=acquire;await c.request('automationLeave',{callKey:'long-running'});
  }
  const status=await c.request('status',{owner,id:lease.id});assert.equal(status.resumeAllowed,true);assert.equal(status.snapshotObserved,false);assert.equal(status.inputFenced,true);assert.equal(status.recoveryRequired,false);assert.deepEqual(events,['watch','fence']);
});

test('promotion dispatch is durably marked possibly writable before a failing runtime call',async t=>{
  let stateDir,possiblyWritable=false;
  const fixture=await setup(t,{runtime:{promoteViewer:async({leaseId})=>{possiblyWritable=JSON.parse(await readFile(join(stateDir,'ledger.json'),'utf8')).leases[leaseId].mayBeWritable===true;throw new Error('transport lost after dispatch');}}});
  stateDir=fixture.stateDir;const c=fixture.controller;let forcedReset;const stop=fixture.runtime.stopViewerAndSettle;fixture.runtime.stopViewerAndSettle=params=>{forcedReset=params.mayBeWritable;return stop(params);};
  const lease=await c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30});
  await assert.rejects(c.supervisor.promote({ownedId:lease.id,probeId:lease.id}),/failed/);
  assert.equal(possiblyWritable,true);assert.equal(forcedReset,true);assert.deepEqual(fixture.events,['watch','fence','observe']);assert.equal(c.ledger.leases[lease.id].receipt.snapshotObserved,true);
});

test('cancelling a pending acquisition preserves an unrelated active automation call',async t=>{
  const{controller:c,events}=await setup(t);await c.request('automationEnter',{callKey:'still-running'});
  const lease=await c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30});
  const promotion=assert.rejects(c.supervisor.promote({ownedId:lease.id,probeId:lease.id}),/cancel|failed/i);
  while(c.gate.holder!==lease.id)await new Promise(resolve=>setTimeout(resolve,1));
  await c.supervisor.cancelPromotion(lease.id);await promotion;
  assert.equal(c.gate.active.has('still-running'),true);assert.equal(c.gate.holder,null);assert.deepEqual(events,['watch','fence']);
  await c.request('automationLeave',{callKey:'still-running'});
});

test('production ensure rejects missing sandbox or authenticated Internet readiness',async t=>{
  for(const capability of ['browserSandbox','authenticatedInternetReady']){
    const{controller:c}=await setup(t,{runtime:{status:async()=>({ready:true,displayGeneration:'g1',browserGeneration:'g1',browserSandbox:true,authenticatedInternetReady:true,[capability]:false})}});
    await assert.rejects(c.request('ensure'),/sandbox|Internet|isolation|readiness/i);
    await assert.rejects(c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30}),/sandbox|Internet|isolation|readiness/i);
    assert.equal(Object.keys(c.ledger.leases).length,0);
  }
});

test('completion persistence failure aligns public cleanup failure and private recovery state',async t=>{
  const{controller:c}=await setup(t);
  const lease=await c.request('create',{owner,profile:'human',permission:'watch',ttlSeconds:30});
  const viewer=await viewerClient(t,c,lease),persist=c.persist.bind(c),ended=c.ended.bind(c);
  let completion=false;
  c.ended=(...args)=>{completion=true;return ended(...args);};
  c.persist=()=>completion?Promise.reject(new Error('disk unavailable')):persist();
  const response=await viewer.post('done');assert.equal(response.status,503);assert.equal((await response.json()).mode,'cleanup_failed');
  const status=await c.request('status',{owner,id:lease.id});
  c.persist=persist;
  assert.equal(status.mode,'recovery_required');assert.equal(status.resumeAllowed,false);assert.equal(status.recoveryRequired,true);
});

test('public Done cancels a draining takeover before writable dispatch',async t=>{
  const{controller:c,events}=await setup(t);await c.request('automationEnter',{callKey:'draining'});
  const lease=await c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30}),viewer=await viewerClient(t,c,lease);
  const watching=await(await viewer.post('credentials')).json();await viewer.open(watching.generation);
  const taking=viewer.post('control');while(c.gate.holder!==lease.id)await new Promise(resolve=>setTimeout(resolve,1));
  const persist=c.persist.bind(c);let slowWrite=true;
  c.persist=async()=>{if(slowWrite){slowWrite=false;await new Promise(resolve=>setTimeout(resolve,150));}return persist();};
  // The acquisition already in flight must be cancelled, never reacquired for cleanup.
  const acquire=c.gate.acquire;let acquisitions=0;
  c.gate.acquire=async()=>{acquisitions++;throw new Error('Cancelled takeover must not reacquire automation');};
  try{
    const response=await viewer.post('done'),result=await response.json();
    assert.equal(response.status,200);assert.equal(result.reason,'done');assert.equal((await taking).status,409);
    assert.equal(acquisitions,0);assert.equal(c.gate.holder,null);
    assert.equal(c.gate.active.has('draining'),true);assert.ok(c.ledger.calls.draining);
  }finally{
    c.gate.acquire=acquire;await c.request('automationLeave',{callKey:'draining'});await taking;
  }
  assert.deepEqual(events,['watch','fence']);assert.equal(c.ledger.leases[lease.id].mayBeWritable,false);assert.equal(c.ledger.leases[lease.id].reason,'done');
});

test('runtime ensure cannot mutate under human ownership without this connection admission',async t=>{
  let ensures=0;
  const{controller:c}=await setup(t,{runtime:{ensure:async()=>{ensures++;}}});
  c.gate.holder='human-owner';
  await assert.rejects(c.request('ensure',{}),/human control|admission/i);
  await assert.rejects(c.request('tabs',{}),/human control|admission/i);
  await assert.rejects(c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30}),/human control|admission/i);
  assert.equal(ensures,0);assert.equal(c.health().profile,'human');
  c.gate.holder=null;
  await c.request('automationEnter',{callKey:'existing'},{connectionId:'one'});c.gate.holder='human-owner';
  await assert.rejects(c.request('ensure',{callKey:'existing'},{connectionId:'two'}),/connection|admission/i);
  assert.equal(ensures,0);c.gate.holder=null;await c.request('automationLeave',{callKey:'existing'},{connectionId:'one'});
});

test('an admitted browser call can ensure while takeover drains it',async t=>{
  let ensures=0;
  const{controller:c,events}=await setup(t,{runtime:{ensure:async()=>{ensures++;}}});
  const lease=await c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30});
  const context={connectionId:'admitted'};await c.request('automationEnter',{callKey:'running'},context);
  const taking=c.supervisor.promote({ownedId:lease.id,probeId:lease.id});
  while(c.gate.holder!==lease.id)await new Promise(resolve=>setTimeout(resolve,1));
  const identity=await c.request('ensure',{profile:'human',callKey:'running'},context);
  assert.equal(identity.ready,true);assert.equal(ensures,2);assert.deepEqual(events,['watch']);
  await c.request('automationLeave',{callKey:'running'},context);await taking;assert.deepEqual(events,['watch','control']);
});

test('startup reconciliation exposes health but admits no new work',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'desktop-startup-'));
  let release;const barrier=new Promise(resolve=>{release=resolve;});
  const c=new DesktopController({stateDir,profile:'human',port:0,runtime:{cdpUrl:'http://127.0.0.1:18810'},transport:{close:async()=>{}}});
  const persist=c.persist.bind(c);let first=true;c.persist=async()=>{if(first){first=false;await barrier;}return persist();};
  const starting=c.start();let client;
  t.after(async()=>{release();await starting.catch(()=>{});client?.close();await c.close();await rm(stateDir,{recursive:true,force:true});});
  while(!c.rpc.started)await new Promise(resolve=>setTimeout(resolve,1));
  const {DesktopRpcClient}=await import('../src/desktop-rpc.mjs');client=new DesktopRpcClient(c.socketPath);
  assert.equal((await c.request('health')).ready,false);
  const timedRelease=setTimeout(release,50);t.after(()=>clearTimeout(timedRelease));
  await assert.rejects(c.request('automationEnter',{callKey:'too-early'}),/reconcil|ready|starting/i);
  assert.equal((await client.request('health')).ready,false);
  await assert.rejects(client.request('automationEnter',{callKey:'rpc-too-early'}),/reconcil|ready|starting/i);
  assert.equal(Object.keys(c.ledger.calls).length,0);release();await starting;
});

test('cleanup of a duplicate controller cannot overwrite the singleton authority ledger',async t=>{
  const{controller:c,stateDir}=await setup(t);await c.request('automationEnter',{callKey:'owned-call'});
  const duplicate=new DesktopController({stateDir,profile:'human',runtime:c.runtime,transport:{close:async()=>{}},port:0,observe:c.observe});
  await assert.rejects(duplicate.start(),/already running|lock/i);await duplicate.close();
  const saved=JSON.parse(await readFile(join(stateDir,'ledger.json'),'utf8'));assert.equal(saved.calls['owned-call'].state,'active');
  await c.request('automationLeave',{callKey:'owned-call'});
});

test('viewer heartbeats stop after retirement and controller shutdown',async t=>{
  const beats=[];const{controller:c}=await setup(t,{runtime:{heartbeatViewer:async params=>{beats.push(params);return{ok:true,...params};}},controller:{supervisorHeartbeatMs:10}});
  const lease=await c.request('create',{owner,profile:'human',permission:'watch',ttlSeconds:30});
  const deadline=Date.now()+500;while(!beats.length&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(beats.length>0);assert.deepEqual(beats.at(-1),{leaseId:lease.id,epoch:c.ledger.leases[lease.id].epoch});
  await c.request('revoke',{owner,id:lease.id});const count=beats.length;await c.heartbeatViewers();await c.close();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(beats.length,count);
});

test('a current viewer heartbeat failure ends ingress through the normal full fence',async t=>{
  const{controller:c,events}=await setup(t,{runtime:{heartbeatViewer:async()=>{throw new Error('supervisor unreachable');}}});
  const lease=await c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30});await c.supervisor.promote({ownedId:lease.id,probeId:lease.id});
  await c.heartbeatViewers();const status=await c.request('status',{owner,id:lease.id});assert.equal(status.mode,'ended');assert.equal(status.reason,'supervisor_unavailable');assert.equal(status.resumeAllowed,true);assert.equal(status.recoveryRequired,false);assert.deepEqual(events,['watch','control','fence','observe']);
});

test('a late old-epoch heartbeat failure cannot retire or refresh the promoted viewer',async t=>{
  let rejectOld,entered;const waiting=new Promise((_,reject)=>{rejectOld=reject;}),started=new Promise(resolve=>{entered=resolve;});const beats=[];
  const{controller:c,events}=await setup(t,{runtime:{heartbeatViewer:params=>{beats.push(params);if(params.epoch===1){entered();return waiting;}return Promise.resolve({ok:true,...params});}}});
  const lease=await c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30});
  const oldHeartbeat=c.heartbeatViewers();await started;await c.supervisor.promote({ownedId:lease.id,probeId:lease.id});
  const promotedEpoch=c.ledger.leases[lease.id].epoch;await c.heartbeatViewers();assert.deepEqual(beats.map(beat=>beat.epoch),[1,promotedEpoch]);
  rejectOld(new Error('old heartbeat timed out'));await oldHeartbeat;
  assert.equal(c.ledger.leases[lease.id].state,'control');assert.equal(c.actors.get(lease.id).epoch,promotedEpoch);assert.equal(c.gate.poisonReason,null);assert.deepEqual(events,['watch','control']);
});

test('a new private client can retire unknown prior owners on plugin stop',async t=>{
  const{controller:c,events}=await setup(t);const lease=await c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30});await c.supervisor.promote({ownedId:lease.id,probeId:lease.id});
  const {DesktopRpcClient}=await import('../src/desktop-rpc.mjs');const newClient=new DesktopRpcClient(c.socketPath);t.after(()=>newClient.close());
  const result=await newClient.request('revokeAll',{reason:'plugin_stop'});assert.deepEqual(result,{revoked:1,allRetired:true,recoveryRequired:false});
  const status=await c.request('status',{owner,id:lease.id});assert.equal(status.reason,'plugin_stop');assert.equal(status.resumeAllowed,true);assert.equal(c.gate.holder,null);assert.deepEqual(events,['watch','control','fence','observe']);
});

test('bulk retirement reports unsafe proof and retains the recovery gate',async t=>{
  const{controller:c}=await setup(t,{runtime:{stopViewerAndSettle:async()=>({vncProcessesExited:true})}});
  const lease=await c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30});await c.supervisor.promote({ownedId:lease.id,probeId:lease.id});
  const result=await c.request('revokeAll',{reason:'plugin_stop'});assert.deepEqual(result,{revoked:1,allRetired:false,recoveryRequired:true});
  await assert.rejects(c.request('automationEnter',{callKey:'unsafe'}),/recovery|uncertain/);
  assert.deepEqual(await c.request('revokeAll',{reason:'plugin_stop'}),{revoked:0,allRetired:false,recoveryRequired:true});
});

test('bulk retirement cancels a create still waiting for runtime startup',async t=>{
  let entered,release;const started=new Promise(resolve=>{entered=resolve;}),waiting=new Promise(resolve=>{release=resolve;});
  const{controller:c,events}=await setup(t,{runtime:{ensure:async()=>{entered();await waiting;}}});
  const creating=c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30});const rejected=assert.rejects(creating,/cancel|stopped/i);await started;
  assert.deepEqual(await c.request('revokeAll',{reason:'plugin_stop'}),{revoked:0,allRetired:true,recoveryRequired:false});release();await rejected;
  assert.deepEqual(events,[]);assert.equal(Object.keys(c.ledger.leases).length,0);
});

async function isolateCreateClients(t,c){
  const {DesktopRpcClient}=await import('../src/desktop-rpc.mjs');const main=new DesktopRpcClient(c.socketPath),tool=new DesktopRpcClient(c.socketPath);t.after(()=>{main.close();tool.close();});
  await main.request('automationEnter',{callKey:'unrelated-main-call'});return{main,tool};
}
async function settleCreate(c){const deadline=Date.now()+1000;while(c.creating&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(c.creating,undefined);}

test('aborting an isolated create during ensure leaves no actor and preserves unrelated admission',async t=>{
  const {once}=await import('node:events');let entered,release;const started=new Promise(resolve=>{entered=resolve;}),waiting=new Promise(resolve=>{release=resolve;});
  const{controller:c,events}=await setup(t,{runtime:{ensure:async()=>{entered();await waiting;}}});const{main,tool}=await isolateCreateClients(t,c);const abort=new AbortController();
  const creating=assert.rejects(tool.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30},{signal:abort.signal}),/abort/i);await started;
  const closed=once([...c.rpc.sockets].at(-1),'close');abort.abort();await creating;await closed;release();await settleCreate(c);
  assert.deepEqual(events,[]);assert.equal(Object.keys(c.ledger.leases).length,0);assert.equal(c.gate.poisonReason,null);assert.equal(c.ledger.calls['unrelated-main-call'].state,'active');await main.request('automationLeave',{callKey:'unrelated-main-call'});
});

test('aborting an isolated create during actor startup retires and discards its invitation',async t=>{
  const {once}=await import('node:events');let entered,release;const started=new Promise(resolve=>{entered=resolve;}),waiting=new Promise(resolve=>{release=resolve;});
  const{controller:c,runtime,events}=await setup(t);const start=runtime.startViewer;runtime.startViewer=async params=>{entered();await waiting;return start(params);};
  const{main,tool}=await isolateCreateClients(t,c);const abort=new AbortController();
  const creating=assert.rejects(tool.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30},{signal:abort.signal}),/abort/i);await started;
  const closed=once([...c.rpc.sockets].at(-1),'close');abort.abort();await creating;await closed;release();await settleCreate(c);
  const [row]=Object.values(c.ledger.leases);assert.equal(row.state,'ended');assert.equal(row.reason,'creation_cancelled');assert.equal(c.gateway.sessions.get(row.id).mode,'ended');assert.equal(c.gateway.sessions.get(row.id).inviteHash,undefined);assert.equal(c.actors.size,0);assert.deepEqual(events,['watch','fence']);assert.equal(c.gate.poisonReason,null);assert.equal(c.gate.active.has('unrelated-main-call'),true);await main.request('automationLeave',{callKey:'unrelated-main-call'});
});

test('closing a tool client after delivered creation does not revoke its valid lease',async t=>{
  const{controller:c}=await setup(t);const{main,tool}=await isolateCreateClients(t,c);
  const lease=await tool.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30});tool.close();await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(c.ledger.leases[lease.id].state,'watch');assert.equal(c.gateway.sessions.get(lease.id).mode,'unclaimed');assert.equal(c.gate.poisonReason,null);assert.equal(c.gate.active.has('unrelated-main-call'),true);await c.request('revoke',{owner,id:lease.id});await main.request('automationLeave',{callKey:'unrelated-main-call'});
});

async function cdpObservationWire(t,ids,{fail=[],windowState='normal'}={}){
  const {createServer}=await import('node:http');const {WebSocketServer}=await import('ws');
  const methods=[];let origin,foreground=ids[0];
  const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({webSocketDebuggerUrl:origin.replace('http:','ws:')+'/browser'}));});
  const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req)));
  wss.on('connection',(ws,req)=>ws.on('message',bytes=>{const message=JSON.parse(bytes);methods.push({path:req.url,method:message.method});
    const response={id:message.id};if(message.method==='Page.getFrameTree'&&fail.includes(req.url.slice('/page/'.length)))response.error={code:-32000,message:'page unavailable'};
    else response.result=message.method==='Page.getFrameTree'?{frameTree:{frame:{id:'fresh-frame'}}}:message.method==='Browser.getWindowForTarget'?{windowId:17,bounds:{windowState}}:{product:'mock-browser'};if(message.method==='Page.bringToFront')foreground=req.url.slice('/page/'.length);ws.send(JSON.stringify(response));
  }));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{for(const client of wss.clients)client.terminate();await Promise.all([new Promise(resolve=>wss.close(resolve)),new Promise(resolve=>server.close(resolve))]);});
  return{origin,methods,get foreground(){return foreground;},tabs:ids.map(id=>({id,type:'page',webSocketDebuggerUrl:origin.replace('http:','ws:')+'/page/'+id}))};
}

test('full-browser handback observes another live page after the original target closes',async t=>{
  const wire=await cdpObservationWire(t,['remaining']);
  const{controller:c,stateDir}=await setup(t,{runtime:{cdpUrl:wire.origin,tabs:async()=>wire.tabs},controller:{observe:observeDesktop}});
  const lease=await c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30,targetId:'closed-original'});await c.supervisor.promote({ownedId:lease.id,probeId:lease.id});
  const status=await c.request('revoke',{owner,id:lease.id});assert.equal(status.resumeAllowed,true);assert.equal(status.snapshotObserved,true);assert.equal(status.observedTargetId,'remaining');assert.equal(status.targetChanged,true);assert.equal(status.targetId,'closed-original');assert.equal(status.recoveryRequired,false);
  assert.deepEqual(wire.methods,[{path:'/browser',method:'Browser.getVersion'},{path:'/page/remaining',method:'Page.getFrameTree'}]);
  const saved=await readFile(join(stateDir,'ledger.json'),'utf8');assert.equal(JSON.parse(saved).leases[lease.id].receipt.observedTargetId,'remaining');assert.equal(JSON.parse(saved).leases[lease.id].receipt.targetChanged,true);assert.equal(saved.includes(wire.origin),false);assert.equal(saved.includes('fresh-frame'),false);
});

test('fresh browser observation prefers the original page while it remains available',async t=>{
  const wire=await cdpObservationWire(t,['other','original']);
  const result=await observeDesktop({cdpUrl:wire.origin,status:async()=>({ready:true,displayGeneration:'g1',browserGeneration:'g1'}),tabs:async()=>wire.tabs},{targetId:'original'});
  assert.equal(result.observedTargetId,'original');assert.equal(result.targetChanged,false);assert.equal(wire.methods.at(-1).path,'/page/original');
});

test('failure to observe every remaining page keeps the control gate closed',async t=>{
  const wire=await cdpObservationWire(t,['original','other'],{fail:['original','other']});
  const{controller:c}=await setup(t,{runtime:{cdpUrl:wire.origin,tabs:async()=>wire.tabs},controller:{observe:observeDesktop}});
  const lease=await c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30,targetId:'original'});await c.supervisor.promote({ownedId:lease.id,probeId:lease.id});
  const status=await c.request('revoke',{owner,id:lease.id});assert.equal(status.resumeAllowed,false);assert.equal(status.inputFenced,true);assert.equal(status.snapshotObserved,false);assert.equal(status.recoveryRequired,true);await assert.rejects(c.request('automationEnter',{callKey:'blocked'}),/recovery|uncertain/);
  assert.deepEqual(wire.methods.filter(entry=>entry.method==='Page.getFrameTree').map(entry=>entry.path),['/page/original','/page/other']);
});

test('requested task activation drains automation and focuses the exact page before watch exposure',async t=>{
  const wire=await cdpObservationWire(t,['other','requested'],{windowState:'minimized'});
  const{controller:c,runtime,events}=await setup(t,{runtime:{cdpUrl:wire.origin,tabs:async()=>wire.tabs},controller:{activateTarget:activateDesktopTarget}});
  const start=runtime.startViewer;runtime.startViewer=params=>{assert.equal(wire.foreground,'requested');assert.equal(c.gate.locked,true,'the activation gate must cover viewer registration');return start(params);};
  await c.request('automationEnter',{callKey:'existing'});
  const creating=c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30,targetId:'requested'});
  const deadline=Date.now()+1000;while(c.gate.holder===null&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,1));assert.notEqual(c.gate.holder,null);
  assert.deepEqual(wire.methods,[]);assert.deepEqual(events,[]);assert.equal(c.gate.active.has('existing'),true);await assert.rejects(c.request('automationEnter',{callKey:'new'}),/human control/i);
  await c.request('automationLeave',{callKey:'existing'});const lease=await creating;
  assert.equal(c.gate.holder,null);assert.equal(c.gateway.sessions.get(lease.id).mode,'unclaimed');assert.equal(wire.foreground,'requested');
  assert.deepEqual(wire.methods,[{path:'/page/requested',method:'Browser.getWindowForTarget'},{path:'/page/requested',method:'Browser.setWindowBounds'},{path:'/page/requested',method:'Page.bringToFront'}]);
  await c.supervisor.promote({ownedId:lease.id,probeId:lease.id});const count=wire.methods.length;await c.request('revoke',{owner,id:lease.id});assert.equal(wire.methods.length,count,'Done must preserve the human-selected browser context');
});

test('a missing requested task refuses invitation instead of focusing an arbitrary page',async t=>{
  const wire=await cdpObservationWire(t,['other']);
  const{controller:c,events}=await setup(t,{runtime:{cdpUrl:wire.origin,tabs:async()=>wire.tabs},controller:{activateTarget:activateDesktopTarget}});
  await assert.rejects(c.request('create',{owner,profile:'human',permission:'control',ttlSeconds:30,targetId:'missing'}),/target|requested|available/i);
  assert.equal(c.gate.holder,null);assert.equal(Object.keys(c.ledger.leases).length,0);assert.deepEqual(events,[]);assert.deepEqual(wire.methods,[]);
});

for (const boundary of ['admission', 'rpc', 'receipt', 'observation', 'observation-receipt', 'journal', 'completion-journal']) test(`retirement records a bounded diagnostic code for ${boundary} without changing fencing`, async t => {
  const { controller: c, runtime, stateDir } = await setup(t);
  const lease = await c.request('create', { owner, profile: 'human', permission: 'control', ttlSeconds: 30 });
  await c.supervisor.promote({ ownedId: lease.id, probeId: lease.id });
  const privateError = 'PRIVATE_FIXTURE_MUST_NOT_BE_STORED';
  const expected = boundary === 'admission' ? 'input_fence_admission' : boundary === 'rpc' ? 'input_fence_rpc' : boundary === 'receipt' ? 'input_fence_receipt'
    : boundary.startsWith('observation') ? 'browser_observation' : 'journal_persistence';
  if (boundary === 'admission') c.gate.holder = 'other-fixture-owner';
  if (boundary === 'rpc') runtime.stopViewerAndSettle = async () => { throw new Error(privateError); };
  if (boundary === 'receipt') runtime.stopViewerAndSettle = async () => ({ epoch: 100, heldInputCleared: false, privateError });
  if (boundary === 'observation') c.observe = async () => { throw new Error(privateError); };
  if (boundary === 'observation-receipt') c.observe = async () => ({ snapshotObserved: false, privateError });
  if (boundary.includes('journal')) {
    const persist = c.persist.bind(c); let failed = false;
    c.persist = async () => {
      if (!failed && (boundary === 'journal' || c.ledger.leases[lease.id].state === 'ended')) { failed = true; throw new Error(privateError); }
      return persist();
    };
  }
  const result = await c.request('revoke', { owner, id: lease.id });
  assert.equal(result.recoveryCode, expected);
  assert.equal(result.mode, 'recovery_required'); assert.equal(result.resumeAllowed, false); assert.equal(result.recoveryRequired, true);
  assert.equal(result.inputFenced, boundary.startsWith('observation') || boundary === 'completion-journal');
  await assert.rejects(c.request('automationEnter', { callKey: 'must-remain-blocked' }), /recovery|uncertain/);
  const contents = await readFile(join(stateDir, 'ledger.json'), 'utf8');
  const durable = JSON.parse(contents);
  assert.equal(durable.leases[lease.id].recoveryCode, expected);
  assert.equal(durable.leases[lease.id].state, 'recovery_required'); assert.deepEqual(durable.calls, {});
  assert.equal(contents.includes(privateError), false); assert.equal(JSON.stringify(result).includes(privateError), false);
});

test('a proven ended row clears its diagnostic while the existing poisoned gate remains latched', async t => {
  const { controller: c, runtime, stateDir } = await setup(t);
  const lease = await c.request('create', { owner, profile: 'human', permission: 'control', ttlSeconds: 30 });
  await c.supervisor.promote({ ownedId: lease.id, probeId: lease.id });
  const stop = runtime.stopViewerAndSettle;
  runtime.stopViewerAndSettle = async () => { throw new Error('fixture transport failure'); };
  await c.request('revoke', { owner, id: lease.id });
  assert.equal(c.status(c.ledger.leases[lease.id]).recoveryCode, 'input_fence_rpc');
  runtime.stopViewerAndSettle = stop;
  await c.retire(lease.id, { reconcile: true });
  const row = c.ledger.leases[lease.id], result = c.status(row);
  assert.equal(row.state, 'ended'); assert.equal(row.recoveryCode, undefined); assert.equal(result.recoveryCode, undefined);
  assert.equal(result.resumeAllowed, false); assert.equal(result.recoveryRequired, true);
  assert.equal(JSON.parse(await readFile(join(stateDir, 'ledger.json'), 'utf8')).leases[lease.id].recoveryCode, undefined);
});

test('status never exposes an unrecognized or non-string recovery code from the journal', async t => {
  const { controller: c } = await setup(t);
  const lease = await c.request('create', { owner, profile: 'human', permission: 'watch', ttlSeconds: 30 });
  const row = c.ledger.leases[lease.id]; row.state = 'recovery_required';
  for (const code of ['PRIVATE_FIXTURE', { toString: () => 'input_fence_rpc' }, null, ['input_fence_rpc']]) {
    row.recoveryCode = code;
    assert.equal(Object.hasOwn(c.status(row), 'recoveryCode'), false);
  }
});
