import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { skip as noX, startX } from '../runtime/desktop/test/xvfb.mjs';
import { CdpConnection } from '../src/cdp.mjs';
import { maximizeObservedWindow } from '../src/desktop-controller.mjs';
import { BROWSER_PATH, NO_SESSION_BUS } from '../src/host-units.mjs';

const execute = promisify(execFile);
const chrome = process.env.CHROME_BIN || '/usr/bin/google-chrome-stable';
const has = bin => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = noX || (!has('openbox') ? 'needs openbox' : false) || (await fs.access(chrome).then(() => false, () => 'needs Chrome (CHROME_BIN)'));

// A real Chrome under Clawser's openbox config on a throwaway display, run as the browser unit runs it.
test('a resized or minimized browser window is maximized again, and only the observed one', { skip, timeout: 90_000 }, async t => {
  const x = await startX();
  const dir = await fs.mkdtemp(join(tmpdir(), 'clawser-maximize-'));
  const children = [];
  // Processes first, then their folder, then the display.
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
    await x.stop();
  });
  await execute('python3', ['-I', new URL('../runtime/desktop/openbox_config.py', import.meta.url).pathname, '/etc/xdg/openbox/rc.xml', join(dir, 'rc.xml')]).catch(async () => {
    await fs.writeFile(join(dir, 'source.xml'), '<openbox_config xmlns="http://openbox.org/3.4/rc"/>');
    await execute('python3', ['-I', new URL('../runtime/desktop/openbox_config.py', import.meta.url).pathname, join(dir, 'source.xml'), join(dir, 'rc.xml')]);
  });
  await fs.writeFile(join(dir, 'menu.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<openbox_menu xmlns="http://openbox.org/3.4/menu"/>\n');
  const env = { ...x.env, HOME: dir, PATH: BROWSER_PATH, DBUS_SESSION_BUS_ADDRESS: NO_SESSION_BUS };
  const wm = spawn('openbox', ['--config-file', join(dir, 'rc.xml')], { env, stdio: 'ignore' });
  const browser = spawn(chrome, [`--user-data-dir=${join(dir, 'profile')}`, '--ozone-platform=x11', '--password-store=basic', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--window-size=600,400', 'about:blank'], { env, stdio: 'ignore' });
  children.push(browser, wm);
  let port;
  for (let n = 0; n < 300 && !port; n++) { await sleep(100); port = (await fs.readFile(join(dir, 'profile', 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0]; }
  assert.ok(port, 'Chrome started');
  const runtime = { cdpUrl: `http://127.0.0.1:${port}` };
  const { webSocketDebuggerUrl } = await (await fetch(runtime.cdpUrl + '/json/version')).json();
  const cdp = await new CdpConnection().connect(webSocketDebuggerUrl);
  t.after(() => cdp.close());
  const pages = async () => (await cdp.send('Target.getTargets')).targetInfos.filter(info => info.type === 'page');
  let page;
  for (let n = 0; n < 50 && !page; n++) { page = (await pages())[0]; if (!page) await sleep(100); }
  const state = async targetId => (await cdp.send('Browser.getWindowForTarget', { targetId })).bounds;
  const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: page.targetId });
  // A second window, as a popup the person left open behind the observed one.
  const { targetId: other } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  const otherWindow = (await cdp.send('Browser.getWindowForTarget', { targetId: other })).windowId;
  assert.notEqual(otherWindow, windowId);
  await cdp.send('Browser.setWindowBounds', { windowId: otherWindow, bounds: { windowState: 'normal' } });
  await cdp.send('Browser.setWindowBounds', { windowId: otherWindow, bounds: { left: 10, top: 10, width: 320, height: 240 } });
  for (const shrink of [{ windowState: 'normal' }, { left: 40, top: 30, width: 300, height: 200 }]) await cdp.send('Browser.setWindowBounds', { windowId, bounds: shrink });
  await sleep(300);
  assert.equal((await state(page.targetId)).windowState, 'normal');
  assert.equal(await maximizeObservedWindow(runtime, page.targetId), true);
  for (let n = 0; n < 30 && (await state(page.targetId)).windowState !== 'maximized'; n++) await sleep(100);
  assert.equal((await state(page.targetId)).windowState, 'maximized');
  assert.equal((await state(other)).windowState, 'normal', 'the other window is left as it was');
  assert.equal(await maximizeObservedWindow(runtime, page.targetId), false, 'already maximized: nothing to do');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  await sleep(300);
  assert.equal(await maximizeObservedWindow(runtime, page.targetId), true);
  for (let n = 0; n < 30 && (await state(page.targetId)).windowState !== 'maximized'; n++) await sleep(100);
  assert.equal((await state(page.targetId)).windowState, 'maximized', 'a minimized window comes back maximized');
  assert.equal(await maximizeObservedWindow(runtime, 'not a target id!'), false);
});
