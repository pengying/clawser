import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENBOX_GENERATOR, controlRefusal, receiptBesideConfig, receiptForSocket, windowManagerState } from '../src/window-manager.mjs';
import { OPENBOX_GENERATOR as SETUP_GENERATOR } from '../src/host-setup.mjs';
import { unitNames } from '../src/host-units.mjs';

test('the receipt says whether the window manager is locked down', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'clawser-wm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'setup.json'), wm = unitNames(dir).windowManager;
  const write = value => writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  const receipt = extra => ({ identity: 'clawser-setup-v2', stateDir: dir, units: { [wm]: 'digest' }, ...extra });
  assert.equal(await windowManagerState(path), 'missing');
  await write('{not json'); assert.equal(await windowManagerState(path), 'invalid');
  await write({ ...receipt(), identity: 'clawser-setup-v1' }); assert.equal(await windowManagerState(path), 'invalid');
  await write(receipt()); assert.equal(await windowManagerState(path), 'stale', 'no generator recorded');
  await write(receipt({ openboxGenerator: OPENBOX_GENERATOR - 1 })); assert.equal(await windowManagerState(path), 'stale');
  await write(receipt({ openboxGenerator: OPENBOX_GENERATOR })); assert.equal(await windowManagerState(path), 'current');
  await write({ ...receipt(), units: {} }); assert.equal(await windowManagerState(path), 'none', 'setup runs no window manager');
  assert.equal(SETUP_GENERATOR, OPENBOX_GENERATOR);
  assert.equal(receiptBesideConfig('/s/clawser/controller.json'), '/s/clawser/setup.json');
  assert.equal(receiptForSocket('/s/clawser/state/desktop.sock'), '/s/clawser/setup.json');
  assert.equal(controlRefusal('current'), undefined);
  assert.equal(controlRefusal('none'), undefined);
  for (const state of ['stale', 'missing', 'invalid', undefined]) assert.match(controlRefusal(state), /setup --yes/);
});
