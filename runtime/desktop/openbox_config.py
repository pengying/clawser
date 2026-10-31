"""Rewrite an openbox rc.xml: one desktop, no desktop switching, borderless, browser maximized."""
import os,sys,tempfile
import xml.etree.ElementTree as E
NS='http://openbox.org/3.4/rc'
E.register_namespace('',NS)
q=lambda n:'{%s}%s'%(NS,n)
BANNED={'GoToDesktop','SendToDesktop','DesktopNext','DesktopPrevious'}
src,dest=sys.argv[1:3]
tree=E.parse(src);root=tree.getroot()
desktops=root.find(q('desktops'))
if desktops is None:desktops=E.SubElement(root,q('desktops'))
for n in desktops.findall(q('number')):desktops.remove(n)
E.SubElement(desktops,q('number')).text='1'
for parent in list(root.iter()):
    for child in list(parent):
        if child.tag==q('action') and child.get('name') in BANNED:parent.remove(child)
for parent in list(root.iter()):
    for child in list(parent):
        if child.tag in (q('keybind'),q('mousebind')) and child.find(q('action')) is None:parent.remove(child)
for a in root.findall(q('applications')):root.remove(a)
apps=E.SubElement(root,q('applications'))
E.SubElement(E.SubElement(apps,q('application'),{'class':'*'}),q('decor')).text='no'
for cls in ('Google-chrome','Chromium'):
    E.SubElement(E.SubElement(apps,q('application'),{'class':cls,'role':'browser'}),q('maximized')).text='yes'
fd,tmp=tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(dest)))
os.close(fd)
tree.write(tmp,encoding='UTF-8',xml_declaration=True)
os.chmod(tmp,0o600)
os.replace(tmp,dest)
