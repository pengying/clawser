#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XRes.h>
#include <X11/extensions/XTest.h>
#include <X11/extensions/XInput2.h>
#include <unistd.h>
#include <chrono>
#include <iostream>
#include <set>
#include <map>
#include <string>
#include <vector>
#include <stdexcept>

static int xerror = 0;
static int onerror(Display*, XErrorEvent* event) { xerror = event->error_code; return 0; }
struct Client { unsigned long xid; long pid; };
static std::vector<Client> clients(Display* d) {
  long count = 0;
  XResClientIdValue* values = nullptr;
  XResClientIdSpec spec{};
  spec.client = 0;
  spec.mask = XRES_CLIENT_ID_XID_MASK | XRES_CLIENT_ID_PID_MASK;
  if (XResQueryClientIds(d, 1, &spec, &count, &values) != Success) throw std::runtime_error("XRes QueryClientIds failed");
  std::vector<Client> out;
  std::set<unsigned long> xids;
  std::set<unsigned long> pidXids;
  for (long i=0;i<count;i++) if (XResGetClientIdType(&values[i]) == XRES_CLIENT_ID_XID && values[i].spec.client != 0) xids.insert(values[i].spec.client);
  for (long i=0;i<count;i++) if (XResGetClientIdType(&values[i]) == XRES_CLIENT_ID_PID) {
    pid_t pid = XResGetClientPid(&values[i]);
    if (pid > 0) {out.push_back({values[i].spec.client, pid});pidXids.insert(values[i].spec.client);}
  }
  XResClientIdsDestroy(count, values);
  for(auto xid:xids) if(!pidXids.count(xid)) throw std::runtime_error("X client has unknown PID; absence cannot be proven");
  XSync(d, False);
  if(xerror) throw std::runtime_error("XRes X protocol error");
  return out;
}
static bool held(Display* d) {
  char keymap[32]; XQueryKeymap(d,keymap);
  for(char byte:keymap) if(byte) return true;
  int count=0; XIDeviceInfo* devices=XIQueryDevice(d,XIAllMasterDevices,&count);
  if(!devices) throw std::runtime_error("XIQueryDevice failed");
  bool down=false;
  for(int n=0;n<count;n++) if(devices[n].use==XIMasterPointer) {
    Window root,child; double rx,ry,wx,wy; XIButtonState buttons{}; XIModifierState mods{}; XIGroupState group{};
    if(!XIQueryPointer(d,devices[n].deviceid,DefaultRootWindow(d),&root,&child,&rx,&ry,&wx,&wy,&buttons,&mods,&group)) {XIFreeDeviceInfo(devices);throw std::runtime_error("XIQueryPointer failed");}
    for(int b=1;b<buttons.mask_len*8;b++) if(XIMaskIsSet(buttons.mask,b)) down=true;
    if(buttons.mask) XFree(buttons.mask);
  }
  XIFreeDeviceInfo(devices); XSync(d,False);
  if(xerror) throw std::runtime_error("input query X protocol error");
  return down;
}
int main(int argc,char** argv) {
  try {
    if(argc<2) throw std::runtime_error("expected clients|settle|held");
    // Explicit local UNIX transport is necessary for server-authenticated PID IDs.
    Display* d=XOpenDisplay("unix/:1");
    if(!d) throw std::runtime_error("local X display unavailable");
    XSetErrorHandler(onerror);
    int major=1,minor=2;
    if(!XResQueryVersion(d,&major,&minor) || major<1 || (major==1&&minor<2)) throw std::runtime_error("XRes 1.2 required");
    int opcode,event,error; int xiMajor=2,xiMinor=0;
    if(!XQueryExtension(d,"XInputExtension",&opcode,&event,&error) || XIQueryVersion(d,&xiMajor,&xiMinor)!=Success) throw std::runtime_error("XI2 required");
    std::string op=argv[1];
    if(op=="screenshot") {
      Window root=DefaultRootWindow(d);XWindowAttributes attrs;
      if(!XGetWindowAttributes(d,root,&attrs))throw std::runtime_error("root window unavailable");
      XImage* img=XGetImage(d,root,0,0,attrs.width,attrs.height,AllPlanes,ZPixmap);
      if(!img)throw std::runtime_error("XGetImage failed");
      auto channel=[](unsigned long pixel,unsigned long mask)->unsigned char {
        if(!mask)return 0;
        int shift=0;
        while(!(mask&1)){mask>>=1;shift++;}
        return static_cast<unsigned char>(((pixel>>shift)&mask)*255/mask);
      };
      std::cout<<"P6\n"<<attrs.width<<" "<<attrs.height<<"\n255\n";
      for(int y=0;y<attrs.height;y++)for(int x=0;x<attrs.width;x++){
        auto p=XGetPixel(img,x,y);std::cout.put(channel(p,img->red_mask));std::cout.put(channel(p,img->green_mask));std::cout.put(channel(p,img->blue_mask));
      }
      XDestroyImage(img);
    } else if(op=="selection-owner") {
      Window owner=XGetSelectionOwner(d,XInternAtom(d,"CLIPBOARD",False));
      long pid=0;
      if(owner!=None) {
        XResClientIdSpec spec{};spec.client=owner;spec.mask=XRES_CLIENT_ID_PID_MASK;
        long count=0;XResClientIdValue* values=nullptr;
        if(XResQueryClientIds(d,1,&spec,&count,&values)!=Success)throw std::runtime_error("clipboard owner XRes query failed");
        for(long i=0;i<count;i++)if(XResGetClientIdType(&values[i])==XRES_CLIENT_ID_PID)pid=XResGetClientPid(&values[i]);
        XResClientIdsDestroy(count,values);
        if(pid<=0)throw std::runtime_error("clipboard owner PID cannot be proven");
      }
      XSync(d,False);if(xerror)throw std::runtime_error("clipboard owner X protocol error");
      std::cout<<"{\"ownerWindow\":"<<owner<<",\"pid\":"<<pid<<"}\n";
    } else if(op=="clients") {
      auto list=clients(d); std::cout<<"[";bool first=true;
      for(auto c:list){if(!first)std::cout<<",";first=false;std::cout<<"{\"clientId\":"<<c.xid<<",\"pid\":"<<c.pid<<"}";}
      std::cout<<"]\n";
    } else if(op=="settle" || op=="absent") {
      if(argc<3) throw std::runtime_error("settle requires all owned actor PIDs");
      std::set<long> pids; for(int i=2;i<argc;i++) pids.insert(std::stol(argv[i]));
      auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
      while(true) {
        bool found=false; for(auto c:clients(d)) if(pids.count(c.pid)) found=true;
        if(!found)break;
        if(std::chrono::steady_clock::now()>deadline)throw std::runtime_error("actor X clients remain");
        usleep(2000); // Poll scheduling only; success requires a server observation.
      }
      if(op=="absent") {
        XSync(d,False);
        if(xerror)throw std::runtime_error("read-only fence X protocol error");
        std::cout<<"{\"xClientsAbsent\":true,\"heldInputCleared\":false,\"xSyncComplete\":true}\n";
        XCloseDisplay(d);return 0;
      }
      char keys[32];XQueryKeymap(d,keys);
      for(int key=8;key<256;key++)if(keys[key/8]&(1<<(key%8))) if(!XTestFakeKeyEvent(d,key,False,CurrentTime))throw std::runtime_error("XTest key release failed");
      unsigned char mapping[256];int buttons=XGetPointerMapping(d,mapping,256);
      for(int b=1;b<=buttons;b++)if(!XTestFakeButtonEvent(d,b,False,CurrentTime))throw std::runtime_error("XTest button release failed");
      XSync(d,False);
      if(xerror)throw std::runtime_error("XTest release X protocol error");
      if(held(d))throw std::runtime_error("held input remains");
      XSync(d,False);
      std::cout<<"{\"xClientsAbsent\":true,\"heldInputCleared\":true,\"xSyncComplete\":true}\n";
    } else if(op=="held") std::cout<<"{\"held\":"<<(held(d)?"true":"false")<<"}\n";
    else throw std::runtime_error("unknown operation");
    XCloseDisplay(d);return 0;
  }catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}
}
