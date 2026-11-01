import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ARTIFACTS } from '../src/setup.mjs';
import { unitNames } from '../src/host-units.mjs';
import { activationFixture } from './setup-activation-fixture.mjs';

export const execute = promisify(execFile);
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const PACKAGE_FILES = ['index.mjs', 'bin/desktop-controller.mjs', 'runtime/desktop/supervisor.py', 'runtime/desktop/openbox_config.py', 'runtime/desktop/xproof.py', 'runtime/desktop/clipboard.py'];
const entry = path => ({ path, source: 'system', version: '1', sha256: 'b'.repeat(64) });
const MUTATING = ['enable', 'restart', 'stop', 'disable', 'daemon-reload'];

export function merge(base, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key];
    else if (value && typeof value === 'object' && !Array.isArray(value)) merge(base[key] ??= {}, value);
    else base[key] = structuredClone(value);
  }
  return base;
}

export const systemctl = (calls, verb) => calls.filter(call => call.command === 'systemctl' && call.args[1] === verb).map(call => call.args.at(-1));
export const isPatch = call => call.command === 'openclaw' && call.args[0] === 'config' && call.args[1] === 'patch' && !call.args.includes('--dry-run');
/** Downloads, file writes, service changes, config patches and plugin reloads: anything setup must not do before it commits. */
export const mutations = (calls, artifacts) => calls.filter(call =>
  (call.command === 'fetch' && [artifacts.cloudflared.url, artifacts.noVnc.url].includes(call.args[0])) || call.command === 'fs' ||
  (call.command === 'systemctl' && MUTATING.includes(call.args[1])) || isPatch(call) || (call.command === 'openclaw' && call.args[1] === 'reload'));

/** A Linux host that runClawser can set up in host mode: real tar, fake systemd, loginctl and OpenClaw, and docker is a failure. */
export async function hostWorld(t, { root, config = {}, stateName = 'state', packageName = 'package', deps = {}, run: fallback, calls = [] } = {}) {
  // macOS tmpdir() is long and behind a symlink; sockets under it would exceed 107 bytes.
  if (!root) {
    root = await fs.realpath(await fs.mkdtemp('/tmp/clawser-setup-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
  }
  const stateDir = join(root, stateName), unitDir = join(root, 'config/systemd/user'), packageDir = join(root, packageName);
  for (const file of PACKAGE_FILES) {
    await fs.mkdir(dirname(join(packageDir, file)), { recursive: true });
    await fs.writeFile(join(packageDir, file), 'fixture');
  }
  const archiveRoot = join(root, 'archive');
  await fs.mkdir(join(archiveRoot, 'noVNC-1.7.0/core'), { recursive: true });
  await fs.writeFile(join(archiveRoot, 'noVNC-1.7.0/core/rfb.js'), 'export default class RFB {}');
  await execute('tar', ['-czf', join(root, 'novnc.tgz'), '-C', archiveRoot, 'noVNC-1.7.0']);
  const binary = Buffer.from('verified cloudflared fixture'), archive = await fs.readFile(join(root, 'novnc.tgz'));
  const artifacts = { cloudflared: { ...ARTIFACTS.cloudflared, sha256: digest(binary) }, noVnc: { ...ARTIFACTS.noVnc, sha256: digest(archive) } };
  const rc = join(root, 'rc.xml');
  await fs.writeFile(rc, '<openbox_config/>\n');
  const binaries = { Xvfb: entry('/usr/bin/Xvfb'), x11vnc: entry('/home/linuxbrew/.linuxbrew/bin/x11vnc'), python3: entry('/usr/bin/python3'), openbox: entry('/usr/bin/openbox') };
  const logs = [], units = new Map();
  let busy = [];
  const track = (name, real, writes = () => true) => async (...args) => { if (writes(...args)) calls.push({ command: 'fs', args: [name, args.at(name === 'rename' ? 1 : 0)] }); return real(...args); };
  const trackedFs = { ...fs, writeFile: track('writeFile', fs.writeFile), open: track('open', fs.open, (path, flags = 'r') => /[wa]/.test(flags)),
    rename: track('rename', fs.rename), mkdir: track('mkdir', fs.mkdir), rm: track('rm', fs.rm), chmod: track('chmod', fs.chmod) };
  const world = {
    root, stateDir, unitDir, packageDir, config, calls, logs, units, binaries, artifacts, rc,
    names: unitNames(stateDir), args: ['setup', '--state-dir', stateDir], linger: 'yes\n', corrupt: false, fragments: {},
    busy: ports => { busy = ports; },
    receipt: async () => JSON.parse(await fs.readFile(join(stateDir, 'setup.json'), 'utf8')),
    unit: name => fs.readFile(join(unitDir, name), 'utf8'),
    mutations: () => mutations(calls, artifacts),
  };
  world.deps = {
    fs: trackedFs, artifacts, packageDir, env: { XDG_CONFIG_HOME: join(root, 'config') }, homeDir: root, uid: process.getuid(),
    platform: 'linux', arch: 'x64', nodeVersion: '24.18.0', execPath: '/usr/bin/node',
    now: Date.now, sleep: async () => {}, log: message => logs.push(message), readProcessStartTicks: async () => '4242',
    findBrowserBinary: async () => ({ path: '/usr/bin/google-chrome-stable', brand: 'chrome' }),
    freeDisplay: async () => 20, randomBytes: () => Buffer.alloc(16, 7),
    hostResolver: {
      plan: async () => ({ binaries: structuredClone(binaries), warnings: [] }),
      install: async plan => ({ record: { binaries: structuredClone(plan.binaries) }, warnings: [] }),
      verify: async () => [], describe: () => [],
    },
    openboxRcPaths: [rc], isPortFree: async port => !busy.includes(port), portHolder: async () => undefined,
    controllerHealth: async () => ({ ready: true, profile: 'clawser', cdpUrl: 'http://127.0.0.1:18820', recoveryRequired: false }),
    fetch: async url => {
      calls.push({ command: 'fetch', args: [url] });
      if (url === artifacts.cloudflared.url || url === artifacts.noVnc.url) return new Response(world.corrupt ? 'corrupt' : url === artifacts.cloudflared.url ? binary : archive);
      // The CDP viewer path probes an existing browser and its own viewer.
      const local = url.match(/^http:\/\/127\.0\.0\.1:(\d+)\/(json\/version|assets\/style\.css)$/);
      if (local?.[2] === 'json/version') return Response.json({ Browser: 'Chrome/149', webSocketDebuggerUrl: `ws://127.0.0.1:${local[1]}/devtools/browser/test` });
      if (local) return new Response('body {}', { headers: { 'content-type': 'text/css' } });
      throw new Error('Unexpected network request: ' + url);
    },
    run: async (command, args = [], options = {}) => {
      calls.push({ command, args, input: options.input, timeoutMs: options.timeoutMs });
      if (command === 'docker') assert.fail('setup must never run docker: ' + args.join(' '));
      if (command === 'tar') return args[0] === '--version' ? 'tar (GNU tar) 1.35' : (await execute(command, args)).stdout;
      if (command === '/usr/bin/flock') return 'flock from util-linux 2.39';
      if (command === 'loginctl') return world.linger;
      if (command === 'systemctl') {
        const verb = args[1], name = args.at(-1);
        if (verb === 'show-environment') return 'PATH=/usr/bin';
        if (verb === 'show') {
          const state = units.get(args[2]);
          return `LoadState=${state ? 'loaded' : 'not-found'}\nFragmentPath=${state ? world.fragments[args[2]] ?? join(unitDir, args[2]) : ''}\nActiveState=${state ?? 'inactive'}\n`;
        }
        if (verb === 'enable' || verb === 'restart') units.set(name, 'active');
        if (verb === 'stop') units.set(name, 'inactive');
        return '';
      }
      if (command === 'openclaw') {
        if (args[0] === '--version') return 'OpenClaw 2026.10.4';
        if (args[0] === 'config' && args[1] === 'get') return JSON.stringify(config[args[2]] ?? {});
        if (args[0] === 'config' && args[1] === 'patch') { if (!args.includes('--dry-run')) merge(config, JSON.parse(options.input)); return ''; }
        if (args[0] === 'plugins' && args[1] === 'reload') {
          if (config.plugins?.entries?.['browser-handoff']?.config?.desktop?.enabled === true) assert.equal(units.get(world.names.controller), 'active', 'reload before the controller runs');
          await world.activation.publish(); return '';
        }
      }
      if (String(args[0]).endsWith('/runtime/desktop/openbox_config.py')) {
        const [, source, dest] = args;
        await fs.writeFile(dest, '<!-- rendered -->' + await fs.readFile(source, 'utf8'), { mode: 0o600 });
        return '';
      }
      if (fallback) return fallback(command, args, options);
      throw new Error('unexpected command: ' + command + ' ' + args.join(' '));
    },
    ...deps,
  };
  world.activation = activationFixture(config, world.deps);
  return world;
}
