import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
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
const READ_ONLY_SYSTEMCTL = ['show', 'show-environment'];

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
  (call.command === 'systemctl' && !READ_ONLY_SYSTEMCTL.includes(call.args[1])) || String(call.args?.[0]).endsWith('/openbox_config.py') ||
  isPatch(call) || (call.command === 'openclaw' && call.args[1] === 'reload'));

/** Points `w.deps.packageDir` at a fresh copy of the package, the way a git upgrade moves the plugin. */
export async function movePackage(w, name = 'package-moved') {
  const packageDir = join(w.root, name);
  for (const file of PACKAGE_FILES) {
    await fs.mkdir(dirname(join(packageDir, file)), { recursive: true });
    await fs.writeFile(join(packageDir, file), 'fixture');
  }
  w.deps.packageDir = packageDir;
  return packageDir;
}

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
  const logs = [], units = new Map(), pids = new Map(), sockets = new Map();
  let nextPid = 5000;
  // A docker call inside a doctor check or a caught probe would otherwise vanish.
  t.after(() => assert.deepEqual(calls.filter(call => call.command === 'docker'), [], 'setup must never run docker'));
  let busy = [];
  const track = (name, real, writes = () => true) => async (...args) => { if (writes(...args)) calls.push({ command: 'fs', args: [name, args.at(name === 'rename' ? 1 : 0)] }); return real(...args); };
  const trackedFs = { ...fs, writeFile: track('writeFile', fs.writeFile), open: track('open', fs.open, (path, flags = 'r') => /[wa]/.test(flags)),
    rename: track('rename', fs.rename), mkdir: track('mkdir', fs.mkdir), mkdtemp: track('mkdtemp', fs.mkdtemp), rm: track('rm', fs.rm), chmod: track('chmod', fs.chmod) };
  const world = {
    root, stateDir, unitDir, packageDir, config, calls, logs, units, binaries, artifacts, rc,
    names: unitNames(stateDir), args: ['setup', '--state-dir', stateDir], linger: 'yes\n', corrupt: false, fragments: {},
    // Each start of a unit gives it a new main PID. The fake X server's socket lives under the world root.
    pids, x11SocketDir: join(root, 'x11'),
    // What xproof clients lists: by default Clawser's browser is the one X client.
    xproof: () => [{ clientId: 1, pid: pids.get(world.names.browser) ?? 0 }],
    // Hand-written user units that option B discovery reads with one systemctl show: unit name to its properties.
    foreign: {},
    busy: ports => { busy = ports; },
    receipt: async () => JSON.parse(await fs.readFile(join(stateDir, 'setup.json'), 'utf8')),
    unit: name => fs.readFile(join(unitDir, name), 'utf8'),
    mutations: () => mutations(calls, artifacts),
  };
  // Starting the display unit starts a fake Xvfb: a real Unix socket at <x11SocketDir>/X<display>, read from the unit's ExecStart.
  const startDisplay = async name => {
    const display = (await fs.readFile(join(unitDir, name), 'utf8').catch(() => '')).match(/ :(\d+) -screen /)?.[1];
    if (display === undefined || sockets.has(display)) return;
    await fs.mkdir(world.x11SocketDir, { recursive: true, mode: 0o700 });
    const server = createServer();
    await new Promise((accept, reject) => server.once('error', reject).listen(join(world.x11SocketDir, 'X' + display), accept));
    server.unref();
    sockets.set(display, server);
  };
  t.after(() => Promise.all([...sockets.values()].map(server => new Promise(accept => server.close(() => accept())))));
  world.deps = {
    fs: trackedFs, artifacts, packageDir, env: { XDG_CONFIG_HOME: join(root, 'config') }, homeDir: root, uid: process.getuid(),
    platform: 'linux', arch: 'x64', nodeVersion: '24.18.0', execPath: '/usr/bin/node', procRoot: join(root, 'proc'), x11SocketDir: world.x11SocketDir,
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
      calls.push({ command, args, input: options.input, timeoutMs: options.timeoutMs, ...options.env ? { env: options.env } : {} });
      if (command === 'docker') assert.fail('setup must never run docker: ' + args.join(' '));
      if (command === 'tar') return args[0] === '--version' ? 'tar (GNU tar) 1.35' : (await execute(command, args)).stdout;
      if (command === '/usr/bin/flock') return 'flock from util-linux 2.39';
      if (command === 'loginctl') return world.linger;
      if (command === 'systemctl') {
        const verb = args[1], name = args.at(-1);
        if (verb === 'show-environment') return 'PATH=/usr/bin';
        if (verb === 'show' && world.foreign[args[2]]) return Object.entries(world.foreign[args[2]]).map(([key, value]) => key + '=' + value).join('\n') + '\n';
        if (verb === 'show') {
          const state = units.get(args[2]);
          const sub = state === 'active' ? 'running' : state === 'failed' ? 'failed' : 'dead';
          return `LoadState=${state ? 'loaded' : 'not-found'}\nFragmentPath=${state ? world.fragments[args[2]] ?? join(unitDir, args[2]) : ''}\nActiveState=${state ?? 'inactive'}\nSubState=${sub}\nMainPID=${pids.get(args[2]) ?? 0}\n`;
        }
        if (verb === 'enable' || verb === 'restart') {
          units.set(name, 'active');
          pids.set(name, ++nextPid);
          if (name === world.names.display) await startDisplay(name);
        }
        if (verb === 'stop') { units.set(name, 'inactive'); pids.delete(name); }
        // A hand-written unit reports what setup did to it, so a crash leaves the state a rerun would see.
        if (world.foreign[name] && verb === 'stop') world.foreign[name].ActiveState = 'inactive';
        if (world.foreign[name] && verb === 'disable') world.foreign[name].UnitFileState = 'disabled';
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
      if (String(args[0]).endsWith('/runtime/desktop/xproof.py') && args[1] === 'clients') return JSON.stringify(await world.xproof(args, options));
      if (fallback) return fallback(command, args, options);
      throw new Error('unexpected command: ' + command + ' ' + args.join(' '));
    },
    ...deps,
  };
  world.activation = activationFixture(config, world.deps);
  return world;
}
