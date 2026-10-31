"""Own or read the X CLIPBOARD selection over the local transport."""
import ctypes as c,os,select,signal,sys,time
i32,ul,vp,cp=c.c_int,c.c_ulong,c.c_void_p,c.c_char_p
x=c.CDLL('libX11.so.6')
class SelectionRequestEvent(c.Structure):_fields_=[('type',i32),('serial',ul),('send_event',i32),('display',vp),('owner',ul),('requestor',ul),('selection',ul),('target',ul),('property',ul),('time',ul)]
class SelectionEvent(c.Structure):_fields_=[('type',i32),('serial',ul),('send_event',i32),('display',vp),('requestor',ul),('selection',ul),('target',ul),('property',ul),('time',ul)]
class SelectionClearEvent(c.Structure):_fields_=[('type',i32),('serial',ul),('send_event',i32),('display',vp),('window',ul),('selection',ul),('time',ul)]
class PropertyEvent(c.Structure):_fields_=[('type',i32),('serial',ul),('send_event',i32),('display',vp),('window',ul),('atom',ul),('time',ul),('state',i32)]
class XEvent(c.Union):_fields_=[('type',i32),('xselectionrequest',SelectionRequestEvent),('xselection',SelectionEvent),('xselectionclear',SelectionClearEvent),('xproperty',PropertyEvent),('pad',c.c_long*24)]
ERRHANDLER=c.CFUNCTYPE(i32,vp,vp)
x.XOpenDisplay.argtypes=[cp];x.XOpenDisplay.restype=vp
x.XCloseDisplay.argtypes=[vp];x.XCloseDisplay.restype=i32
x.XSetErrorHandler.argtypes=[ERRHANDLER];x.XSetErrorHandler.restype=vp
x.XConnectionNumber.argtypes=[vp];x.XConnectionNumber.restype=i32
x.XPending.argtypes=[vp];x.XPending.restype=i32
x.XNextEvent.argtypes=[vp,c.POINTER(XEvent)];x.XNextEvent.restype=i32
x.XFlush.argtypes=[vp];x.XFlush.restype=i32
x.XDefaultRootWindow.argtypes=[vp];x.XDefaultRootWindow.restype=ul
x.XCreateSimpleWindow.argtypes=[vp,ul,i32,i32,c.c_uint,c.c_uint,c.c_uint,ul,ul];x.XCreateSimpleWindow.restype=ul
x.XSelectInput.argtypes=[vp,ul,c.c_long];x.XSelectInput.restype=i32
x.XInternAtom.argtypes=[vp,cp,i32];x.XInternAtom.restype=ul
x.XSetSelectionOwner.argtypes=[vp,ul,ul,ul];x.XSetSelectionOwner.restype=i32
x.XGetSelectionOwner.argtypes=[vp,ul];x.XGetSelectionOwner.restype=ul
x.XConvertSelection.argtypes=[vp,ul,ul,ul,ul,ul];x.XConvertSelection.restype=i32
x.XChangeProperty.argtypes=[vp,ul,ul,ul,i32,i32,vp,i32];x.XChangeProperty.restype=i32
x.XGetWindowProperty.argtypes=[vp,ul,ul,c.c_long,c.c_long,i32,ul,c.POINTER(ul),c.POINTER(i32),c.POINTER(ul),c.POINTER(ul),c.POINTER(c.POINTER(c.c_ubyte))];x.XGetWindowProperty.restype=i32
x.XSendEvent.argtypes=[vp,ul,i32,c.c_long,c.POINTER(XEvent)];x.XSendEvent.restype=i32
x.XFree.argtypes=[vp];x.XFree.restype=i32
x.XExtendedMaxRequestSize.argtypes=[vp];x.XExtendedMaxRequestSize.restype=c.c_long
x.XMaxRequestSize.argtypes=[vp];x.XMaxRequestSize.restype=c.c_long
PROPERTY_NOTIFY,SELECTION_CLEAR,SELECTION_REQUEST,SELECTION_NOTIFY=28,29,30,31
PROPERTY_CHANGE_MASK=1<<22;REPLACE,APPEND=0,2;XA_ATOM=4
# A requestor can vanish mid-conversion. Xlib's default handler would exit the owner on that BadWindow.
handler=ERRHANDLER(lambda _d,_e:0)
def stop(*_):raise SystemExit(0)
def display():
    d=x.XOpenDisplay(('unix/'+os.environ.get('DISPLAY','')).encode())
    if not d:raise RuntimeError('local X display unavailable')
    x.XSetErrorHandler(handler)
    return d
def atom(d,name):return x.XInternAtom(d,name.encode(),0)
def window(d):return x.XCreateSimpleWindow(d,x.XDefaultRootWindow(d),0,0,1,1,0,0,0)
def next_event(d,deadline=None):
    fd=x.XConnectionNumber(d)
    while not x.XPending(d):
        wait=None if deadline is None else deadline-time.monotonic()
        if wait is not None and wait<=0:return None
        select.select([fd],[],[],wait)
    ev=XEvent();x.XNextEvent(d,c.byref(ev))
    return ev
def server_time(d,win):
    x.XSelectInput(d,win,PROPERTY_CHANGE_MASK)
    x.XChangeProperty(d,win,atom(d,'CLAWSER_CLIPBOARD'),atom(d,'UTF8_STRING'),8,APPEND,b'',0)
    while True:
        ev=next_event(d)
        if ev.type==PROPERTY_NOTIFY and ev.xproperty.window==win:return ev.xproperty.time
def own():
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    text=sys.stdin.buffer.read().decode('utf-8')
    d=display()
    units=x.XExtendedMaxRequestSize(d) or x.XMaxRequestSize(d)
    data=text.encode('utf-8')
    if len(data)>units*4-1024:raise RuntimeError('clipboard text too large')
    latin=text.encode('latin-1','replace')
    clipboard,targets,utf8,string=atom(d,'CLIPBOARD'),atom(d,'TARGETS'),atom(d,'UTF8_STRING'),atom(d,'STRING')
    texts=[utf8,string,atom(d,'TEXT'),atom(d,'text/plain;charset=utf-8')]
    offered=(ul*5)(targets,*texts)
    win=window(d)
    # ICCCM forbids CurrentTime for ownership. A PropertyNotify yields a real server timestamp.
    acquired=server_time(d,win)
    x.XSetSelectionOwner(d,clipboard,win,acquired)
    if x.XGetSelectionOwner(d,clipboard)!=win:raise RuntimeError('clipboard ownership refused')
    while True:
        ev=next_event(d)
        if ev.type==SELECTION_CLEAR and ev.xselectionclear.window==win:break
        if ev.type!=SELECTION_REQUEST:continue
        req=ev.xselectionrequest;prop=req.property or req.target
        # Server time is 32-bit milliseconds and wraps around.
        stale=req.time and 0<(acquired-req.time)%2**32<2**31
        if stale or req.selection!=clipboard or (req.target!=targets and req.target not in texts):prop=0
        elif req.target==targets:x.XChangeProperty(d,req.requestor,prop,XA_ATOM,32,REPLACE,offered,len(offered))
        elif req.target==string:x.XChangeProperty(d,req.requestor,prop,string,8,REPLACE,latin,len(latin))
        else:x.XChangeProperty(d,req.requestor,prop,utf8,8,REPLACE,data,len(data))
        reply=XEvent();reply.xselection=SelectionEvent(type=SELECTION_NOTIFY,display=d,requestor=req.requestor,selection=req.selection,target=req.target,property=prop,time=req.time)
        x.XSendEvent(d,req.requestor,0,0,c.byref(reply));x.XFlush(d)
    x.XCloseDisplay(d)
    return 0
def read():
    d=display();win=window(d);prop=atom(d,'CLAWSER_CLIPBOARD')
    x.XConvertSelection(d,atom(d,'CLIPBOARD'),atom(d,'UTF8_STRING'),prop,win,0)
    deadline=time.monotonic()+1
    while True:
        ev=next_event(d,deadline)
        if ev is None:raise RuntimeError('clipboard unavailable')
        if ev.type==SELECTION_NOTIFY and ev.xselection.requestor==win:break
    if not ev.xselection.property:raise RuntimeError('clipboard unavailable')
    kind,fmt,count,after=ul(),i32(),ul(),ul();value=c.POINTER(c.c_ubyte)()
    status=x.XGetWindowProperty(d,win,ev.xselection.property,0,0x1fffffff,1,0,c.byref(kind),c.byref(fmt),c.byref(count),c.byref(after),c.byref(value))
    data=(c.string_at(value,count.value) if count.value else b'') if fmt.value==8 else None
    if value:x.XFree(c.cast(value,vp))
    if kind.value==atom(d,'INCR') or after.value:raise RuntimeError('clipboard text too large')
    if status!=0 or not kind.value or data is None:raise RuntimeError('clipboard unavailable')
    x.XCloseDisplay(d)
    sys.stdout.buffer.write(data);sys.stdout.flush()
    return 0
def main(argv):
    try:
        op=argv[1] if len(argv)>1 else ''
        if op=='own':return own()
        if op=='read':return read()
        raise RuntimeError('expected own|read')
    except Exception as e:
        print(e,file=sys.stderr);return 1
if __name__=='__main__':sys.exit(main(sys.argv))
