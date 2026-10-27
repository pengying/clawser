import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CloudflareTransport } from '../src/cloudflare-transport.mjs';

class Child extends EventEmitter {
  pid = 12345; exitCode = null; signalCode = null; stdout = new PassThrough(); stderr = new PassThrough();
  kill(signal) { this.signalCode = signal; queueMicrotask(() => this.emit('exit', null, signal)); return true; }
}
async function setup(t, spawnImpl, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'handoff-cloudflare-test-'));
  const transport = new CloudflareTransport({ binaryPath: '/fixture/cloudflared', stateDir, spawnImpl, probeImpl: async () => true, dnsProbeImpl: async () => true, ...options });
  t.after(async () => { await transport.close(); await rm(stateDir, { recursive: true, force: true }); });
  return transport;
}
test('public URL requires both allocated hostname and registered connection; target stays loopback', async t => {
  let child, args;
  const transport = await setup(t, (_binary, argv) => { args = argv; child = new Child(); setImmediate(() => child.stderr.write('https://fixture.trycloudflare.com\n')); return child; });
  let resolved = false; const ready = transport.ensure(19410).then(value => { resolved = true; return value; });
  while (!child) await new Promise(setImmediate);
  await new Promise(setImmediate); assert.equal(resolved, false);
  child.stderr.write('Registered tunnel connection\n');
  assert.equal(await ready, 'https://fixture.trycloudflare.com');
  assert.equal(args.at(-1), 'http://127.0.0.1:19410');
  assert.equal(await transport.ensure(19410), 'https://fixture.trycloudflare.com');
  await assert.rejects(transport.ensure(19411), /target cannot change/);
  const failed = new Promise(resolve => transport.once('failure', resolve)); child.exitCode = 1; child.emit('exit', 1);
  assert.match((await failed).message, /stopped/);
});
test('unready transport times out and terminates only its owned child', async t => {
  let child;
  const transport = await setup(t, () => { child = new Child(); return child; }, { startupTimeoutMs: 20 });
  await assert.rejects(transport.ensure(19410), /Cloudflare startup failed \(connection: TIMEOUT\)/); assert.equal(child.signalCode, 'SIGTERM');
});
test('intentional close does not report a tunnel failure', async t => {
  let failures = 0;
  const transport = await setup(t, () => { const child = new Child(); setImmediate(() => child.stdout.write('https://fixture.trycloudflare.com\nRegistered tunnel connection\n')); return child; });
  transport.on('failure', () => failures++);
  await transport.ensure(19410); await transport.close(); assert.equal(failures, 0);
  await assert.rejects(transport.ensure(19410), /closed/);
});

test('registered tunnel waits for public DNS/HTTP readiness before returning a link', async t => {
  let checks = 0;
  const transport = await setup(t, () => { const child = new Child(); setImmediate(() => child.stdout.write('https://fixture.trycloudflare.com\nRegistered tunnel connection\n')); return child; }, {
    probeImpl: async () => { checks++; if (checks === 1) throw new Error('DNS pending'); return checks >= 3; },
  });
  assert.equal(await transport.ensure(19410), 'https://fixture.trycloudflare.com');
  assert.equal(checks, 3);
});

test('native HTTP lookup is deferred until public DNS has a usable answer', async t => {
  let dnsChecks = 0, httpChecks = 0;
  const transport = await setup(t, () => { const child = new Child(); setImmediate(() => child.stdout.write('https://fixture.trycloudflare.com\nRegistered tunnel connection\n')); return child; }, {
    dnsProbeImpl: async () => ++dnsChecks >= 2,
    probeImpl: async () => { assert.equal(dnsChecks, 2); httpChecks++; return true; },
  });
  await transport.ensure(19410); assert.equal(httpChecks, 1);
});

function registeredChild() {
  const child = new Child();
  setImmediate(() => child.stdout.write('https://fixture.trycloudflare.com\nRegistered tunnel connection\n'));
  return child;
}

test('DNS publication timeout identifies the stage without probing HTTPS', async t => {
  let httpChecks = 0;
  const transport = await setup(t, registeredChild, {
    startupTimeoutMs: 20,
    dnsProbeImpl: async () => false,
    probeImpl: async () => { httpChecks++; return true; },
  });
  await assert.rejects(transport.ensure(19410), /Cloudflare startup failed \(dns: DNS_NOT_READY\)/);
  assert.equal(httpChecks, 0);
});

test('HTTPS timeout preserves a sanitized nested lookup cause after public DNS is ready', async t => {
  const transport = await setup(t, registeredChild, {
    startupTimeoutMs: 20,
    probeImpl: async () => { throw new Error('secret https://private.trycloudflare.com/?bearer=secret', { cause: Object.assign(new Error('private hostname'), { code: 'ENOTFOUND' }) }); },
  });
  await assert.rejects(transport.ensure(19410), error => {
    assert.equal(error.message, 'Cloudflare startup failed (https: ENOTFOUND)');
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('receipt write failure identifies the filesystem stage and safe error code', async t => {
  const transport = await setup(t, registeredChild);
  await mkdir(join(transport.stateDir, 'transport.json'));
  await assert.rejects(transport.ensure(19410), /Cloudflare startup failed \(receipt: EISDIR\)/);
});

test('unexpected process exit during a health probe identifies process failure', async t => {
  const child = registeredChild();
  const transport = await setup(t, () => child, {
    probeImpl: async () => { child.exitCode = 7; child.emit('exit', 7); return false; },
  });
  await assert.rejects(transport.ensure(19410), /Cloudflare startup failed \(process: EXIT_7\)/);
});

test('default HTTPS probe retains a failing HTTP status', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('temporarily unavailable', { status: 503 }));
  const transport = await setup(t, registeredChild, { startupTimeoutMs: 20, probeImpl: undefined });
  await assert.rejects(transport.ensure(19410), /Cloudflare startup failed \(https: HTTP_503\)/);
});

test('default DNS probe retains NXDOMAIN and never starts HTTPS', async t => {
  let checks = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    assert.match(url, /^https:\/\/cloudflare-dns\.com\/dns-query\?/);
    checks++;
    return Response.json({ Status: 3 });
  });
  const transport = await setup(t, registeredChild, { startupTimeoutMs: 20, dnsProbeImpl: undefined });
  await assert.rejects(transport.ensure(19410), /Cloudflare startup failed \(dns: DNS_STATUS_3\)/);
  assert.ok(checks > 0);
});

test('configured 90-second startup survives a 60-second negative TTL after allocation without replacing the tunnel', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let spawns = 0, dnsChecks = 0, httpChecks = 0, resolved = false;
  const origins = new Set();
  const transport = await setup(t, () => { spawns++; return registeredChild(); }, {
    startupTimeoutMs: 90_000,
    dnsProbeImpl: async origin => { origins.add(origin); dnsChecks++; return Date.now() >= 64_000; },
    probeImpl: async origin => { origins.add(origin); httpChecks++; return true; },
  });
  const ready = transport.ensure(19410).then(origin => { resolved = true; return origin; });
  while (!dnsChecks) await new Promise(setImmediate);
  for (let second = 0; second < 60; second++) { t.mock.timers.tick(1000); await new Promise(setImmediate); }
  assert.equal(resolved, false);
  assert.equal(httpChecks, 0);
  for (let second = 0; second < 4; second++) { t.mock.timers.tick(1000); await new Promise(setImmediate); }
  assert.equal(await ready, 'https://fixture.trycloudflare.com');
  assert.equal(spawns, 1);
  assert.equal(origins.size, 1);
  assert.equal(httpChecks, 1);
});
