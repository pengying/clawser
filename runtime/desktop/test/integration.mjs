import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { DesktopRuntime } from '../index.mjs';
import { mkdir, writeFile,readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import net from 'node:net';
import { createCipheriv } from 'node:crypto';

const artifact = process.env.DESKTOP_ARTIFACT_DIR ?? fileURLToPath(new URL('../../../test-artifacts/desktop', import.meta.url));
await mkdir(artifact,{recursive:true,mode:0o700});
const runtime = new DesktopRuntime({name:process.env.DESKTOP_NAME??'handoff-production-runtime-final-test',stateDir:`${artifact}/final-state`,image:process.env.DESKTOP_IMAGE,cdpPort:Number(process.env.DESKTOP_CDP_PORT??18811),vncPort:Number(process.env.DESKTOP_VNC_PORT??59091)});
await runtime.ensure();
let status;
for(let n=0;n<100;n++) {try {status=await runtime.status();break;} catch(e) {if(n===99) throw e; await new Promise(r=>setTimeout(r,100));}}
assert.equal(status.ready,true);
assert.equal(typeof status.browserGeneration,'string');
const before = await runtime.tabs();
assert.ok(before.some(t=>t.type==='page'));
const unicode = 'Clipboard proof — 中文 🙂\nsecond line';
await assert.rejects(runtime.clipboardRead(),/control lease/);
const actor = await runtime.startViewer({leaseId:'integration-1',role:'control'});
assert.ok(actor.xClients.some(c=>c.pid===actor.pid));
assert.equal(actor.role,'control');
const firstWrite=await runtime.clipboardWrite(unicode,{leaseId:actor.leaseId,epoch:actor.epoch});
const secondWrite=await runtime.clipboardWrite(unicode,{leaseId:actor.leaseId,epoch:actor.epoch});
assert.equal(secondWrite.selectionOwnedByHelper,true);assert.ok(secondWrite.ownerPid>0);assert.notEqual(firstWrite.ownerPid,secondWrite.ownerPid);
assert.equal((await runtime.clipboardRead()).text,unicode);
await assert.rejects(runtime.clipboardWrite('stale',{leaseId:'wrong-lease'}),/lease\/epoch mismatch/);
// Real RFB authentication and input, independent of CDP keyboard injection.
const socket=net.connect(actor.port,actor.host);
let buffered=Buffer.alloc(0),wake;
socket.on('data',b=>{buffered=Buffer.concat([buffered,b]);wake?.();});
async function read(n) {const deadline=Date.now()+5000;while(buffered.length<n) {if(Date.now()>deadline)throw new Error('RFB read timeout');await new Promise(r=>{wake=r;setTimeout(r,25);});}const result=buffered.subarray(0,n);buffered=buffered.subarray(n);return result;}
assert.match((await read(12)).toString(),/^RFB/);socket.write('RFB 003.008\n');
const securityCount=(await read(1))[0];const securityTypes=await read(securityCount);assert.ok(securityTypes.includes(2));socket.write(Buffer.from([2]));
const challenge=await read(16);
const key=Buffer.alloc(8);for(let i=0;i<8;i++){let byte=actor.password.charCodeAt(i)||0;for(let b=0;b<8;b++)key[i]|=((byte>>b)&1)<<(7-b);}
const cipher=createCipheriv('des-ede3',Buffer.concat([key,key,key]),null);cipher.setAutoPadding(false);socket.write(Buffer.concat([cipher.update(challenge),cipher.final()]));
assert.equal((await read(4)).readUInt32BE(),0);socket.write(Buffer.from([1]));
const init=await read(24);await read(init.readUInt32BE(20));
const keyEvent=(sym,down)=>{const b=Buffer.alloc(8);b[0]=4;b[1]=Number(down);b.writeUInt32BE(sym,4);socket.write(b);};
const cdpSocket=new WebSocket(before.find(t=>t.type==='page').webSocketDebuggerUrl);
await new Promise((r,j)=>{cdpSocket.once('open',r);cdpSocket.once('error',j);});
let sequence=0;const pending=new Map();cdpSocket.on('message',b=>{const m=JSON.parse(b);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}});
const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});cdpSocket.send(JSON.stringify({id,method,params}));});
await cdp('Page.navigate',{url:'data:text/html,<meta charset="UTF-8"><textarea id="proof" autofocus></textarea>'});
for(let n=0;n<100;n++){const r=await cdp('Runtime.evaluate',{expression:'Boolean(document.querySelector("textarea"))',returnByValue:true});if(r.result.value)break;await new Promise(r=>setTimeout(r,25));}
await cdp('Runtime.evaluate',{expression:'document.querySelector("textarea").focus()'});
await cdp('Page.bringToFront');
socket.write(Buffer.from([5,1,0,80,0,110]));socket.write(Buffer.from([5,0,0,80,0,110]));
keyEvent(0x78,true);keyEvent(0x78,false);
let typed;
for(let n=0;n<100;n++){typed=(await cdp('Runtime.evaluate',{expression:'document.querySelector("textarea").value',returnByValue:true})).result.value;if(typed==='x')break;await new Promise(r=>setTimeout(r,25));}
assert.equal(typed,'x','RFB keyboard reaches the focused native browser window');
await cdp('Runtime.evaluate',{expression:'document.querySelector("textarea").value=""'});
keyEvent(0xffe3,true);keyEvent(0x76,true);keyEvent(0x76,false);keyEvent(0xffe3,false);
let pasted;
for(let n=0;n<100;n++){pasted=(await cdp('Runtime.evaluate',{expression:'document.querySelector("textarea").value',returnByValue:true})).result.value;if(pasted===unicode)break;await new Promise(r=>setTimeout(r,25));}
assert.equal(pasted,unicode);
keyEvent(0xffe1,true);const pointer=Buffer.from([5,1,0,100,0,150]);socket.write(pointer);
await new Promise(r=>setTimeout(r,100));
const owned=await runtime.owned();
assert.equal(JSON.parse(await runtime.run(['exec','--user','1000:1000',owned.Id,'/opt/desktop/x11-proof','held'])).held,true);
const receipt = await runtime.stopViewerAndSettle({leaseId:'integration-1',mayBeWritable:false});
assert.equal(receipt.readOnly,false);assert.equal(receipt.inputResetRequired,true);
socket.destroy();cdpSocket.close();
assert.equal(JSON.parse(await runtime.run(['exec','--user','1000:1000',owned.Id,'/opt/desktop/x11-proof','held'])).held,false);
for(const key of ['vncProcessesExited','xClientsAbsent','heldInputCleared','xSyncComplete']) assert.equal(receipt[key],true,key);
assert.equal((await runtime.status()).displayGeneration,status.displayGeneration);
assert.equal(receipt.browserGeneration,status.browserGeneration);
const after = await runtime.tabs();
assert.deepEqual(after.map(t=>t.id).sort(),before.map(t=>t.id).sort());
const watch = await runtime.startViewer({leaseId:'integration-2',role:'watch'});
assert.equal(watch.role,'watch');
await assert.rejects(runtime.clipboardRead(),/control lease/);
const promoted = await runtime.promoteViewer({leaseId:'integration-2'});
assert.equal(promoted.role,'control');
assert.equal(promoted.previousSettlement.readOnly,true);assert.equal(promoted.previousSettlement.inputResetRequired,false);
assert.notEqual(promoted.pid,watch.pid);
await runtime.stopViewerAndSettle({leaseId:'integration-2'});
const fixture=await readFile(new URL('./input-fixture.py',import.meta.url),'utf8');
const fixtureInput=async action=>JSON.parse(await runtime.run(['exec','--interactive','--user','1000:1000',owned.Id,'python3','-',action],fixture));
await runtime.startViewer({leaseId:'readonly-preserve',role:'watch'});
try {
  assert.deepEqual(await fixtureInput('hold'),{shift:true,button1:true});
  const readonlyReceipt=await runtime.stopViewerAndSettle({leaseId:'readonly-preserve'});
  assert.equal(readonlyReceipt.readOnly,true);assert.equal(readonlyReceipt.inputResetRequired,false);assert.equal(readonlyReceipt.heldInputCleared,false);assert.equal(readonlyReceipt.xClientsAbsent,true);
  assert.deepEqual(await fixtureInput('state'),{shift:true,button1:true});
  const forced=await runtime.stopViewerAndSettle({leaseId:'readonly-preserve',mayBeWritable:true});
  assert.equal(forced.readOnly,false);assert.equal(forced.inputResetRequired,true);assert.equal(forced.heldInputCleared,true);
  assert.deepEqual(await fixtureInput('state'),{shift:false,button1:false});
}finally {await fixtureInput('release');}
await runtime.startViewer({leaseId:'integration-expiry',role:'control',expiresAt:Date.now()+1800});
for(let n=0;n<100;n++){if((await runtime.status()).viewer===null)break;await new Promise(r=>setTimeout(r,25));}
assert.equal((await runtime.status()).viewer,null);
assert.equal((await runtime.stopViewerAndSettle({leaseId:'integration-expiry'})).vncProcessesExited,true);
await writeFile(`${artifact}/integration-result.json`,JSON.stringify({image:runtime.image,containerId:owned.Id,imageId:owned.Image,status,before:before.map(t=>({id:t.id,url:t.url})),actor:{...actor,password:'[redacted]'},receipt,clipboardUnicode:true,clipboardOwnerPidVerified:true,rfbAuthentication:true,rfbCtrlV:true,heldShiftAndButtonReleased:true,readonlyPreservesHeldAgentInputs:true,mayBeWritableForcesFullReset:true,persistentTabs:true,promote:true},null,2));
console.log('persistent desktop integration passed');
