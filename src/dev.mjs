import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpBrowser } from './cdp.mjs';
import { HandoffServer } from './server.mjs';

// This harness cannot gate another process's agent. Use a dedicated test browser.
if (process.env.HANDOFF_DEV_ACK !== 'dedicated-browser') throw new Error('Set HANDOFF_DEV_ACK=dedicated-browser; standalone mode has no OpenClaw agent-control gate');
if (!process.env.HANDOFF_CDP_URL || !process.env.HANDOFF_TARGET_ID) throw new Error('Set HANDOFF_CDP_URL and HANDOFF_TARGET_ID for a dedicated running test browser');
const server = new HandoffServer({ backend: new CdpBrowser({ demo: process.env.HANDOFF_CDP_URL }), publicBaseUrl: process.env.HANDOFF_PUBLIC_BASE_URL });
await server.start({ port: Number(process.env.HANDOFF_PORT || 18796) });
const invite = await server.createShare({ owner: 'standalone-dev', profile: 'demo', targetId: process.env.HANDOFF_TARGET_ID, ttlMs: 300_000 });
const directory = await mkdtemp(join(tmpdir(), 'browser-handoff-invite-'));
const path = join(directory, 'invite.json');
await writeFile(path, JSON.stringify(invite), { mode: 0o600 });
console.log(`Development viewer listening on loopback. Private invitation saved to ${path}`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await server.close(); process.exitCode = 0; }
process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
