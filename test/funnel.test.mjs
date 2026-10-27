import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FunnelTransport } from '../src/funnel.mjs';
const ownedRoute = () => ({
  TCP: { '10000': { HTTPS: true } },
  Web: { 'demo.example.ts.net:10000': { Handlers: { '/': { Proxy: 'http://127.0.0.1:18796' } } } },
  AllowFunnel: { 'demo.example.ts.net:10000': true },
});

test('Funnel refuses occupied ports and never overwrites existing services', async () => {
  const calls = [];
  const transport = new FunnelTransport({ run: async (args) => { calls.push(args); return JSON.stringify({ TCP: { '10000': { HTTPS: true } } }); } });
  await assert.rejects(transport.open(18796), /occupied|in use/i);
  assert.equal(calls.length, 1);
});

test('Funnel uses argument arrays and only removes an unchanged route it created', async () => {
  const calls = []; let status = {};
  const transport = new FunnelTransport({ run: async (args) => {
    calls.push(args);
    if (args[0] === 'status') return JSON.stringify({ Self: { DNSName: 'demo.example.ts.net.' } });
    if (args[0] === 'serve') return JSON.stringify(status);
    status = args.includes('off') ? {} : ownedRoute();
    return '';
  } });
  assert.equal(await transport.open(18796), 'https://demo.example.ts.net:10000');
  assert.deepEqual(calls[2], ['funnel', '--bg', '--https=10000', 'http://127.0.0.1:18796']);
  await transport.close();
  assert.ok(calls.some((args) => JSON.stringify(args) === JSON.stringify(['funnel', '--https=10000', 'off'])));
});

test('changed Funnel configuration is left untouched during cleanup', async () => {
  const calls = []; let configured = false;
  const transport = new FunnelTransport({ run: async (args) => {
    calls.push(args);
    if (args[0] === 'status') return JSON.stringify({ Self: { DNSName: 'demo.example.ts.net.' } });
    if (args[0] === 'serve') return JSON.stringify(configured ? { Web: { 'demo.example.ts.net:10000': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } } : {});
    configured = true; return '';
  } });
  // Setup now verifies its exact isolated port configuration.
  await assert.rejects(transport.open(18796), /verify|configuration|setup/i);
  assert.ok(!calls.some((args) => args.includes('off')));
});

test('partial Funnel mutation is reconciled when the CLI applies configuration then fails', async () => {
  const calls = []; let status = {};
  const transport = new FunnelTransport({ run: async (args) => {
    calls.push(args);
    if (args[0] === 'status') return JSON.stringify({ Self: { DNSName: 'demo.example.ts.net.' } });
    if (args[0] === 'serve') return JSON.stringify(status);
    if (args.includes('off')) { status = {}; return ''; }
    status = ownedRoute();
    throw new Error('CLI timed out after applying mutation');
  } });
  await assert.rejects(transport.open(18796), /setup/i);
  assert.ok(calls.some((args) => args.includes('off')));
  assert.deepEqual(status, {});
});

test('foreground ports are occupied too; cleanup preserves added port-wide configuration', async () => {
  const occupied = new FunnelTransport({ run: async () => JSON.stringify({ Foreground: { other: { TCP: { '10000': { HTTPS: true } } } } }) });
  await assert.rejects(occupied.open(18796), /occupied/i);
  let status = {}, calls = [];
  const transport = new FunnelTransport({ run: async (args) => {
    calls.push(args);
    if (args[0] === 'status') return JSON.stringify({ Self: { DNSName: 'demo.example.ts.net.' } });
    if (args[0] === 'serve') return JSON.stringify(status);
    status = ownedRoute();
    return '';
  } });
  await transport.open(18796);
  status.AllowFunnel['another.example.ts.net:10000'] = true;
  await assert.rejects(transport.close(), /changed/i);
  assert.ok(!calls.some((args) => args.includes('off')));
});

const receipt = () => ({ version: 1, owner: 'browser-handoff', httpsPort: 10000, dnsName: 'demo.example.ts.net', localPort: 18796 });
const unrelated = () => ({ TCP: { '8443': { HTTPS: true } }, Web: { 'demo.example.ts.net:8443': { Handlers: { '/chat': { Proxy: 'http://127.0.0.1:8788' } } } }, AllowFunnel: { 'demo.example.ts.net:8443': true }, Foreground: { other: { TCP: { '443': { HTTPS: true } } } } });
function withRoute(base = unrelated()) {
  const result = structuredClone(base), route = ownedRoute();
  for (const key of ['TCP', 'Web', 'AllowFunnel']) Object.assign(result[key], route[key]);
  return result;
}
async function persistent(t) {
  const directory = await mkdtemp(join(tmpdir(), 'handoff-funnel-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = { ownershipFile: join(directory, 'ownership.json'), state: unrelated(), calls: [], remove: true, offThrows: false };
  fixture.run = async (args) => {
    fixture.calls.push(args);
    if (args[0] === 'serve') return JSON.stringify(fixture.state);
    if (args[0] === 'status') {
      if (fixture.beforeIdentity) await fixture.beforeIdentity();
      return JSON.stringify({ Self: { DNSName: 'demo.example.ts.net.' } });
    }
    if (args.includes('off')) {
      if (fixture.remove) {
        delete fixture.state.TCP['10000']; delete fixture.state.Web['demo.example.ts.net:10000']; delete fixture.state.AllowFunnel['demo.example.ts.net:10000'];
      }
      if (fixture.offThrows) throw new Error('CLI lost after removal');
    } else {
      if (fixture.beforeMutation) await fixture.beforeMutation();
      fixture.state = withRoute(fixture.state);
    }
    return '';
  };
  fixture.transport = () => new FunnelTransport(fixture);
  fixture.mutations = () => fixture.calls.filter((args) => args[0] === 'funnel');
  return fixture;
}

test('restart recovers a durably recorded exact route without mutation and preserves other services', async (t) => {
  const f = await persistent(t), before = structuredClone(f.state);
  f.beforeMutation = async () => assert.deepEqual(JSON.parse(await readFile(f.ownershipFile, 'utf8')), receipt(), 'intent must be durable before CLI mutation');
  await f.transport().open(18796); // Simulate process loss without close.
  assert.equal((await stat(f.ownershipFile)).mode & 0o777, 0o600);
  const mutationCount = f.mutations().length, restarted = f.transport();
  assert.equal(await restarted.open(18796), 'https://demo.example.ts.net:10000');
  assert.equal(f.mutations().length, mutationCount, 'recovery must not recreate or remove the route');
  await restarted.close();
  assert.deepEqual(f.state, before);
  await assert.rejects(access(f.ownershipFile), { code: 'ENOENT' });
});

test('write-ahead intent recovers both crash boundaries: before and after route creation', async (t) => {
  for (const applied of [false, true]) await t.test(String(applied), async (t) => {
    const f = await persistent(t);
    await writeFile(f.ownershipFile, JSON.stringify(receipt()));
    if (applied) f.state = withRoute();
    await f.transport().open(18796);
    assert.equal(f.mutations().length, applied ? 0 : 1);
  });
});

test('even an exact existing route without a receipt is never adopted', async (t) => {
  const f = await persistent(t); f.state = withRoute();
  await assert.rejects(f.transport().open(18796), /occupied|ownership/i);
  assert.equal(f.mutations().length, 0);
});

test('malformed, foreign, or mismatching ownership records fail closed before mutation', async (t) => {
  for (const record of ['{', { ...receipt(), version: 2 }, { ...receipt(), owner: 'other' }, { ...receipt(), localPort: 18797 }, { ...receipt(), httpsPort: 443 }, { ...receipt(), dnsName: 'other.example.ts.net' }]) await t.test(JSON.stringify(record), async (t) => {
    const f = await persistent(t);
    await writeFile(f.ownershipFile, typeof record === 'string' ? record : JSON.stringify(record));
    await assert.rejects(f.transport().open(18796), /ownership|receipt/i);
    assert.equal(f.mutations().length, 0);
  });
});

test('ownership read or write failure cannot create a public route', async (t) => {
  const f = await persistent(t);
  f.ownershipFile = join(f.ownershipFile, 'impossible.json');
  await writeFile(f.ownershipFile.replace('/impossible.json', ''), 'not a directory');
  await assert.rejects(f.transport().open(18796), /ownership|receipt|ENOTDIR/i);
  assert.equal(f.mutations().length, 0);
});

test('failed receipt persistence prevents the first Funnel mutation', async (t) => {
  const f = await persistent(t), blockedDirectory = join(f.ownershipFile, 'state');
  f.ownershipFile = join(blockedDirectory, 'receipt.json');
  f.beforeIdentity = async () => { await writeFile(blockedDirectory.replace('/state', ''), 'block parent creation'); };
  await assert.rejects(f.transport().open(18796), /persist.*ownership/i);
  assert.equal(f.mutations().length, 0);
});

test('observed route drift permanently invalidates the active receipt', async (t) => {
  const f = await persistent(t);
  await f.transport().open(18796);
  f.state.Web['demo.example.ts.net:10000'].Handlers['/other'] = { Proxy: 'http://127.0.0.1:9999' };
  const before = structuredClone(f.state), count = f.mutations().length;
  await assert.rejects(f.transport().open(18796), /changed|occupied|ownership/i);
  assert.deepEqual(f.state, before);
  assert.equal(f.mutations().length, count);
  await assert.rejects(access(f.ownershipFile), { code: 'ENOENT' });
  f.state = withRoute();
  await assert.rejects(f.transport().open(18796), /occupied|ownership/i);
  assert.equal(f.mutations().length, count);
});

test('cleanup requires verified removal, retains recovery intent on failure, and tolerates apply-then-throw', async (t) => {
  const f = await persistent(t), transport = f.transport();
  await transport.open(18796);
  f.remove = false;
  await assert.rejects(transport.close(), /cleanup|remov|Funnel/i);
  await access(f.ownershipFile);
  f.remove = true; f.offThrows = true;
  await transport.close();
  await assert.rejects(access(f.ownershipFile), { code: 'ENOENT' });
  assert.deepEqual(f.state, unrelated());
});

test('cleanup preserves configuration drift and invalidates its receipt', async (t) => {
  const f = await persistent(t), transport = f.transport();
  await transport.open(18796);
  f.state.Foreground.samePort = { TCP: { '10000': { HTTPS: true } } };
  const before = structuredClone(f.state), count = f.mutations().length;
  await assert.rejects(transport.close(), /changed/i);
  assert.deepEqual(f.state, before); assert.equal(f.mutations().length, count);
  await assert.rejects(access(f.ownershipFile), { code: 'ENOENT' });
});

test('a setup failure after applying the route reconciles and removes its receipt', async (t) => {
  const f = await persistent(t), run = f.run;
  f.run = async (args) => { const result = await run(args); if (args.includes('--bg')) throw new Error('interrupted after applying'); return result; };
  await assert.rejects(f.transport().open(18796), /setup failed.*reconciled/i);
  assert.deepEqual(f.state, unrelated());
  await assert.rejects(access(f.ownershipFile), { code: 'ENOENT' });
});
