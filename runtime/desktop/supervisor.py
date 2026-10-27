#!/usr/bin/python3
"""Single owner for persistent display/browser and bounded disposable input actors."""
import functools, json, os, re, secrets, signal, socket, subprocess, threading, time, uuid

os.umask(0o077)
GENERATION = str(uuid.uuid4())
BROWSER_GENERATION = str(uuid.uuid4())
children=[]
critical=[]
actor=None
epoch=0
tainted=False
settlements={}
settlement_pids={}
clipboard_owner=None
pending_clipboard={}
lifecycle_lock=threading.RLock()
stopping=threading.Event()
HEARTBEAT_TIMEOUT_MS=int(os.environ.get('DESKTOP_TEST_HEARTBEAT_TIMEOUT_MS','30000'))
if not 1000<=HEARTBEAT_TIMEOUT_MS<=30000: raise RuntimeError('invalid trusted heartbeat test timeout')

def serialized(function):
    @functools.wraps(function)
    def invoke(*args,**kwargs):
        with lifecycle_lock: return function(*args,**kwargs)
    return invoke

def refresh_heartbeat(current):
    wall=time.time()*1000
    remaining=min(HEARTBEAT_TIMEOUT_MS,current['expiresAt']-wall)
    current['heartbeatDeadline']=min(wall+HEARTBEAT_TIMEOUT_MS,current['expiresAt'])
    current['heartbeatMonotonic']=time.monotonic()+remaining/1000

@serialized
def heartbeat(lease_id,actor_epoch):
    if not actor or actor['leaseId']!=lease_id or type(actor_epoch) is not int or actor.get('epoch')!=actor_epoch or actor.get('fenced'): raise RuntimeError('heartbeat lease/epoch mismatch')
    if time.time()*1000>=actor['expiresAt'] or time.monotonic()>=actor['heartbeatMonotonic']:
        reason='lease_expired' if time.time()*1000>=actor['expiresAt'] else 'heartbeat_timeout'
        retire(lease_id,reason=reason)
        raise RuntimeError('heartbeat deadline expired')
    refresh_heartbeat(actor)
    return {'ok':True,'leaseId':lease_id,'epoch':actor_epoch,'heartbeatDeadline':actor['heartbeatDeadline'],'expiresAt':actor['expiresAt']}

class InheritedProxy:
    """Bootstrap child stays UID1001; PID1 can reap and observe it without caps."""
    def __init__(self,pid): self.pid=pid;self.args=['socat'];self.returncode=None
    def poll(self):
        if self.returncode is not None: return self.returncode
        try:
            pid,status=os.waitpid(self.pid,os.WNOHANG)
            if pid: self.returncode=os.waitstatus_to_exitcode(status)
        except ChildProcessError: self.returncode=1
        return self.returncode

def listening(port,uid=1000):
    with open('/proc/net/tcp') as table:
        for line in list(table)[1:]:
            fields=line.split()
            if fields[3]=='0A' and int(fields[1].split(':')[1],16)==port and int(fields[7])==uid: return True
    return False

def launch(args, **kwargs):
    with open('/tmp/desktop/'+os.path.basename(args[0])+'-'+secrets.token_hex(4)+'.stderr','xb') as log:
        process=subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log, start_new_session=True, **kwargs)
    children.append(process)
    return process

def command(args, data=None, timeout=8):
    return subprocess.run(args,input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout,check=True).stdout

def proof(op,*pids):
    return json.loads(command(['/opt/desktop/x11-proof',op,*map(str,pids)]))

def group_pids(pgid):
    found=[]
    for name in os.listdir('/proc'):
        if name.isdigit():
            try:
                stat=open('/proc/'+name+'/stat').read().rsplit(')',1)[1].split()
                if int(stat[2])==pgid and stat[0]!='Z': found.append(int(name))
            except (FileNotFoundError,ProcessLookupError): pass
    return found

@serialized
def retire(lease_id,may_be_writable=None,reason='controller_request'):
    global actor,tainted,epoch
    if actor is None and lease_id in settlements:
        cached=settlements[lease_id]
        if may_be_writable is True and cached['readOnly']:
            try: upgraded=proof('settle',*settlement_pids[lease_id])
            except Exception:
                tainted=True
                raise
            epoch+=1
            upgraded.update(vncProcessesExited=True,readOnly=False,inputResetRequired=True,displayGeneration=GENERATION,browserGeneration=BROWSER_GENERATION,epoch=epoch,leaseId=lease_id)
            settlements[lease_id]=upgraded
            return upgraded
        return cached
    if not actor or actor['leaseId']!=lease_id: raise ValueError('active lease mismatch')
    current=actor
    process=current['process']
    # The ingress owner must already have fenced sockets and queued operations.
    pids=set(current['pids']) | set(group_pids(process.pid))
    current['fenced']=True
    try:
        for sig,limit in [(signal.SIGTERM,1),(signal.SIGKILL,3)]:
            try: os.killpg(process.pid,sig)
            except ProcessLookupError: pass
            deadline=time.monotonic()+limit
            while group_pids(process.pid) and time.monotonic()<deadline: time.sleep(.01)
            if not group_pids(process.pid): break
        process.wait(timeout=1)
        # PID 1 adopts any actor descendants; reap the entire owned group.
        while True:
            try:
                reaped,_=os.waitpid(-process.pid,os.WNOHANG)
                if reaped==0: break
            except ChildProcessError: break
        if group_pids(process.pid): raise RuntimeError('actor process group remains')
        for pid,(owner,lease) in list(pending_clipboard.items()):
            if lease is current:
                stop_clipboard_owner(owner)
                pending_clipboard.pop(pid,None)
        reset_required=current['role']=='control' or may_be_writable is True
        result=proof('settle' if reset_required else 'absent',*sorted(pids))
        epoch+=1
        result.update(vncProcessesExited=True,readOnly=not reset_required,inputResetRequired=reset_required,displayGeneration=GENERATION,browserGeneration=BROWSER_GENERATION,epoch=epoch,leaseId=lease_id,retirementReason=reason)
        settlements[lease_id]=result
        settlement_pids[lease_id]=sorted(pids)
        if len(settlements)>32:
            oldest=next(iter(settlements));del settlements[oldest];settlement_pids.pop(oldest,None)
        actor=None
        if process in children: children.remove(process)
        try: os.unlink(current['passwordFile'])
        except FileNotFoundError: pass
        return result
    except Exception:
        tainted=True
        raise

@serialized
def start(lease_id,role,expires_at=None):
    global actor,epoch
    if tainted: raise RuntimeError('desktop settlement failed; quarantined')
    if actor: raise ValueError('an actor already owns the display')
    if not isinstance(lease_id,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',lease_id): raise ValueError('invalid lease ID')
    if role not in ('watch','control'): raise ValueError('invalid role')
    now=time.time()*1000
    if expires_at is None: expires_at=now+600000
    if not isinstance(expires_at,(int,float)) or not now<expires_at<=now+3600000: raise ValueError('lease deadline must be within one hour')
    settlements.pop(lease_id,None)
    settlement_pids.pop(lease_id,None)
    password=secrets.token_urlsafe(12)[:8]
    password_file='/tmp/desktop/vnc-'+secrets.token_hex(8)
    open(password_file,'w').write(password+'\n')
    args=['x11vnc','-display','unix/:1','-rfbport','5900','-listen','0.0.0.0','-passwdfile',password_file,
          '-forever','-shared','-noxdamage','-noxrecord','-nosel','-noprimary','-noclipboard','-nosetclipboard',
          '-nosetprimary','-noremote','-nocmds','-no6','-noipv6','-o','/dev/null']
    if role=='watch': args.append('-viewonly')
    process=launch(args)
    actor={'process':process,'leaseId':lease_id,'role':role,'pids':[process.pid],'passwordFile':password_file,'expiresAt':expires_at}
    try:
        deadline=time.monotonic()+8
        while time.monotonic()<deadline:
            if process.poll() is not None: raise RuntimeError('x11vnc exited before identity verification')
            clients=proof('clients')
            owned=[c for c in clients if c['pid'] in group_pids(process.pid)]
            if any(c['pid']==process.pid for c in owned):
                if listening(5900): break
            time.sleep(.025)
        else: raise RuntimeError('x11vnc PID not proven by XRes')
        actor['pids']=group_pids(process.pid)
        epoch+=1
        actor['epoch']=epoch
        refresh_heartbeat(actor)
        return {'pid':process.pid,'xClients':owned,'password':password,'role':role,'leaseId':lease_id,'epoch':epoch,'expiresAt':expires_at,'heartbeatDeadline':actor['heartbeatDeadline'],'heartbeatTimeoutMs':HEARTBEAT_TIMEOUT_MS,'displayGeneration':GENERATION,'browserGeneration':BROWSER_GENERATION}
    except Exception:
        retire(lease_id)
        raise

def dispatch(request):
    global clipboard_owner
    op=request.get('op')
    with lifecycle_lock: healthy=all(child.poll() is None for child in critical)
    if op=='status':
        with lifecycle_lock: return {'ready':healthy and not tainted,'displayGeneration':GENERATION,'browserGeneration':BROWSER_GENERATION,'epoch':epoch,'tainted':tainted,'heartbeatTimeoutMs':HEARTBEAT_TIMEOUT_MS,'viewer':None if not actor else {'leaseId':actor['leaseId'],'role':actor['role'],'pid':actor['process'].pid,'epoch':actor.get('epoch'),'expiresAt':actor['expiresAt'],'heartbeatDeadline':actor.get('heartbeatDeadline')},'criticalProcesses':[{'name':child.args[0],'pid':child.pid,'running':child.poll() is None} for child in critical],'browserSandbox':True,'authenticatedInternetReady':healthy and not tainted,'sandboxVerification':'headed Chromium with namespace/seccomp profile; see deployment proof','isolation':'browser-userns-seccomp-and-dedicated-container-no-host-mounts'}
    if op=='stopViewerAndSettle': return retire(request.get('leaseId'),request.get('mayBeWritable'))
    if not healthy or tainted: raise RuntimeError('desktop unavailable or quarantined; do not resume browser automation')
    if op=='heartbeatViewer': return heartbeat(request.get('leaseId'),request.get('epoch'))
    if op=='startViewer': return start(request.get('leaseId'),request.get('role','watch'),request.get('expiresAt'))
    if op=='promoteViewer':
        with lifecycle_lock:
            lease=request.get('leaseId')
            if not actor or actor['leaseId']!=lease: raise ValueError('active lease mismatch')
            expires=actor['expiresAt']
            retired=retire(lease)
            result=start(lease,'control',expires);result['previousSettlement']=retired;return result
    if op=='clipboardWrite':
        text=request.get('text')
        if not isinstance(text,str) or len(text.encode('utf-8'))>1048576: raise ValueError('invalid clipboard text')
        # Foreground ownership avoids xclip's default fork retaining command pipes.
        with lifecycle_lock:
            lease=actor;operation_epoch=epoch
            check_clipboard_lease(request,lease,operation_epoch)
            owner=subprocess.Popen(['xclip','-quiet','-selection','clipboard','-in','-target','UTF8_STRING'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
            children.append(owner)
            pending_clipboard[owner.pid]=(owner,lease)
        committed=False
        data=text.encode('utf-8')
        try:
            owner.stdin.write(data);owner.stdin.close()
            deadline=time.monotonic()+3
            while True:
                check_clipboard_lease(request,lease,operation_epoch)
                if owner.poll() is not None: raise RuntimeError('clipboard owner exited before selection verification')
                selected=proof('selection-owner')
                if selected['pid']==owner.pid:
                    if command(['xclip','-selection','clipboard','-out','-target','UTF8_STRING'],timeout=1)==data and proof('selection-owner')['pid']==owner.pid: break
                if time.monotonic()>deadline: raise RuntimeError('clipboard selection verification timed out')
                time.sleep(.01)
            with lifecycle_lock:
                check_clipboard_lease(request,lease,operation_epoch)
                previous=clipboard_owner
                clipboard_owner=owner
                pending_clipboard.pop(owner.pid,None)
                committed=True
            if previous is not None: stop_clipboard_owner(previous)
            return {'ok':True,'bytes':len(data),'leaseId':lease['leaseId'],'epoch':operation_epoch,'ownerPid':owner.pid,'selectionOwnedByHelper':True}
        except Exception:
            with lifecycle_lock: pending_clipboard.pop(owner.pid,None)
            if not committed: stop_clipboard_owner(owner)
            raise
    if op=='clipboardRead':
        lease=actor;operation_epoch=epoch
        check_clipboard_lease(request,lease,operation_epoch)
        data=command(['xclip','-selection','clipboard','-out','-target','UTF8_STRING'])
        if len(data)>1048576: raise ValueError('clipboard exceeds limit')
        check_clipboard_lease(request,lease,operation_epoch)
        return {'text':data.decode('utf-8'),'leaseId':lease['leaseId'],'epoch':operation_epoch}
    raise ValueError('unknown operation')

@serialized
def check_clipboard_lease(request,lease,operation_epoch):
    if lease is None or actor is not lease or lease['role']!='control' or lease.get('fenced') or epoch!=operation_epoch or time.time()*1000>=lease['expiresAt']: raise RuntimeError('clipboard requires an active control lease')
    if request.get('leaseId',lease['leaseId'])!=lease['leaseId'] or request.get('epoch',operation_epoch)!=operation_epoch: raise RuntimeError('clipboard control lease/epoch mismatch')

@serialized
def stop_clipboard_owner(owner):
    global tainted
    try:
        if owner.poll() is None:
            try: os.killpg(owner.pid,signal.SIGKILL)
            except ProcessLookupError: pass
        owner.wait(timeout=1)
        deadline=time.monotonic()+5
        while any(client['pid']==owner.pid for client in proof('clients')):
            if time.monotonic()>deadline: raise RuntimeError('retired clipboard owner X clients remain')
            time.sleep(.002)
        if owner in children: children.remove(owner)
    except Exception:
        tainted=True
        raise

def cleanup(*unused):
    stopping.set()
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    signal.signal(signal.SIGINT,signal.SIG_IGN)
    # Keep X alive while Chrome flushes its profile and removes Singleton locks.
    for child in reversed(children):
        if child.args[0] in ('Xvfb','openbox'): continue
        try: os.killpg(child.pid,signal.SIGTERM)
        except ProcessLookupError: pass
    deadline=time.monotonic()+4
    for child in reversed(children):
        if child.args[0] in ('Xvfb','openbox'): continue
        try: child.wait(timeout=max(.01,deadline-time.monotonic()))
        except subprocess.TimeoutExpired: pass
    for child in reversed(children):
        try: os.killpg(child.pid,signal.SIGKILL)
        except ProcessLookupError: pass
    raise SystemExit(0)

def watchdog():
    global tainted
    while not stopping.wait(.05):
        with lifecycle_lock:
            if not all(child.poll() is None for child in critical): tainted=True
            current=actor
            if not current or current.get('fenced'): continue
            reason=None
            if tainted: reason='critical_child_exit'
            elif time.time()*1000>=current['expiresAt']: reason='lease_expired'
            elif time.monotonic()>=current['heartbeatMonotonic']: reason='heartbeat_timeout'
            elif current['process'].poll() is not None: reason='actor_process_exit'
            if reason:
                try: retire(current['leaseId'],reason=reason)
                except Exception: tainted=True

signal.signal(signal.SIGTERM,cleanup)
signal.signal(signal.SIGINT,cleanup)
critical.append(InheritedProxy(int(os.environ['DESKTOP_PROXY_PID'])))
critical.append(launch(['Xvfb',':1','-screen','0','1280x900x24','-dpi','96','-ac','-nolisten','tcp','+extension','XTEST','+extension','X-Resource']))
deadline=time.monotonic()+10
while not os.path.exists('/tmp/.X11-unix/X1'):
    if time.monotonic()>deadline: raise RuntimeError('display startup timeout')
    time.sleep(.02)
proof('clients')
os.makedirs('/home/browser/.config/openbox',exist_ok=True)
open('/home/browser/.config/openbox/rc.xml','w').write('''<openbox_config xmlns="http://openbox.org/3.4/rc"><applications><application class="*"><decor>no</decor><maximized>yes</maximized></application></applications></openbox_config>''')
critical.append(launch(['openbox','--config-file','/home/browser/.config/openbox/rc.xml']))
# The host adapter proves this dedicated volume has no running users before boot.
# Chrome's SIGTERM/crash can leave lock symlinks naming a previous container.
for singleton in ('SingletonLock','SingletonCookie','SingletonSocket'):
    path='/profile/'+singleton
    if os.path.lexists(path):
        if not os.path.islink(path): raise RuntimeError('unexpected non-symlink Chromium singleton lock')
        os.unlink(path)
critical.append(launch(['chromium','--test-type','--no-first-run','--no-default-browser-check','--password-store=basic','--user-data-dir=/profile','--remote-debugging-address=127.0.0.1','--remote-debugging-port=9222','--force-device-scale-factor=1','--high-dpi-support=1','--start-maximized','--window-position=0,0','--window-size=1280,900','--disable-dev-shm-usage','https://example.com']))
deadline=time.monotonic()+30
while not (listening(9222) and listening(9223,1001)):
    if not all(child.poll() is None for child in critical): raise RuntimeError('critical desktop process exited during startup')
    if time.monotonic()>deadline: raise RuntimeError('browser startup timeout')
    time.sleep(.05)
server=socket.socket(socket.AF_UNIX)
server.bind('/tmp/desktop/control.sock');server.listen(8);server.settimeout(.25)
threading.Thread(target=watchdog,name='desktop-heartbeat-watchdog',daemon=True).start()
while True:
    try: connection,_=server.accept()
    except socket.timeout: continue
    connection.settimeout(15)
    try:
        data=b''
        while True:
            chunk=connection.recv(65536)
            if not chunk: break
            data+=chunk
            if len(data)>1200000: raise ValueError('request exceeds limit')
        response=dispatch(json.loads(data))
    except Exception as error: response={'error':str(error)[:300]}
    try: connection.sendall(json.dumps(response,ensure_ascii=False).encode('utf-8'))
    except OSError: pass
    connection.close()
