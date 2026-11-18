"""Rewrite an openbox rc.xml for the agent's virtual screen.

Whoever holds a control link can send any key or click to this X display, so
the window manager must offer nothing beyond the browser windows: one desktop,
no menus, no commands, no closing or hiding windows. Every action that is not
on an allowlist is removed from every key and mouse binding, the menu points at
an empty Clawser-owned file (openbox otherwise falls back to the system
menu.xml, which opens a terminal), and the browser window is borderless and
maximized.

Usage: openbox_config.py SOURCE_RC_XML DEST_RC_XML
The menu file is DEST's sibling menu.xml; setup writes it.
"""
import os,sys,tempfile
import xml.etree.ElementTree as E
NS='http://openbox.org/3.4/rc'
E.register_namespace('',NS)
q=lambda n:'{%s}%s'%(NS,n)
# Clicks must still focus and raise a window, so Chrome's own popups and
# dialogs stay reachable. Alt+Tab cycles windows, the one way back to a popup
# that a click on the maximized browser hid. Moving and resizing with the mouse
# keeps an off-screen dialog reachable. Nothing else survives: no Execute,
# ShowMenu, ToggleShowDesktop, Exit, Restart, Reconfigure, Close, Iconify,
# desktop switching, or If/ForEach wrappers that could hold any of them.
MOUSE_ACTIONS={'Focus','Raise','Lower','Unfocus','FocusToBottom','Unshade','Move','Resize'}
KEY_ACTIONS={'NextWindow','PreviousWindow','Focus','Raise','Unshade'}
MENU_NAME='menu.xml'
src,dest=sys.argv[1:3]
tree=E.parse(src);root=tree.getroot()
desktops=root.find(q('desktops'))
if desktops is None:desktops=E.SubElement(root,q('desktops'))
for n in desktops.findall(q('number')):desktops.remove(n)
E.SubElement(desktops,q('number')).text='1'

def prune(parent,allowed):
    # Depth first, so an allowed action keeps only allowed nested actions (NextWindow's finalactions).
    for child in list(parent):
        if child.tag==q('action') and child.get('name') not in allowed:parent.remove(child)
        else:prune(child,allowed)

def binds(section,tag):
    if section is None:return
    for parent in list(section.iter()):
        for child in list(parent):
            # A key chain (a keybind inside a keybind) goes as a whole.
            if child.tag==tag and (child.find(q('action')) is None or child.find(tag) is not None):parent.remove(child)

keyboard=root.find(q('keyboard'))
mouse=root.find(q('mouse'))
if keyboard is not None:prune(keyboard,KEY_ACTIONS)
if mouse is not None:prune(mouse,MOUSE_ACTIONS)
# An action outside the keyboard and mouse sections has no business in rc.xml.
for section in list(root):
    if section not in (keyboard,mouse):prune(section,set())
binds(keyboard,q('keybind'))
binds(mouse,q('mousebind'))
if mouse is not None:
    for context in mouse.findall(q('context')):
        if context.find(q('mousebind')) is None:mouse.remove(context)

for m in root.findall(q('menu')):root.remove(m)
menu=E.SubElement(root,q('menu'))
E.SubElement(menu,q('file')).text=os.path.join(os.path.dirname(os.path.abspath(dest)),MENU_NAME)

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
