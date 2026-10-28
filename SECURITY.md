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
or control. Default CDP shares a selected tab in the configured existing host
browser. Optional noVNC shares an entire dedicated Chromium profile: every tab,
browser chrome, dialog and system clipboard during control may be exposed.
A human can act with the authority of accounts signed into the shared browser.
The OpenClaw connection is not automatically the operator’s everyday OS Chrome
profile. Keep browsers for unrelated personal and family use separate.

Invitation URLs are bearer credentials with one-use redemption, one concurrent
viewer and a fixed expiry. Watch-only invitations cannot promote to control.
Control invitations begin in watch mode and require explicit takeover. Reopening
a link in the same browser may reuse its authenticated cookie until the original
expiry; it does not renew the lifetime. The default lifetime is 300 seconds,
configurable from 30 to 1800 seconds. There is no human-inactivity timeout.
Done, revocation, disconnect or absolute expiry retires viewer access while
preserving the browser, tabs, cookies and profile.

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
the viewer origin. Keep CDP/VNC on loopback and controller sockets/state private
to the host user.

## Browser and handback boundaries

Default setup attaches only to an explicitly configured loopback Chromium CDP
origin with `attachOnly=true`. It never launches Chrome, creates a Chrome
user-data directory, copies cookies, guesses ports or substitutes another browser.
The host browser uses its normal OS sandbox; CDP mode adds no Docker isolation.
It does not own the Chrome process and has no idle browser cleanup.

The optional noVNC Docker runtime uses a dedicated profile volume, Chromium’s
sandbox, restricted capabilities, a read-only root filesystem and network
restrictions. It does not mount the host home directory or Docker socket into
the browser container. Local Docker access and the OpenClaw host account remain
trusted and capable of bypassing these controls. Switching `desktop.enabled`
does not adopt or delete existing Docker resources; ownership receipts and source
identity remain mandatory for desktop maintenance.

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
site focus or navigation changes. Supported native HTML selects and classic RGB
color fields have phone controls; full native OS dialogs and browser UI require
noVNC. CDP device paste does not synchronize or copy the remote OS clipboard.

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
trusted-tool-policy SDK. Native fixtures cover 2026.10.4 and 2026.10.7. noVNC
additionally requires local Docker, user systemd, `flock` and `tar`. Other host
architectures and operating systems remain unverified.

Review and targeted tests cover authorization, runtime/controller ownership,
invitation lifecycle, browser admission and handback. They are not penetration
tests, independent certification or a guarantee that vulnerabilities do not
remain. CI uses disposable browser fixtures and runtime adapters; ordinary CI
does not run the complete Docker desktop or test every physical phone. Physical
iOS Safari coverage is unverified. CDP renders screencast images rather than
native video, without a latency or frame-rate guarantee.

Setup pins cloudflared and verifies its SHA-256 checksum. Only `--novnc` also
downloads pinned noVNC and builds the browser image. Managed CDP doctor is read-only
and checks receipt ownership, executable/checksummed cloudflared, current browser
binding, CDP, local viewer and public tunnel readiness. Checksums detect changes
relative to the published file; they are not an independent publisher signature.
