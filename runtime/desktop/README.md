# Persistent browser desktop runtime

This directory runs the noVNC handoff on the host. The agent's Chrome runs on a private Xvfb display with openbox. A supervisor starts one disposable x11vnc input actor per viewer session. Returning control stops the actor and preserves the browser, tabs, cookies and open dialogs.

Setup writes five systemd user services: the display, the window manager, the browser, the supervisor and the controller. Xvfb, x11vnc, openbox and python3 come from the host's distribution packages. Setup installs none of them.

- `supervisor.py` serves a private Unix control socket and owns the x11vnc actors.
- `xproof.py` lists X clients by PID through XRes, and settles held input through XTest. It uses Python `ctypes` and the host's X libraries, so it needs no compiler.
- `clipboard.py` owns and reads the X clipboard over libX11, so it needs no xclip.
- `openbox_config.py` writes Clawser's own openbox config from the system `rc.xml`.
- `index.mjs` exports `HostDesktopRuntime`, the controller's adapter for the supervisor.

```js
import { HostDesktopRuntime } from './runtime/desktop/index.mjs';
const desktop = new HostDesktopRuntime({
  stateDir: '/private/runtime-state',
  controlSocket: '/private/runtime-state/control.sock',
  cdpUrl: 'http://127.0.0.1:18820',
});
await desktop.status();
await desktop.tabs();
const viewer = await desktop.startViewer({
  leaseId: 'unique-lease-id', role: 'watch', expiresAt: Date.now() + 600_000,
});
// Fence viewer ingress and close existing transports before promotion or Done.
const controlled = await desktop.promoteViewer({ leaseId: viewer.leaseId });
await desktop.heartbeatViewer({ leaseId: controlled.leaseId, epoch: controlled.epoch });
await desktop.clipboardWrite('Unicode text 🙂', { leaseId: controlled.leaseId, epoch: controlled.epoch });
const { text } = await desktop.clipboardRead({ leaseId: controlled.leaseId, epoch: controlled.epoch });
const receipt = await desktop.stopViewerAndSettle({ leaseId: viewer.leaseId });
// Hold the controller ownership gate until a fresh CDP observation also succeeds.
```

The viewer result contains a private VNC password and the path of the actor's Unix socket. Never put these in agent tool results, logs or URLs. Only the authenticated controller connects to the raw VNC socket; it delivers the current epoch's role-specific password to its authenticated noVNC viewer. Watch actors use x11vnc's enforced view-only mode. Promotion settles the previous actor and creates a fresh actor and password while preserving the original expiry.

x11vnc runs with `-unixsock <path> -rfbport 0 -no6 -rfbportv6 -1`, so it opens no TCP listener. Each socket sits in a 0700 folder. Xvfb runs with `-nolisten tcp` and `-auth <cookie file>`, and refuses any client without the cookie. The supervisor clears `WAYLAND_DISPLAY` for itself and its children.

The controller sends `heartbeatViewer({ leaseId, epoch })` every five seconds for the current actor descriptor. Successful acknowledgement includes `{ ok: true, leaseId, epoch, heartbeatDeadline, expiresAt }`. Production actors have a 30-second heartbeat deadline capped by their absolute lease expiry. Missing, stale or mismatched lease/epoch cannot refresh it. A watchdog thread runs independently of control socket reads and fences an abandoned actor with the same recorded watch/full settlement path while preserving Chrome. Promotion creates a new epoch, so the heartbeat must switch to the returned descriptor. The trusted local constructor option `testHeartbeatTimeoutMs` permits 1000–30000 ms solely for deterministic runtime tests; production configuration defaults to 30000 ms and viewer requests cannot set it.

The caller must authenticate every operation and authorize clipboard reads/writes only for the current control lease. The runtime also requires an active control actor and checks optional `{ leaseId, epoch }` context. This module is a local trusted runtime adapter, not an HTTP authorization layer. Clipboard text travels on stdin to the clipboard helper; text is never placed in command arguments. A native XGetSelectionOwner/XRes PID query positively proves that the new helper owns the selection before acknowledgement, including when the text is unchanged. Failed or replaced helpers are killed, reaped and fenced through observed X client absence. Automatic RFB clipboard exchange and x11vnc external commands are disabled.

`stopViewerAndSettle` requires the caller to fence the retiring viewer's HTTP/WebSocket/input ingress first. The runtime kills and reaps the entire actor process group, queries XRes over the local Unix X socket until all actor PID clients are absent, and performs XSync. A recorded control actor also releases depressed keys and mapped buttons through XTEST and verifies keyboard/XI2 button state. A recorded watch actor preserves ongoing agent inputs and returns `readOnly: true`, `inputResetRequired: false`, `heldInputCleared: false`. Trusted controller uncertainty can force the full reset with `{ mayBeWritable: true }`; a false/omitted value never downgrades a recorded control actor. Cached watch receipts can be upgraded to a fresh full-reset receipt under that same authority.

Unknown client PID reporting, protocol errors, remaining control input or timeouts quarantine the display. A receipt contains `vncProcessesExited`, `xClientsAbsent`, `heldInputCleared`, `xSyncComplete`, `readOnly`, `inputResetRequired`, `displayGeneration`, `browserGeneration`, `epoch` and `leaseId`. The controller may retire a proven watch without draining agent operations or taking a CDP snapshot. Writable or potentially writable handback holds the ownership gate through settlement and a fresh CDP observation.

This proves the retired actor cannot dispatch further X input. It does not prove that previously delivered browser events, renderer tasks, navigation, downloads or remote requests have completed. The controller must keep its ownership gate closed through a fresh browser snapshot. Failure must not transfer control back to automation.

The display and browser generations change when Xvfb or Chrome restarts. A restart while idle is harmless, and the next handoff uses the new generations. A restart during a viewer session retires that session and quarantines the supervisor. A supervisor restart changes both generations, so the controller treats any open session as lost. On start, the supervisor kills x11vnc actors and clipboard helpers a previous supervisor left behind and releases any input they held.

There is no container and no egress firewall. Chrome runs in its normal OS sandbox. The supervisor's status reports `isolation: 'host-user-services'`, `browserSandbox: 'chrome-os-sandbox'` and `egressFirewall: false`.

Run the runtime tests with `npm run test:desktop`. Tests that need Xvfb, x11vnc or python3 skip when the program is missing. They start their own displays from `:140` to `:199` and never touch an existing profile or user service.
