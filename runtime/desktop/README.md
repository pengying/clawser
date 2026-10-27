# Persistent browser desktop runtime

This directory owns a dedicated headed Chromium profile, Xvfb display and disposable x11vnc input actors. Returning control stops the actor and preserves the browser, tabs, cookies and open dialogs.

Build with `docker build -t openclaw-handoff-desktop:20261027 runtime/desktop`. The image uses a pinned Debian base and Chromium version and includes Latin/CJK fonts. It has no dependency on prototype images or fixtures.

```js
import { DesktopRuntime } from './runtime/desktop/index.mjs';
const desktop = new DesktopRuntime({
  name: 'openclaw-handoff-desktop',
  stateDir: '/private/runtime-state',
  cdpPort: 18810,
  vncPort: 59090,
});
await desktop.ensure();
await desktop.status();
await desktop.tabs();
const viewer = await desktop.startViewer({
  leaseId: 'unique-lease-id', role: 'watch', expiresAt: Date.now() + 600_000,
});
// Fence viewer ingress and close existing transports before promotion or Done.
const controlled = await desktop.promoteViewer({ leaseId: viewer.leaseId });
await desktop.heartbeatViewer({ leaseId: controlled.leaseId, epoch: controlled.epoch });
await desktop.clipboardWrite('Unicode text 🙂');
const { text } = await desktop.clipboardRead();
const receipt = await desktop.stopViewerAndSettle({ leaseId: viewer.leaseId });
// Hold the controller ownership gate until a fresh CDP observation also succeeds.
```

The viewer result contains a private VNC password and loopback host/port. Never put these in agent tool results, logs or URLs. Only the authenticated controller connects the raw VNC backend; it delivers the current epoch's role-specific password to its authenticated noVNC viewer. Watch actors use x11vnc's enforced view-only mode. Promotion settles the previous actor and creates a fresh actor/password while preserving the original expiry.

The controller sends `heartbeatViewer({ leaseId, epoch })` every five seconds for the current actor descriptor. Successful acknowledgement includes `{ ok: true, leaseId, epoch, heartbeatDeadline, expiresAt }`. Production actors have a 30-second heartbeat deadline capped by their absolute lease expiry. Missing, stale or mismatched lease/epoch cannot refresh it. A watchdog thread runs independently of management socket reads and fences an abandoned actor with the same recorded watch/full settlement path while preserving Chromium. Promotion creates a new epoch, so the heartbeat must switch to the returned descriptor. The trusted local constructor option `testHeartbeatTimeoutMs` permits 1000–30000 ms solely for deterministic runtime tests; production configuration defaults to 30000 ms and viewer requests cannot set it.

The caller must authenticate every operation and authorize clipboard reads/writes only for the current control lease. The runtime also requires an active control actor and checks optional `{ leaseId, epoch }` context. This module is a local trusted runtime adapter, not an HTTP authorization layer. Clipboard text travels in stdin through the Docker exec adapter and UTF-8 X selection helper; text is never placed in command arguments. A native XGetSelectionOwner/XRes PID query positively proves that the new foreground helper owns the selection before acknowledgement, including when the text is unchanged. Failed/replaced helpers are killed, reaped and fenced through observed X client absence. Completed helpers hold immutable clipboard data across Done and never reclaim ownership after another application replaces it. Automatic RFB clipboard exchange and x11vnc external commands are disabled.

`stopViewerAndSettle` requires the caller to fence the retiring viewer's HTTP/WebSocket/input ingress first. The runtime kills and reaps the entire actor process group, queries XRes 1.2 over the local UNIX X socket until all actor PID clients are absent, and performs XSync. A recorded control actor also releases depressed keys and mapped buttons through XTEST and verifies keyboard/XI2 button state. A recorded watch actor preserves ongoing agent inputs and returns `readOnly: true`, `inputResetRequired: false`, `heldInputCleared: false`. Trusted controller uncertainty can force the full reset with `{ mayBeWritable: true }`; a false/omitted value never downgrades a recorded control actor. Cached watch receipts can be upgraded to a fresh full-reset receipt under that same authority.

Unknown client PID reporting, protocol errors, remaining control input or timeouts quarantine the display. A receipt contains `vncProcessesExited`, `xClientsAbsent`, `heldInputCleared`, `xSyncComplete`, `readOnly`, `inputResetRequired`, `displayGeneration`, `browserGeneration`, `epoch` and `leaseId`. The controller may retire a proven watch without draining agent operations or taking a CDP snapshot. Writable or potentially writable handback holds the ownership gate through settlement and a fresh CDP observation.

This proves the retired actor cannot dispatch further X input. It does not prove that previously delivered browser events, renderer tasks, navigation, downloads or remote requests have completed. The controller must keep its ownership gate closed through a fresh browser snapshot. Failure must not transfer control back to automation.

The container has no host home, Docker socket or host network mount. CDP/VNC publish only on host loopback. Bootstrap installs an outbound allowlist for public TCP 80/443 and embedded Docker DNS, rejects private, metadata, link-local and shared address ranges, and disables IPv6. Browser, display, VNC and supervisor run as UID 1000 with zero capabilities. A separate UID 1001 TCP forwarder has zero capabilities and is the trusted CDP bridge. UID 1000 cannot initiate loopback TCP connections to CDP ports 9222/9223 or VNC port 5900. Readiness uses PID/socket-table observations instead of management TCP probes. The supervisor control socket and X display use UNIX sockets. This constrains normal browser network requests; it does not claim containment of a compromised browser main process beyond the measured Chromium sandbox/container boundary.

The reviewed seccomp profile preserves the [official Moby default policy](https://raw.githubusercontent.com/moby/profiles/main/seccomp/default.json) (source snapshot SHA256 `6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6`) and narrowly enables Chromium user/PID/network namespace setup plus chroot. It leaves mount/UTS/IPC/cgroup namespace creation and setns denied and clone3 returning ENOSYS. Docker's default AppArmor policy and no-new-privileges remain enabled; Chromium runs without `--no-sandbox`. The namespace argument rules and headed sandbox have been verified on the deployment's x86_64 Linux host.

`ensure()` records an ownership intent before creating resources and safely resumes partial startup only when labels, exact container ID, loopback port bindings, network ID and named profile volume match. Changed endpoint configuration is rejected before CDP access. The adapter refuses profile volumes mounted by another running container; only after this exclusive check may boot remove stale Chromium Singleton symlinks from the dedicated volume. Operation locks record PID/start ticks, fail closed and require explicit reconciliation if their owning process dies. `shutdown()` removes only owned container/network resources, retains the dedicated profile volume by default and records a stopped receipt; `ensure()` can recreate the container against that profile. `shutdown({ removeProfile: true })` explicitly deletes it. Browser/profile lifetime is independent of viewer lease lifetime.

Run adapter tests with `node --test runtime/desktop/test/adapter.test.mjs`. The real Docker/RFB integration test is `node runtime/desktop/test/integration.mjs`; it uses the dedicated `handoff-production-runtime-final-test` name and ports 18811/59091 and leaves the owned desktop available for inspection. Its artifacts go to `artifacts/browser-handoff-20261027-production/runtime` outside this package. `node runtime/desktop/test/inspect.mjs` verifies headed sandbox status, public web access, normal browser chrome, DPR/zoom, capabilities and private egress, then captures the entire X display. Test container/name/ports/image can be overridden with `DESKTOP_NAME`, `DESKTOP_CDP_PORT`, `DESKTOP_VNC_PORT` and `DESKTOP_IMAGE`.

`node runtime/desktop/test/heartbeat.mjs` uses a separate `handoff-runtime-heartbeat-test` on 18813/59093 with a one-second trusted test deadline. It proves controller loss, a stalled partial management request, held-input cleanup, exact epoch refresh, watch-input preservation, absolute expiry capping and persistent tabs/generations. That fast-timeout fixture is not a production controller endpoint.
