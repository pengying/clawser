import net from 'node:net';
import { chmod, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_MESSAGE = 1024 * 1024;
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 100;
const failure = message => new Error(message);

export class DesktopRpcClient {
  pending = new Map();
  constructor(socketPath) {
    if (!isAbsolute(socketPath || '')) throw failure('Private RPC socket path must be absolute');
    this.socket = net.createConnection(socketPath);
    this.buffer = Buffer.alloc(0);
    this.ready = new Promise((resolve, reject) => {this.socket.once('connect',resolve);this.socket.once('error',reject);});
    this.ready.catch(()=>{});
    this.socket.on('data',chunk=>this.receive(chunk));
    this.socket.on('error',()=>this.fail('Production controller disconnected'));
    this.socket.on('close',()=>this.fail('Production controller disconnected'));
  }
  fail(message) {
    this.closed = true;
    for (const entry of this.pending.values()) entry.reject(failure(message));
    this.pending.clear();
  }
  receive(chunk) {
    this.buffer=Buffer.concat([this.buffer,chunk]);
    while (true) {
      const end=this.buffer.indexOf(10);
      if(end<0) {if(this.buffer.length>MAX_MESSAGE)this.close();return;}
      if(end>MAX_MESSAGE){this.close();return;}
      let message;try{message=JSON.parse(this.buffer.subarray(0,end));}catch{this.close();return;}
      this.buffer=this.buffer.subarray(end+1);
      if(!validId(message?.id)){this.close();return;}
      const entry=this.pending.get(message.id);if(!entry)continue;
      if(message.error) entry.reject(failure(typeof message.error.message==='string'?message.error.message:'Controller request failed'));
      else if(Object.hasOwn(message,'result')) entry.resolve(message.result);
      else {this.close();return;}
    }
  }
  async request(method,params={}, {signal,timeoutMs=15_000}={}) {
    if(this.closed)throw failure('Production controller connection is closed');
    if(signal?.aborted)throw failure('Controller request aborted');
    if(typeof method!=='string'||method.length>100||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>180_000)throw failure('Invalid controller request');
    if(this.pending.size>=128)throw failure('Too many controller requests');
    const id=randomUUID(),line=JSON.stringify({id,method,params})+'\n';
    if(Buffer.byteLength(line)>MAX_MESSAGE)throw failure('Controller request is too large');
    return new Promise((resolve,reject)=>{
      const finish=(callback,value)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.pending.delete(id);callback(value);};
      const abort=()=>{finish(reject,failure('Controller request aborted; outcome may be uncertain'));this.close();};
      const timer=setTimeout(()=>{finish(reject,failure('Controller request timed out; outcome may be uncertain'));this.close();},timeoutMs);
      timer.unref();
      this.pending.set(id,{resolve:value=>finish(resolve,value),reject:error=>finish(reject,error)});
      signal?.addEventListener('abort',abort,{once:true});
      this.ready.then(()=>{if(this.pending.has(id)&&!this.closed)this.socket.write(line);else if(this.closed)this.pending.get(id)?.reject(failure('Production controller disconnected'));},()=>this.pending.get(id)?.reject(failure('Production controller disconnected')));
    });
  }
  close(){this.fail('Production controller connection is closed');this.socket.destroy();}
}

export class DesktopRpcServer {
  sockets = new Set();
  disconnects = new Set();
  constructor({socketPath,handler,onDisconnect=()=>{},onLockLost=()=>{}}) {
    if(!isAbsolute(socketPath||''))throw failure('Private RPC socket path must be absolute');
    Object.assign(this,{socketPath,handler,onDisconnect,onLockLost});
    this.server=net.createServer(socket=>this.accept(socket));
    this.server.maxConnections=16;
  }
  async start() {
    await mkdir(dirname(this.socketPath),{recursive:true,mode:0o700});
    const directory=await lstat(dirname(this.socketPath));
    if(!directory.isDirectory()||directory.uid!==process.getuid()||(directory.mode&0o077))throw failure('RPC state directory must be owner-only');
    await this.acquireLock();
    this.closing=false;
    try {
    let existing;try{existing=await lstat(this.socketPath);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(existing){
      if(!existing.isSocket()||existing.uid!==process.getuid())throw failure('Refusing unowned RPC socket');
      const alive=await new Promise(resolve=>{const socket=net.createConnection(this.socketPath);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));});
      if(alive)throw failure('Production controller is already running');
      await unlink(this.socketPath);
    }
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.socketPath,resolve);});
    await chmod(this.socketPath,0o600);this.started=true;
    } catch(error) {
      if(this.server.listening)await new Promise(resolve=>this.server.close(resolve));
      await this.releaseLock();
      throw error;
    }
  }
  async acquireLock() {
    if(this.lockHolder)throw failure('Production controller is already running');
    const lockPath=this.socketPath+'.lock';
    // Never unlink this file: every contender must flock the same inode.
    const file=await open(lockPath,constants.O_CREAT|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    try {
      const info=await file.stat();
      if(!info.isFile()||info.uid!==process.getuid()||(info.mode&0o077))throw failure('Controller lock must be an owner-only regular file');
    } finally {await file.close();}
    const child=spawn('/usr/bin/flock',['--exclusive','--nonblock','--no-fork',lockPath,'/bin/sh','-c','printf "locked\\n"; cat >/dev/null'],{stdio:['pipe','pipe','ignore']});
    child.stdin.on('error',()=>{});
    const holder={child,closed:new Promise(resolve=>child.once('close',resolve)),releasing:false};
    let acquired=false;
    try {
      await new Promise((resolve,reject)=>{
        let response='';
        const timer=setTimeout(()=>reject(failure('Controller singleton lock did not respond')),5000);
        child.once('error',()=>{clearTimeout(timer);reject(failure('Controller singleton lock is unavailable'));});
        child.once('exit',()=>{clearTimeout(timer);if(!acquired)reject(failure('Production controller is already running or its singleton lock is unavailable'));});
        child.stdout.on('data',chunk=>{
          response+=chunk;
          if(response==='locked\n'){acquired=true;clearTimeout(timer);resolve();}
          else if(response.length>64){clearTimeout(timer);reject(failure('Invalid controller singleton lock receipt'));}
        });
      });
      this.lockHolder=holder;
      child.once('exit',()=>{
        if(!holder.releasing){holder.lost=true;this.closing=true;try{this.onLockLost();}finally{void this.close().catch(()=>{});}}
      });
    } catch(error) {
      holder.releasing=true;child.stdin.end();child.kill('SIGTERM');await holder.closed;throw error;
    }
  }
  async releaseLock() {
    const holder=this.lockHolder;if(!holder)return;
    holder.releasing=true;holder.child.stdin.end();await holder.closed;
    if(this.lockHolder===holder)this.lockHolder=undefined;
  }
  accept(socket) {
    if(this.closing){socket.destroy();return;}
    this.sockets.add(socket);let buffer=Buffer.alloc(0);const calls=new Map(),inflight=new Set();const abort=new AbortController();const connectionId=randomUUID();
    socket.on('error',()=>{});
    socket.on('close',()=>{this.sockets.delete(socket);abort.abort();const task=Promise.resolve(this.onDisconnect([...calls.keys()]));this.disconnects.add(task);task.catch(()=>{}).finally(()=>this.disconnects.delete(task));});
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      while(true){
        const end=buffer.indexOf(10);if(end<0){if(buffer.length>MAX_MESSAGE)socket.destroy();return;}
        if(end>MAX_MESSAGE){socket.destroy();return;}
        let message;try{message=JSON.parse(buffer.subarray(0,end));}catch{socket.destroy();return;}
        buffer=buffer.subarray(end+1);
        if(!validId(message?.id)||typeof message.method!=='string'||message.method.length>100||!message.params||typeof message.params!=='object'||Array.isArray(message.params)||inflight.has(message.id)||inflight.size>=128){socket.destroy();return;}
        inflight.add(message.id);
        if(message.method==='automationEnter'&&typeof message.params.callKey==='string')calls.set(message.params.callKey,(calls.get(message.params.callKey)||0)+1);
        Promise.resolve().then(()=>this.handler(message.method,message.params,{signal:abort.signal,connectionId})).then(result=>{
          if(message.method==='automationLeave'){const count=calls.get(message.params.callKey)||0;if(count>1)calls.set(message.params.callKey,count-1);else calls.delete(message.params.callKey);}
          this.reply(socket,{id:message.id,result});
        },error=>this.reply(socket,{id:message.id,error:{message:String(error?.message||'Controller request failed').slice(0,1000)}})).finally(()=>inflight.delete(message.id));
      }
    });
  }
  reply(socket,value){if(socket.destroyed)return;const line=JSON.stringify(value)+'\n';if(Buffer.byteLength(line)>MAX_MESSAGE||socket.writableLength>MAX_MESSAGE){socket.destroy();return;}socket.write(line);}
  async close(){this.closing=true;const closed=[...this.sockets].map(socket=>new Promise(resolve=>{socket.once('close',resolve);socket.destroy();}));await Promise.all(closed);await Promise.allSettled([...this.disconnects]);if(this.started){await new Promise(resolve=>this.server.close(resolve));await unlink(this.socketPath).catch(()=>{});this.started=false;}await this.releaseLock();}
}
