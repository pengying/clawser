# Security

## Reporting a vulnerability

Use [GitHub’s private vulnerability reporting form](https://github.com/pengying/clawser/security/advisories/new)
when it is available. Include the affected version, a minimal reproduction using
a disposable profile, the expected authorization boundary and the observed
behavior. If private reporting is unavailable, open a public issue asking for a
private reporting channel without publishing exploit details or credentials.

Do not attach invitation URLs, viewer cookies, VNC passwords, browser profiles,
private controller files, Gateway credentials, screenshots of signed-in pages or
unredacted session logs. There is no promised response time or bug bounty.

## Trust model

Clawser lets a verified native OpenClaw owner delegate temporary browser viewing
or control. By default a link shares the agent's whole browser through noVNC.
Whoever opens it sees every tab, the browser menus, dialogs and, during control,
the browser's clipboard. The `--cdp` viewer shares one selected tab instead.
A human can act with the authority of accounts signed into the shared browser.
The agent's browser is not the operator's everyday browser. Keep browsers for
unrelated personal and family use separate.

Invitation URLs are bearer credentials with one-use redemption, one concurrent
viewer and a fixed expiry. Watch-only invitations cannot promote to control.
Control invitations begin in watch mode and require explicit takeover. Reopening
a link in the same browser may reuse its authenticated cookie until the original
expiry; it does not renew the lifetime. The default lifetime is 300 seconds,
configurable from 30 to 1800 seconds. There is no human-inactivity timeout.
Done, revocation or absolute expiry retires viewer access while preserving the
browser, tabs, cookies and profile. A viewer disconnect releases control but
keeps the same viewer cookie valid in watch mode until the original expiry.
noVNC first fences and settles input exactly as retirement does. Control again
requires explicit takeover.

Private owner conversations are the default. Exact `ownerGroupSessions` entries
may authorize native verified owner turns in groups. Only an explicit owner
request permits delivery to that same requesting group/thread, where any member
can claim the bearer link first. Nonowners cannot invoke `browser_handoff` or
ordinary browser tools. Message text and tool arguments never establish owner
identity. Shared-admin HTTP agent proxies cannot establish per-sender authority.

Service generations bind to current browser and plugin configuration. A changed
binding, unavailable current configuration or changed group allowlist retires
existing shares and fails closed. Checks occur on requests, input and frames;
an idle noVNC service also polls at one-second intervals. Removing a group entry
therefore retires its existing shares as well as denying future calls. A
configuration change does not turn an already performed website action back.

The Cloudflare HTTPS tunnel serves the authenticated viewer only. Its public URL
is not itself an authorization boundary; Cloudflare is part of the transport
trust boundary. Never expose the Gateway, CDP, raw VNC or controller socket through
the viewer origin.

## Host boundaries

- **No container and no egress firewall.** The agent's Chrome runs on the host
  as a user service, in Chrome's normal OS sandbox. Nothing restricts which
  sites or networks it can reach.
- **The VNC server and the virtual screen are private to the operator.** Each
  viewer session gets its own x11vnc. It listens only on a Unix socket inside a
  0700 folder, and never on a network port. The virtual screen accepts no
  network connections. Programs need an X cookie, which only the operator can
  read, to draw on it or read it.
- **Other local accounts can reach the debugging port.** Chrome's debugging
  port listens on 127.0.0.1, because OpenClaw connects to it over HTTP. Any
  other account on the same machine can connect to it and control the agent's
  browser. Blocking that needs root, so it is not fixed in this release. Use a
  machine you don't share.
- **A link shows every tab.** Whoever opens a noVNC link sees every tab in the
  agent's browser, not just the one the agent was using.
- **Cookies are protected by file permissions only.** Clawser's browser uses
  Chrome's basic password store, so it starts signed in after a reboot with
  nobody at the machine. Cookies are stored unencrypted on disk. The profile
  folder must be 0700. Setup refuses a looser option B folder, and doctor
  checks it.
- **Moving keyring cookies is opt-in.** Option B leaves them in the keyring
  unless setup runs with `--migrate-cookies`.
- **A kept cookie export is plaintext.** With `--migrate-cookies`, option B
  moves keyring cookies through an export file in a `<stateDir>/cookies-*`
  folder. The file is 0600 inside a 0700 folder. Setup removes it once an import succeeds. A failed import keeps
  it so a rerun can try again. Doctor reports it until then. Cookie values never
  appear in logs or messages.

Setup touches only three browser profiles: the one Clawser created, the one
named with `--browser-profile`, and, on an upgrade from the CDP viewer, the
profile that viewer already used. It never copies, moves or recreates a
profile folder. It closes a browser or takes over services it didn't write only
with `--yes`. It moves cookies only with both `--yes` and `--migrate-cookies`.

Local access to the operator's account remains trusted and can bypass every
control here.

The CDP viewer attaches only to an explicitly configured loopback Chromium CDP
origin with `attachOnly=true`. It never launches Chrome, creates a Chrome
user-data directory, copies cookies, guesses ports or substitutes another
browser. It does not own the Chrome process and has no idle browser cleanup.

## Browser and handback boundaries

Native trusted-tool policy restricts ordinary browser tools to verified owner
invocations, `target="host"` and an allowed configured profile. Browser startup,
profile creation, sandbox/node routes and endpoint/MCP overrides are denied.
Install, update and enable through OpenClaw’s native `--accept-capabilities` flow;
never fabricate capability acknowledgement settings. Missing native APIs,
uncertain admission and current configuration drift fail closed.

CDP completion requires ended mode without a browser gate fault or recovery
requirement, followed by a fresh gated browser observation. noVNC additionally
requires `resumeAllowed=true`: its controller fences incoming human input,
retires the input actor and verifies process/X-client and held-input state.
Uncertain settlement keeps automation blocked. These checks do not prove that
previous browser events, navigation, downloads or remote requests have finished.
Do not retry or replay an uncertain input operation.

Passive CDP field metadata does not collect field values. An explicit **Keyboard** request
after tapping an opaque or out-of-process iframe grants manual keyboard authority
to the focused frame, not verified field-level input. Capabilities are revoked on
stale state, navigation or loss of control. Browser events are not atomic with
site focus or navigation changes. In the CDP viewer, supported native HTML
selects and classic RGB color fields have phone controls; full native OS
dialogs and browser UI require noVNC. CDP device paste does not synchronize or
copy the remote clipboard.

CDP supports separate invitations for different tabs, one invite per same tab,
and one human control session per Gateway. noVNC permits one active invitation
per controller. Neither queues competing control. Multiple Gateways sharing one
Chrome instance are unsupported because their control fences are not coordinated
across processes; use distinct browser connections.

Coordination covers OpenClaw’s normal browser-tool path. It does not suspend
arbitrary shell tools, independent CDP clients or manual desktop operators. Never
use another route around the gate. A host/browser compromise, browser exploit,
malicious dependency or malicious website may exceed tested boundaries. CAPTCHA
and authentication steps remain manual human actions; there is no stealth or
challenge-acceptance guarantee.

## Supported versions and verification

Security fixes target the latest tagged release. The validated platform is Linux
x86_64 with Node.js >=24.16 <25 or >=26.1 and OpenClaw 2026.10.4+ with the native
trusted-tool-policy SDK. Native fixtures cover 2026.10.4 and 2026.10.7. The
noVNC default also requires systemd user services, `flock`, `tar`, Xvfb,
x11vnc and python3. Other host architectures and operating systems remain
unverified.

Review and targeted tests cover authorization, runtime/controller ownership,
invitation lifecycle, browser admission and handback. They are not penetration
tests, independent certification or a guarantee that vulnerabilities do not
remain. CI uses disposable browser fixtures, and a separate job runs a real
host setup with user services on a disposable runner. CI does not test every
physical phone. Physical iOS Safari coverage is unverified. CDP renders
screencast images rather than native video, without a latency or frame-rate
guarantee.

Setup pins cloudflared and noVNC and verifies their SHA-256 checksums. The CDP
viewer downloads only cloudflared. Setup records the path and SHA-256 of Xvfb,
x11vnc, openbox and python3, and doctor rechecks them. Doctor is read-only.
Checksums detect changes relative to the published file; they are not an
independent publisher signature.
