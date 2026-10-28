import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(root, 'openclaw.plugin.json'), 'utf8'));
const { stdout } = await promisify(execFile)('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, maxBuffer: 2 * 1024 * 1024 });
const [archive] = JSON.parse(stdout);
const files = new Set(archive.files.map(file => file.path));
const privateHome = ['', 'home', 'pengying'].join('/');
const privateWorkspace = ['.openclaw', 'workspace'].join('/');
for (const required of [
  'index.mjs', 'openclaw.plugin.json', 'package.json', 'README.md', 'LICENSE',
  'SECURITY.md', 'CONTRIBUTING.md', 'docs/install.md',
  'src/cli.mjs', 'src/setup.mjs', 'src/desktop-plugin.mjs',
  'src/browser-config.mjs', 'src/browser-policy.mjs', 'src/browser-activation.mjs',
  'src/cdp-setup.mjs', 'src/setup-activation.mjs', 'src/frame-keyboard.mjs',
  'bin/clawser.mjs', 'bin/desktop-controller.mjs',
  'public/probe.html', 'public/probe.js', 'public/probe.css',
  'skills/browser-handoff/SKILL.md', 'runtime/desktop/Dockerfile',
  'runtime/desktop/index.mjs', 'runtime/desktop/supervisor.py',
  'runtime/desktop/x11-proof.cpp', 'runtime/desktop/entrypoint.sh',
  'runtime/desktop/chromium-seccomp.json', 'runtime/desktop/MOBY-LICENSE',
]) assert.ok(files.has(required), `Release archive is missing ${required}`);
assert.equal(pkg.main, './index.mjs');
assert.equal(pkg.bin?.clawser, './bin/clawser.mjs');
assert.equal(manifest.id, 'browser-handoff');
assert.ok(manifest.contracts.tools.includes('browser_handoff'));
assert.ok(manifest.cliCommands.some(command => command.name === 'clawser' && command.hasSubcommands));
assert.equal(archive.version, pkg.version);
for (const path of files) {
  assert.doesNotMatch(path, /(?:^|\/)(?:node_modules|\.git|\.env|\.openclaw|\.codex|test-artifacts)(?:\/|$)/, `Private or generated path in archive: ${path}`);
  assert.doesNotMatch(path, /(?:^|\/)(?:transport|setup|ownership|desktop-controller)\.json$/, `Local state in archive: ${path}`);
  const contents = await readFile(join(root, path), 'utf8');
  assert.ok(!contents.includes(privateHome) && !contents.includes(privateWorkspace), `Private workstation path in ${path}`);
  assert.doesNotMatch(contents, /#invite=[A-Za-z0-9_-]{24,}/, `Live invite material in ${path}`);
  assert.doesNotMatch(contents, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, `Private key material in ${path}`);
}
console.log(`Package verified: ${archive.filename}; ${files.size} files, ${archive.size} bytes.`);
