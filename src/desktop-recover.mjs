import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DesktopController, readProcessInfo } from './desktop-controller.mjs';
import { unitNames } from './host-units.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);

/**
 * Offline operator recovery for browser-call admissions the noVNC controller can't clear itself.
 * The controller clears a call on its own once the Gateway process that admitted it has exited. A call with no
 * recorded Gateway (admitted by Clawser 1.0.1 or earlier, or by a Gateway whose /proc identity didn't check out,
 * such as one in another PID namespace) never proves that, and keeps the gate poisoned. With the controller
 * stopped, this clears calls whose Gateway is gone, and with `abandonCalls` also those that name no Gateway.
 * It never clears a call whose Gateway is still running, and never touches leases: the controller re-checks
 * leases from an earlier supervisor boot when it starts, and bin/reconcile-desktop.mjs handles a failed control
 * handback on the current boot.
 */
export async function recoverDesktopCalls({ stateDir, abandonCalls = false, dryRun = false }, { processInfo = readProcessInfo, controllerFactory = options => new DesktopController(options) } = {}) {
  const configPath = join(stateDir, 'controller.json');
  const info = await lstat(configPath).catch(() => undefined);
  if (!info?.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error(`No private controller configuration at ${configPath}; run recover with the --state-dir setup used`);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (typeof config.stateDir !== 'string' || typeof config.profile !== 'string') throw new Error('Controller configuration names no state folder or profile');
  const fromConfig = value => isAbsolute(value) ? value : resolve(dirname(configPath), value);
  const ledgerDir = fromConfig(config.stateDir);
  const socketPath = config.socketPath ? fromConfig(config.socketPath) : join(ledgerDir, 'desktop.sock');
  const controller = controllerFactory({ stateDir: ledgerDir, profile: config.profile, socketPath, runtime: { cdpUrl: config.runtime?.cdpUrl },
    transport: { ensure: async () => { throw new Error('recover opens no tunnel'); }, close: async () => {} } });
  try { await controller.rpc.acquireLock(); }
  catch { throw new Error(`The controller is running. Stop it first with: systemctl --user stop ${unitNames(stateDir).controller}, then start it again afterwards`); }
  try {
    let saved;
    try { saved = JSON.parse(await readFile(join(ledgerDir, 'ledger.json'), 'utf8')); }
    catch (error) {
      // A controller that never recorded anything has nothing to recover.
      if (error.code === 'ENOENT') return { ok: true, dryRun, cleared: 0, running: 0, unknown: 0, recoveryRequired: [], noLedger: join(ledgerDir, 'ledger.json') };
      throw new Error(`The controller ledger at ${join(ledgerDir, 'ledger.json')} could not be read (${error.message}); it was left unchanged`);
    }
    if (saved.version !== 1 || !object(saved.calls) || !object(saved.leases)) throw new Error('The controller ledger is invalid; it was left unchanged');
    const cleared = [], running = [], unknown = [];
    for (const [key, call] of Object.entries(saved.calls)) {
      if (!Number.isSafeInteger(call?.ownerPid) || typeof call.ownerStartTicks !== 'string') { (abandonCalls ? cleared : unknown).push(key); continue; }
      const owner = await processInfo(call.ownerPid);
      if (!owner || owner.startTicks !== call.ownerStartTicks) cleared.push(key); else running.push(key);
    }
    if (cleared.length && !dryRun) {
      for (const key of cleared) delete saved.calls[key];
      controller.ledger = saved;
      await controller.persist();
    }
    const recoveryRequired = Object.values(saved.leases).filter(row => row?.state === 'recovery_required').map(row => row.id);
    // A lease that needs recovery keeps the gate closed too, so the run is not a success while one remains.
    return { ok: !running.length && !unknown.length && !recoveryRequired.length, dryRun, cleared: cleared.length, running: running.length, unknown: unknown.length, recoveryRequired };
  } finally { await controller.rpc.releaseLock(); }
}

export function describeRecovery(result, unit) {
  if (result.noLedger) return [`No controller ledger at ${result.noLedger}: the controller has not recorded anything here, so there is nothing to recover.`, 'Start the controller again: systemctl --user start ' + unit];
  const lines = [(result.dryRun ? 'Would clear ' : 'Cleared ') + result.cleared + ' browser call admission(s) whose Gateway has exited or that you abandoned.'];
  if (result.running) lines.push(result.running + ' call(s) belong to a Gateway that is still running. Restart it with openclaw gateway restart, then run recover again.');
  if (result.unknown) lines.push(`${result.unknown} call(s) name no Gateway: Clawser 1.0.1 or earlier recorded none, and a Gateway whose process Clawser couldn't check (one in another PID namespace, for example) records none either. Once no browser call can still be running (after openclaw gateway restart), rerun with --abandon-calls.`);
  if (result.recoveryRequired.length) lines.push('Leases needing recovery: ' + result.recoveryRequired.join(', ') + '. Starting the controller re-checks those from an earlier supervisor boot; for a failed control handback on this boot see "Operator reconciliation" in docs/install.md.');
  lines.push('Start the controller again: systemctl --user start ' + unit);
  return lines;
}
