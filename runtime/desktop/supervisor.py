#!/usr/bin/python3
"""Host supervisor for the display and browser, with one disposable x11vnc actor per viewer session."""
import functools, json, os, re, secrets, signal, socket, stat, subprocess, sys, threading, time, urllib.parse, urllib.request, uuid

os.umask(0o077)
HERE=os.path.dirname(os.path.abspath(__file__))
# Bytecode would change the installed package. PYTHONSAFEPATH would hide xproof.
sys.dont_write_bytecode=True
sys.path.insert(0,HERE)
import xproof

CLIPBOARD=os.path.join(HERE,'clipboard.py')
BOOT=str(uuid.uuid4())
HEARTBEAT_TIMEOUT_MS=int(os.environ.get('DESKTOP_TEST_HEARTBEAT_TIMEOUT_MS','30000'))
if not 1000<=HEARTBEAT_TIMEOUT_MS<=30000: raise RuntimeError('invalid trusted heartbeat test timeout')
BROWSER_CHECK_S=int(os.environ.get('DESKTOP_TEST_BROWSER_CHECK_MS','10000'))/1000
if not .1<=BROWSER_CHECK_S<=10: raise RuntimeError('invalid trusted browser check interval')

def load_config(path):
    info=os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077: raise SystemExit('supervisor config must be an owner-only regular file')
    with open(path) as file: config=json.load(file)
    if type(config.get('display')) is not int or not 0<=config['display']<=65535: raise SystemExit('supervisor config display must be a display number')
    for name in ('xauthority','controlSocket','vncDir')+(('x11vnc',) if 'x11vnc' in config else ()):
        value=config.get(name)
        if not isinstance(value,str) or not os.path.isabs(value) or re.search(r'[\x00-\x1f\x7f]',value): raise SystemExit('supervisor config '+name+' must be an absolute path')
    if 'browserPort' in config and (type(config['browserPort']) is not int or not 1<=config['browserPort']<=65535): raise SystemExit('supervisor config browserPort must be a port number')
    url=urllib.parse.urlsplit(str(config.get('cdpUrl','')))
    # localhost can resolve to ::1 while Chrome listens only on 127.0.0.1.
    if url.scheme!='http' or url.hostname!='127.0.0.1' or url.username or url.password or url.query or url.fragment or url.path not in ('','/'): raise SystemExit('supervisor config cdpUrl must be http://127.0.0.1:<port>')
    config['cdpUrl']='http://'+url.netloc
    return config

def private_dir(path):
    try: info=os.lstat(path)
    except FileNotFoundError: info=None
    if not info or not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o700: raise SystemExit(path+' must be a 0700 directory owned by this user')

if len(sys.argv)!=2: raise SystemExit('usage: supervisor.py <config.json>')
CONFIG=load_config(sys.argv[1])
DISPLAY=CONFIG['display'];CONTROL=CONFIG['controlSocket'];VNC_DIR=CONFIG['vncDir'];CDP_URL=CONFIG['cdpUrl']
X_SOCKET='/tmp/.X11-unix/X%d'%DISPLAY
X_LOCK='/tmp/.X%d-lock'%DISPLAY
for path in (CONTROL,os.path.join(VNC_DIR,'vnc-'+'0'*16+'.sock')):
    if len(os.fsencode(path))>107: raise SystemExit('socket path exceeds 107 bytes: '+path)
private_dir(VNC_DIR)
private_dir(os.path.dirname(CONTROL))
os.environ['DISPLAY']=':%d'%DISPLAY
os.environ['XAUTHORITY']=CONFIG['xauthority']
# x11vnc exits when it sees a Wayland session, even with -display.
os.environ.pop('WAYLAND_DISPLAY',None)

children=[]
actor=None
epoch=0
tainted=False
settlements={}
settlement_pids={}
clipboard_owner=None
pending_clipboard={}
display_known=None
browser_guid=None
browser_ready=False
browser_seq=0
probe_seq=[0]
retry_delay=[.5]
lifecycle_lock=threading.RLock()
x_lock=threading.Lock()
stopping=threading.Event()
x_identity=[None]
# A user's http_proxy must never receive loopback CDP requests.
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))

def serialized(function):
    @functools.wraps(function)
    def invoke(*args,**kwargs):
        with lifecycle_lock: return function(*args,**kwargs)
    return invoke

def x_alive(d):
    probe=socket.fromfd(xproof.x.XConnectionNumber(d),socket.AF_UNIX,socket.SOCK_STREAM)
    try: return probe.recv(1,socket.MSG_PEEK|socket.MSG_DONTWAIT)!=b''
    except BlockingIOError: return True
    except OSError: return False
    finally: probe.close()

def proof(function,*args):
    # xproof shares one Xlib connection, which is not thread-safe. Its error flag never clears itself.
    with x_lock:
        identity=display_identity()
        # Xlib exits the process on I/O to a dead server. A stale connection is dropped, never closed.
        replaced=identity is not None and identity!=x_identity[0]
        if xproof._d[0] and (replaced or not x_alive(xproof._d[0])): xproof._d[0]=None
        if identity is not None: x_identity[0]=identity
        xproof.xerror[0]=0
        return function(*args)

def display_lost():
    # Xvfb drops its clients before it unlinks its socket. A dead connection is the earlier signal.
    with x_lock:
        d=xproof._d[0]
        return display_identity()!=display_known or bool(d) and not x_alive(d)

def display_generation(): return BOOT+':'+str(display_known)
def browser_generation(): return BOOT+':'+(browser_guid or 'none')

def display_identity():
    # An ext4 /tmp can give a restarted Xvfb the same socket inode. Its PID tells them apart.
    try:
        inode=os.stat(X_SOCKET).st_ino
        with open(X_LOCK,'rb') as file: text=file.read(64)
    except OSError: return None
    if not re.fullmatch(rb' *[1-9][0-9]{0,9}\n',text): return None
    return '%d:%d'%(inode,int(text))

def display_up(): return display_identity() is not None and proof(xproof.display_ok)

def probe_browser():
    try:
        with opener.open(CDP_URL+'/json/version',timeout=2) as response: body=json.loads(response.read(65536))
        if not re.match(r'(Chrome|Chromium)/',str(body.get('Browser',''))): return False,None
    except Exception: return False,None
    match=re.fullmatch(r'/devtools/browser/([A-Za-z0-9._-]{1,128})',urllib.parse.urlsplit(str(body.get('webSocketDebuggerUrl',''))).path)
    return True,match and match.group(1)

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

def launch(args):
    process=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,start_new_session=True)
    children.append(process)
    return process

def command(args, data=None, timeout=8):
    return subprocess.run(args,input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout,check=True).stdout

def clipboard_read(timeout=8):
    try: return command([sys.executable,CLIPBOARD,'read'],timeout=timeout)
    except subprocess.CalledProcessError as error: raise RuntimeError(error.stderr.decode('utf-8','replace').strip()[-200:] or 'clipboard unavailable') from None

def remove(path):
    try: os.unlink(path)
    except FileNotFoundError: pass

def group_pids(pgid):
    found=[]
    for name in os.listdir('/proc'):
        if name.isdigit():
            try:
                fields=open('/proc/'+name+'/stat').read().rsplit(')',1)[1].split()
                if int(fields[2])==pgid and fields[0]!='Z': found.append(int(name))
            except (FileNotFoundError,ProcessLookupError): pass
    return found

@serialized
def retire(lease_id,may_be_writable=None,reason='controller_request'):
    global actor,tainted,epoch
    if actor is None and lease_id in settlements:
        cached=settlements[lease_id]
        if may_be_writable is True and cached['readOnly']:
            try: upgraded=proof(xproof.settle,settlement_pids[lease_id])
            except Exception:
                tainted=True
                raise
            epoch+=1
            upgraded.update(vncProcessesExited=True,readOnly=False,inputResetRequired=True,displayGeneration=display_generation(),browserGeneration=browser_generation(),epoch=epoch,leaseId=lease_id)
            settlements[lease_id]=upgraded
            return upgraded
        return cached
    if not actor or actor['leaseId']!=lease_id: raise ValueError('active lease mismatch')
    current=actor
    reason=current.setdefault('reason',reason)
    process=current['process']
    # The ingress owner must already have fenced sockets and queued operations.
    pids=set(current['pids']) | set(group_pids(process.pid))
    current['fenced']=True
    try:
        remove(current['socketPath'])
        remove(current['passwordFile'])
        for sig,limit in [(signal.SIGTERM,1),(signal.SIGKILL,3)]:
            try: os.killpg(process.pid,sig)
            except ProcessLookupError: pass
            deadline=time.monotonic()+limit
            while group_pids(process.pid) and time.monotonic()<deadline: time.sleep(.01)
            if not group_pids(process.pid): break
        process.wait(timeout=1)
        if group_pids(process.pid): raise RuntimeError('actor process group remains')
        for pid,(owner,lease) in list(pending_clipboard.items()):
            if lease is current:
                stop_clipboard_owner(owner)
                pending_clipboard.pop(pid,None)
        if display_lost():
            tainted=True
            current['reason']=reason='critical_child_exit'
        reset_required=current['role']=='control' or may_be_writable is True
        result=proof(xproof.settle if reset_required else xproof.absent,sorted(pids))
        epoch+=1
        result.update(vncProcessesExited=True,readOnly=not reset_required,inputResetRequired=reset_required,displayGeneration=display_generation(),browserGeneration=browser_generation(),epoch=epoch,leaseId=lease_id,retirementReason=reason)
        settlements[lease_id]=result
        settlement_pids[lease_id]=sorted(pids)
        if len(settlements)>32:
            oldest=next(iter(settlements));del settlements[oldest];settlement_pids.pop(oldest,None)
        actor=None
        if process in children: children.remove(process)
        retry_delay[0]=.5
        return result
    except Exception as error:
        tainted=True
        if 'retryAt' not in current: print('supervisor: retirement failed; retrying with backoff: '+str(error),file=sys.stderr,flush=True)
        current['retryAt']=time.monotonic()+retry_delay[0]
        current['retries']=current.get('retries',0)+1
        retry_delay[0]=min(retry_delay[0]*2,30)
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
    password_file=os.path.join(VNC_DIR,'vnc-'+secrets.token_hex(8))
    socket_path=os.path.join(VNC_DIR,'vnc-'+secrets.token_hex(8)+'.sock')
    with open(password_file,'x') as file: file.write(password+'\n')
    # A person's ~/.x11vncrc must not add options to an actor.
    args=[CONFIG.get('x11vnc','x11vnc'),'-display','unix/:%d'%DISPLAY,'-unixsock',socket_path,'-rfbport','0','-no6','-rfbportv6','-1','-passwdfile',password_file,
          '-forever','-shared','-noxdamage','-noxrecord','-nosel','-noprimary','-noclipboard','-nosetclipboard',
          '-nosetprimary','-noremote','-nocmds','-o','/dev/null','-norc']
    if role=='watch': args.append('-viewonly')
    try: process=launch(args)
    except Exception:
        remove(password_file)
        raise
    actor={'process':process,'leaseId':lease_id,'role':role,'pids':[process.pid],'passwordFile':password_file,'socketPath':socket_path,'expiresAt':expires_at}
    try:
        deadline=time.monotonic()+8
        while time.monotonic()<deadline:
            if process.poll() is not None: raise RuntimeError('x11vnc exited before identity verification')
            group=set(group_pids(process.pid))
            owned=[c for c in proof(xproof.clients) if c['pid'] in group]
            if any(c['pid']==process.pid for c in owned):
                try:
                    if stat.S_ISSOCK(os.lstat(socket_path).st_mode): break
                except FileNotFoundError: pass
            time.sleep(.025)
        else: raise RuntimeError('x11vnc PID not proven by XRes')
        actor['pids']=group_pids(process.pid)
        epoch+=1
        actor['epoch']=epoch
        refresh_heartbeat(actor)
        return {'pid':process.pid,'xClients':owned,'password':password,'role':role,'leaseId':lease_id,'epoch':epoch,'expiresAt':expires_at,'heartbeatDeadline':actor['heartbeatDeadline'],'heartbeatTimeoutMs':HEARTBEAT_TIMEOUT_MS,'displayGeneration':display_generation(),'browserGeneration':browser_generation(),'socketPath':socket_path}
    except Exception:
        retire(lease_id)
        raise

def dispatch(request):
    global clipboard_owner
    op=request.get('op')
    if op=='status':
        with lifecycle_lock:
            displayed=display_up()
            return {'ready':displayed and not tainted,'browserReady':browser_ready,'displayGeneration':display_generation(),'browserGeneration':browser_generation(),'epoch':epoch,'tainted':tainted,'heartbeatTimeoutMs':HEARTBEAT_TIMEOUT_MS,'viewer':None if not actor else {'leaseId':actor['leaseId'],'role':actor['role'],'pid':actor['process'].pid,'epoch':actor.get('epoch'),'expiresAt':actor['expiresAt'],'heartbeatDeadline':actor.get('heartbeatDeadline'),'retirementAttempts':actor.get('retries',0)},'isolation':'host-user-services','browserSandbox':'chrome-os-sandbox','egressFirewall':False}
    if op=='stopViewerAndSettle': return retire(request.get('leaseId'),request.get('mayBeWritable'))
    with lifecycle_lock: healthy=display_identity() is not None and not tainted
    if not healthy: raise RuntimeError('desktop unavailable or quarantined; do not resume browser automation')
    if op=='heartbeatViewer': return heartbeat(request.get('leaseId'),request.get('epoch'))
    if op=='startViewer':
        # An idle restart the monitor hasn't seen yet would otherwise count as a change under this actor.
        observe_browser()
        return start(request.get('leaseId'),request.get('role','watch'),request.get('expiresAt'))
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
        with lifecycle_lock:
            lease=actor;operation_epoch=epoch
            check_clipboard_lease(request,lease,operation_epoch)
            owner=subprocess.Popen([sys.executable,CLIPBOARD,'own'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
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
                selected=proof(xproof.selection_owner)
                if selected['pid']==owner.pid:
                    if clipboard_read(timeout=2)==data and proof(xproof.selection_owner)['pid']==owner.pid: break
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
        data=clipboard_read()
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
        while any(client['pid']==owner.pid for client in proof(xproof.clients)):
            if time.monotonic()>deadline: raise RuntimeError('retired clipboard owner X clients remain')
            time.sleep(.002)
        if owner in children: children.remove(owner)
    except Exception:
        tainted=True
        raise

def watchdog():
    global tainted
    while not stopping.wait(.05):
        with lifecycle_lock:
            current=actor
            if not current: continue
            if current.get('fenced'):
                # A retirement that failed while the display was down completes once it is back.
                if time.monotonic()>=current.get('retryAt',float('inf')):
                    try: retire(current['leaseId'])
                    except Exception: pass
                continue
            if display_lost(): tainted=True
            reason=None
            if tainted: reason='critical_child_exit'
            elif time.time()*1000>=current['expiresAt']: reason='lease_expired'
            elif time.monotonic()>=current['heartbeatMonotonic']: reason='heartbeat_timeout'
            elif current['process'].poll() is not None: reason='actor_process_exit'
            if reason:
                try: retire(current['leaseId'],reason=reason)
                except Exception: tainted=True

@serialized
def observe(seq=None,ready=None,guid=None):
    global tainted,display_known,browser_guid,browser_ready,browser_seq
    active=actor is not None and not actor.get('fenced')
    identity=display_identity()
    if identity is not None and identity!=display_known:
        if active: tainted=True
        display_known=identity
    # A probe can take 2 s. One that started before the newest applied probe is stale.
    if seq is None or seq<browser_seq: return
    browser_seq=seq
    if guid is not None and guid!=browser_guid:
        if active and browser_guid is not None: tainted=True
        browser_guid=guid
    browser_ready=ready

def observe_browser():
    with lifecycle_lock:
        probe_seq[0]+=1
        seq=probe_seq[0]
    observe(seq,*probe_browser())

def listener_pid(port):
    # /proc/net/tcp lists sockets by inode; the process holding that inode is the listener.
    want='0100007F:%04X'%port
    inodes=set()
    try:
        with open('/proc/net/tcp') as file:
            for line in file.readlines()[1:]:
                fields=line.split()
                if fields[1]==want and fields[3]=='0A': inodes.add('socket:['+fields[9]+']')
    except OSError: return None
    if not inodes: return None
    for name in os.listdir('/proc'):
        if not name.isdigit(): continue
        try:
            if os.stat('/proc/'+name).st_uid!=os.getuid(): continue
            for fd in os.listdir('/proc/'+name+'/fd'):
                if os.readlink('/proc/'+name+'/fd/'+fd) in inodes: return int(name)
        except OSError: continue
    return None

def upgraded_browser():
    # A package upgrade replaces Chrome's files under a running Chrome. It keeps running from the deleted binary, and its CDP can hang.
    pid=listener_pid(CONFIG['browserPort'])
    if pid is None: return None
    try: exe=os.readlink('/proc/%d/exe'%pid)
    except OSError: return None
    # Without a new binary at the same path, a restart would fail. Leave that browser to the person.
    if not exe.endswith(' (deleted)') or not os.path.isfile(exe[:-10]): return None
    return pid

def restart_upgraded_browser():
    with lifecycle_lock:
        # Never under a person: a session that is active, or still settling, keeps the browser it started with.
        if actor is not None: return
        pid=upgraded_browser()
        if pid is None: return
        print('supervisor: the browser (pid %d) was upgraded while it ran; stopping it so its unit restarts it on the new version'%pid,file=sys.stderr,flush=True)
        try: os.kill(pid,signal.SIGTERM)
        except ProcessLookupError: return
    deadline=time.monotonic()+15
    while time.monotonic()<deadline and not stopping.is_set():
        try:
            with open('/proc/%d/stat'%pid) as file:
                if file.read().rsplit(')',1)[1].split()[0]=='Z': return
        except OSError: return
        time.sleep(.2)
    try: os.kill(pid,signal.SIGKILL)
    except ProcessLookupError: pass

def monitor():
    checked=time.monotonic()
    while not stopping.wait(.5):
        observe()
        observe_browser()
        if 'browserPort' in CONFIG and time.monotonic()-checked>=BROWSER_CHECK_S:
            checked=time.monotonic()
            restart_upgraded_browser()

def take_control_path():
    try: info=os.lstat(CONTROL)
    except FileNotFoundError: return
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid!=os.getuid(): raise SystemExit('refusing to replace '+CONTROL+': not a socket owned by this user')
    probe=socket.socket(socket.AF_UNIX);probe.settimeout(1)
    try:
        probe.connect(CONTROL)
        raise SystemExit('another supervisor is serving '+CONTROL)
    except (ConnectionRefusedError,FileNotFoundError): pass
    finally: probe.close()
    remove(CONTROL)

def shutdown():
    with lifecycle_lock:
        if actor:
            try: retire(actor['leaseId'],reason='supervisor_stop')
            except Exception as error: print('supervisor: retirement on stop failed: '+str(error),file=sys.stderr)
        for child in children:
            if child.poll() is None:
                try: os.killpg(child.pid,signal.SIGKILL)
                except ProcessLookupError: pass
                try: child.wait(timeout=1)
                except subprocess.TimeoutExpired: pass
        try:
            if os.lstat(CONTROL).st_ino==control_inode: os.unlink(CONTROL)
        except FileNotFoundError: pass
    raise SystemExit(0)

def strays():
    found=[]
    display=b'DISPLAY=:%d'%DISPLAY
    for name in os.listdir('/proc'):
        if not name.isdigit(): continue
        try:
            if os.stat('/proc/'+name).st_uid!=os.getuid(): continue
            with open('/proc/'+name+'/cmdline','rb') as file: argv=file.read().split(b'\0')
            if os.path.basename(argv[0])==b'x11vnc':
                if b'-unixsock' in argv[:-1] and os.path.dirname(argv[argv.index(b'-unixsock')+1])==os.fsencode(VNC_DIR): found.append(int(name))
            elif argv[1:3]==[os.fsencode(CLIPBOARD),b'own']:
                with open('/proc/'+name+'/environ','rb') as file: env=file.read().split(b'\0')
                if display in env: found.append(int(name))
        except (OSError,IndexError): continue
    return found

signal.signal(signal.SIGTERM,lambda *unused: stopping.set())
signal.signal(signal.SIGINT,lambda *unused: stopping.set())
take_control_path()
deadline=time.monotonic()+30
while not display_up():
    if stopping.is_set(): raise SystemExit(0)
    if time.monotonic()>deadline: raise SystemExit('display :%d is unavailable'%DISPLAY)
    time.sleep(.1)
display_known=display_identity()
# Outside systemd's control-group kill, a killed supervisor's children outlive it.
orphans=strays()
for pid in orphans:
    try: os.kill(pid,signal.SIGKILL)
    except ProcessLookupError: pass
# The host display outlives this process. Input a previous supervisor's x11vnc held stays held.
try: proof(xproof.settle,orphans)
except Exception as error:
    tainted=True
    print('supervisor: held input could not be released; quarantined: '+str(error),file=sys.stderr)
for name in os.listdir(VNC_DIR):
    if re.fullmatch(r'vnc-[0-9a-f]{16}(\.sock)?',name): remove(os.path.join(VNC_DIR,name))
observe_browser()
server=socket.socket(socket.AF_UNIX)
server.bind(CONTROL);server.listen(8);server.settimeout(.25)
control_inode=os.lstat(CONTROL).st_ino
threading.Thread(target=watchdog,name='desktop-heartbeat-watchdog',daemon=True).start()
threading.Thread(target=monitor,name='desktop-generation-monitor',daemon=True).start()
while not stopping.is_set():
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
server.close()
shutdown()
