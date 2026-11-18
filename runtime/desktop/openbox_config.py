"""Rewrite an openbox rc.xml for the agent's virtual screen.

Whoever holds a control link can send any key or click to this X display, so
the window manager must offer nothing beyond the browser windows: one desktop,
no menus, no commands, no closing or hiding windows. Every action that is not
on an allowlist is removed from every key and mouse binding, the menu points at
an empty Clawser-owned file (openbox otherwise falls back to the system
menu.xml, which opens a terminal), and the browser window is borderless and
maximized. The result is checked against the allowlist on its own before it is
written; anything left over fails the run.

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

def menu_path(dest):return os.path.join(os.path.dirname(os.path.abspath(dest)),MENU_NAME)

def prune(parent,allowed):
    # Depth first, so an allowed action keeps only allowed nested actions (NextWindow's finalactions).
    for child in list(parent):
        if child.tag==q('action') and child.get('name') not in allowed:parent.remove(child)
        else:prune(child,allowed)

def binds(section,tag):
    for parent in list(section.iter()):
        for child in list(parent):
            # A key chain (a keybind inside a keybind) goes as a whole.
            if child.tag==tag and (child.find(q('action')) is None or child.find(tag) is not None):parent.remove(child)

def section(root,tag):
    # With no keyboard or mouse section openbox applies built-in bindings (Alt+F4 closes the window), so both are
    # always present, empty if need be. openbox reads one of each.
    found=root.findall(q(tag))
    for extra in found[1:]:root.remove(extra)
    return found[0] if found else E.SubElement(root,q(tag))

def lock_down(root,dest):
    # openbox matches element names without their namespace, so a source with no xmlns, or another one, is handled
    # the same: every element is moved into openbox's namespace before anything is matched.
    for element in root.iter():
        if isinstance(element.tag,str):element.tag=q(element.tag.rsplit('}',1)[-1])
    if root.tag!=q('openbox_config'):raise ValueError('not an openbox rc.xml')
    desktops=root.find(q('desktops'))
    if desktops is None:desktops=E.SubElement(root,q('desktops'))
    for n in desktops.findall(q('number')):desktops.remove(n)
    E.SubElement(desktops,q('number')).text='1'
    keyboard,mouse=section(root,'keyboard'),section(root,'mouse')
    prune(keyboard,KEY_ACTIONS)
    prune(mouse,MOUSE_ACTIONS)
    # An action outside the keyboard and mouse sections has no business in rc.xml, even as a direct child of the root.
    for child in list(root):
        if child.tag==q('action'):root.remove(child)
        elif child is not keyboard and child is not mouse:prune(child,set())
    binds(keyboard,q('keybind'))
    binds(mouse,q('mousebind'))
    for context in mouse.findall(q('context')):
        # A click on the bare desktop has nothing to do; openbox's own binds it to its menus.
        if context.get('name','').lower()=='root' or context.find(q('mousebind')) is None:mouse.remove(context)
    for m in root.findall(q('menu')):root.remove(m)
    E.SubElement(E.SubElement(root,q('menu')),q('file')).text=menu_path(dest)
    for a in root.findall(q('applications')):root.remove(a)
    apps=E.SubElement(root,q('applications'))
    E.SubElement(E.SubElement(apps,q('application'),{'class':'*'}),q('decor')).text='no'
    for cls in ('Google-chrome','Chromium'):
        E.SubElement(E.SubElement(apps,q('application'),{'class':cls,'role':'browser'}),q('maximized')).text='yes'

def leftovers(root,dest):
    """What the config would still allow beyond the allowlist, judged by local names, apart from lock_down."""
    local=lambda element:element.tag.rsplit('}',1)[-1] if isinstance(element.tag,str) else ''
    found=set()
    sections={name:[e for e in root if local(e)==name] for name in ('keyboard','mouse')}
    for name,items in sections.items():
        if len(items)!=1:found.add('%d %s sections'%(len(items),name))
    for element in root.iter():
        if local(element)!='action':continue
        name=element.get('name')
        within=lambda tag:any(any(element is e for e in s.iter()) for s in sections[tag])
        if not ((within('keyboard') and name in KEY_ACTIONS) or (within('mouse') and name in MOUSE_ACTIONS)):found.add('action %s'%name)
    files=[(f.text or '') for m in root if local(m)=='menu' for f in m.iter() if local(f)=='file']
    if files!=[menu_path(dest)]:found.add('a menu file other than Clawser\'s empty one')
    for mouse in sections['mouse']:
        for context in mouse.iter():
            if local(context)=='context' and context.get('name','').lower()=='root':found.add('a binding on the bare desktop')
    return sorted(found)

def main(src,dest):
    tree=E.parse(src);root=tree.getroot()
    try:lock_down(root,dest)
    except ValueError as error:sys.exit('openbox_config.py: %s: %s'%(src,error))
    left=leftovers(root,dest)
    if left:sys.exit('openbox_config.py: refusing to write %s, which would still allow: %s'%(dest,'; '.join(left)))
    fd,tmp=tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(dest)))
    os.close(fd)
    tree.write(tmp,encoding='UTF-8',xml_declaration=True)
    os.chmod(tmp,0o600)
    os.replace(tmp,dest)

if __name__=='__main__':
    if len(sys.argv)!=3:sys.exit(__doc__.strip().splitlines()[-2])
    main(*sys.argv[1:3])
