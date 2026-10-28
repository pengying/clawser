import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { CdpBrowser, CdpConnection } from '../src/cdp.mjs';
import { HandoffServer } from '../src/server.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn,label,timeout=2000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await pause(10);}throw new Error(label);}
async function fixture(t,{holdPaint=false,viewport={pageX:0,pageY:0,clientWidth:800,clientHeight:600}}={}){
 let captures=0,wheels=0,visual='before',heldInput,peer;const commands=[];
 const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify([{type:'page',id:'owned',url:'http://fixture.invalid',webSocketDebuggerUrl:`ws://127.0.0.1:${server.address().port}/owned`}]))});
 const sockets=new WebSocketServer({server});
 const finishInput=()=>{if(heldInput){peer.send(JSON.stringify({id:heldInput,result:{}}));heldInput=null;visual='after';}};
 sockets.on('connection',socket=>{peer=socket;socket.on('message',raw=>{
  const command=JSON.parse(String(raw)),{id,method}=command;commands.push(command);
  if(method==='Input.dispatchMouseEvent'&&command.params.type==='mouseWheel'){wheels++;heldInput=id;return;}
  if(method==='Page.captureScreenshot'&&++captures>1){if(holdPaint)return;finishInput();}
  const result=method==='Page.getFrameTree'?{frameTree:{frame:{id:'top',url:'http://fixture.invalid'}}}
   :method==='Page.createIsolatedWorld'?{executionContextId:1}
   :method==='Page.getLayoutMetrics'?{cssVisualViewport:viewport}
   :method==='Runtime.evaluate'?{result:{value:command.params.expression==='globalThis.devicePixelRatio'?1:{document:'f'.repeat(32),regions:[],focus:null}}}
   :method==='Browser.getWindowForTarget'?{windowId:1,bounds:{windowState:'normal'}}
   :method==='Page.captureScreenshot'?{data:'PRIVATE_SCREENSHOT_DATA'}:{};
  socket.send(JSON.stringify({id,result}));
  if(method==='Page.captureScreenshot') socket.send(JSON.stringify({method:'Page.screencastFrame',params:{sessionId:1,data:captures===2&&wheels?'before':visual,metadata:{deviceWidth:800,deviceHeight:600}}}));
 });});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{for(const socket of sockets.clients)socket.terminate();sockets.close();server.close();});
 return{backend:new CdpBrowser({own:`http://127.0.0.1:${server.address().port}`}),commands,captures:()=>captures,wheels:()=>wheels,finishInput,change(){visual='watch';}};
}
test('concurrent paint unblocks original pending wheel; stale first frame preserves completion paint',async t=>{
 const ctx=await fixture(t),frames=[];
 const connection=await ctx.backend.open({profile:'own',targetId:'owned'},{onFrame:frame=>frames.push(frame.data),onClose(){}});t.after(()=>connection.close());
 await connection.input({kind:'scroll',x:.5,y:.5,deltaX:0,deltaY:300});
 await until(()=>frames.includes('after'),'completion paint must recover pixels after stale first frame');
 assert.equal(ctx.wheels(),1);assert.equal(ctx.captures(),3);assert.equal(frames.includes('PRIVATE_SCREENSHOT_DATA'),false);
 const shot=ctx.commands.find(command=>command.method==='Page.captureScreenshot');
 assert.equal(shot.params.captureBeyondViewport,false);assert.equal(Object.hasOwn(shot.params,'clip'),false);
});
async function streamFixture(t,options={}){
 const ctx=await fixture(t,options),handoff=new HandoffServer({backend:ctx.backend});await handoff.start();t.after(()=>handoff.close());
 const invite=await handoff.createShare({owner:'owner',profile:'own',targetId:'owned'}),base=handoff.localUrl+'/s/'+invite.id;
 const post=(action,cookie,body={})=>fetch(base+'/'+action,{method:'POST',headers:{origin:handoff.localUrl,'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body)});
 const claim=await post('claim',null,{token:new URL(invite.url).hash.slice(8)}),cookie=claim.headers.get('set-cookie').split(';')[0];
 const ws=new WebSocket(base.replace('http:','ws:')+'/stream',{headers:{cookie,origin:handoff.localUrl}});ws.on('error',()=>{});t.after(()=>ws.terminate());
 const messages=[];let ack=true,visibility='visible';
 ws.on('message',raw=>{const msg=JSON.parse(String(raw));messages.push(msg);if(ack&&msg.displayId)ws.send(JSON.stringify({type:'displayAck',connectionId:msg.connectionId,displayId:msg.displayId,visibility}));});
 await until(()=>messages.find(msg=>msg.type==='ready'),'stream ready');await post('control',cookie);
 const entry=handoff.streams.get(invite.id);
 return{...ctx,ws,messages,entry,handoff,post:action=>post(action,cookie),setAck:value=>{ack=value;},setVisibility:value=>{visibility=value;},
  wheel(){ws.send(JSON.stringify({type:'input',id:1,connectionId:entry.connectionId,controlId:entry.share.controlId,event:{kind:'scroll',x:.5,y:.5,deltaX:0,deltaY:300}}));}};
}
test('executing input is not reader backpressure: server paint unblocks wheel while entry executes',async t=>{
 const ctx=await streamFixture(t);ctx.wheel();await until(()=>ctx.wheels()===1,'wheel dispatched');assert.equal(ctx.entry.executing,true);
 await until(()=>ctx.messages.some(msg=>msg.type==='inputAck'),'concurrent paint input ACK');
 await until(()=>ctx.messages.some(msg=>msg.type==='frame'&&msg.data==='after'),'completion display');assert.equal(ctx.wheels(),1);
});
test('unacknowledged and hidden viewer demand block assistance until valid ACK/visibility',async t=>{
 const ctx=await streamFixture(t);ctx.setAck(false);ctx.entry.display.metadata({title:'outstanding'});await until(()=>ctx.entry.display.inFlight,'display outstanding');
 ctx.wheel();await pause(250);assert.equal(ctx.captures(),1);
 ctx.ws.send(JSON.stringify({type:'captureVisibility',connectionId:ctx.entry.connectionId,visibility:'visible'}));await pause(50);assert.equal(ctx.captures(),1);
 ctx.ws.send(JSON.stringify({type:'displayAck',connectionId:ctx.entry.connectionId,displayId:ctx.entry.display.inFlight.id,visibility:'hidden'}));await pause(100);assert.equal(ctx.captures(),1);
 ctx.setAck(true);ctx.ws.send(JSON.stringify({type:'captureVisibility',connectionId:ctx.entry.connectionId,visibility:'visible'}));
 await until(()=>ctx.messages.some(msg=>msg.type==='inputAck'),'visible reader resumes pending paint');assert.equal(ctx.wheels(),1);
});
test('release cancels input paint authority and abandoned completion cannot reschedule it',async t=>{
 const ctx=await streamFixture(t);ctx.wheel();await until(()=>ctx.wheels()===1,'wheel pending');await ctx.post('release');ctx.finishInput();await ctx.entry.queue;
 await pause(500);assert.equal(ctx.captures(),1);assert.equal(ctx.wheels(),1);assert.equal(ctx.handoff.store.gate.poisonReason,null);
});
test('paint timeout with a dispatched input preserves uncertainty and never retries input',async t=>{
 const ctx=await streamFixture(t,{holdPaint:true}),original=CdpConnection.prototype.send;let captures=0;
 CdpConnection.prototype.send=function(method,...args){if(method==='Page.captureScreenshot'&&++captures===1)this.commandTimeoutMs=80;return original.call(this,method,...args);};
 try{ctx.wheel();await until(()=>ctx.handoff.store.gate.poisonReason,'paint timeout poisons pending input');assert.equal(ctx.wheels(),1);assert.throws(()=>ctx.handoff.store.gate.enter('agent'),/uncertain/i);}
 finally{CdpConnection.prototype.send=original;}
});

test('a stale watch renderer refreshes passive pixels without input or synthetic frames',async t=>{
 const ctx=await fixture(t),frames=[];
 const connection=await ctx.backend.open({profile:'own',targetId:'owned'},{onFrame:frame=>frames.push(frame.data),onClose(){}});t.after(()=>connection.close());
 ctx.change();await until(()=>frames.includes('watch'),'stale watch paint',2800);
 assert.equal(ctx.wheels(),0);assert.equal(ctx.captures(),2);assert.equal(frames.includes('PRIVATE_SCREENSHOT_DATA'),false);
});
test('oversized paint readback fails closed without clipping or emulation changes',async t=>{
 const ctx=await fixture(t,{viewport:{pageX:400,pageY:2000,clientWidth:10000,clientHeight:8000}});
 await assert.rejects(ctx.backend.open({profile:'own',targetId:'owned'},{onFrame(){},onClose(){}}),/too large/);
 assert.equal(ctx.commands.some(command=>command.method==='Page.captureScreenshot'),false);
 assert.equal(ctx.commands.some(command=>command.method.startsWith('Emulation.')),false);
});
