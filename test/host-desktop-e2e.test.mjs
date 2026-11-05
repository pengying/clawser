import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const script = new URL('./host-desktop-e2e.mjs', import.meta.url);
// The abort stands in for unit cleanup: it takes a moment, then leaves a marker the parent reads.
const CHILD = `
import { writeFileSync } from 'node:fs';
const { installCrashCleanup } = await import(process.env.E2E_URL);
installCrashCleanup(async reason => { await new Promise(r => setTimeout(r, 50)); writeFileSync(process.env.MARKER, String(reason)); });
if (process.env.CASE === 'pipe') {
  process.stdout.write('ready\\n');
  setInterval(() => { for (let i = 0; i < 16; i++) process.stdout.write('x'.repeat(4096) + '\\n'); }, 5);
} else setTimeout(() => { throw new Error('boom'); }, 10);
`;

async function crash(t, kind) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'clawser-crash-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const marker = join(dir, 'cleaned');
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
    env: { ...process.env, E2E_URL: script.href, MARKER: marker, CASE: kind }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const exited = new Promise(accept => child.once('exit', (code, signal) => accept({ code, signal })));
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  t.after(() => { clearTimeout(timer); child.kill('SIGKILL'); });
  if (kind === 'pipe') {
    const ready = await Promise.race([new Promise(accept => child.stdout.once('data', accept)), exited.then(() => undefined)]);
    assert.equal(String(ready), 'ready\n', 'the child exited before it was ready: ' + stderr);
    child.stdout.destroy();
  }
  const { code, signal } = await exited;
  return { code, signal, stderr, cleaned: await fs.readFile(marker, 'utf8').catch(() => undefined) };
}

test('a closed output pipe or an uncaught error still runs cleanup', async t => {
  const pipe = await crash(t, 'pipe');
  assert.equal(pipe.code, 1, 'after a closed pipe: ' + JSON.stringify(pipe));
  assert.match(pipe.cleaned ?? '', /output/, 'cleanup did not run after a closed pipe: ' + pipe.stderr);
  const thrown = await crash(t, 'throw');
  assert.equal(thrown.code, 1, 'after an uncaught error: ' + JSON.stringify(thrown));
  assert.match(thrown.cleaned ?? '', /boom/, 'cleanup did not run after an uncaught error: ' + thrown.stderr);
});

test('the e2e script skips without CLAWSER_HOST_E2E', async () => {
  const env = { ...process.env };
  delete env.CLAWSER_HOST_E2E;
  const { stdout } = await execute(process.execPath, [script.pathname], { env });
  assert.equal(stdout, 'host noVNC end to end skipped (set CLAWSER_HOST_E2E=1 on a disposable runner)\n');
});
