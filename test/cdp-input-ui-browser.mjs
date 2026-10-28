// Full viewer acceptance using two disposable browsers, never operator Chrome.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CdpBrowser, CdpConnection } from '../src/cdp.mjs';
import { HandoffServer } from '../src/server.mjs';
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=8000) { const start=performance.now();while(performance.now()-start<timeout){try{const value=await fn();if(value)return value;}catch{}await pause(20);}throw new Error('Timed out: '+label); }
const directory=await mkdtemp(join(tmpdir(),'cdp-input-ui-'));
const fixture=createServer((req,res)=>{
  res.setHeader('content-type','text/html');
  const base=`http://127.0.0.1:${fixture.address().port}`;
  if(req.url.startsWith('/child')) return res.end('<style>body{margin:0}input{position:absolute;top:10px;left:10px;width:240px;height:35px}</style><input id=child><script>document.addEventListener("input",()=>parent.postMessage({dummyValue:child.value},"*"))</script>');
  res.end(`<!doctype html><style>body{margin:0;height:2000px}input,textarea,[contenteditable],select{position:absolute;left:20px;width:240px;height:35px;box-sizing:border-box}#textField{top:20px}#password{top:80px}#area{top:140px;height:55px}#editable{top:210px}#choice{top:280px}#color{top:280px;left:300px}#frame{position:absolute;left:20px;top:360px;width:340px;height:120px;border:0}#marker{position:fixed;left:740px;top:10px;width:50px;height:50px;background:rgb(200,20,20)}</style><input id=textField><input id=password type=password><textarea id=area></textarea><div id=editable contenteditable=true></div><select id=choice><option value=first>First</option><option value=second>Second</option></select><input id=color type=color value="#112233"><iframe id=frame src="${req.url.includes('opaque')?base.replace('127.0.0.1','localhost'):base}/child"></iframe><div id=marker></div><script>window.dummyValue='';window.lastInputAt=0;window.lastScrollAt=0;document.addEventListener('input',()=>{lastInputAt=Date.now();marker.style.background='rgb(20,200,20)'});addEventListener('scroll',()=>{lastScrollAt=Date.now();marker.style.background='rgb(20,20,200)'});addEventListener('message',e=>{if(e.source===frame.contentWindow){dummyValue=e.data.dummyValue;marker.style.background='rgb(20,200,20)'}});</script>`);
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const fixtureBase=`http://127.0.0.1:${fixture.address().port}`;
const launch=profile=>spawn(process.env.CHROME_BIN||'/usr/bin/google-chrome-stable',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--site-per-process','--remote-debugging-port=0',`--user-data-dir=${profile}`],{stdio:'ignore'});
const targetChrome=launch(join(directory,'target')), viewerChrome=launch(join(directory,'viewer'));
let handoff,remote,viewer,currentInvite;
const report={cases:[],timings:[]};
const evaluate=async(cdp,expression)=>{const r=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error('fixture evaluation failed');return r.result.value;};
const targetEval=expression=>evaluate(remote,expression),viewerEval=expression=>evaluate(viewer,expression);
async function click(x,y){await viewer.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await viewer.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});}
async function clickElement(id){const p=await viewerEval(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);await click(p.x,p.y);}
async function tapRemote(x,y){const p=await viewerEval(`(()=>{const r=document.getElementById('screen').getBoundingClientRect();return{x:r.x+r.width*${x}/800,y:r.y+r.height*${y}/600}})()`);await viewer.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:1}]});await viewer.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
async function settled(){await until(()=>viewerEval('window.qaPending===0'),'viewer input settled');await handoff.streams.get(currentInvite.id)?.queue;}
async function begin(targetId){currentInvite=await handoff.createShare({owner:'fixture',profile:'fixture',targetId,ttlMs:120000});await viewer.send('Page.navigate',{url:currentInvite.url});await until(()=>viewerEval('document.getElementById("control")&&!document.getElementById("control").disabled'),'takeover available');await clickElement('control');await until(()=>viewerEval('document.getElementById("badge").textContent === "YOU HAVE CONTROL"'),'human control');}
async function done(){await settled();await clickElement('done');await until(()=>!handoff.streams.has(currentInvite.id),'Done closes stream');assert.equal(handoff.store.gate.locked,false);}
async function keyboard(){await clickElement('keyboardButton');await until(()=>viewerEval('["text","passwordProxy","multilineProxy"].includes(document.activeElement.id)'),'keyboard proxy focused');await settled();}
async function painted(channel){return viewerEval(`(()=>{const c=document.getElementById('screen');const p=c.getContext('2d').getImageData(Math.floor(c.width*765/800),Math.floor(c.height*35/600),1,1).data;return p[${channel}]>150&&p[${(channel+1)%3}]<80&&p[${(channel+2)%3}]<80})()`);}
try{
 const targetPort=await until(async()=>(await readFile(join(directory,'target','DevToolsActivePort'),'utf8')).split('\n')[0],'target Chrome');
 const viewerPort=await until(async()=>(await readFile(join(directory,'viewer','DevToolsActivePort'),'utf8')).split('\n')[0],'viewer Chrome');
 const targetBase=`http://127.0.0.1:${targetPort}`,viewerBase=`http://127.0.0.1:${viewerPort}`;
 const newTab=async(base,url)=>(await(await fetch(`${base}/json/new?${encodeURIComponent(url)}`,{method:'PUT'})).json());
 const target=await newTab(targetBase,fixtureBase+'/same'),phone=await newTab(viewerBase,'about:blank');
 remote=await new CdpConnection().connect(target.webSocketDebuggerUrl);viewer=await new CdpConnection().connect(phone.webSocketDebuggerUrl);
 await remote.send('Page.enable');await remote.send('Emulation.setDeviceMetricsOverride',{width:800,height:600,deviceScaleFactor:1,mobile:false});
 await viewer.send('Page.enable');await viewer.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
 await viewer.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.qaPending=0;window.qaErrors=[];const Socket=WebSocket;window.WebSocket=class extends Socket{constructor(...a){super(...a);this.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.type==='inputAck'||m.type==='error')qaPending--;if(m.type==='error')qaErrors.push(m.error)})}send(data){if(JSON.parse(data).type==='input')qaPending++;return super.send(data)}}`});
 handoff=new HandoffServer({backend:new CdpBrowser({fixture:targetBase})});await handoff.start();
 await until(()=>targetEval('document.readyState === "complete"'),'target loaded');
 // Repeat complete invitations on the same unchanged target, then another tab.
 for(let cycle=0;cycle<3;cycle++){
  await begin(target.id);await tapRemote(150,37);await until(()=>viewerEval('document.activeElement.id === "text"'),'text proxy after repeated open');
  await viewer.send('Input.insertText',{text:'cycle'+cycle+'😀'});await settled();
  assert.ok((await targetEval('textField.value')).includes('cycle'+cycle+'😀'));
  await viewerEval('document.activeElement.blur()');await keyboard();await viewer.send('Input.insertText',{text:' reopened'});await settled();
  assert.ok((await targetEval('textField.value')).includes('reopened'));
  report.cases.push('same unchanged tab invitation '+(cycle+1));await done();
 }
 const second=await newTab(targetBase,fixtureBase+'/same');remote.close();remote=await new CdpConnection().connect(second.webSocketDebuggerUrl);await remote.send('Page.enable');await remote.send('Emulation.setDeviceMetricsOverride',{width:800,height:600,deviceScaleFactor:1,mobile:false});await until(()=>targetEval('document.readyState === "complete"'),'second tab loaded');await begin(second.id);
 for(const [id,y,proxy]of[['textField',37,'text'],['password',97,'passwordProxy'],['area',160,'multilineProxy'],['editable',225,'multilineProxy']]){
  await tapRemote(150,y);await until(()=>viewerEval(`document.activeElement.id===${JSON.stringify(proxy)}`),id+' proxy');
  await viewer.send('Input.insertText',{text:'Unicode 😀 日本'});await settled();assert.equal(await targetEval(`${id}.${id==='editable'?'textContent':'value'}`),'Unicode 😀 日本');report.cases.push(id+' Unicode');
 }
 await tapRemote(150,37);await settled();await targetEval('textField.value="";textField.setSelectionRange(0,0);marker.style.background="rgb(200,20,20)"');await until(()=>painted(0),'red baseline paint');
 const start=performance.now();await viewer.send('Input.insertText',{text:'Measured'});await until(()=>targetEval('textField.value === "Measured"'),'typing delivery');const delivered=performance.now();await until(()=>painted(1),'typing visibly painted');report.timings.push({kind:'typing',deliveryMs:delivered-start,visibleMs:performance.now()-start});await settled();
 await viewer.send('Input.imeSetComposition',{text:'日本',selectionStart:2,selectionEnd:2});assert.equal(await targetEval('textField.value'),'Measured','IME preedit is local');await viewer.send('Input.insertText',{text:'日本'});await settled();assert.equal(await targetEval('textField.value'),'Measured日本');report.cases.push('IME commits once');
 await viewerEval(`(()=>{const e=new ClipboardEvent('paste',{clipboardData:new DataTransfer(),bubbles:true,cancelable:true});e.clipboardData.setData('text/plain',' clipboard 😀');document.activeElement.dispatchEvent(e)})()`);await settled();assert.equal(await targetEval('textField.value'),'Measured日本 clipboard 😀');report.cases.push('clipboard');
 await tapRemote(150,385);await until(()=>viewerEval('document.activeElement.id==="text"'),'same-origin child proxy');await viewer.send('Input.insertText',{text:'child'});await settled();assert.equal(await targetEval('dummyValue'),'child');report.cases.push('same-origin child typing');
 const oldFocus=handoff.streams.get(currentInvite.id).display.currentMetadata.interactions.focus;
 await targetEval('frame.src=frame.src+"?navigation"');await until(()=>targetEval('frame.contentDocument?.readyState === "complete" && frame.contentDocument.getElementById("child").value === ""'),'child navigation');
 await assert.rejects(handoff.streams.get(currentInvite.id).connection.input({kind:'edit',operation:'insert',text:'STALE',focusToken:oldFocus.token}),/focus|field|changed/i);assert.equal(await targetEval('frame.contentDocument.getElementById("child").value'),'');report.cases.push('same-origin child navigation rejects old focus');
 await tapRemote(150,37);await settled();const before=performance.now();await viewerEval(`(()=>{const c=document.getElementById('screen'),r=c.getBoundingClientRect();c.dispatchEvent(new WheelEvent('wheel',{clientX:r.x+r.width*.8,clientY:r.y+r.height*.8,deltaY:300,bubbles:true,cancelable:true}))})()`);await until(()=>targetEval('scrollY>0'),'scroll delivery');const scrollDelivery=performance.now();await until(()=>painted(2),'scroll visible paint');report.timings.push({kind:'scroll',deliveryMs:scrollDelivery-before,visibleMs:performance.now()-before});await settled();
 report.cases.push('different tab and scroll');await done();
 await remote.send('Page.navigate',{url:fixtureBase+'/opaque'});await until(()=>targetEval('document.readyState === "complete"'),'opaque loaded');await begin(second.id);await tapRemote(150,385);await settled();
 const opaqueProxy=await viewerEval('document.activeElement.id');await viewerEval(`window.qaGuardMessages=[];new MutationObserver(()=>qaGuardMessages.push(document.getElementById('status').textContent)).observe(document.getElementById('status'),{childList:true,subtree:true,characterData:true})`);await clickElement('keyboardButton');await pause(50);report.opaque={proxyAfterTap:opaqueProxy,keyboardStatus:await viewerEval('document.getElementById("status").textContent'),guardMessages:await viewerEval('qaGuardMessages')};
 console.log(JSON.stringify(report,null,2));
 assert.equal(await viewerEval('document.activeElement.id'),'text','explicit Keyboard must support cross-origin OOPIF focus');
 await settled();
 await targetEval('marker.style.background="rgb(200,20,20)"');await until(()=>painted(0),'opaque red baseline');
 const nativeStart=performance.now();await viewer.send('Input.insertText',{text:'Opaque 😀 日本'});
 await until(()=>targetEval('dummyValue === "Opaque 😀 日本"'),'opaque typing delivery');const nativeDelivery=performance.now();
 await until(()=>painted(1),'opaque typing visible paint');report.timings.push({kind:'native opaque typing',deliveryMs:nativeDelivery-nativeStart,visibleMs:performance.now()-nativeStart});await settled();
 assert.equal(await targetEval('dummyValue'),'Opaque 😀 日本');
 await viewer.send('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});
 assert.equal(await targetEval('dummyValue'),'Opaque 😀 日本','opaque IME preedit stays local');
 await viewer.send('Input.insertText',{text:'中文'});await settled();
 await viewerEval(`(()=>{const e=new ClipboardEvent('paste',{clipboardData:new DataTransfer(),bubbles:true,cancelable:true});e.clipboardData.setData('text/plain',' pasted');document.activeElement.dispatchEvent(e)})()`);await settled();
 assert.equal(await targetEval('dummyValue'),'Opaque 😀 日本中文 pasted');
 await viewerEval('document.activeElement.blur()');await keyboard();await viewer.send('Input.insertText',{text:' reopened'});await settled();
 assert.equal(await targetEval('dummyValue'),'Opaque 😀 日本中文 pasted reopened');
 report.cases.push('opaque explicit Keyboard Unicode/IME/paste/reopen');
 await done();
 for(let cycle=0;cycle<2;cycle++) {
  const before=await targetEval('dummyValue');
  await begin(second.id);await tapRemote(150,385);await settled();
  assert.notEqual(await viewerEval('document.activeElement.id'),'text','opaque taps never auto-enable keyboard');
  await keyboard();await viewer.send('Input.insertText',{text:' repeat'+cycle+'😀'});await settled();
  assert.equal((await targetEval('dummyValue')).replace(' repeat'+cycle+'😀',''),before);
  await done();report.cases.push('repeated opaque invitation '+(cycle+2));
 }
 console.log(JSON.stringify({opaqueGreen:true,cases:report.cases,timings:report.timings},null,2));
}finally{
 remote?.close();viewer?.close();await handoff?.close();await new Promise(resolve=>fixture.close(resolve));
 for(const child of[targetChrome,viewerChrome])if(child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
 await rm(directory,{recursive:true,force:true,maxRetries:3});
}
