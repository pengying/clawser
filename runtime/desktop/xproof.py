"""X identity and input settlement proofs over the server-authenticated local transport."""
import ctypes as c,json,os,sys,time
u32,i32,vp,cp=c.c_uint32,c.c_int,c.c_void_p,c.c_char_p
LIBS='libX11.so.6','libXRes.so.1','libXtst.so.6','libXi.so.6'
x=r=t=xi=None
class Spec(c.Structure):_fields_=[('client',c.c_ulong),('mask',u32)]
class Value(c.Structure):_fields_=[('spec',Spec),('length',c.c_long),('value',vp)]
class ErrorEvent(c.Structure):_fields_=[('type',i32),('display',vp),('resourceid',c.c_ulong),('serial',c.c_ulong),('error_code',c.c_ubyte),('request_code',c.c_ubyte),('minor_code',c.c_ubyte)]
class ButtonState(c.Structure):_fields_=[('mask_len',i32),('mask',c.POINTER(c.c_ubyte))]
class ModifierState(c.Structure):_fields_=[('base',i32),('latched',i32),('locked',i32),('effective',i32)]
class DeviceInfo(c.Structure):_fields_=[('deviceid',i32),('name',cp),('use',i32),('attachment',i32),('enabled',i32),('num_classes',i32),('classes',vp)]
ERRHANDLER=c.CFUNCTYPE(i32,vp,c.POINTER(ErrorEvent))
def load():
    # A host can lack an X library. Loading on first use lets display_ok() say so instead of failing at import.
    global x,r,t,xi
    if x is not None:return
    libs=[]
    for name in LIBS:
        try:libs.append(c.CDLL(name))
        except OSError:raise RuntimeError('missing X library '+name) from None
    X,R,T,XI=libs
    X.XConnectionNumber.argtypes=[vp];X.XConnectionNumber.restype=i32
    X.XOpenDisplay.argtypes=[cp];X.XOpenDisplay.restype=vp
    X.XCloseDisplay.argtypes=[vp];X.XCloseDisplay.restype=i32
    X.XSetErrorHandler.argtypes=[ERRHANDLER];X.XSetErrorHandler.restype=vp
    X.XSync.argtypes=[vp,i32];X.XSync.restype=i32
    X.XFree.argtypes=[vp];X.XFree.restype=i32
    X.XDefaultRootWindow.argtypes=[vp];X.XDefaultRootWindow.restype=c.c_ulong
    X.XQueryKeymap.argtypes=[vp,c.c_char_p];X.XQueryKeymap.restype=i32
    X.XQueryExtension.argtypes=[vp,cp,c.POINTER(i32),c.POINTER(i32),c.POINTER(i32)];X.XQueryExtension.restype=i32
    X.XInternAtom.argtypes=[vp,cp,i32];X.XInternAtom.restype=c.c_ulong
    X.XGetSelectionOwner.argtypes=[vp,c.c_ulong];X.XGetSelectionOwner.restype=c.c_ulong
    X.XGetPointerMapping.argtypes=[vp,c.c_char_p,i32];X.XGetPointerMapping.restype=i32
    R.XResQueryVersion.argtypes=[vp,c.POINTER(i32),c.POINTER(i32)];R.XResQueryVersion.restype=i32
    R.XResQueryClientIds.argtypes=[vp,c.c_long,c.POINTER(Spec),c.POINTER(c.c_long),c.POINTER(c.POINTER(Value))];R.XResQueryClientIds.restype=i32
    R.XResGetClientIdType.argtypes=[c.POINTER(Value)];R.XResGetClientIdType.restype=i32
    R.XResGetClientPid.argtypes=[c.POINTER(Value)];R.XResGetClientPid.restype=i32
    R.XResClientIdsDestroy.argtypes=[c.c_long,c.POINTER(Value)];R.XResClientIdsDestroy.restype=None
    T.XTestFakeKeyEvent.argtypes=[vp,c.c_uint,i32,c.c_ulong];T.XTestFakeKeyEvent.restype=i32
    T.XTestFakeButtonEvent.argtypes=[vp,c.c_uint,i32,c.c_ulong];T.XTestFakeButtonEvent.restype=i32
    XI.XIQueryVersion.argtypes=[vp,c.POINTER(i32),c.POINTER(i32)];XI.XIQueryVersion.restype=i32
    XI.XIQueryDevice.argtypes=[vp,i32,c.POINTER(i32)];XI.XIQueryDevice.restype=c.POINTER(DeviceInfo)
    XI.XIFreeDeviceInfo.argtypes=[c.POINTER(DeviceInfo)];XI.XIFreeDeviceInfo.restype=None
    XI.XIQueryPointer.argtypes=[vp,i32,c.c_ulong,c.POINTER(c.c_ulong),c.POINTER(c.c_ulong),c.POINTER(c.c_double),c.POINTER(c.c_double),c.POINTER(c.c_double),c.POINTER(c.c_double),c.POINTER(ButtonState),c.POINTER(ModifierState),c.POINTER(ModifierState)];XI.XIQueryPointer.restype=i32
    x,r,t,xi=X,R,T,XI
SUCCESS=0;ALL_MASTER=1;MASTER_POINTER=1
ID_XID,ID_PID=0,1
MASK_XID,MASK_PID=1,2
xerror=[0]
def onerror(_d,event):xerror[0]=event.contents.error_code;return 0
handler=ERRHANDLER(onerror)
_d=[None]
def display():
    if _d[0]:return _d[0]
    load()
    # Explicit local UNIX transport is necessary for server-authenticated PID IDs.
    d=x.XOpenDisplay(('unix/'+os.environ.get('DISPLAY','')).encode())
    if not d:raise RuntimeError('local X display unavailable')
    x.XSetErrorHandler(handler)
    major,minor=i32(1),i32(2)
    if not r.XResQueryVersion(d,c.byref(major),c.byref(minor)) or major.value<1 or (major.value==1 and minor.value<2):raise RuntimeError('XRes 1.2 required')
    op,ev,er=i32(),i32(),i32();xm,xn=i32(2),i32(0)
    if not x.XQueryExtension(d,b'XInputExtension',c.byref(op),c.byref(ev),c.byref(er)) or xi.XIQueryVersion(d,c.byref(xm),c.byref(xn))!=SUCCESS:raise RuntimeError('XI2 required')
    _d[0]=d
    return d
def sync(d,msg):
    x.XSync(d,0)
    if xerror[0]:raise RuntimeError(msg)
def query_ids(d,client,mask):
    spec=Spec(client,mask);count=c.c_long(0);values=c.POINTER(Value)()
    if r.XResQueryClientIds(d,1,c.byref(spec),c.byref(count),c.byref(values))!=SUCCESS:return None
    out=[(values[i].spec.client,r.XResGetClientIdType(c.byref(values[i])),r.XResGetClientPid(c.byref(values[i]))) for i in range(count.value)]
    r.XResClientIdsDestroy(count,values)
    return out
def clients():
    d=display()
    ids=query_ids(d,0,MASK_XID|MASK_PID)
    if ids is None:raise RuntimeError('XRes QueryClientIds failed')
    xids={cl for cl,ty,_ in ids if ty==ID_XID and cl!=0}
    out=[{'clientId':cl,'pid':pid} for cl,ty,pid in ids if ty==ID_PID and pid>0]
    if xids-{o['clientId'] for o in out}:raise RuntimeError('X client has unknown PID; absence cannot be proven')
    sync(d,'XRes X protocol error')
    return out
def held():
    d=display()
    keymap=c.create_string_buffer(32);x.XQueryKeymap(d,keymap)
    if any(keymap.raw):return True
    count=i32(0);devices=xi.XIQueryDevice(d,ALL_MASTER,c.byref(count))
    if not devices:raise RuntimeError('XIQueryDevice failed')
    down=False
    for n in range(count.value):
        if devices[n].use!=MASTER_POINTER:continue
        root,child=c.c_ulong(),c.c_ulong();rx,ry,wx,wy=(c.c_double() for _ in range(4))
        buttons=ButtonState();mods=ModifierState();group=ModifierState()
        if not xi.XIQueryPointer(d,devices[n].deviceid,x.XDefaultRootWindow(d),c.byref(root),c.byref(child),c.byref(rx),c.byref(ry),c.byref(wx),c.byref(wy),c.byref(buttons),c.byref(mods),c.byref(group)):
            xi.XIFreeDeviceInfo(devices);raise RuntimeError('XIQueryPointer failed')
        for b in range(1,buttons.mask_len*8):
            if buttons.mask[b//8]&(1<<(b%8)):down=True
        if buttons.mask:x.XFree(c.cast(buttons.mask,vp))
    xi.XIFreeDeviceInfo(devices);sync(d,'input query X protocol error')
    return down
def wait_absent(pids):
    d=display();want=set(pids);deadline=time.monotonic()+5
    while True:
        if not any(cl['pid'] in want for cl in clients()):break
        if time.monotonic()>deadline:raise RuntimeError('actor X clients remain')
        time.sleep(.002)
    return d
def absent(pids):
    d=wait_absent(pids)
    sync(d,'read-only fence X protocol error')
    return {'xClientsAbsent':True,'heldInputCleared':False,'xSyncComplete':True}
def settle(pids):
    d=wait_absent(pids)
    keys=c.create_string_buffer(32);x.XQueryKeymap(d,keys)
    for key in range(8,256):
        if keys.raw[key//8]&(1<<(key%8)) and not t.XTestFakeKeyEvent(d,key,0,0):raise RuntimeError('XTest key release failed')
    mapping=c.create_string_buffer(256);buttons=x.XGetPointerMapping(d,mapping,256)
    for b in range(1,buttons+1):
        if not t.XTestFakeButtonEvent(d,b,0,0):raise RuntimeError('XTest button release failed')
    sync(d,'XTest release X protocol error')
    if held():raise RuntimeError('held input remains')
    x.XSync(d,0)
    return {'xClientsAbsent':True,'heldInputCleared':True,'xSyncComplete':True}
def selection_owner():
    d=display()
    owner=x.XGetSelectionOwner(d,x.XInternAtom(d,b'CLIPBOARD',0));pid=0
    if owner:
        ids=query_ids(d,owner,MASK_PID)
        if ids is None:raise RuntimeError('clipboard owner XRes query failed')
        for _,ty,p in ids:
            if ty==ID_PID:pid=p
        if pid<=0:raise RuntimeError('clipboard owner PID cannot be proven')
    sync(d,'clipboard owner X protocol error')
    return {'ownerWindow':owner,'pid':pid}
def display_ok():
    try:display();return True
    except Exception:return False
def main(argv):
    try:
        if len(argv)<2:raise RuntimeError('expected clients|settle|held')
        op=argv[1]
        display()
        if op=='selection-owner':out=selection_owner()
        elif op=='clients':out=clients()
        elif op in('settle','absent'):
            if len(argv)<3:raise RuntimeError('settle requires all owned actor PIDs')
            out=(settle if op=='settle' else absent)([int(a) for a in argv[2:]])
        elif op=='held':out={'held':held()}
        else:raise RuntimeError('unknown operation')
        print(json.dumps(out,separators=(',',':')))
        x.XCloseDisplay(_d[0])
        return 0
    except Exception as e:
        print(e,file=sys.stderr);return 1
if __name__=='__main__':sys.exit(main(sys.argv))
