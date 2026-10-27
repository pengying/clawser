import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { DesktopRuntime } from '../index.mjs';
const artifact=process.env.DESKTOP_ARTIFACT_DIR??fileURLToPath(new URL('../../../test-artifacts/desktop', import.meta.url));
const runtime=new DesktopRuntime({name:process.env.DESKTOP_NAME??'handoff-production-runtime-final-test',stateDir:`${artifact}/final-state`,image:process.env.DESKTOP_IMAGE,cdpPort:Number(process.env.DESKTOP_CDP_PORT??18811),vncPort:Number(process.env.DESKTOP_VNC_PORT??59091)});
const before=await runtime.status();assert.equal(before.ready,true);
const actor=await runtime.startViewer({leaseId:'health-fault',role:'control'});
const bridge=before.criticalProcesses.find(c=>c.name==='socat');assert.ok(bridge?.running);
const owned=await runtime.owned();
await runtime.run(['exec','--user','1001:1001',owned.Id,'python3','-c','import os,signal,sys;os.kill(int(sys.argv[1]),signal.SIGKILL)',String(bridge.pid)]);
let failed;
for(let n=0;n<100;n++){failed=await runtime.status();if(failed.tainted&&failed.viewer===null)break;await new Promise(r=>setTimeout(r,25));}
assert.equal(failed.ready,false);assert.equal(failed.authenticatedInternetReady,false);assert.equal(failed.tainted,true);assert.equal(failed.viewer,null);
assert.equal(failed.displayGeneration,before.displayGeneration);assert.equal(failed.browserGeneration,before.browserGeneration);
const retired=await runtime.stopViewerAndSettle({leaseId:actor.leaseId});
for(const key of ['vncProcessesExited','xClientsAbsent','heldInputCleared','xSyncComplete'])assert.equal(retired[key],true,key);
await assert.rejects(runtime.startViewer({leaseId:'must-reject',role:'control'}),/unavailable|quarantined/);
await assert.rejects(runtime.clipboardWrite('must reject'),/unavailable|quarantined/);
await runtime.shutdown();await runtime.ensure();
let recovered;
for(let n=0;n<100;n++){try{recovered=await runtime.status();if(recovered.ready)break;}catch{}await new Promise(r=>setTimeout(r,100));}
assert.equal(recovered.ready,true);assert.notEqual(recovered.displayGeneration,before.displayGeneration);assert.notEqual(recovered.browserGeneration,before.browserGeneration);
await writeFile(`${artifact}/health-result.json`,JSON.stringify({fault:'CDP bridge killed',failed,retired,recovered,retainedProfileRecovered:true},null,2));
console.log('critical failure quarantines, retires actor and retained profile restarts with new generations');
