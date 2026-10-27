"""Trusted integration fixture: simulate held agent inputs outside the VNC actor."""
import ctypes as c,json,sys
x=c.CDLL('libX11.so.6');t=c.CDLL('libXtst.so.6')
x.XOpenDisplay.argtypes=[c.c_char_p];x.XOpenDisplay.restype=c.c_void_p
x.XDefaultRootWindow.argtypes=[c.c_void_p];x.XDefaultRootWindow.restype=c.c_ulong
x.XKeysymToKeycode.argtypes=[c.c_void_p,c.c_ulong];x.XKeysymToKeycode.restype=c.c_ubyte
x.XQueryKeymap.argtypes=[c.c_void_p,c.c_char_p]
x.XSync.argtypes=[c.c_void_p,c.c_int]
x.XCloseDisplay.argtypes=[c.c_void_p]
x.XQueryPointer.argtypes=[c.c_void_p,c.c_ulong,c.POINTER(c.c_ulong),c.POINTER(c.c_ulong),c.POINTER(c.c_int),c.POINTER(c.c_int),c.POINTER(c.c_int),c.POINTER(c.c_int),c.POINTER(c.c_uint)]
t.XTestFakeKeyEvent.argtypes=[c.c_void_p,c.c_uint,c.c_int,c.c_ulong]
t.XTestFakeButtonEvent.argtypes=[c.c_void_p,c.c_uint,c.c_int,c.c_ulong]
d=x.XOpenDisplay(b'unix/:1')
if not d:raise RuntimeError('fixture X display unavailable')
key=x.XKeysymToKeycode(d,0xffe1)
if sys.argv[1] in ('hold','release'):
    down=int(sys.argv[1]=='hold')
    if not t.XTestFakeKeyEvent(d,key,down,0) or not t.XTestFakeButtonEvent(d,1,down,0):raise RuntimeError('fixture XTest failed')
x.XSync(d,0)
keys=c.create_string_buffer(32);x.XQueryKeymap(d,keys)
root=c.c_ulong();child=c.c_ulong();rx=c.c_int();ry=c.c_int();wx=c.c_int();wy=c.c_int();mask=c.c_uint()
if not x.XQueryPointer(d,x.XDefaultRootWindow(d),c.byref(root),c.byref(child),c.byref(rx),c.byref(ry),c.byref(wx),c.byref(wy),c.byref(mask)):raise RuntimeError('fixture pointer unavailable')
print(json.dumps({'shift':bool(keys.raw[key//8]&(1<<(key%8))),'button1':bool(mask.value&256)}))
x.XCloseDisplay(d)
