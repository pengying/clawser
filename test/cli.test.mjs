import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerClawserCli } from '../src/cli.mjs';
import { createPlugin } from '../index.mjs';
import { runClawser } from '../src/setup.mjs';

class Command {
  children = new Map();
  command(name) { const child = new Command(); this.children.set(name, child); return child; }
  description() { return this; }
  option() { return this; }
  action(callback) { this.callback = callback; return this; }
}

test('CLI registration is inert and forwards setup options without shell parsing', async () => {
  let registrar, descriptors, received;
  const api = { rootDir: '/installed/clawser', registerCli(fn, options) { registrar = fn; descriptors = options.descriptors; } };
  registerClawserCli(api, { runClawser: async args => { received = args; return { ok: true }; } });
  assert.equal(received, undefined);
  assert.equal(descriptors[0].name, 'clawser');
  assert.equal(descriptors[0].hasSubcommands, true);
  const program = new Command();
  await registrar({ program });
  const setup = program.children.get('clawser').children.get('setup');
  await setup.callback({ stateDir: '/tmp/a directory', browserProfile: 'demo', port: '19510', cdp: true, novnc: true, dryRun: true, yes: true, migrateCookies: false });
  assert.deepEqual(received, ['setup', '--state-dir', '/tmp/a directory', '--browser-profile', 'demo', '--port', '19510', '--cdp', '--novnc', '--dry-run', '--yes', '--no-migrate-cookies']);
  await setup.callback({ migrateCookies: true });
  assert.deepEqual(received, ['setup']);
});

test('CLI registers the 0.7.0 options and drops the Docker desktop ones', async () => {
  let registrar;
  class Recording extends Command {
    options = []; descriptionText = '';
    command(name) { const child = new Recording(); this.children.set(name, child); return child; }
    description(text) { this.descriptionText = text; return this; }
    option(flags) { this.options.push(flags.split(' ')[0]); return this; }
  }
  registerClawserCli({ rootDir: '/installed/clawser', registerCli(fn) { registrar = fn; } }, { runClawser: async () => ({ ok: true }) });
  const program = new Recording();
  await registrar({ program });
  const root = program.children.get('clawser');
  const setup = root.children.get('setup'), doctor = root.children.get('doctor');
  assert.equal(setup.descriptionText, 'Give the agent its own browser on a private virtual screen (noVNC); --cdp keeps the CDP viewer');
  assert.equal(doctor.descriptionText, 'Check the configured browser backend without changing it');
  assert.deepEqual(setup.options.sort(), ['--browser-profile', '--cdp', '--dry-run', '--no-migrate-cookies', '--novnc', '--port', '--state-dir', '--yes']);
  assert.deepEqual(doctor.options.sort(), ['--browser-profile', '--cdp', '--novnc', '--port', '--state-dir']);
});

test('help text says noVNC is the default and --cdp keeps the one-tab viewer', async () => {
  const logs = [];
  const result = await runClawser(['help'], { log: message => logs.push(message), run: async () => assert.fail('help runs nothing') });
  assert.deepEqual(result, { ok: true, command: 'help' });
  const text = logs.join('\n');
  assert.ok(text.includes('Usage: clawser <setup|doctor> [--dry-run] [--yes] [--state-dir <path>] [--browser-profile <name>] [--port <n>] [--novnc | --cdp] [--no-migrate-cookies]'), text);
  assert.ok(text.includes('Default setup gives the agent its own browser on a private virtual screen that you view over noVNC. --cdp keeps the one-tab CDP viewer.'), text);
});

test('CLI metadata and setup-only discovery never access runtime or register services', () => {
  for (const registrationMode of ['cli-metadata', 'setup-only']) {
    let registered = false;
    const api = {
      registrationMode,
      pluginConfig: { desktop: { enabled: true } },
      registerCli() { registered = true; },
      get runtime() { throw new Error('Runtime must remain unavailable'); },
      registerService() { throw new Error('No service during CLI metadata'); },
      registerTool() { throw new Error('No tool during CLI metadata'); },
      on() { throw new Error('No hooks during CLI metadata'); },
    };
    createPlugin().register(api);
    assert.equal(registered, true);
  }
});

test('older SDK mocks without CLI registration keep the standalone entry available', () => {
  assert.equal(registerClawserCli({}), false);
});

test('operator setup failures explain the problem instead of a generic host CLI error', async t => {
  let registrar, message;
  const previous = process.exitCode;
  t.after(() => { process.exitCode = previous; });
  registerClawserCli({ rootDir: '/installed/clawser', registerCli(fn) { registrar = fn; } }, {
    runClawser: async () => { throw new Error('Docker is unavailable'); },
    reportError: value => { message = value; },
  });
  const program = new Command();
  await registrar({ program });
  const result = await program.children.get('clawser').children.get('setup').callback({});
  assert.equal(result.ok, false);
  assert.equal(message, 'Clawser: Docker is unavailable');
  assert.equal(process.exitCode, 1);
});

test('operator commands bind nested calls to the launching OpenClaw entrypoint', async () => {
  let registrar, invocation, packageDir;
  registerClawserCli({ rootDir: '/installed/clawser', registerCli(fn) { registrar = fn; } }, {
    runClawser: async (_argv, dependencies) => {
      invocation = dependencies.openclawInvocation;
      packageDir = dependencies.packageDir;
      return { ok: true };
    },
  });
  const program = new Command();
  await registrar({ program });
  await program.children.get('clawser').children.get('doctor').callback({});
  assert.deepEqual(invocation, { command: process.execPath, prefixArgs: [process.argv[1]] });
  assert.equal(packageDir, '/installed/clawser');
});

test('operator setup refuses a host without a stable plugin directory', async t => {
  let registrar, invoked = false, message;
  const previous = process.exitCode;
  t.after(() => { process.exitCode = previous; });
  registerClawserCli({ registerCli(fn) { registrar = fn; } }, {
    runClawser: async () => { invoked = true; },
    reportError: value => { message = value; },
  });
  const program = new Command();
  await registrar({ program });
  await program.children.get('clawser').children.get('setup').callback({});
  assert.equal(invoked, false);
  assert.match(message, /stable installed plugin directory/);
  assert.equal(process.exitCode, 1);
});

test('index routes cold desktop discovery to the active full instance', async t => {
  const config = { browser: { profiles: { handoff: { cdpUrl: 'http://127.0.0.1:18812', attachOnly: true, driver: 'openclaw', engine: 'chromium' } } } };
  const pluginConfig = { desktop: { enabled: true, socketPath: '/tmp/clawser-index-test.sock', profile: 'handoff' } };
  config.plugins = { entries: { 'browser-handoff': { enabled: true, config: pluginConfig } } };
  let service, discovered;
  const client = { close() {}, async request(method) {
    if (method === 'health') return { ready: true, profile: 'handoff', cdpUrl: 'http://127.0.0.1:18812' };
    if (method === 'revokeAll') return { allRetired: true, recoveryRequired: false };
    if (method === 'status') return { mode: 'ended', resumeAllowed: true, recoveryRequired: false };
    throw new Error(`Unexpected method ${method}`);
  } };
  createPlugin({ desktopRpcFactory: async () => client }).register({
    registrationMode: 'full', config, pluginConfig, runtime: { config: { current: () => config } },
    registerTrustedToolPolicy() {},
    logger: { warn() {} }, on() {}, registerTool() {},
    registerService(value) { service = value; },
  });
  await service.start();
  t.after(() => service.stop());
  createPlugin().register({
    registrationMode: 'tool-discovery', config, pluginConfig,
    registerTool(value) { discovered = value; },
    get runtime() { throw new Error('Discovery must use the active instance'); },
    registerService() { throw new Error('Discovery must not register another service'); },
    on() { throw new Error('Discovery must not register browser hooks'); },
  });
  const tool = discovered.create({ senderIsOwner: true, sessionKey: 'agent:main:cli:direct:publication-test', sessionId: 'one', assertInvocationCurrent() {} });
  const result = await tool.execute('call', { action: 'status', id: 'owned' });
  assert.equal(result.details.resumeAllowed, true);
});
