import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { DesktopRuntime } from '../index.mjs';
const artifact=process.env.DESKTOP_ARTIFACT_DIR??fileURLToPath(new URL('../../../test-artifacts/desktop', import.meta.url));
const runtime=new DesktopRuntime({name:process.env.DESKTOP_NAME??'handoff-production-runtime-final-test',stateDir:`${artifact}/final-state`,image:process.env.DESKTOP_IMAGE,cdpPort:Number(process.env.DESKTOP_CDP_PORT??18811),vncPort:Number(process.env.DESKTOP_VNC_PORT??59091)});
await runtime.owned();
const version=await(await fetch(`${runtime.cdpUrl}/json/version`)).json();
async function connect(url) {
  const socket=new WebSocket(url);await new Promise((r,j)=>{socket.once('open',r);socket.once('error',j);});
  let sequence=0;const pending=new Map();
  socket.on('message',b=>{const m=JSON.parse(b);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}});
  return {socket,send:(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));})};
}
const browser=await connect(version.webSocketDebuggerUrl);
const sandboxTarget=await browser.send('Target.createTarget',{url:'chrome://sandbox'});
const publicTarget=await browser.send('Target.createTarget',{url:'https://example.com'});
async function page(id) {for(let n=0;n<100;n++){const found=(await runtime.tabs()).find(t=>t.id===id);if(found)return connect(found.webSocketDebuggerUrl);await new Promise(r=>setTimeout(r,25));}throw new Error('target unavailable');}
const sandbox=await page(sandboxTarget.targetId),publicPage=await page(publicTarget.targetId);
async function evaluate(client,expression){return(await client.send('Runtime.evaluate',{expression,returnByValue:true})).result.value;}
let sandboxText,publicText;
for(let n=0;n<200;n++){
  sandboxText=await evaluate(sandbox,'document.body?.innerText');
  publicText=await evaluate(publicPage,'document.body?.innerText');
  if(sandboxText?.includes('adequately sandboxed')&&publicText?.includes('documentation examples'))break;
  await new Promise(r=>setTimeout(r,50));
}
assert.match(sandboxText,/Namespace/);assert.match(sandboxText,/PID namespaces\s+Yes/);assert.match(sandboxText,/Network namespaces\s+Yes/);assert.match(sandboxText,/Seccomp-BPF sandbox\s+Yes/);assert.match(publicText,/documentation examples/);
await browser.send('Target.activateTarget',{targetId:publicTarget.targetId});
const dimensions=await evaluate(publicPage,'({devicePixelRatio,zoom:visualViewport.scale,outerWidth,outerHeight,innerWidth,innerHeight})');
assert.equal(dimensions.devicePixelRatio,1);assert.equal(dimensions.zoom,1);assert.equal(dimensions.outerWidth,1280);assert.equal(dimensions.outerHeight,900);assert.ok(dimensions.outerHeight-dimensions.innerHeight>=70);
const window=await browser.send('Browser.getWindowForTarget',{targetId:publicTarget.targetId});
assert.equal(window.bounds.windowState,'maximized');
const owned=await runtime.owned();
await runtime.startViewer({leaseId:'isolation-proof',role:'watch'});
const probe="import json,socket;out={};\nfor name,ip in [('metadata','169.254.169.254'),('private','10.255.255.1'),('dockerHost','172.17.0.1')]:\n try:\n  s=socket.create_connection((ip,80),timeout=.5);s.close();out[name]='UNEXPECTED-CONNECTED'\n except OSError as e:out[name]=type(e).__name__\nprint(json.dumps(out))";
const egress=JSON.parse(await runtime.run(['exec','--user','1000:1000',owned.Id,'python3','-c',probe]));
assert.ok(Object.values(egress).every(s=>s!=='UNEXPECTED-CONNECTED'));
const managementProbe="import json,socket;out={};\nfor port in (9222,9223,5900):\n try:\n  s=socket.create_connection(('127.0.0.1',port),timeout=.5);s.close();out[str(port)]='UNEXPECTED-CONNECTED'\n except OSError as e:out[str(port)]=type(e).__name__\nprint(json.dumps(out))";
const managementEgress=JSON.parse(await runtime.run(['exec','--user','1000:1000',owned.Id,'python3','-c',managementProbe]));
assert.ok(Object.values(managementEgress).every(s=>s!=='UNEXPECTED-CONNECTED'));
const status=await runtime.status();const proxy=status.criticalProcesses.find(c=>c.name==='socat');
const proxyIdentity=JSON.parse(await runtime.run(['exec','--user','1001:1001',owned.Id,'python3','-c',`import json;print(json.dumps({k:v.strip() for k,v in (line.split(':',1) for line in open('/proc/${proxy.pid}/status') if ':' in line) if k in ['Uid','CapEff','CapBnd','NoNewPrivs','Seccomp']}))`]));
assert.match(proxyIdentity.Uid,/^1001\s+1001/);assert.equal(Number.parseInt(proxyIdentity.CapEff,16),0);assert.equal(Number.parseInt(proxyIdentity.CapBnd,16),0);assert.equal(proxyIdentity.NoNewPrivs,'1');
const isolationSettlement=await runtime.stopViewerAndSettle({leaseId:'isolation-proof'});assert.equal(isolationSettlement.xClientsAbsent,true);
const processes=JSON.parse(await runtime.run(['exec','--user','1000:1000',owned.Id,'python3','-c',"import json;print(json.dumps({k:v.strip() for k,v in (line.split(':',1) for line in open('/proc/1/status') if ':' in line) if k in ['Uid','CapEff','CapBnd','NoNewPrivs','Seccomp']}))"]));
assert.match(processes.Uid,/^1000\s+1000/);assert.equal(Number.parseInt(processes.CapEff,16),0);assert.equal(Number.parseInt(processes.CapBnd,16),0);assert.equal(processes.NoNewPrivs,'1');
await writeFile(`${artifact}/inspection-result.json`,JSON.stringify({image:runtime.image,sandboxText,publicText,dimensions,window,egress,managementEgress,proxyIdentity,isolationSettlement,processes,profileVolume:runtime.volume,cdpLoopback:runtime.cdpUrl},null,2));
await new Promise((accept,reject)=>{
  const child=spawn('docker',['--host=unix:///var/run/docker.sock','exec','--user','1000:1000',owned.Id,'/opt/desktop/x11-proof','screenshot']);const buffers=[];child.stdout.on('data',b=>buffers.push(b));child.on('error',reject);child.on('close',async code=>{if(code!==0)return reject(new Error('desktop screenshot failed'));await writeFile(`${artifact}/desktop.ppm`,Buffer.concat(buffers));accept();});
});
sandbox.socket.close();publicPage.socket.close();browser.socket.close();
console.log('headed sandbox, public web, full browser chrome, DPR/zoom and private egress proof passed');
