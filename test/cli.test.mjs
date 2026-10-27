import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerClawserCli } from '../src/cli.mjs';
import { createPlugin } from '../index.mjs';

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
  await setup.callback({ stateDir: '/tmp/a directory', browserProfile: 'demo', port: '19510', cdpPort: '19511', vncPort: '59512', containerName: 'demo-browser', dryRun: true, defaultProfile: false });
  assert.deepEqual(received, ['setup', '--state-dir', '/tmp/a directory', '--browser-profile', 'demo', '--port', '19510', '--cdp-port', '19511', '--vnc-port', '59512', '--container-name', 'demo-browser', '--dry-run', '--no-default-profile']);
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
  let service, discovered;
  const client = { close() {}, async request(method) {
    if (method === 'health') return { ready: true, profile: 'handoff', cdpUrl: 'http://127.0.0.1:18812' };
    if (method === 'revokeAll') return { allRetired: true, recoveryRequired: false };
    if (method === 'status') return { mode: 'ended', resumeAllowed: true, recoveryRequired: false };
    throw new Error(`Unexpected method ${method}`);
  } };
  createPlugin({ desktopRpcFactory: async () => client }).register({
    registrationMode: 'full', config, pluginConfig, runtime: {},
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
