#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { HostDesktopRuntime } from '../runtime/desktop/index.mjs';
import { reconcileDesktop } from '../src/desktop-recovery.mjs';

// Explicit local operator maintenance, after stopping the controller service.
// Arguments: /absolute/private/controller.json exact-failed-lease-id
let code = 'DESKTOP_RECOVERY_CONFIG_INVALID';
try {
  const [configPath, leaseId, extra] = process.argv.slice(2);
  if (!isAbsolute(configPath || '') || !/^[a-f0-9]{32}$/.test(leaseId || '') || extra !== undefined) throw new Error();
  const info = await lstat(configPath);
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error();
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (typeof config.stateDir !== 'string' || typeof config.profile !== 'string') throw new Error();
  const fromConfig = value => isAbsolute(value) ? value : resolve(dirname(configPath), value);
  const stateDir = fromConfig(config.stateDir);
  const { stateDir: runtimeState, controlSocket, cdpUrl } = config.runtime || {};
  const runtime = new HostDesktopRuntime({ stateDir: runtimeState ? fromConfig(runtimeState) : resolve(stateDir, 'runtime'),
    controlSocket: typeof controlSocket === 'string' && controlSocket ? fromConfig(controlSocket) : controlSocket, cdpUrl });
  code = 'DESKTOP_RECOVERY_FAILED';
  const result = await reconcileDesktop({ stateDir, profile: config.profile, runtime, leaseId,
    ...(config.socketPath ? { socketPath: fromConfig(config.socketPath) } : {}) });
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  if (/^DESKTOP_RECOVERY_[A-Z_]+$/.test(error?.code || '')) code = error.code;
  process.stderr.write('Desktop recovery refused: ' + code + '\n');
  process.exitCode = 1;
}
