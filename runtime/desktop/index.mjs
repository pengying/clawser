import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const label = 'openclaw.browser-handoff.desktop';
const here = dirname(fileURLToPath(import.meta.url));
export const desktopControlClient = `import json,socket,sys
payload=sys.stdin.buffer.read()
request=json.loads(payload)
s=socket.socket(socket.AF_UNIX)
s.settimeout(20)
try:
    s.connect('/tmp/desktop/control.sock')
except (FileNotFoundError,ConnectionRefusedError):
    if request.get('op')=='status':
        print(json.dumps({'ready':False,'phase':'starting'}))
        sys.exit(0)
    raise
s.sendall(payload)
s.shutdown(socket.SHUT_WR)
sys.stdout.buffer.write(s.makefile('rb').read())
`;
const client = desktopControlClient;

export function dockerCommand(args, input = '') {
  return new Promise((accept, reject) => {
    const child = spawn('docker', ['--host=unix:///var/run/docker.sock', ...args], {env:{PATH:process.env.PATH},stdio:['pipe','pipe','pipe']});
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('desktop Docker operation timed out')); }, 120_000);
    child.stdout.on('data', b => {out += b; if(out.length > 4_000_000) child.kill('SIGKILL');});
    child.stderr.on('data', b => {if(err.length < 16_000) err += b;});
    child.on('error', e => {clearTimeout(timer); reject(e);});
    child.on('close', code => {clearTimeout(timer); code === 0 ? accept(out.trim()) : reject(new Error('Docker operation failed (' + code + '): ' + err.slice(0,1000)));});
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export class DesktopRuntime {
  constructor(options = {}) {
    this.name = options.name ?? 'openclaw-handoff-desktop';
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(this.name)) throw new Error('invalid desktop name');
    if(options.bindHost && options.bindHost !== '127.0.0.1') throw new Error('desktop endpoints must be loopback');
    this.cdpPort = options.cdpPort ?? 18810;
    this.vncPort = options.vncPort ?? 59090;
    for(const port of [this.cdpPort,this.vncPort]) if(!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid desktop port');
    if(this.cdpPort === this.vncPort) throw new Error('desktop ports must differ');
    this.stateDir = resolve(options.stateDir ?? process.env.HOME + '/.local/state/openclaw-handoff-desktop');
    this.image = options.image ?? 'openclaw-handoff-desktop:20261027';
    this.heartbeatTimeoutMs=options.testHeartbeatTimeoutMs??30000;
    if(!Number.isInteger(this.heartbeatTimeoutMs)||this.heartbeatTimeoutMs<1000||this.heartbeatTimeoutMs>30000)throw new Error('invalid trusted heartbeat test timeout');
    this.seccompProfile = resolve(options.seccompProfile ?? `${here}/chromium-seccomp.json`);
    const networkName = this.name;
    this.network = `${networkName}` + '-net';
    const profileName = this.name;
    this.volume = `${profileName}` + '-profile';
    this.ownerId = options.ownerId;
    this.run = options.run ?? dockerCommand;
    this.cdpUrl = 'http://127.0.0.1:' + this.cdpPort;
  }
  async locked(fn) {
    await mkdir(this.stateDir,{recursive:true,mode:0o700});
    const lock = this.stateDir + '/operation.lock';
    try { await mkdir(lock,{mode:0o700}); } catch(e) {if(e.code === 'EEXIST') throw new Error('desktop operation is locked; reconcile the owning process before retry'); throw e;}
    try {
      const stat=await readFile('/proc/self/stat','utf8');
      const processStartTicks=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19];
      await writeFile(`${lock}/owner.json`,JSON.stringify({pid:process.pid,processStartTicks,createdAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});
      return await fn();
    } finally {await rm(lock,{recursive:true,force:true});}
  }
  async owner() {
    const receipt = JSON.parse(await readFile(this.stateDir + '/ownership.json','utf8'));
    if(receipt.name !== this.name) throw new Error('desktop ownership receipt name mismatch');
    if(this.ownerId && receipt.ownerId!==this.ownerId) throw new Error('desktop ownership receipt changed');
    if((receipt.cdpPort!==undefined && receipt.cdpPort!==this.cdpPort)||(receipt.vncPort!==undefined && receipt.vncPort!==this.vncPort)) throw new Error('desktop port configuration differs from ownership receipt');
    if((receipt.network!==undefined && receipt.network!==this.network)||(receipt.volume!==undefined && receipt.volume!==this.volume)) throw new Error('desktop network/profile identity differs from ownership receipt');
    if(receipt.heartbeatTimeoutMs!==undefined&&receipt.heartbeatTimeoutMs!==this.heartbeatTimeoutMs)throw new Error('desktop heartbeat configuration differs from ownership receipt');
    this.ownerId = receipt.ownerId;
    return this.ownerId;
  }
  async owned({allowUnpinned=false}={}) {
    const owner = await this.owner();
    const receipt=JSON.parse(await readFile(this.stateDir + '/ownership.json','utf8'));
    const [item] = JSON.parse(await this.run(['inspect',this.name]));
    if(!item || item.Config?.Labels?.[label] !== owner) throw new Error('desktop ownership mismatch');
    const name = this.name;
    if(item.Name!=='/' + `${name}` || (receipt.containerId && item.Id!==receipt.containerId) || (!receipt.containerId && !allowUnpinned)) throw new Error('desktop container identity mismatch');
    const validatePorts=ports=>{
      if(ports)ports=Object.fromEntries(Object.entries(ports).filter(([,value])=>value!==null));
      if(!ports || Object.keys(ports).length!==2) throw new Error('desktop published port binding mismatch');
      for(const [key,port] of [['9223/tcp',this.cdpPort],['5900/tcp',this.vncPort]]) {
        const entries=ports[key];
        if(!Array.isArray(entries)||entries.length!==1||entries[0].HostIp!=='127.0.0.1'||entries[0].HostPort!==String(port))throw new Error('desktop published port binding mismatch');
      }
    };
    validatePorts(item.HostConfig?.PortBindings);
    if(item.State?.Running)validatePorts(item.NetworkSettings?.Ports);
    const networks=item.NetworkSettings?.Networks;
    if(item.HostConfig?.NetworkMode!==this.network || !networks || Object.keys(networks).length!==1 || !networks[this.network]?.NetworkID || (receipt.networkId && receipt.networkId!==networks[this.network].NetworkID)) throw new Error('desktop network identity mismatch');
    const mounts=item.Mounts??[];
    const profile=mounts.filter(m=>m.Destination==='/profile');
    if(profile.length!==1||profile[0].Type!=='volume'||profile[0].Name!==this.volume||profile[0].RW!==true||mounts.some(m=>m.Type==='bind'||(m.Type==='volume'&&m.Destination!=='/profile'))) throw new Error('desktop profile volume identity mismatch');
    if(allowUnpinned) await writeFile(this.stateDir + '/ownership.json',JSON.stringify({...receipt,containerId:item.Id,network:this.network,networkId:networks[this.network].NetworkID,volume:this.volume,bindHost:'127.0.0.1',cdpPort:this.cdpPort,vncPort:this.vncPort}) + '\n',{mode:0o600});
    return item;
  }
  async rpc(op, fields={}) {
    return this.locked(()=>this.rpcDirect(op,fields));
  }
  async rpcDirect(op,fields={}) {
    const item = await this.owned();
    if(!item.State?.Running) throw new Error('desktop is not running');
    const result = JSON.parse(await this.run(['exec','--interactive','--user','1000:1000',item.Id,'python3','-c',client],JSON.stringify({op,...fields})));
    if(result.error) throw new Error('desktop ' + ''.concat(op) + ': ' + ''.concat(result.error));
    return result;
  }
  async ensure() {
    return this.locked(async () => {
      let receipt;
      try {
        receipt=JSON.parse(await readFile(this.stateDir + '/ownership.json','utf8'));
        await this.owner();
        try {const current = await this.owned({allowUnpinned:true}); if(!current.State.Running) {if((await this.run(['ps','--filter',`volume=${this.volume}`,'--format','{{.ID}}'])).trim())throw new Error('desktop profile is already in use');await this.run(['start',current.Id]);} return {name:this.name,cdpUrl:this.cdpUrl,persistent:true};}
        catch(e) {if(!/No such (object|container)/i.test(e.message))throw e;}
      } catch(e) {if(e.code !== 'ENOENT')throw e;}
      this.ownerId ??= randomUUID();
      receipt={...receipt,ownerId:this.ownerId,name:this.name,network:this.network,volume:this.volume,bindHost:'127.0.0.1',cdpPort:this.cdpPort,vncPort:this.vncPort,heartbeatTimeoutMs:this.heartbeatTimeoutMs,createdAt:receipt?.createdAt??new Date().toISOString()};
      // Write intent before mutations: failed starts remain reviewable and are never guessed away.
      try {await writeFile(this.stateDir + '/ownership.json',JSON.stringify(receipt) + '\n',{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
      const labels = ['--label',`${label}=${this.ownerId}`];
      let networkId;
      for(const [kind,name] of [['network',this.network],['volume',this.volume]]) {
        let existing;
        try {[existing]=JSON.parse(await this.run([kind,'inspect',name]));}
        catch(e){if(!/No such (object|network|volume)|network [^\n]+ not found/i.test(e.message))throw e;}
        if(existing) {if(existing.Labels?.[label]!==this.ownerId)throw new Error(`${kind} ownership mismatch`);if(kind==='network')networkId=existing.Id;}
        else {const resourceId=await this.run([kind,'create',...labels,name]);if(kind==='network')networkId=resourceId;}
      }
      if((await this.run(['ps','--filter',`volume=${this.volume}`,'--format','{{.ID}}'])).trim()) throw new Error('desktop profile is already in use');
      const id = await this.run(['create','--name',this.name,...labels,'--network',this.network,
        '--publish','127.0.0.1:' + this.cdpPort + ':9223','--publish','127.0.0.1:' + this.vncPort + ':5900',
        '--read-only','--tmpfs','/tmp:rw,nosuid,nodev,size=256m,mode=1777',
        '--tmpfs','/home/browser:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700',
        '--mount','type=volume,src=' + this.volume + ',dst=/profile','--shm-size','512m',
        '--cap-drop','ALL','--cap-add','NET_ADMIN','--cap-add','SETUID','--cap-add','SETGID','--cap-add','SETPCAP','--cap-add','CHOWN',
        ...(this.heartbeatTimeoutMs===30000?[]:['--env',`DESKTOP_TEST_HEARTBEAT_TIMEOUT_MS=${this.heartbeatTimeoutMs}`]),
        '--security-opt','no-new-privileges:true','--security-opt','seccomp=' + this.seccompProfile,'--sysctl','net.ipv6.conf.all.disable_ipv6=1',
        '--pids-limit','1024','--memory','3072m','--cpus','2','--restart','no',this.image]);
      await writeFile(this.stateDir + '/ownership.json',JSON.stringify({...receipt,containerId:id,networkId}) + '\n',{mode:0o600});
      await this.run(['start',id]);
      return {name:this.name,cdpUrl:this.cdpUrl,persistent:true};
    });
  }
  status() {return this.rpc('status');}
  async tabs() {await this.owned(); const response = await fetch(this.cdpUrl + '/json/list',{signal:AbortSignal.timeout(5000)}); if(!response.ok) throw new Error('CDP tabs unavailable'); return response.json();}
  async startViewer({leaseId,role='watch',expiresAt}) {const result = await this.rpc('startViewer',{leaseId,role,expiresAt}); return {...result,host:'127.0.0.1',port:this.vncPort};}
  async promoteViewer({leaseId}) {const result = await this.rpc('promoteViewer',{leaseId}); return {...result,host:'127.0.0.1',port:this.vncPort};}
  stopViewerAndSettle({leaseId,mayBeWritable}) {return this.rpc('stopViewerAndSettle',{leaseId,mayBeWritable});}
  heartbeatViewer({leaseId,epoch}={}) {
    if(typeof leaseId!=='string'||!leaseId||!Number.isSafeInteger(epoch)||epoch<1)throw new Error('heartbeat requires a lease ID and exact actor epoch');
    // Heartbeats are read/refresh operations, independent of the mutation lock.
    return this.rpcDirect('heartbeatViewer',{leaseId,epoch});
  }
  clipboardRead({leaseId,epoch}={}) {return this.rpc('clipboardRead',{leaseId,epoch});}
  clipboardWrite(text,{leaseId,epoch}={}) {if(typeof text !== 'string' || Buffer.byteLength(text) > 1_048_576) throw new Error('invalid clipboard text size'); return this.rpc('clipboardWrite',{text,leaseId,epoch});}
  async shutdown({removeProfile=false}={}) {
    return this.locked(async () => {
      const item = await this.owned();
      const owner = await this.owner();
      for(const [kind,name] of [['network',this.network],...(removeProfile ? [['volume',this.volume]] : [])]) {
        const [resource] = JSON.parse(await this.run([kind,'inspect',name]));
        if(resource?.Labels?.[label] !== owner) throw new Error(`${kind} ownership mismatch`);
      }
      if(item.State?.Running) await this.run(['stop','--time','8',item.Id]);
      await this.run(['rm','--force',item.Id]);
      await this.run(['network','rm',this.network]);
      if(removeProfile) await this.run(['volume','rm',this.volume]);
      await writeFile(this.stateDir + '/stopped.json',JSON.stringify({ownerId:owner,profileRetained:!removeProfile,stoppedAt:new Date().toISOString()}),{mode:0o600});
      return {stopped:true,profileRetained:!removeProfile};
    });
  }
}

if(process.argv[1] === fileURLToPath(import.meta.url)) {
  const [operation='status',stateDir] = process.argv.slice(2);
  const runtime = new DesktopRuntime({stateDir});
  if(!['ensure','status','tabs','shutdown'].includes(operation)) throw new Error('supported CLI operations: ensure/status/tabs/shutdown');
  console.log(JSON.stringify(await runtime[operation]()));
}
