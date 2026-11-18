import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { EMPTY_OPENBOX_MENU } from '../../../src/host-setup.mjs';
import { skip as noX, startX } from './xvfb.mjs';

const execute = promisify(execFile);
const script = new URL('../openbox_config.py', import.meta.url).pathname;
const desktopSwitching = ['GoToDesktop', 'SendToDesktop', 'DesktopNext', 'DesktopPrevious'];
// Each of these reaches past the browser: a command, a menu (whose fallback opens a terminal), the bare desktop, the window manager itself, or a closed or hidden browser.
const banned = ['Execute', 'ShowMenu', 'ToggleShowDesktop', 'Exit', 'Restart', 'Reconfigure', 'Close', 'Iconify', 'If', 'ForEach', 'SessionLogout', ...desktopSwitching];
const distroRc = '/etc/xdg/openbox/rc.xml';
const has = bin => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const source = `<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
<desktops><!-- <number>4</number> --><number>4</number></desktops>
<keyboard>
<chainQuitKey>C-g</chainQuitKey>
<keybind key="C-A-Left"><action name="GoToDesktop"><to>left</to></action></keybind>
<keybind key="C-A-Right"><action name="DesktopNext"/></keybind>
<keybind key="A-F4"><action name="Close"/></keybind>
<keybind key="W-d"><action name="ToggleShowDesktop"/></keybind>
<keybind key="W-e"><action name="Execute"><command>x-terminal-emulator</command></action></keybind>
<keybind key="Print"><action name="Execute"><command>scrot</command></action></keybind>
<keybind key="A-space"><action name="ShowMenu"><menu>client-menu</menu></action></keybind>
<keybind key="A-F7"><action name="Move"/></keybind>
<keybind key="A-F8"><action name="Resize"/></keybind>
<keybind key="W-x"><keybind key="t"><action name="Execute"><command>xterm</command></action></keybind><keybind key="f"><action name="Focus"/></keybind></keybind>
<keybind key="W-i"><action name="If"><then><action name="Execute"><command>xterm</command></action></then></action></keybind>
<keybind key="C-A-Delete"><action name="Exit"/></keybind>
<keybind key="W-r"><action name="Reconfigure"/><action name="Restart"/></keybind>
<keybind key="W-S-Left"><action name="SendToDesktop"><to>left</to></action><action name="DesktopPrevious"/></keybind>
<keybind key="A-Tab"><action name="NextWindow"><finalactions><action name="Focus"/><action name="Raise"/><action name="Execute"><command>xterm</command></action></finalactions></action></keybind>
</keyboard>
<mouse><context name="Desktop">
<mousebind button="A-Up" action="Click"><action name="GoToDesktop"><to>previous</to></action></mousebind>
<mousebind button="Left" action="Press"><action name="Focus"/></mousebind>
</context>
<context name="Root">
<mousebind button="Middle" action="Press"><action name="ShowMenu"><menu>client-list-combined-menu</menu></action></mousebind>
<mousebind button="Right" action="Press"><action name="ShowMenu"><menu>root-menu</menu></action></mousebind>
</context>
<context name="Client">
<mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
<mousebind button="Right" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
</context>
<context name="Frame">
<mousebind button="A-Left" action="Drag"><action name="Move"/></mousebind>
<mousebind button="W-Left" action="Click"><action name="Iconify"/></mousebind>
</context>
<context name="Close"><mousebind button="Left" action="Click"><action name="Close"/></mousebind></context>
</mouse>
<menu><file>/var/lib/openbox/debian-menu.xml</file><file>menu.xml</file><hideDelay>200</hideDelay></menu>
<applications/>
</openbox_config>
`;

async function generate(input = source) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'clawser-openbox-'));
  const rc = join(dir, 'source.xml'), out = join(dir, 'rc.xml');
  if (input === distroRc) await fs.copyFile(input, rc); else await fs.writeFile(rc, input);
  await execute('python3', [script, rc, out]);
  return { dir, out };
}
// Prints one tab-separated line per element: its tag, name attribute, text, and the context or key it sits under.
const query = (out, expr) => execute('python3', ['-c', `
import sys,xml.etree.ElementTree as E
n={'o':'http://openbox.org/3.4/rc'}
r=E.parse(sys.argv[1]).getroot()
for e in r.findall(sys.argv[2],n):print('\\t'.join([e.tag.split('}')[1],e.get('name') or e.get('key') or e.get('button') or '',(e.text or '').strip()]))
`, out, expr]).then(r => r.stdout.trim().split('\n').filter(Boolean).map(line => line.split('\t')));

async function assertLockedDown(out) {
  const actions = (await query(out, './/o:action')).map(([, name]) => name);
  for (const name of banned) assert.ok(!actions.includes(name), `${name} survived`);
  // A key may still move between windows, never move or resize one.
  const keyActions = (await query(out, './o:keyboard//o:action')).map(([, name]) => name);
  for (const name of keyActions) assert.ok(['NextWindow', 'PreviousWindow', 'Focus', 'Raise', 'Unshade'].includes(name), `key action ${name} survived`);
  assert.deepEqual(await query(out, "./o:mouse/o:context[@name='Root']"), [], 'the root window opens no menu');
  assert.equal((await fs.readFile(out, 'utf8')).includes('root-menu'), false);
  assert.deepEqual(await query(out, './o:menu/o:file'), [['file', '', join(out, '../menu.xml')]], 'only the empty Clawser menu is loaded');
  assert.deepEqual(await query(out, './o:desktops/o:number'), [['number', '', '1']]);
  // A click must still focus and raise the browser window.
  const client = await query(out, "./o:mouse/o:context[@name='Client']/o:mousebind[@button='Left']/o:action");
  assert.deepEqual(client.map(([, name]) => name), ['Focus', 'Raise']);
}

test('generated openbox config keeps one desktop and drops every escape from the browser', async () => {
  const { dir, out } = await generate();
  try {
    await assertLockedDown(out);
    const keys = (await query(out, './o:keyboard/o:keybind')).map(([, key]) => key);
    assert.deepEqual(keys, ['A-Tab'], 'chains and keys left with no action are removed');
    const cycle = (await query(out, "./o:keyboard/o:keybind[@key='A-Tab']//o:action")).map(([, name]) => name);
    assert.deepEqual(cycle, ['NextWindow', 'Focus', 'Raise']);
    assert.deepEqual((await query(out, './o:mouse/o:context')).map(([, name]) => name), ['Desktop', 'Client', 'Frame'], 'contexts left with no binding are removed');
    assert.deepEqual((await query(out, "./o:mouse/o:context[@name='Frame']/o:mousebind/o:action")).map(([, name]) => name), ['Move']);
    assert.deepEqual(await query(out, './o:menu/o:hideDelay'), [], 'the menu section is replaced');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the distribution default rc.xml comes out with no command, menu or window-manager action', { skip: has('python3') ? false : 'needs python3' }, async t => {
  try { await fs.access(distroRc); } catch { t.skip('no ' + distroRc + ' on this host'); return; }
  const { dir, out } = await generate(distroRc);
  try {
    await assertLockedDown(out);
    const all = (await query(out, './/o:action')).map(([, name]) => name);
    assert.ok(all.includes('NextWindow'), 'Alt+Tab still reaches a popup hidden behind the browser');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('generated openbox config hides title bars and maximizes only the browser\'s main window', async () => {
  const { dir, out } = await generate();
  try {
    const apps = await execute('python3', ['-c', `
import sys,xml.etree.ElementTree as E
n={'o':'http://openbox.org/3.4/rc'}
r=E.parse(sys.argv[1]).getroot()
for a in r.findall('./o:applications/o:application',n):
  print(a.get('class'),a.get('role'),{c.tag.split('}')[1]:c.text for c in a})
`, out]);
    const lines = apps.stdout.trim().split('\n');
    assert.ok(lines.includes("* None {'decor': 'no'}"), apps.stdout);
    assert.ok(lines.includes("Google-chrome browser {'maximized': 'yes'}"), apps.stdout);
    assert.ok(lines.includes("Chromium browser {'maximized': 'yes'}"), apps.stdout);
    assert.equal(lines.length, 3);
    assert.equal((await fs.stat(out)).mode & 0o777, 0o600);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// openbox loads the menu file named in rc.xml; a missing or invalid one makes it fall back to the system menu.xml.
test('openbox loads the generated config and its empty menu without falling back', { skip: noX || (has('openbox') ? false : 'needs openbox') }, async t => {
  const x = await startX();
  t.after(() => x.stop());
  const { dir, out } = await generate(await fs.access(distroRc).then(() => distroRc, () => source));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(join(dir, 'menu.xml'), EMPTY_OPENBOX_MENU, { mode: 0o600 });
  const wm = spawn('openbox', ['--config-file', out], { env: x.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  wm.stdout.on('data', chunk => { output += chunk; });
  wm.stderr.on('data', chunk => { output += chunk; });
  t.after(() => { if (wm.exitCode === null) wm.kill('SIGKILL'); });
  await sleep(1500);
  assert.equal(wm.exitCode, null, 'openbox is still running: ' + output);
  assert.doesNotMatch(output, /menu file|Unable to|error/i);
  wm.kill('SIGTERM');
  await new Promise(resolve => wm.exitCode === null ? wm.once('exit', resolve) : resolve());
});

// Review V6: the generator matched only namespaced tags, so a source without xmlns kept every binding, exit 0.
test('a source without the openbox namespace is locked down the same way', async () => {
  const bare = await generate(source.replace(' xmlns="http://openbox.org/3.4/rc"', ''));
  const namespaced = await generate();
  try {
    await assertLockedDown(bare.out);
    assert.equal(await fs.readFile(bare.out, 'utf8'), (await fs.readFile(namespaced.out, 'utf8')).replace(join(namespaced.dir, 'menu.xml'), join(bare.dir, 'menu.xml')));
  } finally { await fs.rm(bare.dir, { recursive: true, force: true }); await fs.rm(namespaced.dir, { recursive: true, force: true }); }
});

// Review S2: with no keyboard or mouse section openbox applies its built-in bindings, among them Alt+F4.
test('keyboard and mouse sections are always written, empty if the source has none', async () => {
  const { dir, out } = await generate('<?xml version="1.0"?>\n<openbox_config xmlns="http://openbox.org/3.4/rc"><desktops><number>2</number></desktops></openbox_config>\n');
  try {
    assert.deepEqual((await query(out, './o:keyboard')).map(([tag]) => tag), ['keyboard']);
    assert.deepEqual((await query(out, './o:mouse')).map(([tag]) => tag), ['mouse']);
    assert.deepEqual(await query(out, './o:keyboard/*'), []);
    assert.deepEqual(await query(out, './/o:action'), []);
    assert.deepEqual(await query(out, './o:desktops/o:number'), [['number', '', '1']]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a Root context loses even its allowed actions, and a stray top-level action goes too', async () => {
  const { dir, out } = await generate(`<openbox_config xmlns="http://openbox.org/3.4/rc"><action name="Execute"><command>xterm</command></action>
<keyboard/><mouse><context name="Root"><mousebind button="Left" action="Press"><action name="Focus"/></mousebind></context></mouse></openbox_config>`);
  try {
    assert.deepEqual(await query(out, './/o:action'), []);
    assert.deepEqual(await query(out, './o:mouse/o:context'), []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the generator refuses a file that is not an openbox config and writes nothing', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'clawser-openbox-'));
  try {
    await fs.writeFile(join(dir, 'source.xml'), '<menu><item label="Terminal"/></menu>');
    await assert.rejects(execute('python3', [script, join(dir, 'source.xml'), join(dir, 'rc.xml')]), error => error.code === 1 && /not an openbox rc\.xml/.test(error.stderr));
    await assert.rejects(fs.access(join(dir, 'rc.xml')));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// The independent check that runs before every write: anything outside the allowlist fails the run.
test('the final check names every action, section or menu outside the allowlist', async () => {
  const check = xml => execute('python3', ['-c', `
import importlib.util,sys,json,xml.etree.ElementTree as E
spec=importlib.util.spec_from_file_location('openbox_config',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
print(json.dumps(m.leftovers(E.fromstring(sys.argv[2]),'/s/rc.xml')))
`, script, xml]).then(r => JSON.parse(r.stdout));
  const ok = '<keyboard><keybind key="A-Tab"><action name="NextWindow"/></keybind></keyboard><mouse><context name="Client"><mousebind button="Left" action="Press"><action name="Focus"/></mousebind></context></mouse><menu><file>/s/menu.xml</file></menu>';
  const wrap = body => `<openbox_config xmlns="http://openbox.org/3.4/rc">${body}</openbox_config>`;
  assert.deepEqual(await check(wrap(ok)), []);
  assert.deepEqual(await check(wrap(ok.replace('NextWindow', 'Execute'))), ['action Execute']);
  assert.deepEqual(await check(wrap(ok.replace('Focus', 'Close'))), ['action Close']);
  assert.deepEqual(await check(wrap(ok.replace('NextWindow', 'Move'))), ['action Move'], 'a key may not move a window');
  assert.deepEqual(await check(wrap(ok.replace(/<mouse>.*<\/mouse>/, ''))), ['0 mouse sections']);
  assert.deepEqual(await check(wrap(ok + '<keyboard/>')), ['2 keyboard sections']);
  assert.deepEqual(await check(wrap(ok.replace('/s/menu.xml', '/etc/xdg/openbox/menu.xml'))), ["a menu file other than Clawser's empty one"]);
  assert.deepEqual(await check(wrap(ok.replace('name="Client"', 'name="Root"'))), ['a binding on the bare desktop']);
  assert.deepEqual(await check(wrap(ok + '<action name="ShowMenu"/>')), ['action ShowMenu']);
  assert.deepEqual(await check(wrap(ok).replace(' xmlns="http://openbox.org/3.4/rc"', '').replace('NextWindow', 'Execute')), ['action Execute'], 'judged by local names');
});

// A live probe on a throwaway display: the distribution config opens menus and closes windows, the generated one does neither.
const probeTools = ['openbox', 'xdotool', 'xmessage', 'xwininfo'].filter(bin => !has(bin));
test('on a live openbox, a root click and the default keys do nothing under the generated config', { skip: noX || (probeTools.length ? 'needs ' + probeTools.join(', ') : false) }, async t => {
  const x = await startX();
  t.after(() => x.stop());
  const run = (command, args) => execute(command, args, { env: x.env }).then(r => r.stdout.trim(), () => '');
  const visible = async () => (await run('xdotool', ['search', '--onlyvisible', '--name', '.*'])).split('\n').filter(Boolean).length;
  const mapState = async id => (await run('xwininfo', ['-id', id])).match(/Map State: (\S+)/)?.[1];
  async function probe(config) {
    const wm = spawn('openbox', ['--config-file', config], { env: x.env, stdio: 'ignore' });
    const win = spawn('xmessage', ['-geometry', '200x80+300+300', 'clawser probe'], { env: x.env, stdio: 'ignore' });
    try {
      let id = '';
      for (let n = 0; n < 50 && !id; n++) { await sleep(100); id = (await run('xdotool', ['search', '--onlyvisible', '--class', 'xmessage'])).split('\n')[0]; }
      assert.ok(id, 'the probe window appeared');
      await sleep(500);
      const seen = {}, base = await visible();
      const opens = async keys => { await keys(); await sleep(400); const more = await visible() > base; await run('xdotool', ['key', 'Escape']); await sleep(200); return more; };
      seen.rootRight = await opens(() => run('xdotool', ['mousemove', '10', '10', 'click', '3']));
      seen.rootMiddle = await opens(() => run('xdotool', ['mousemove', '10', '10', 'click', '2']));
      seen.clientMenu = await opens(async () => { await run('xdotool', ['windowfocus', id]); await run('xdotool', ['key', 'alt+space']); });
      await run('xdotool', ['windowfocus', id]); await run('xdotool', ['key', 'super+d']); await sleep(400);
      seen.showDesktop = await mapState(id) !== 'IsViewable';
      if (seen.showDesktop) { await run('xdotool', ['key', 'super+d']); await sleep(300); }
      await run('xdotool', ['windowfocus', id]); await run('xdotool', ['key', 'alt+F4']);
      for (let n = 0; n < 8 && win.exitCode === null; n++) await sleep(100);
      seen.close = win.exitCode !== null || win.signalCode !== null;
      return seen;
    } finally {
      for (const child of [win, wm]) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
    }
  }
  const unlocked = await fs.access(distroRc).then(() => distroRc, () => undefined);
  const dir = await fs.mkdtemp(join(tmpdir(), 'clawser-openbox-live-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // The probe must be able to see each escape, or its silence below would prove nothing.
  const raw = join(dir, 'raw.xml');
  await fs.writeFile(raw, unlocked ? await fs.readFile(unlocked, 'utf8') : source);
  const before = await probe(raw);
  assert.equal(before.rootRight, true, 'the unlocked config opens its root menu');
  assert.equal(before.close, true, 'the unlocked config closes a window on Alt+F4');
  for (const input of [unlocked ? await fs.readFile(unlocked, 'utf8') : source, source.replace(' xmlns="http://openbox.org/3.4/rc"', ''), '<openbox_config xmlns="http://openbox.org/3.4/rc"/>']) {
    const { dir: out, out: config } = await generate(input);
    t.after(() => fs.rm(out, { recursive: true, force: true }));
    await fs.writeFile(join(out, 'menu.xml'), EMPTY_OPENBOX_MENU, { mode: 0o600 });
    assert.deepEqual(await probe(config), { rootRight: false, rootMiddle: false, clientMenu: false, showDesktop: false, close: false });
  }
});
