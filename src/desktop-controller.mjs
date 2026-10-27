import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ControlGate } from './leases.mjs';
import { NoVncProbeGateway } from './novnc-probe.mjs';
import { CdpConnection, validateCdpUrl } from './cdp.mjs';
import { DesktopRpcServer } from './desktop-rpc.mjs';

const receiptFlags=['vncProcessesExited','xClientsAbsent','heldInputCleared','xSyncComplete'];
const recoveryMessage='Browser input outcome uncertain; operator recovery is required';
const validateActor=(actor,id,role)=>{if(actor?.leaseId!==id||actor.role!==role||!Number.isSafeInteger(actor.epoch)||actor.epoch<1||typeof actor.displayGeneration!=='string'||!actor.displayGeneration||typeof actor.browserGeneration!=='string'||!actor.browserGeneration)throw new Error('Viewer authority identity is invalid');};
const inputFenced=receipt=>receipt?.vncProcessesExited===true&&receipt?.xClientsAbsent===true&&((receipt.readOnly===true&&receipt.inputResetRequired===false)||receiptFlags.every(key=>receipt[key]===true));
const safeCompletion=row=>inputFenced(row.receipt)&&((row.mayBeWritable===false&&row.receipt.readOnly===true)||row.receipt.snapshotObserved===true);
const terminal=row=>row.state==='ended'||row.state==='recovery_required';
const ownerParts=value=>{let parts;try{parts=JSON.parse(value);}catch{}if(!Array.isArray(parts)||parts.length!==2||parts.some(x=>typeof x!=='string'||!x||x.length>1000))throw new Error('Invalid owner session');return parts;};
const checkedKey=value=>{if(typeof value!=='string'||!value||value.length>4096)throw new Error('Invalid browser call key');return value;};
const targetIdentity=tab=>typeof (tab.id||tab.targetId)==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(tab.id||tab.targetId)?tab.id||tab.targetId:undefined;
const browserPage=tab=>tab?.type==='page'&&targetIdentity(tab)&&!String(tab.url||'').startsWith('chrome://omnibox-popup');
const observedContext=observation=>typeof observation.observedTargetId==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(observation.observedTargetId)?{observedTargetId:observation.observedTargetId,targetChanged:observation.targetChanged===true}:{targetChanged:false};

// Focus is a service-owned UI action. The caller reserves the automation gate
// through viewer startup so the initial watch stream shows this exact task.
export async function activateDesktopTarget(runtime,targetId){
  const origin=validateCdpUrl(runtime.cdpUrl).origin;
  const tabs=await runtime.tabs();
  if(!Array.isArray(tabs)||tabs.length>1000)throw new Error('Requested browser target is unavailable');
  const target=tabs.find(tab=>browserPage(tab)&&targetIdentity(tab)===targetId);
  if(!target)throw new Error('Requested browser target is unavailable');
  const endpoint=new URL(target.webSocketDebuggerUrl);
  if(endpoint.protocol!=='ws:'||endpoint.host!==new URL(origin).host||endpoint.username||endpoint.password)throw new Error('Requested browser target has an invalid local endpoint');
  const page=await new CdpConnection({commandTimeoutMs:3000}).connect(endpoint.href);
  try{
    const window=await page.send('Browser.getWindowForTarget',{targetId});
    if(!Number.isInteger(window?.windowId))throw new Error('Requested browser target window is unavailable');
    if(window.bounds?.windowState==='minimized')await page.send('Browser.setWindowBounds',{windowId:window.windowId,bounds:{windowState:'normal'}});
    await page.send('Page.bringToFront');
  }finally{page.close();}
  return{targetId};
}

// This connection observes state only. The resumed agent still needs a normal
// browser snapshot and task-specific success check before issuing more input.
export async function observeDesktop(runtime, row) {
  const status=await runtime.status();
  if(status.ready!==true||!status.displayGeneration)throw new Error('Browser observation unavailable');
  const origin=validateCdpUrl(runtime.cdpUrl).origin;
  const versionResponse=await fetch(`${origin}/json/version`,{redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!versionResponse.ok)throw new Error('Browser observation unavailable');
  const version=await versionResponse.json();
  const connect=async url=>{
    const endpoint=new URL(url);
    if(endpoint.protocol!=='ws:'||endpoint.host!==new URL(origin).host||endpoint.username||endpoint.password)throw new Error('Invalid local CDP endpoint');
    return new CdpConnection().connect(endpoint.href);
  };
  const browser=await connect(version.webSocketDebuggerUrl);
  try{await browser.send('Browser.getVersion');}finally{browser.close();}
  const tabs=await runtime.tabs();
  if(!Array.isArray(tabs)||tabs.length>1000)throw new Error('Browser observation unavailable');
  const pages=tabs.filter(browserPage);
  const original=pages.find(tab=>targetIdentity(tab)===row.targetId);
  const candidates=original?[original,...pages.filter(tab=>tab!==original)]:pages;
  for(const target of candidates){
    let page;
    try{
      page=await connect(target.webSocketDebuggerUrl);
      const tree=await page.send('Page.getFrameTree');
      if(!tree?.frameTree?.frame?.id)continue;
      const observedTargetId=targetIdentity(target);
      return{snapshotObserved:true,displayGeneration:status.displayGeneration,browserGeneration:status.browserGeneration||status.displayGeneration,observedTargetId,targetChanged:!!row.targetId&&observedTargetId!==row.targetId};
    }catch{}finally{page?.close();}
  }
  throw new Error('No browser page can be freshly observed');
}

export class DesktopController {
  gate=new ControlGate();
  ledger={version:1,calls:{},leases:{}};
  actors=new Map();
  heartbeatWork=new Map();
  createGeneration=0;
  writes=Promise.resolve();
  runtimeQueue=Promise.resolve();
  constructor({stateDir,profile,runtime,transport,port=19410,socketPath,noVncAssetsDir,supervisorHeartbeatMs=5000,observe=observeDesktop,activateTarget=activateDesktopTarget,gatewayFactory=options=>new NoVncProbeGateway(options),...gatewayOptions}={}) {
    if(!stateDir||!profile||!runtime||!transport)throw new Error('Desktop controller requires stateDir, profile, runtime and transport');
    if(!Number.isInteger(supervisorHeartbeatMs)||supervisorHeartbeatMs<1||supervisorHeartbeatMs>5000)throw new Error('Invalid supervisor heartbeat interval');
    Object.assign(this,{stateDir:resolve(stateDir),profile,runtime,transport,port,observe,activateTarget,supervisorHeartbeatMs});
    this.socketPath=socketPath||join(this.stateDir,'desktop.sock');
    this.transport.on?.('failure',()=>{void this.transportFailed();});
    this.supervisor={create:params=>this.createActor(params),read:async id=>({state:this.actors.has(id)?'running':'stopped'}),register:params=>this.registration(params.ownedId),promote:params=>this.promote(params),cancelPromotion:id=>this.cancelPromotion(id),destroy:(id,options)=>this.retire(id,options),verifyExited:async id=>this.ledger.leases[id]?.state==='ended'&&safeCompletion(this.ledger.leases[id]),clipboardRead:id=>this.clipboard(id),clipboardWrite:(id,text)=>this.clipboard(id,text)};
    this.gateway=gatewayFactory({...gatewayOptions,supervisor:this.supervisor,noVncAssetsDir,prefix:'/browser/',completionDisposition:'retained',capabilities:{clipboard:'utf8'},maxProbes:1,promotionMs:120_000,onEnded:(session,status)=>this.ended(session,status)});
    this.rpc=new DesktopRpcServer({socketPath:this.socketPath,handler:(method,params,context)=>this.request(method,params,context),onDisconnect:keys=>this.disconnected(keys),onLockLost:()=>{this.poison();this.ready=false;void this.gateway.close();}});
  }
  poison(){this.gate.poison();this.gate.poisonReason=recoveryMessage;}
  runtimeOperation(operation){const next=this.runtimeQueue.then(operation);this.runtimeQueue=next.catch(()=>{});return next;}
  async persist(){
    if(!this.rpc?.lockHolder||this.rpc.lockHolder.lost){this.poison();throw new Error('Controller authority lock is unavailable; persistence denied');}
    const contents=JSON.stringify(this.ledger)+'\n';
    const next=this.writes.then(async()=>{
      const temporary=join(this.stateDir,`ledger.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
      const file=await open(temporary,'wx',0o600);
      try{await file.writeFile(contents);await file.sync();}finally{await file.close();}
      await rename(temporary,join(this.stateDir,'ledger.json'));
      const directory=await open(this.stateDir,'r');try{await directory.sync();}finally{await directory.close();}
    });
    this.writes=next.catch(()=>{this.poison();});
    try{await next;}catch{this.poison();throw new Error('Could not persist browser authority; operator recovery is required');}
  }
  async start(){
    await mkdir(this.stateDir,{recursive:true,mode:0o700});
    await this.rpc.start(); // Claims singleton socket before touching durable authority.
    try{
      try{const saved=JSON.parse(await readFile(join(this.stateDir,'ledger.json'),'utf8'));if(saved.version!==1||!saved.calls||!saved.leases)throw new Error('Invalid authority ledger');this.ledger=saved;}catch(error){if(error.code!=='ENOENT')throw error;}
      this.gate.holder='startup_reconciliation';
      const uncertain=Object.keys(this.ledger.calls).length>0;
      for(const row of Object.values(this.ledger.leases))if(!terminal(row)){
        row.reason='controller_restart';
        await this.retire(row.id,{reconcile:true}).catch(()=>{});
      }
      this.gate.holder=null;
      if(uncertain||Object.values(this.ledger.leases).some(row=>row.state==='recovery_required'))this.poison();
      await this.persist();
      await this.gateway.start({port:this.port});
      this.ready=true;
      this.supervisorHeartbeatTimer=setInterval(()=>{void this.heartbeatViewers();},this.supervisorHeartbeatMs);
      this.supervisorHeartbeatTimer.unref();
      return this;
    }catch(error){this.poison();await this.rpc.close();throw error;}
  }
  async ensure(params={},context={}){
    const callKey=params.callKey===undefined?undefined:checkedKey(params.callKey);
    const assertAdmission=()=>{
      if(this.gate.poisonReason)throw new Error(recoveryMessage);
      const call=callKey===undefined?undefined:this.ledger.calls[callKey];
      if(callKey!==undefined&&(!call||call.state!=='active'||call.connectionId!==(context.connectionId||'direct')||!this.gate.active.has(callKey)))throw new Error('Runtime ensure requires an active browser admission from this connection');
      if(this.gate.holder!==null&&!call)throw new Error('Browser is under human control; runtime ensure requires a prior browser admission');
    };
    assertAdmission();
    return this.runtimeOperation(async()=>{
      assertAdmission();
      await this.runtime.ensure();
      const deadline=Date.now()+60_000;
      let status;
      do{status=await this.runtime.status();if(status.ready===true)break;if(status.tainted||Date.now()>=deadline)throw new Error('Dedicated browser is unavailable');await new Promise(resolve=>setTimeout(resolve,100));}while(true);
      if(status.browserSandbox!==true||status.authenticatedInternetReady!==true)throw new Error('Dedicated browser sandbox and authenticated Internet readiness must be verified');
      return{ready:true,profile:this.profile,cdpUrl:this.runtime.cdpUrl,browserGeneration:status.browserGeneration||status.displayGeneration,displayGeneration:status.displayGeneration,recoveryRequired:false};
    });
  }
  health(){return{ready:this.ready===true&&!this.gate.poisonReason,profile:this.profile,cdpUrl:this.runtime.cdpUrl,recoveryRequired:!!this.gate.poisonReason};}
  heartbeatCurrent(id,actor){
    const row=this.ledger.leases[id],session=this.gateway.sessions.get(id);
    return this.ready===true&&!this.gateway.closed&&this.actors.get(id)===actor&&
      row?.epoch===actor.epoch&&row.displayGeneration===actor.displayGeneration&&row.browserGeneration===actor.browserGeneration&&
      ((row.state==='watch'&&actor.role==='watch')||(row.state==='control'&&actor.role==='control'))&&
      !!session&&!session.endingReason&&!['ending','ended','cleanup_failed'].includes(session.mode);
  }
  async heartbeatViewers(){
    const work=[];
    for(const [id,actor] of this.actors){
      if(!this.heartbeatCurrent(id,actor))continue;
      const key=`${id}:${actor.epoch}`;
      if(this.heartbeatWork.has(key))continue;
      // Heartbeats carry no input and bypass the runtime operation queue: a
      // pending takeover must never prevent the independent watchdog refresh.
      const heartbeat=Promise.resolve().then(async()=>{
        if(!this.heartbeatCurrent(id,actor))return;
        try{
          const receipt=await this.runtime.heartbeatViewer({leaseId:id,epoch:actor.epoch});
          if(receipt?.ok!==true||receipt.leaseId!==id||receipt.epoch!==actor.epoch)throw new Error('Invalid viewer heartbeat receipt');
        }catch{
          if(this.heartbeatCurrent(id,actor))await this.gateway.end(this.gateway.sessions.get(id),'supervisor_unavailable');
        }
      });
      this.heartbeatWork.set(key,heartbeat);work.push(heartbeat);
      heartbeat.finally(()=>{if(this.heartbeatWork.get(key)===heartbeat)this.heartbeatWork.delete(key);}).catch(()=>{});
    }
    await Promise.allSettled(work);
  }
  async createActor({probeId,expiresAt}){
    if(!this.creating)throw new Error('Missing owner admission');
    const row={id:probeId,owner:this.creating.owner,profile:this.profile,permission:this.creating.permission,targetId:this.creating.targetId,expiresAt,mayBeWritable:false,state:'starting',createdAt:Date.now()};
    this.ledger.leases[probeId]=row;await this.persist();
    try{
      const actor=await this.runtimeOperation(()=>this.runtime.startViewer({leaseId:probeId,role:'watch',expiresAt}));
      validateActor(actor,probeId,'watch');
      this.actors.set(probeId,actor);row.epoch=actor.epoch;row.displayGeneration=actor.displayGeneration;row.browserGeneration=actor.browserGeneration||actor.displayGeneration;row.state='watch';await this.persist();
      return{ownedId:probeId};
    }catch(error){await this.retire(probeId).catch(()=>{});throw new Error('Dedicated viewer could not start');}
  }
  registration(id){const actor=this.actors.get(id);if(!actor)throw new Error('Viewer is unavailable');return{endpoint:{host:actor.host,port:actor.port},credentials:actor.role==='control'?{watch:randomBytes(32).toString('base64url'),control:actor.password}:{watch:actor.password,control:randomBytes(32).toString('base64url')}};}
  async cancelPromotion(id){const row=this.ledger.leases[id];if(!row||row.mayBeWritable===true)return;row.acquisitionCancelled=true;row.reason ||= this.gateway.sessions.get(id)?.reason;this.gate.release(id);await this.persist();}
  async promote({ownedId,probeId}){
    const row=this.ledger.leases[ownedId];
    if(!row||probeId!==ownedId||row.permission!=='control'||row.state!=='watch')throw new Error('Control is unavailable');
    row.state='acquiring';await this.persist();
    try{
      // acquire waits only for paired leaves; it never owns the runtime queue.
      if(row.acquisitionCancelled||row.state!=='acquiring')throw new Error('Control acquisition cancelled');
      await this.gate.acquire(ownedId);
      if(row.acquisitionCancelled||row.state!=='acquiring')throw new Error('Control acquisition cancelled');
      row.state='promoting';row.mayBeWritable=true;await this.persist();
      const actor=await this.runtimeOperation(()=>this.runtime.promoteViewer({leaseId:ownedId}));
      validateActor(actor,ownedId,'control');
      if(actor.epoch<=row.epoch||actor.displayGeneration!==row.displayGeneration||actor.browserGeneration!==row.browserGeneration)throw new Error('Viewer authority generation changed');
      this.actors.set(ownedId,actor);row.epoch=actor.epoch;row.state='control';row.displayGeneration=actor.displayGeneration;row.browserGeneration=actor.browserGeneration||actor.displayGeneration;await this.persist();
      return this.registration(ownedId);
    }catch(error){row.reason ||= this.gateway.sessions.get(ownedId)?.reason||'promotion_failed';await this.retire(ownedId).catch(()=>{});throw new Error(this.gate.poisonReason||'Control acquisition failed');}
  }
  async retire(id,{reconcile=false,reason}={}){
    const row=this.ledger.leases[id];if(!row)throw new Error('Unknown browser lease');
    if(row.state==='ended')return;
    if(reason)row.reason ||= reason;
    if(row.retirement)return row.retirement;
    const retirement=(async()=>{
      try{
        const readOnly=row.mayBeWritable===false;
        if(readOnly)this.gate.release(id); // Cancels only this lease's pending acquisition.
        if(!readOnly&&!reconcile&&this.gate.holder!==id){if(this.gate.poisonReason&&this.gate.holder===null)this.gate.holder=id;else await this.gate.acquire(id);}
        row.state='retiring';row.recoveryStage='input_fence';await this.persist();
        const receipt=await this.runtimeOperation(()=>this.runtime.stopViewerAndSettle({leaseId:id,mayBeWritable:!readOnly}));
        if(!Number.isSafeInteger(receipt.epoch)||receipt.epoch<1||(Number.isSafeInteger(row.epoch)&&receipt.epoch<=row.epoch)||receipt.leaseId!==id||receipt.vncProcessesExited!==true||receipt.xClientsAbsent!==true||(readOnly?(receipt.readOnly!==true||receipt.inputResetRequired!==false):receiptFlags.some(key=>receipt[key]!==true))||!receipt.displayGeneration||(row.displayGeneration&&row.displayGeneration!==receipt.displayGeneration)||(row.browserGeneration&&receipt.browserGeneration&&row.browserGeneration!==receipt.browserGeneration))throw new Error('Input retirement was not proven');
        row.receipt={leaseId:id,...Object.fromEntries(receiptFlags.map(key=>[key,receipt[key]===true])),readOnly,inputResetRequired:!readOnly,displayGeneration:receipt.displayGeneration,browserGeneration:receipt.browserGeneration,epoch:receipt.epoch,snapshotObserved:false};
        if(!readOnly){row.recoveryStage='browser_observation';await this.persist();
        const observation=await this.runtimeOperation(()=>this.observe(this.runtime,row));
        if(observation?.snapshotObserved!==true||observation.displayGeneration!==receipt.displayGeneration||(receipt.browserGeneration&&observation.browserGeneration!==receipt.browserGeneration))throw new Error('Fresh browser observation was not proven');
        // Copy only nonsecret fence fields into the journal.
        row.receipt={leaseId:id,...Object.fromEntries(receiptFlags.map(key=>[key,true])),displayGeneration:receipt.displayGeneration,browserGeneration:observation.browserGeneration||receipt.displayGeneration,epoch:receipt.epoch,readOnly:false,inputResetRequired:true,snapshotObserved:true,...observedContext(observation)};}
        row.state='ended';delete row.recoveryStage;row.completedAt=Date.now();row.reason||='ended';
        await this.persist();this.actors.delete(id);
        if(!reconcile)this.gate.release(id);
      }catch(error){row.state='recovery_required';row.reason||='retirement_failed';row.completedAt=Date.now();this.poison();await this.persist().catch(()=>{});throw new Error(recoveryMessage);}
    })();
    // A promise is process-local and must never enter the durable JSON journal.
    Object.defineProperty(row,'retirement',{value:retirement,writable:true,configurable:true,enumerable:false});
    try{return await retirement;}finally{delete row.retirement;}
  }
  async ended(session,status){
    const row=this.ledger.leases[session.id];if(!row)return;row.reason=session.reason||row.reason||'ended';
    if(status?.mode==='cleanup_failed'){row.state='recovery_required';row.recoveryStage ||= 'gateway_cleanup';this.poison();}
    try{await this.persist();}catch(error){row.state='recovery_required';row.recoveryStage='completion_persistence';this.poison();await this.persist().catch(()=>{});throw error;}
  }
  async clipboard(id,text){const row=this.ledger.leases[id];if(!row||row.state!=='control'||this.gate.holder!==id||this.gate.poisonReason)throw new Error('Clipboard requires current human control');return this.runtimeOperation(async()=>{if(row.state!=='control')throw new Error('Clipboard authority ended');return text===undefined?this.runtime.clipboardRead({leaseId:id,epoch:row.epoch}):this.runtime.clipboardWrite(text,{leaseId:id,epoch:row.epoch});});}
  owned(owner,id){ownerParts(owner);const row=this.ledger.leases[id];if(!row||row.owner!==owner)throw new Error('Lease belongs to another owner session');return row;}
  status(row){
    const gatewaySession=this.gateway.sessions.get(row.id);
    const mode=row.state==='recovery_required'?'recovery_required':row.state==='ended'?'ended':gatewaySession?.mode||row.state;
    return{id:row.id,profile:this.profile,scope:'browser-profile',permission:row.permission,mode,epoch:row.epoch,expiresAt:row.expiresAt,...(row.targetId?{targetId:row.targetId}:{}),...(row.reason?{reason:row.reason}:{}),browserGeneration:row.browserGeneration,displayGeneration:row.displayGeneration,resumeAllowed:row.state==='ended'&&safeCompletion(row)&&!this.gate.poisonReason,recoveryRequired:row.state==='recovery_required'||!!this.gate.poisonReason,inputFenced:inputFenced(row.receipt),snapshotObserved:row.receipt?.snapshotObserved===true,...observedContext(row.receipt||{}),...(row.recoveryStage?{recoveryStage:row.recoveryStage}:{})};
  }
  async revokeAll(reason){
    if(reason!=='plugin_stop')throw new Error('Unsupported bulk revocation reason');
    if(this.revocationWork)return this.revocationWork;
    this.createGeneration++;
    const work=(async()=>{
      const rows=Object.values(this.ledger.leases).filter(row=>!terminal(row));
      await Promise.allSettled(rows.map(async row=>{
        row.reason ||= reason;const session=this.gateway.sessions.get(row.id);
        if(session)await this.gateway.end(session,reason);else await this.retire(row.id,{reason});
      }));
      await this.persist();
      const unsafe=Object.values(this.ledger.leases).some(row=>row.state!=='ended'||!safeCompletion(row));
      const recoveryRequired=unsafe||!!this.gate.poisonReason;
      return{revoked:rows.length,allRetired:!recoveryRequired,recoveryRequired};
    })();
    this.revocationWork=work;
    try{return await work;}finally{if(this.revocationWork===work)this.revocationWork=undefined;}
  }
  async transportFailed(){
    const work=[];for(const session of this.gateway.sessions.values())if(!['ended','cleanup_failed'].includes(session.mode)){const row=this.ledger.leases[session.id];if(row)row.reason||='tunnel_outage';work.push(this.gateway.end(session,'tunnel_outage'));}await Promise.allSettled(work);
  }
  async disconnected(keys){let changed=false;for(const key of keys)if(this.ledger.calls[key]){this.ledger.calls[key].state='uncertain';changed=true;}if(changed){this.poison();await this.persist();}}
  async request(method,params={},context={}){
    if(!this.ready&&!['health','automationLeave'].includes(method))throw new Error('Production controller is reconciling or stopping');
    if(params.profile!==undefined&&params.profile!==this.profile)throw new Error('Only the dedicated browser profile is managed');
    switch(method){
      case 'health':return this.health();
      case 'ensure':return this.ensure(params,context);
      case 'tabs':{
        await this.ensure();const tabs=await this.runtimeOperation(()=>this.runtime.tabs());
        if(!Array.isArray(tabs)||tabs.length>1000)throw new Error('Browser tab list unavailable');
        return{profile:this.profile,tabs:tabs.filter(browserPage).map(tab=>({id:targetIdentity(tab),targetId:targetIdentity(tab),title:String(tab.title||'').slice(0,300),url:String(tab.url||'')}))};
      }
      case 'automationEnter':{
        const key=checkedKey(params.callKey),connectionId=context.connectionId||'direct',existing=this.ledger.calls[key];
        if(existing&&(existing.connectionId!==connectionId||existing.state!=='active'))throw new Error('Browser call already admitted on another connection or uncertain');
        this.gate.enter(key);this.ledger.calls[key]=existing?{...existing,count:existing.count+1}:{state:'active',count:1,connectionId,admittedAt:Date.now()};await this.persist();
        if(context.signal?.aborted){await this.disconnected([key]);throw new Error(recoveryMessage);}return{admitted:true};
      }
      case 'automationLeave':{
        const key=checkedKey(params.callKey);if(!this.ledger.calls[key])throw new Error('Browser call was not admitted');
        const call=this.ledger.calls[key];
        if(call.state==='uncertain')throw new Error(recoveryMessage);
        if(call.connectionId!==(context.connectionId||'direct'))throw new Error('Browser call belongs to another connection');
        if(call.count>1){call.count--;await this.persist();}else{delete this.ledger.calls[key];await this.persist();this.gate.leave(key);}return{released:true};
      }
      case 'create':{
        ownerParts(params.owner);if(this.revocationWork)throw new Error('Browser invitations are stopped during bulk retirement');if(this.creating||Object.values(this.ledger.leases).some(row=>!terminal(row)))throw new Error('A browser invitation is already active');
        if(!['watch','control'].includes(params.permission)||!Number.isInteger(params.ttlSeconds)||params.ttlSeconds<30||params.ttlSeconds>1800)throw new Error('Invalid invitation permission or lifetime');
        if(params.targetId!==undefined&&(typeof params.targetId!=='string'||!params.targetId||params.targetId.length>256))throw new Error('Invalid task target');
        this.creating=params;const generation=this.createGeneration;
        const activationId=params.targetId?`activation:${randomBytes(16).toString('hex')}`:undefined;
        let activationWaiting=false;
        const cancelActivation=()=>{if(activationWaiting)this.gate.release(activationId);};
        const current=()=>{
          const reason=context.signal?.aborted?'creation_cancelled':generation!==this.createGeneration||this.revocationWork?'plugin_stop':undefined;
          if(reason)throw Object.assign(new Error(reason==='creation_cancelled'?'Browser invitation creation cancelled':'Browser invitation cancelled by plugin stop'),{handoffReason:reason});
        };
        try{
          current();await this.ensure();current();
          const origin=await this.transport.ensure(new URL(this.gateway.localUrl).port*1);current();
          if(typeof this.gateway.setPublicBase==='function')this.gateway.setPublicBase(origin);else this.gateway.publicBaseUrl=origin;
          if(activationId){
            current();activationWaiting=true;context.signal?.addEventListener('abort',cancelActivation,{once:true});
            try{await this.gate.acquire(activationId);}finally{activationWaiting=false;context.signal?.removeEventListener('abort',cancelActivation);}
            current();await this.runtimeOperation(()=>this.activateTarget(this.runtime,params.targetId));current();
          }
          current();const result=await this.gateway.createProbe({ttlSeconds:params.ttlSeconds,permission:params.permission});
          try{current();}catch(error){const session=this.gateway.sessions.get(result.id);if(session)await this.gateway.end(session,error.handoffReason||'plugin_stop');throw error;}
          return{...result,...this.status(this.ledger.leases[result.id])};
        }finally{context.signal?.removeEventListener('abort',cancelActivation);if(activationId)this.gate.release(activationId);this.creating=undefined;}
      }
      case 'status':return this.status(this.owned(params.owner,params.id));
      case 'wait':{
        const row=this.owned(params.owner,params.id),seconds=params.timeoutSeconds??60;
        if(!Number.isInteger(seconds)||seconds<1||seconds>60)throw new Error('Invalid wait duration');
        const deadline=Date.now()+seconds*1000;
        while(!terminal(row)&&Date.now()<deadline){if(context.signal?.aborted)throw new Error('Wait cancelled');await new Promise(resolve=>setTimeout(resolve,100));}
        return this.status(row);
      }
      case 'revoke':{
        const row=this.owned(params.owner,params.id);row.reason||='revoked';
        const session=this.gateway.sessions.get(row.id);if(session)await this.gateway.end(session,'revoked');else await this.retire(row.id).catch(()=>{});
        await this.persist();return this.status(row);
      }
      case 'revokeAll':return this.revokeAll(params.reason);
      case 'revokeOwner':{
        const work=[];for(const row of Object.values(this.ledger.leases)){const [key,id]=ownerParts(row.owner);if(key===params.sessionKey&&(params.sessionId===undefined||params.sessionId===id)&&!terminal(row))work.push(this.request('revoke',{owner:row.owner,id:row.id}));}await Promise.all(work);return{revoked:work.length};
      }
      case 'completions':return{completions:Object.values(this.ledger.leases).filter(row=>terminal(row)&&!row.acknowledged).map(row=>({...this.status(row),owner:row.owner,completedAt:row.completedAt}))};
      case 'acknowledgeCompletion':{const row=this.ledger.leases[params.id];if(!row||!terminal(row))throw new Error('Completion is unavailable');row.acknowledged=true;await this.persist();return{acknowledged:true};}
      default:throw new Error('Unsupported controller RPC method');
    }
  }
  async close(){if(this.closePromise)return this.closePromise;clearInterval(this.supervisorHeartbeatTimer);this.ready=false;this.closePromise=(async()=>{await this.gateway.close();if(Object.keys(this.ledger.calls).length)this.poison();if(this.rpc.lockHolder&&!this.rpc.lockHolder.lost)await this.persist().catch(()=>{});await this.rpc.close();await this.transport.close();})();return this.closePromise;}
}
