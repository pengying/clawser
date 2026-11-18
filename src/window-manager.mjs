import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { unitNames } from './host-units.mjs';

// Bumped whenever openbox_config.py changes what a control link can reach, so setup regenerates an rc.xml an older one wrote.
export const OPENBOX_GENERATOR = 3;
const RECEIPT_IDENTITY = 'clawser-setup-v2';

export const STALE_WINDOW_MANAGER = "Control links are unavailable: the window manager on the agent's screen still runs a config from before Clawser's lockdown, and a person in control could open its menu or a terminal from it. Run openclaw clawser setup --yes, then create the link again. Watch links still work.";
export const UNKNOWN_WINDOW_MANAGER = "Control links are unavailable: Clawser can't read its setup receipt, so it can't tell whether the window manager on the agent's screen is locked down. Run openclaw clawser setup --yes, then create the link again. Watch links still work.";

// Setup keeps its receipt in the state folder, beside controller.json and above the folder holding the controller socket.
export const receiptBesideConfig = configPath => join(dirname(configPath), 'setup.json');
export const receiptForSocket = socketPath => join(dirname(dirname(socketPath)), 'setup.json');

/**
 * What the setup receipt says about the window manager: 'current' (locked down), 'none' (setup runs no window manager),
 * 'stale' (an older generator, or one setup has not yet restarted openbox on), 'missing' (no receipt) or 'invalid'.
 * setup records the generator only after openbox restarted on the new config.
 */
export async function windowManagerState(receiptPath, { read = readFile } = {}) {
  let saved;
  try { saved = JSON.parse(await read(receiptPath, 'utf8')); }
  catch (error) { return error?.code === 'ENOENT' ? 'missing' : 'invalid'; }
  if (saved?.identity !== RECEIPT_IDENTITY || typeof saved.stateDir !== 'string' || !saved.stateDir || !saved.units || typeof saved.units !== 'object') return 'invalid';
  if (!saved.units[unitNames(saved.stateDir).windowManager]) return 'none';
  return saved.openboxGenerator === OPENBOX_GENERATOR ? 'current' : 'stale';
}

// Control may be handed out only on a locked-down window manager, or with none at all.
export const controlRefusal = state => state === 'current' || state === 'none' ? undefined : state === 'stale' ? STALE_WINDOW_MANAGER : UNKNOWN_WINDOW_MANAGER;
