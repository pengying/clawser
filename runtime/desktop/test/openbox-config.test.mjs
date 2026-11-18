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
