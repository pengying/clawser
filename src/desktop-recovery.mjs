import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { DesktopController, observeDesktop, safeCompletion } from './desktop-controller.mjs';

class RecoveryFailure extends Error {
  constructor(code) { super('Desktop recovery refused: ' + code); this.code = 'DESKTOP_RECOVERY_' + code; }
}
const failure = code => new RecoveryFailure(code);
const generation = value => typeof value === 'string' && value.length > 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const flags = ['vncProcessesExited', 'xClientsAbsent', 'heldInputCleared', 'xSyncComplete'];

// Local operator maintenance only. The normal controller must be stopped.
// This never opens an HTTP/RPC listener, starts a browser, or clears a gate.
export async function reconcileDesktop({ stateDir, profile, runtime, socketPath = join(stateDir || '', 'desktop.sock'), leaseId }, { observe = observeDesktop, controllerFactory = options => new DesktopController(options) } = {}) {
  let code = 'INVALID_OPTIONS', controller, locked = false, row;
  try {
    if (!isAbsolute(stateDir || '') || !isAbsolute(socketPath) || typeof profile !== 'string' || !profile || !/^[a-f0-9]{32}$/.test(leaseId || '') || !runtime) throw failure(code);
    code = 'PRIVATE_DIRECTORY_REQUIRED';
    for (const directory of new Set([stateDir, dirname(socketPath)])) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw failure(code);
    }
    controller = controllerFactory({ stateDir, profile, runtime, socketPath, transport: { ensure: async () => { throw failure('TRANSPORT_FORBIDDEN'); }, close: async () => {} } });
    code = 'CONTROLLER_RUNNING';
    await controller.rpc.acquireLock(); locked = true;
    const assertLock = () => { if (!controller.rpc.lockHolder || controller.rpc.lockHolder.lost) throw failure('LOCK_LOST'); };
    code = 'INVALID_JOURNAL';
    const saved = JSON.parse(await readFile(join(stateDir, 'ledger.json'), 'utf8'));
    if (saved.version !== 1 || !object(saved.calls) || !object(saved.leases)) throw failure(code);
    controller.ledger = saved;
    code = 'UNSAFE_JOURNAL';
    row = saved.leases[leaseId];
    if (Object.keys(saved.calls).length || !row || row.id !== leaseId || row.profile !== profile || row.state !== 'recovery_required' || row.mayBeWritable !== true || !Number.isSafeInteger(row.epoch) || row.epoch < 1 || !generation(row.displayGeneration) || !generation(row.browserGeneration)) throw failure(code);
    for (const [id, other] of Object.entries(saved.leases)) if (id !== leaseId && (!object(other) || other.id !== id || other.state !== 'ended' || !safeCompletion(other))) throw failure(code);
    controller.poison(); controller.gate.holder = 'operator_reconciliation';
    const persist = controller.persist.bind(controller);
    // Offline proof is transactional: keep the original failed journal intact
    // until retirement, observation and the final idle-runtime check all pass.
    controller.persist = async () => { assertLock(); };
    const idle = (status, epoch) => {
      if (status?.ready !== true || status.tainted !== false || status.viewer !== null || status.browserSandbox !== true || status.authenticatedInternetReady !== true || status.displayGeneration !== row.displayGeneration || status.browserGeneration !== row.browserGeneration || !Number.isSafeInteger(status.epoch) || status.epoch <= row.epoch || (epoch !== undefined && status.epoch !== epoch)) throw failure('RUNTIME_NOT_IDLE_OR_CHANGED');
      assertLock();
    };
    code = 'RUNTIME_UNAVAILABLE';
    const before = await runtime.status(); idle(before);
    const originalRuntime = runtime;
    // Tighten the existing retirement checks to the exact idle supervisor epoch
    // and both generations. A cached writable settlement performs no new input.
    controller.runtime = Object.create(runtime);
    controller.runtime.stopViewerAndSettle = async params => {
      code = 'RETIREMENT_RPC_FAILED';
      const receipt = await originalRuntime.stopViewerAndSettle(params);
      code = 'INVALID_RETIREMENT_RECEIPT';
      if (receipt?.leaseId !== leaseId || receipt.epoch !== before.epoch || receipt.epoch <= row.epoch || receipt.displayGeneration !== row.displayGeneration || receipt.browserGeneration !== row.browserGeneration || receipt.readOnly !== false || receipt.inputResetRequired !== true || !flags.every(flag => receipt[flag] === true)) throw failure(code);
      assertLock(); return receipt;
    };
    controller.observe = async (_runtime, current) => {
      code = 'SNAPSHOT_FAILED';
      const result = await observe(originalRuntime, current);
      if (result?.snapshotObserved !== true || result.displayGeneration !== row.displayGeneration || result.browserGeneration !== row.browserGeneration) throw failure(code);
      code = 'RUNTIME_CHANGED'; idle(await originalRuntime.status(), before.epoch);
      code = 'COMPLETION_PERSISTENCE_FAILED'; return result;
    };
    assertLock();
    await controller.retire(leaseId, { reconcile: true });
    code = 'RUNTIME_CHANGED'; idle(await originalRuntime.status(), before.epoch);
    code = 'COMPLETION_PERSISTENCE_FAILED'; assertLock(); await persist();
    code = 'DURABLE_PROOF_FAILED';
    const durable = JSON.parse(await readFile(join(stateDir, 'ledger.json'), 'utf8'));
    const ended = durable.leases?.[leaseId];
    if (Object.keys(durable.calls || {}).length || ended?.state !== 'ended' || ended.receipt?.epoch !== before.epoch || ended.receipt?.displayGeneration !== before.displayGeneration || ended.receipt?.browserGeneration !== before.browserGeneration || ended.receipt?.readOnly !== false || ended.receipt?.inputResetRequired !== true || !flags.every(flag => ended.receipt?.[flag] === true) || ended.receipt?.snapshotObserved !== true || !safeCompletion(ended)) throw failure(code);
    assertLock();
    return { ok: true, leaseId, inputFenced: true, snapshotObserved: true, restartRequired: true };
  } catch (error) {
    throw failure(error instanceof RecoveryFailure ? error.code.slice('DESKTOP_RECOVERY_'.length) : code);
  } finally {
    if (locked) await controller.rpc.releaseLock();
  }
}
