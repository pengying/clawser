import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {DesktopRuntime} from '../index.mjs';
const artifact=process.env.DESKTOP_ARTIFACT_DIR??fileURLToPath(new URL('../../../test-artifacts/desktop', import.meta.url));
await mkdir(artifact,{recursive:true,mode:0o700});
const runtime=new DesktopRuntime({name:'handoff-runtime-heartbeat-test',stateDir:`${artifact}/heartbeat-state`,cdpPort:18813,vncPort:59093,testHeartbeatTimeoutMs:1000});
await runtime.ensure();
let initial;
for(let n=0;n<100;n++){try{initial=await runtime.status();if(initial.ready)break;}catch{}await new Promise(r=>setTimeout(r,100));}
assert.equal(initial?.ready,true);assert.equal(initial.heartbeatTimeoutMs,1000);
const owned=await runtime.owned();
const fixture=await readFile(new URL('./input-fixture.py',import.meta.url),'utf8');
const input=async action=>JSON.parse(await runtime.run(['exec','--interactive','--user','1000:1000',owned.Id,'python3','-',action],fixture));
const pageIds=async()=>(await runtime.tabs()).filter(t=>t.type==='page').map(t=>t.id).sort();
const before=await pageIds();
await runtime.run(['exec','--user','1000:1000',owned.Id,'python3','-c',"import os;p='/tmp/desktop/heartbeat-stall-ready';os.path.exists(p) and os.unlink(p)"]);
async function untilRetired(leaseId,bound=4500){
  const started=performance.now();
  while(performance.now()-started<bound){
    const state=await runtime.status();
    if(state.viewer===null){const receipt=await runtime.stopViewerAndSettle({leaseId});return{state,receipt,elapsedMs:performance.now()-started};}
    await new Promise(r=>setTimeout(r,25));
  }
  throw new Error('heartbeat watchdog did not retire actor within bound');
}
const lost=await runtime.startViewer({leaseId:'controller-lost',role:'control',expiresAt:Date.now()+60000});
assert.deepEqual(await input('hold'),{shift:true,button1:true});
// An incomplete management request must not stall the independent watchdog.
const stalled=runtime.run(['exec','--user','1000:1000',owned.Id,'python3','-c',"import socket,time;s=socket.socket(socket.AF_UNIX);s.connect('/tmp/desktop/control.sock');s.sendall(b'{');open('/tmp/desktop/heartbeat-stall-ready','w').close();time.sleep(3);s.close()"]);
for(let n=0;n<40;n++){
  const ready=await runtime.run(['exec','--user','1000:1000',owned.Id,'python3','-c',"import os;print(os.path.exists('/tmp/desktop/heartbeat-stall-ready'))"]);
  if(ready==='True')break;await new Promise(r=>setTimeout(r,25));
}
const stalledAt=performance.now();await new Promise(r=>setTimeout(r,1600));
assert.deepEqual(await input('state'),{shift:false,button1:false});
const activeClients=JSON.parse(await runtime.run(['exec','--user','1000:1000',owned.Id,'/opt/desktop/x11-proof','clients']));
assert.ok(!activeClients.some(c=>c.pid===lost.pid));
const inputClearedWhileRpcBlockedMs=performance.now()-stalledAt;
await stalled;
const loss=await untilRetired(lost.leaseId);
assert.equal(loss.receipt.retirementReason,'heartbeat_timeout');assert.equal(loss.receipt.heldInputCleared,true);
assert.deepEqual(await input('state'),{shift:false,button1:false});
assert.equal(loss.state.displayGeneration,initial.displayGeneration);assert.equal(loss.state.browserGeneration,initial.browserGeneration);assert.deepEqual(await pageIds(),before);

const live=await runtime.startViewer({leaseId:'heartbeats-live',role:'control',expiresAt:Date.now()+60000});
const aliveStarted=performance.now();let ack;
for(let n=0;n<8;n++){
  await new Promise(r=>setTimeout(r,200));
  ack=await runtime.heartbeatViewer({leaseId:live.leaseId,epoch:live.epoch});
  assert.equal(ack.ok,true);assert.equal(ack.leaseId,live.leaseId);assert.equal(ack.epoch,live.epoch);assert.ok(ack.heartbeatDeadline<=live.expiresAt);
}
const validHeartbeatsKeptAliveMs=performance.now()-aliveStarted;
assert.ok(validHeartbeatsKeptAliveMs>1000);assert.equal((await runtime.status()).viewer.leaseId,live.leaseId);
await assert.rejects(runtime.heartbeatViewer({leaseId:'wrong',epoch:live.epoch}),/lease|epoch/);
await assert.rejects(runtime.heartbeatViewer({leaseId:live.leaseId,epoch:live.epoch+1}),/lease|epoch/);
assert.throws(()=>runtime.heartbeatViewer({leaseId:live.leaseId}),/epoch/);
await assert.rejects(runtime.rpc('heartbeatViewer',{leaseId:live.leaseId}),/lease\/epoch/);
const mismatchDeadline=(await runtime.status()).viewer.heartbeatDeadline;assert.equal(mismatchDeadline,ack.heartbeatDeadline);
const stopped=await untilRetired(live.leaseId);
assert.equal(stopped.receipt.retirementReason,'heartbeat_timeout');

const watch=await runtime.startViewer({leaseId:'watch-controller-lost',role:'watch',expiresAt:Date.now()+60000});
let watchLoss;
try {
  assert.deepEqual(await input('hold'),{shift:true,button1:true});
  watchLoss=await untilRetired(watch.leaseId);
  assert.equal(watchLoss.receipt.readOnly,true);assert.equal(watchLoss.receipt.heldInputCleared,false);assert.deepEqual(await input('state'),{shift:true,button1:true});
}finally{await input('release');}

const absolute=await runtime.startViewer({leaseId:'absolute-cap',role:'control',expiresAt:Date.now()+1700});
for(let n=0;n<4;n++){
  await new Promise(r=>setTimeout(r,200));
  const capped=await runtime.heartbeatViewer({leaseId:absolute.leaseId,epoch:absolute.epoch});assert.ok(capped.heartbeatDeadline<=absolute.expiresAt);
}
const cap=await untilRetired(absolute.leaseId);assert.equal(cap.receipt.retirementReason,'lease_expired');
const final=await runtime.status();assert.equal(final.displayGeneration,initial.displayGeneration);assert.equal(final.browserGeneration,initial.browserGeneration);assert.deepEqual(await pageIds(),before);
await writeFile(`${artifact}/heartbeat-result.json`,JSON.stringify({image:runtime.image,imageId:owned.Image,timeoutMs:1000,loss,inputClearedWhileRpcBlockedMs,validHeartbeatsKeptAliveMs,staleContextDidNotRefresh:true,watchLoss,absoluteCap:cap,tabIdsPreserved:true,browserGenerationPreserved:true,final},null,2));
console.log('heartbeat controller-loss fence, held input cleanup, exact epoch refresh, read-only preservation and absolute expiry cap passed');
