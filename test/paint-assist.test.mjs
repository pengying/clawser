import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaintAssist } from '../src/paint-assist.mjs';
const deferred = () => { let resolve, reject; const promise = new Promise((r,j) => { resolve=r; reject=j; }); return { promise, resolve, reject }; };
const settle = async () => { for (let n=0;n<12;n++) await Promise.resolve(); };
class Clock {
  now=0; id=0; timers=new Map();
  set=(fn,delay)=>{const id=++this.id;this.timers.set(id,{at:this.now+delay,fn});return id;};
  clear=id=>this.timers.delete(id);
  async tick(ms){const end=this.now+ms;for(;;){const next=[...this.timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;this.timers.delete(next[0]);this.now=next[1].at;next[1].fn();await settle();}this.now=end;await settle();}
}
function fixture(paint){
 const clock=new Clock(),calls=[],state={live:true,demand:true,control:'control-1'};
 const scheduler=new PaintAssist({now:()=>clock.now,setTimer:clock.set,clearTimer:clock.clear,getState:()=>state,
  paint:async context=>{context.onDispatch();calls.push(clock.now);return paint?.(context);},onError(){}});
 scheduler.start();return{clock,calls,state,scheduler};
}
test('input-start paints independently while original input is pending, then completion requests another paint',async()=>{
 const {clock,calls,scheduler}=fixture();const input=scheduler.inputStarted();
 await clock.tick(99);assert.deepEqual(calls,[]);await clock.tick(1);assert.deepEqual(calls,[100]);
 scheduler.inputCompleted(input);scheduler.frame();await clock.tick(199);assert.deepEqual(calls,[100]);
 await clock.tick(1);assert.deepEqual(calls,[100,300],'a stale first frame cannot erase completion');scheduler.stop();
});
test('completion during an in-flight paint survives until a later dispatch',async()=>{
 const held=deferred(),{clock,calls,scheduler}=fixture(()=>held.promise);const input=scheduler.inputStarted();
 await clock.tick(100);scheduler.inputCompleted(input);scheduler.frame();await clock.tick(500);assert.deepEqual(calls,[100]);
 held.resolve();await settle();await clock.tick(0);assert.deepEqual(calls,[100,600]);scheduler.stop();
});
test('input bursts preserve the earliest deadline, coalesce one hint and share the watch rate limit',async()=>{
 const {clock,calls,scheduler}=fixture();
 for(let n=0;n<20;n++){scheduler.inputCompleted(scheduler.inputStarted());await clock.tick(10);assert.ok(clock.timers.size<=1);}
 assert.equal(calls[0],100,'later hints must not starve earlier work');
 await clock.tick(2500);
 assert.ok(calls.every((at,n)=>!n||at-calls[n-1]>=200));assert.ok(calls.length<8);scheduler.stop();
});
test('fresh ordinary frames postpone stale watch work but never erase explicit completion',async()=>{
 const {clock,calls,scheduler}=fixture();await clock.tick(1900);scheduler.frame();await clock.tick(1000);assert.deepEqual(calls,[]);
 await clock.tick(1000);assert.deepEqual(calls,[3900]);scheduler.stop();
});
test('hidden or nonreading viewers keep one hint with no polling and resume only on demand',async()=>{
 const {clock,calls,state,scheduler}=fixture();state.demand=false;scheduler.inputStarted();await clock.tick(10000);
 assert.deepEqual(calls,[]);assert.equal(clock.timers.size,0);
 state.demand=true;scheduler.demandChanged();await clock.tick(0);assert.deepEqual(calls,[10000]);scheduler.stop();
});
for(const action of ['release','navigation','close'])test(`${action} invalidates start and late completion authority`,async()=>{
 const {clock,calls,scheduler,state}=fixture();const input=scheduler.inputStarted();
 if(action==='release'){state.control=null;scheduler.release();}
 if(action==='navigation'){scheduler.navigationStarted();scheduler.navigationCommitted();}
 if(action==='close')scheduler.stop();
 scheduler.inputCompleted(input);await clock.tick(500);assert.deepEqual(calls,[]);
 if(action!=='close'){await clock.tick(2000);assert.equal(calls.length,1,'healthy watch authority survives control retirement');}scheduler.stop();
});
test('closed in-flight paint cannot revive timers after settling',async()=>{
 const held=deferred(),{clock,calls,scheduler}=fixture(()=>held.promise);scheduler.inputStarted();await clock.tick(100);
 scheduler.stop();held.resolve();await settle();await clock.tick(10000);assert.deepEqual(calls,[100]);assert.equal(clock.timers.size,0);
});
test('cooldown is measured at actual screenshot dispatch after asynchronous preparation',async()=>{
 const clock=new Clock(),calls=[],prepare=deferred(),state={live:true,demand:true,control:'control'};let first=true;
 const scheduler=new PaintAssist({now:()=>clock.now,setTimer:clock.set,clearTimer:clock.clear,getState:()=>state,onError(){},
 paint:async context=>{if(first){first=false;await prepare.promise;}context.onDispatch();calls.push(clock.now);}});
 scheduler.start();const input=scheduler.inputStarted();await clock.tick(100);scheduler.inputCompleted(input);await clock.tick(500);
 prepare.resolve();await settle();await clock.tick(199);assert.deepEqual(calls,[600]);await clock.tick(1);assert.deepEqual(calls,[600,800]);scheduler.stop();
});
test('a late demand guard denial requeues one obligation until valid demand returns',async()=>{
 let valid=false;const {clock,calls,state,scheduler}=fixture(context=>{if(!valid){state.demand=false;return false;}});
 scheduler.inputStarted();await clock.tick(100);assert.equal(calls.length,1);assert.equal(clock.timers.size,0);
 valid=true;state.demand=true;scheduler.demandChanged();await clock.tick(200);assert.equal(calls.length,2);scheduler.stop();
});

test('fresh frames retire a stale-watch request while its preparation is pending',async()=>{
 const clock=new Clock(),prepare=deferred(),calls=[],state={live:true,demand:true,control:'control'};
 const scheduler=new PaintAssist({now:()=>clock.now,setTimer:clock.set,clearTimer:clock.clear,getState:()=>state,onError(){},
 paint:async context=>{await prepare.promise;if(!context.isCurrent())return false;if(context.onDispatch())calls.push(clock.now);}});
 scheduler.start();await clock.tick(2000);scheduler.frame();prepare.resolve();await settle();await clock.tick(1000);
 assert.deepEqual(calls,[]);scheduler.stop();
});
test('binding or viewer-generation retirement is permanent even when old read completes late',async()=>{
 const held=deferred(),{clock,calls,scheduler,state}=fixture(()=>held.promise);const input=scheduler.inputStarted();await clock.tick(100);
 state.live=false;scheduler.demandChanged();state.live=true;held.resolve();scheduler.inputCompleted(input);await settle();await clock.tick(5000);
 assert.deepEqual(calls,[100]);assert.equal(clock.timers.size,0);
});
test('navigation during read preserves only new-document watch authority',async()=>{
 const held=deferred(),{clock,calls,scheduler}=fixture(()=>held.promise);const input=scheduler.inputStarted();await clock.tick(100);
 scheduler.navigationStarted();scheduler.navigationCommitted();scheduler.inputCompleted(input);held.resolve();await settle();
 await clock.tick(1999);assert.deepEqual(calls,[100]);await clock.tick(1);assert.deepEqual(calls,[100,2100]);scheduler.stop();
});
