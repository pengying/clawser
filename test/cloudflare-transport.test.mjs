import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  transport.stateDir = stateDir;
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

test('readiness keeps desktop default and supports only the harmless existing-browser asset', async t => {
  const paths = [];
  t.mock.method(globalThis, 'fetch', async url => { paths.push(new URL(url).pathname); return { ok: true, body: { async cancel() {} } }; });
  const options = { binaryPath: '/fixture/cloudflared', stateDir: '/fixture/state' };
  await new CloudflareTransport(options).probe('https://fixture.trycloudflare.com', AbortSignal.timeout(1000));
  await new CloudflareTransport({ ...options, probePath: '/assets/style.css' }).probe('https://fixture.trycloudflare.com', AbortSignal.timeout(1000));
  assert.deepEqual(paths, ['/browser/assets/probe.css', '/assets/style.css']);
  for (const probePath of ['/json/version', '//evil.example/', '/s/token/']) assert.throws(() => new CloudflareTransport({ ...options, probePath }), /readiness/);
});

// A fake /proc: one folder per pid with a NUL-separated cmdline. killImpl removes it, as an exit would.
async function fakeProc(t) {
  const root = await mkdtemp(join(tmpdir(), 'handoff-cloudflare-proc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const signals = [];
  return {
    root, signals,
    async add(pid, argv) { await mkdir(join(root, String(pid)), { recursive: true }); await writeFile(join(root, String(pid), 'cmdline'), argv.join('\0') + '\0'); },
    kill: (stubborn = new Set()) => (pid, signal) => {
      signals.push([pid, signal]);
      if (!stubborn.has(pid) || signal === 'SIGKILL') return rm(join(root, String(pid)), { recursive: true, force: true });
    },
  };
}
const tunnelArgs = (stateDir, binary = '/fixture/cloudflared') => [binary, 'tunnel', '--config', join(stateDir, 'quick-tunnel.yml'), '--no-autoupdate', '--metrics', '127.0.0.1:0', '--url', 'http://127.0.0.1:19410'];
const readyChild = () => { const child = new Child(); setImmediate(() => child.stdout.write('https://fixture.trycloudflare.com\nRegistered tunnel connection\n')); return child; };

test('a cloudflared left by a killed parent is stopped before a new tunnel starts, and only that one', async t => {
  const proc = await fakeProc(t);
  let spawned = 0;
  const transport = await setup(t, () => { spawned++; assert.deepEqual([...new Set(proc.signals.map(([pid]) => pid))], [4001, 4003], 'reaped before the spawn'); return readyChild(); }, { procRoot: proc.root, killImpl: proc.kill(new Set([4003])) });
  const { stateDir } = transport;
  await mkdir(stateDir, { recursive: true });
  // 4001: our orphan from the pid record. 4002: the pid was reused by an unrelated program.
  // 4003: our orphan from the old receipt, which ignores SIGTERM. 4004: another state folder's tunnel.
  await proc.add(4001, tunnelArgs(stateDir));
  await proc.add(4002, ['/usr/bin/vim', 'notes.txt']);
  await proc.add(4003, tunnelArgs(stateDir));
  await proc.add(4004, tunnelArgs('/elsewhere'));
  await writeFile(join(stateDir, 'cloudflared.pid'), JSON.stringify({ pid: 4001 }));
  await writeFile(join(stateDir, 'transport.json'), JSON.stringify({ pid: 4003, origin: 'https://old.trycloudflare.com', port: 19410 }));
  assert.equal(await transport.ensure(19410), 'https://fixture.trycloudflare.com');
  assert.equal(spawned, 1);
  assert.deepEqual(proc.signals, [[4001, 'SIGTERM'], [4003, 'SIGTERM'], [4003, 'SIGKILL']]);
  for (const pid of [4002, 4004]) assert.ok(existsSync(join(proc.root, String(pid))), pid + ' must keep running');
  for (const [pid, stateFolder, binary] of [[4005, stateDir, '/other/cloudflared'], [4006, '/elsewhere', '/fixture/cloudflared']]) {
    await proc.add(pid, tunnelArgs(stateFolder, binary));
    await writeFile(join(stateDir, 'cloudflared.pid'), JSON.stringify({ pid }));
    await transport.reapOrphans();
    assert.ok(existsSync(join(proc.root, String(pid))), 'a different binary or state folder is not ours');
  }
});

test('the child pid is recorded at spawn and forgotten once it exits', async t => {
  let child;
  const transport = await setup(t, () => { child = readyChild(); child.pid = 4100; return child; }, { procRoot: (await fakeProc(t)).root });
  await transport.ensure(19410);
  const recorded = JSON.parse(await readFile(join(transport.stateDir, 'cloudflared.pid'), 'utf8'));
  assert.equal(recorded.pid, 4100);
  await transport.close();
  for (let attempt = 0; attempt < 100 && existsSync(join(transport.stateDir, 'cloudflared.pid')); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(existsSync(join(transport.stateDir, 'cloudflared.pid')), false);
});
