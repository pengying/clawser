// Disposable Chromium fixture. Never attaches to an operator browser/profile.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CdpBrowser, CdpConnection } from '../src/cdp.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let n=0;n<200;n++) { try { const result=await fn(); if(result) return result; } catch {} await pause(25); } throw new Error('Timed out: '+label); }
const directory = await mkdtemp(join(tmpdir(), 'cdp-input-browser-'));
const fixture = createServer((req,res) => {
  res.setHeader('content-type','text/html');
  const base = `http://127.0.0.1:${fixture.address().port}`;
  const child = '<style>body{margin:0}input{position:absolute;left:20px;top:20px;width:240px;height:40px}</style><input id=child placeholder="Dummy cross-origin field"><script>document.addEventListener("input",()=>parent.postMessage({dummyValue:child.value},"*"))</script>';
  if(req.url.startsWith('/child')) return res.end(child);
  res.end(`<style>body{height:2400px;margin:0}input,select{position:absolute;left:20px;top:20px;width:240px;height:40px}iframe{position:absolute;left:20px;top:120px;width:360px;height:160px;border:0}</style><input id=topfield><select style="left:300px"><option>First</option><option>Second</option></select><iframe id=frame src="${req.url.includes('opaque') ? base.replace('127.0.0.1','localhost') : base}/child"></iframe><script>window.dummyValue='';window.addEventListener('message',e=>{if(e.source===frame.contentWindow)dummyValue=e.data.dummyValue});</script>`);
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const fixtureBase=`http://127.0.0.1:${fixture.address().port}`;
const chrome=spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome-stable',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--site-per-process','--remote-debugging-port=0',`--user-data-dir=${directory}`],{stdio:'ignore'});
let remote, connection;
const evidence={cases:[],timings:[]};
const evaluate=async expression=>{const result=await remote.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails) throw new Error('fixture evaluation failed');return result.result.value;};
try {
  const port=await until(async()=>(await readFile(join(directory,'DevToolsActivePort'),'utf8')).split('\n')[0],'Chrome start');
  const base=`http://127.0.0.1:${port}`, backend=new CdpBrowser({fixture:base});
  const tab=await(await fetch(`${base}/json/new?${encodeURIComponent(fixtureBase)}`,{method:'PUT'})).json();
  remote=await new CdpConnection().connect(tab.webSocketDebuggerUrl);
  await remote.send('Emulation.setDeviceMetricsOverride',{width:800,height:600,deviceScaleFactor:1,mobile:false});
  await remote.send('Page.enable');
  const navigations=[]; remote.on('Page.frameNavigated',p=>navigations.push({event:'navigated',parent:!!p.frame.parentId,url:p.frame.url}));
  remote.on('Page.frameStartedLoading',p=>navigations.push({event:'started',frameId:p.frameId}));
  remote.on('Page.frameStoppedLoading',p=>navigations.push({event:'stopped',frameId:p.frameId}));
  for(const mode of ['same','opaque']) {
    await remote.send('Page.navigate',{url:fixtureBase+'/'+mode});
    await until(()=>evaluate('document.readyState === "complete"'),'fixture '+mode);
    let metadata,frames=0;
    connection=await backend.open({profile:'fixture',targetId:tab.id},{onFrame(){frames++;},onMetadata(next){if(next.interactions)metadata=next.interactions;},onClose(){}});
    await until(()=>frames&&metadata,'frame and metadata');
    const tap=await connection.input({kind:'click',x:80/800,y:160/600});
    const nativeFrames=(await remote.send('Target.getTargets')).targetInfos.filter(info=>info.type==='iframe');
    const outcome={mode,iframeContentDocument:await evaluate('!!frame.contentDocument'),oopifCount:nativeFrames.length,childEditableRegions:metadata.regions.filter(r=>r.kind==='editable'&&r.y>.2).length,tapFocus:!!tap.focus};
    evidence.cases.push(outcome);
    if(mode==='same') {
      assert.ok(tap.focus?.token,'same-origin tap confirms focus');
      const start=performance.now();
      await connection.input({kind:'edit',operation:'insert',focusToken:tap.focus.token,text:'dummy 😀 日本'});
      await until(()=>evaluate('dummyValue === "dummy 😀 日本"'),'same-origin input delivery');
      evidence.timings.push({kind:'typing',inputDeliveryMs:performance.now()-start});
    } else {
      // Opaque focus never gains DOM field identity. Only the explicit manual
      // Keyboard request may mint a separate frame-scoped native token.
      const activated=await connection.input({kind:'nativeKeyboardOpen',document:metadata.document});
      outcome.manualKeyboard=Boolean(activated.keyboard?.token);
      await connection.input({kind:'nativeEdit',keyboardToken:activated.keyboard.token,operation:'insert',text:'NATIVE_DUMMY'});
      await until(()=>evaluate('dummyValue === "NATIVE_DUMMY"'),'opaque native diagnostic');
      const before=navigations.length;
      await evaluate('frame.src=frame.src+"?next"');
      await pause(250);
      outcome.subframeNavigationEvents=navigations.slice(before);
      const refocus=await connection.input({kind:'click',x:80/800,y:160/600});
      outcome.refocusAfterChildNavigation=!!refocus.focus;
    }
    const beforeScroll=frames,start=performance.now();
    await connection.input({kind:'scroll',x:.8,y:.7,deltaX:0,deltaY:300});
    await until(()=>evaluate('scrollY>0'),'scroll delivery');
    const delivered=performance.now();
    await until(()=>frames>beforeScroll,'scroll visible frame');
    evidence.timings.push({mode,kind:'scroll',inputDeliveryMs:delivered-start,nextStreamFrameMs:performance.now()-start});
    await connection.close(); connection=null;
  }
  console.log(JSON.stringify(evidence,null,2));
  assert.ok(evidence.cases[1].manualKeyboard,'cross-origin OOPIF frame explicitly permits native keyboard');
} finally {
  await connection?.close(); remote?.close(); await new Promise(resolve=>fixture.close(resolve));
  if(chrome.exitCode===null) { const exited=once(chrome,'exit');chrome.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(chrome.exitCode===null)chrome.kill('SIGKILL'); }
  await rm(directory,{recursive:true,force:true,maxRetries:3});
}
