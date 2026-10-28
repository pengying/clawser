import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpBrowser, CdpConnection } from '../src/cdp.mjs';
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let n=0;n<160;n++){try{const result=await fn();if(result)return result;}catch{}await pause(20);}throw new Error('Disposable browser startup');}

test('discard-only paint assistance preserves viewport and another CDP session emulation',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'paint-geometry-'));
 const fixture=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<style>body{height:2400px}</style><input id=field>');});
 await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
 const chrome=spawn(process.env.CHROME_BIN||'/usr/bin/google-chrome-stable',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${directory}`],{stdio:'ignore'});
 let remote,connection;
 t.after(async()=>{await connection?.close();remote?.close();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));if(chrome.exitCode===null){const exited=once(chrome,'exit');chrome.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(chrome.exitCode===null)chrome.kill('SIGKILL');}await rm(directory,{recursive:true,force:true,maxRetries:3});});
 const port=await until(async()=>(await readFile(join(directory,'DevToolsActivePort'),'utf8')).split('\n')[0]),base=`http://127.0.0.1:${port}`;
 const tab=await(await fetch(base+'/json/new?'+encodeURIComponent(`http://127.0.0.1:${fixture.address().port}`),{method:'PUT'})).json();
 remote=await new CdpConnection().connect(tab.webSocketDebuggerUrl);
 await remote.send('Emulation.setDeviceMetricsOverride',{width:800,height:600,deviceScaleFactor:2,mobile:false});
 const evaluate=async expression=>(await remote.send('Runtime.evaluate',{expression,returnByValue:true})).result.value;
 await until(()=>evaluate('document.readyState === "complete" && innerWidth === 800 && innerHeight === 600 && devicePixelRatio === 2'));
 const expression='({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollY})',before=await evaluate(expression);
 connection=await new CdpBrowser({own:base}).open({profile:'own',targetId:tab.id},{onFrame(){},onClose(){}});
 assert.deepEqual(await evaluate(expression),before,'initial paint cannot change viewport or DPR');
 await connection.input({kind:'text',text:'dummy'});await pause(400);
 assert.deepEqual(await evaluate(expression),before,'background assist cannot change viewport or DPR');
});
