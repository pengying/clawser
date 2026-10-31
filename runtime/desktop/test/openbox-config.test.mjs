import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execute = promisify(execFile);
const script = new URL('../openbox_config.py', import.meta.url).pathname;
const names = ['GoToDesktop', 'SendToDesktop', 'DesktopNext', 'DesktopPrevious'];
const source = `<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
<desktops><!-- <number>4</number> --><number>4</number></desktops>
<keyboard>
<keybind key="C-A-Left"><action name="GoToDesktop"><to>left</to></action></keybind>
<keybind key="C-A-Right"><action name="DesktopNext"/></keybind>
<keybind key="A-F4"><action name="Close"/></keybind>
<keybind key="W-S-Left"><action name="SendToDesktop"><to>left</to></action><action name="DesktopPrevious"/></keybind>
</keyboard>
<mouse><context name="Desktop">
<mousebind button="A-Up" action="Click"><action name="GoToDesktop"><to>previous</to></action></mousebind>
<mousebind button="Left" action="Press"><action name="Focus"/></mousebind>
</context></mouse>
<applications/>
</openbox_config>
`;

async function generate() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'clawser-openbox-'));
  const rc = join(dir, 'rc.xml'), out = join(dir, 'out.xml');
  await fs.writeFile(rc, source);
  await execute('python3', [script, rc, out]);
  return { dir, out };
}
const query = (out, expr) => execute('python3', ['-c', `
import sys,xml.etree.ElementTree as E
n={'o':'http://openbox.org/3.4/rc'}
r=E.parse(sys.argv[1]).getroot()
for e in r.findall(sys.argv[2],n):print(e.tag.split('}')[1],e.get('name') or '',(e.text or '').strip())
`, out, expr]).then(r => r.stdout.trim().split('\n').filter(Boolean));

test('generated openbox config keeps one desktop and no desktop switching', async () => {
  const { dir, out: xml } = await generate();
  try {
    assert.deepEqual(await query(xml, './o:desktops/o:number'), ['number  1']);
    const actions = (await query(xml, './/o:action')).map(l => l.split(' ')[1]);
    for (const name of names) assert.ok(!actions.includes(name), name);
    assert.ok(actions.includes('Close') && actions.includes('Focus'));
    assert.equal((await query(xml, './/o:keybind')).length, 1);
    assert.equal((await query(xml, './/o:mousebind')).length, 1);
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
