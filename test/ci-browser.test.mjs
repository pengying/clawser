import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const script = new URL('../.github/scripts/prepare-browser.mjs', import.meta.url);
const execute = promisify(execFile);

test('CI browser preparation is inert when imported', async () => {
  const result = await execute(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(script.href)})`], {
    env: { ...process.env, CHROME_BIN: '/outside/browser-must-not-run' },
  });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'clawser-ci-browser-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const allowedRoot = join(directory, 'chrome');
  await mkdir(join(allowedRoot, 'resources'), { recursive: true });
  const files = new Map([
    ['google-chrome', Buffer.from('#!/bin/sh\nexit 93\n')],
    ['chrome', Buffer.alloc(300_000, 0x41)],
    ['empty', Buffer.alloc(0)],
    ['resources/data.pak', Buffer.alloc(500_000, 0x42)],
  ]);
  for (const [path, contents] of files) await writeFile(join(allowedRoot, path), contents);
  const logs = [];
  return { directory, allowedRoot, files, logs,
    options: { allowedRoot, browserPath: join(allowedRoot, 'google-chrome'), log: message => logs.push(message) },
    bytes: [...files.values()].reduce((sum, value) => sum + value.length, 0),
  };
}

test('prefetch reads regular installation files without executing the selected wrapper', async t => {
  const { prepareBrowser } = await import(script);
  const f = await fixture(t);
  const result = await prepareBrowser(f.options);
  assert.equal(result.files, f.files.size);
  assert.equal(result.bytes, f.bytes);
  assert.equal(result.browserRealpath, f.options.browserPath);
  assert.equal(result.installationRoot, f.allowedRoot);
  assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
  assert.deepEqual(f.logs.map(JSON.parse), [result]);
  assert.deepEqual(Object.keys(result).sort(), ['browserPath', 'browserRealpath', 'bytes', 'durationMs', 'files', 'installationRoot']);
  assert.deepEqual(await readFile(join(f.allowedRoot, 'chrome')), f.files.get('chrome'), 'prefetch does not modify installation files');
});

test('prefetch excludes every installation symlink including outside files and directories', async t => {
  const { prepareBrowser } = await import(script);
  const f = await fixture(t);
  const outside = join(f.directory, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'private-data'), Buffer.alloc(100_000, 0x43));
  await symlink(join(outside, 'private-data'), join(f.allowedRoot, 'outside-file'));
  await symlink(outside, join(f.allowedRoot, 'outside-directory'));
  await symlink(join(f.allowedRoot, 'chrome'), join(f.allowedRoot, 'inside-file'));
  await symlink(f.allowedRoot, join(f.allowedRoot, 'cycle'));
  const result = await prepareBrowser({ ...f.options, maxBytes: f.bytes });
  assert.equal(result.files, f.files.size);
  assert.equal(result.bytes, f.bytes);
});

test('selected browser symlinks may resolve into the installation but outside wrappers are rejected', async t => {
  const { prepareBrowser } = await import(script);
  const f = await fixture(t);
  const selected = join(f.directory, 'selected-browser');
  await symlink(f.options.browserPath, selected);
  const result = await prepareBrowser({ ...f.options, browserPath: selected });
  assert.equal(result.browserPath, selected);
  assert.equal(result.browserRealpath, f.options.browserPath);
  const outside = join(f.directory, 'chrome-outside');
  await mkdir(outside);
  const wrapper = join(outside, 'google-chrome');
  await writeFile(wrapper, 'outside installation');
  await assert.rejects(prepareBrowser({ ...f.options, browserPath: wrapper }), /outside.*installation|installation.*outside/i);
});

test('prefetch rejects symlink installation roots and enforces independent file and byte bounds', async t => {
  const { prepareBrowser } = await import(script);
  const f = await fixture(t);
  const alias = join(f.directory, 'installation-alias');
  await symlink(f.allowedRoot, alias);
  await assert.rejects(prepareBrowser({ ...f.options, allowedRoot: alias }), /canonical|symlink|symbolic/i);
  await assert.rejects(prepareBrowser({ ...f.options, maxFiles: 1 }), /file.*limit|limit.*file/i);
  await assert.rejects(prepareBrowser({ ...f.options, maxBytes: 1 }), /byte.*limit|limit.*byte/i);
  assert.equal(f.logs.length, 0, 'failed reads cannot report a successful prefetch');
});
