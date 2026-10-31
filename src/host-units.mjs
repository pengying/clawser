import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

export const CLAWSER_CHROME_FLAGS = Object.freeze(['--ozone-platform', '--password-store', '--ignore-gpu-blocklist', '--window-size', '--window-position', '--start-maximized', '--remote-debugging-address', '--remote-debugging-port', '--no-first-run', '--no-default-browser-check']);
// systemd expands $ in Exec words but not in Environment= values.
const env = { dollar: false };
const OWNED_ENV = new Set(['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS']);

export function systemdValue(value, { dollar = true } = {}) {
  value = String(value);
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Service values must contain no control characters');
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, () => dollar ? '$$' : '$') + '"';
}

export function systemdArgument(value) {
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Service command paths must be absolute and contain no control characters');
  return systemdValue(value);
}

export function unitNames(stateDir) {
  const hash = createHash('sha256').update(stateDir).digest('hex').slice(0, 12);
  const name = role => `clawser-${role}-${hash}.service`;
  return { display: name('display'), windowManager: name('wm'), browser: name('browser'), supervisor: name('supervisor'), controller: name('desktop') };
}

export function chromeArgs({ existing = [], userDataDir, profileDirectory, cdpPort }) {
  const out = [];
  const seen = {};
  for (const arg of existing) {
    const name = arg.split('=')[0];
    if (name === '--headless') throw new Error('Refusing to take over a headless Chrome; there is no window for the person to see.');
    if (CLAWSER_CHROME_FLAGS.includes(name)) continue;
    for (const [flag, want] of [['--user-data-dir', userDataDir], ['--profile-directory', profileDirectory]]) {
      if (name !== flag) continue;
      seen[flag] = true;
      if (want !== undefined && arg.slice(flag.length + 1) !== want) throw new Error(`Refusing to take over this Chrome: its ${flag} differs from the OpenClaw profile.`);
    }
    out.push(arg);
  }
  if (userDataDir !== undefined && !seen['--user-data-dir']) out.push(`--user-data-dir=${userDataDir}`);
  if (profileDirectory !== undefined && !seen['--profile-directory']) out.push(`--profile-directory=${profileDirectory}`);
  out.push('--ozone-platform=x11', '--password-store=basic', '--ignore-gpu-blocklist', '--window-size=1920,1080', '--window-position=0,0', '--start-maximized', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`, '--no-first-run', '--no-default-browser-check');
  return out;
}

export function renderUnits(i) {
  const { names: n, browser } = i;
  const header = `# Managed by Clawser; ownership is recorded in ${i.marker.replace(/%/g, '%%')}\n`;
  const install = '\n[Install]\nWantedBy=default.target\n';
  const x = `Environment=${systemdValue('DISPLAY=:' + i.display, env)}\nEnvironment=${systemdValue('XAUTHORITY=' + i.xauthority, env)}\n`;
  const extra = (browser.env ?? []).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || OWNED_ENV.has(name)) throw new Error(`Refusing browser environment variable ${name}; the unit owns its display and session environment`);
    return `Environment=${systemdValue(name + '=' + value, env)}\n`;
  }).join('');
  const wm = i.openbox ? n.windowManager : undefined;
  const units = {};

  units[n.display] = `${header}[Unit]\nDescription=Clawser virtual display\n\n[Service]\nType=simple\nExecStart=${systemdArgument(i.xvfb)} :${i.display} -screen 0 1920x1080x24 -dpi 96 -nolisten tcp -auth ${systemdArgument(i.xauthority)} +extension XTEST +extension X-Resource +extension DAMAGE +extension RANDR\nRestart=always\nRestartSec=2\n${install}`;

  if (wm) units[wm] = `${header}[Unit]\nDescription=Clawser window manager\nRequires=${n.display}\nAfter=${n.display}\nBefore=${n.browser}\n\n[Service]\nType=simple\n${x}UnsetEnvironment=WAYLAND_DISPLAY\nExecStart=${systemdArgument(i.openbox)} --config-file ${systemdArgument(i.openboxConfig)}\nRestart=always\nRestartSec=2\n${install}`;

  // systemd expands $VAR in ExecStartPre, so every $ is doubled for the shell.
  const wait = `for i in $(seq 50); do [ -S /tmp/.X11-unix/X${i.display} ] && exit 0; sleep 0.1; done; exit 1`.replace(/\$/g, '$$$$');
  const command = [browser.path, ...browser.args].map((v, k) => k ? systemdValue(v) : systemdArgument(v)).join(' ');
  units[n.browser] = `${header}[Unit]\nDescription=Clawser agent browser\nRequires=${n.display}\nAfter=${[n.display, wm].filter(Boolean).join(' ')}\n\n[Service]\nType=simple\n${x}${extra}UnsetEnvironment=WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS\nExecStartPre=/bin/sh -c '${wait}'\nExecStart=${command}\nRestart=always\nRestartSec=5\nTimeoutStopSec=15\n${install}`;

  const ordered = `${n.display} ${n.browser}`;
  units[n.supervisor] = `${header}[Unit]\nDescription=Clawser browser handoff supervisor\nWants=${ordered}\nAfter=${ordered}\n\n[Service]\nType=simple\nKillMode=control-group\nExecStart=${[i.python, i.supervisorScript, i.supervisorConfig].map(systemdArgument).join(' ')}\nUMask=0077\nNoNewPrivileges=true\nRestart=on-failure\nRestartSec=3\n${install}`;

  units[n.controller] = `${header}[Unit]\nDescription=Clawser private browser handoff controller\nWants=${n.supervisor}\nAfter=network-online.target ${n.supervisor}\n\n[Service]\nType=simple\nKillMode=mixed\nExecStart=${[i.node, i.controllerScript, i.controllerConfig].map(systemdArgument).join(' ')}\nUMask=0077\nNoNewPrivileges=true\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=180\n${install}`;
  return units;
}
