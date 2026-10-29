# Clawser

**Let a human take over the agent’s existing browser tab from a phone, then hand it back.**

Clawser gives OpenClaw a temporary HTTPS link to a selected tab in its already
configured default Chromium browser. Open the link in a regular mobile browser,
take control for a CAPTCHA, login or sensitive form step, then press **Done**.
The agent checks the page again and continues the pending task in that same tab.

Default setup uses the existing **OpenClaw browser connection**, which is not
automatically your everyday OS Chrome profile. It never launches another browser,
creates a Chrome user-data directory, copies cookies, guesses a CDP port or falls
back to a different browser. Keep the configured browser running.

- Selected-tab viewing through CDP screencast images, with touch scrolling,
  pinch/pan, zoom, a mobile keyboard and device paste.
- Phone controls for supported native HTML selects and classic RGB color fields.
- Explicit **Keyboard** control after tapping a cross-origin frame field; this
  grants manual keyboard input to the focused frame, not verified field autofill.
- Browser-tool coordination that keeps automation paused when human input or
  handback is uncertain. Done preserves the browser, tabs, cookies and profile.
- Optional `--novnc` setup for a dedicated Docker desktop when you need browser
  chrome, all tabs, popup switching, native OS dialogs or system clipboard access.

The recipient needs no VPN or app installation. A Cloudflare HTTPS tunnel exposes
only the authenticated viewer, never the Gateway or browser debugging endpoint.

## Install

The validated host is **Linux x86_64**, **Node.js >=24.16 <25 or >=26.1**, and
**OpenClaw 2026.10.4+** with the native trusted-tool-policy API. Native fixtures
cover 2026.10.4 and 2026.10.7. Other operating systems and ARM hosts are unverified.
Start your OpenClaw Gateway and the configured attach-only browser before setup.
Default setup needs no Docker, user systemd, `flock`, `tar` or noVNC download.

Install the tagged **v0.6.1** release from GitHub. ClawHub availability may lag
GitHub; use v0.5.0 or newer for the CDP-default behavior described here.

```sh
openclaw plugins install git:github.com/pengying/clawser@v0.6.1 --force --accept-capabilities
openclaw clawser setup --dry-run
openclaw clawser setup
openclaw clawser doctor
```

`--accept-capabilities` accepts the declared tool and trusted browser-policy
contracts through OpenClaw. Use the supported native capability-acceptance flow
for installs, updates and enabling; do not hand-write acknowledgement settings.

Setup validates the current default profile’s explicit loopback CDP origin and
`attachOnly=true`, verifies a checksum-pinned cloudflared download, configures
the viewer and reloads the plugin. Use `--browser-profile NAME` to select another
**existing configured connection** and make it the OpenClaw default; this does
not create a Chrome profile. An incompatible or unavailable connection fails
with guidance, without starting or substituting a browser.

Follow setup’s printed activation instructions, then run `doctor` and ask the
owner session to list tabs. See [installation and maintenance](docs/install.md)
for connection requirements, the optional noVNC desktop, upgrades and recovery.
The package is **`@pengying/clawser`**, the plugin ID is `browser-handoff` and the
agent tool is `browser_handoff`.

## Use it

Ask OpenClaw in your private owner conversation:

> Use my configured default browser. If you need me to log in or solve a CAPTCHA,
> send me a Clawser link for that tab and wait for me to finish.

1. Open the private link on your phone. It starts in watch mode.
2. Press **Take control** if the invitation permits it.
3. Complete the manual step and press **Done**.
4. The agent waits for safe handback and takes a fresh browser snapshot.

CDP shares the **selected tab**. Full browser UI, native OS dialogs and automatic
popup switching require the optional noVNC desktop, which shares the **entire
profile**, including all tabs, dialogs and the system clipboard during control.
Choose a browser whose contents you intend to share. noVNC offers explicit
plain-text clipboard transfer with a manual fallback, without file transfer or
automatic clipboard sync. Device paste works in CDP;
it does not synchronize or copy the remote OS clipboard. Phone autofill and
passkeys do not automatically transfer to the remote browser.

CAPTCHA, login and form completion are manual human actions. Support varies by
site and phone. The CDP viewer uses screencast images, not native video; there are
no guarantees about frame rate, network latency or a site’s automation detection.
Physical iOS Safari coverage remains unverified.

An invitation is a **one-use bearer credential**, with one viewer connection at
a time. Reopening it in the same browser can resume its valid viewer cookie;
another browser needs a new invitation. Control requires **Take control**.
Deliver links privately by default and keep them out of logs, issues, other chats
and durable agent memory.

Invitations expire after **five minutes by default**, configurable from 30 to
1800 seconds. Done, revocation or absolute expiry ends viewer access. A viewer
disconnect, such as a phone switching apps for a 2FA code, releases control and
keeps the invitation in watch mode until expiry. noVNC settles input with the
full fence first. Control needs **Take control** again.
There is **no human-inactivity timeout**. A dropped connection may take a
heartbeat interval to detect. First-link tunnel readiness can take up to 90
seconds. Ending a handoff leaves the browser, tabs, cookies and profile intact;
CDP has no browser idle-cleanup lifecycle.

CDP allows invitations for different tabs (up to 100), one invitation per same
tab, and **one human control session per Gateway**. Another takeover receives a
busy response; there is no queue. noVNC allows one active invitation per controller.
Use distinct browser connections for personal and family Gateways. Sharing one
Chrome instance across multiple Gateways is unsupported: there is no cross-process
control coordination.

## Agent tool and browser routing

Both `browser_handoff` and ordinary browser tools require a native verified owner
invocation in an authorized private conversation or explicitly allowed group.
Nonowners cannot use either route. Message text, a display name or an HTTP agent
proxy cannot establish native per-sender owner authority.

| Action | Parameters | Purpose |
| --- | --- | --- |
| `tabs` | Optional `profile` | Return available configured connections or their tabs |
| `create` | `profile`, exact `targetId`, optional `permission`, `ttlSeconds` | Create a watch/control invitation for the task tab |
| `status` | `id` | Check the handoff and completion reason |
| `wait` | `id`, optional `timeoutSeconds` (1–60) | Wait for completion or receive current status |
| `revoke` | `id` | End this owner session’s invitation |

Use the returned profile and raw target ID, not a display label such as `t1`.
Every ordinary browser call, including the handback snapshot, must use
`target: "host"` and that profile. Implicit user-profile, sandbox, node, MCP or
endpoint overrides cannot bypass this route. Missing current APIs or changed
configuration fail closed.

The bundled skill explains delivery and handback. CDP returns `backend: "cdp"`,
`scope: "tab"`, `continuation: "active-wait"`. If replies are buffered until
the turn ends, or delivery behavior is unknown, the agent ends the turn with the
link and asks you to reply after pressing Done. Active waits are used only after
link delivery is confirmed. The next owner turn checks the existing invitation:
require `mode: "ended"` with no `browserGateFault` or recovery requirement, then
take a fresh gated browser snapshot. Your message alone does not prove handback. noVNC returns `backend: "novnc"`, `scope: "browser-profile"` and
requires `resumeAllowed: true` with no recovery requirement. Ended mode alone is
insufficient. Its completion notifications are best effort. Done does not prove
that a CAPTCHA passed or a submission succeeded; never replay uncertain input.

## Owner-requested groups

Group access is off by default. An operator may allow exact base session keys in
`ownerGroupSessions`. Only a verified native owner may request a link there, and
only an explicit owner request permits returning it to that **same requesting
group/thread**. Any member can claim the one-use bearer link first. Other members
cannot invoke browser tools, request, inspect or revoke the handoff.

Runtime browser/configuration changes, including removal or changes to the group
allowlist, retire existing shares. See [group configuration](docs/install.md#owner-requested-groups)
for native-ingress requirements and exact matching rules.

## Safety and limits

Default CDP runs in the host browser’s normal OS sandbox; it adds no Docker
isolation. The optional desktop keeps Chromium’s sandbox enabled and restricts
ordinary browser egress. Neither mode guarantees containment of a compromised
browser or safety of every website.

Clawser coordinates OpenClaw’s normal browser-tool path. It does not stop
arbitrary shell commands, independent CDP clients or manual desktop operators.
Never use those routes to bypass a gate. Keep automation paused and follow
recovery guidance if input retirement or fresh observation cannot be established.

See [SECURITY.md](SECURITY.md) for the trust model and disclosure, and
[desktop runtime documentation](runtime/desktop/README.md) for the optional
noVNC implementation.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run test:runtime
npm run check:package
```

Browser fixtures require local Chrome/Chromium (`CHROME_BIN`). RFB pointer tests
also require pinned noVNC assets (`NOVNC_ASSETS_DIR`). Full Docker tests are opt-in.
See [CONTRIBUTING.md](CONTRIBUTING.md) for source installation and release checks.
Releases contain a plugin archive and SHA-256 checksums; there is no npm registry
publication step.

Licensed under [MIT](LICENSE). Third-party desktop runtime licenses are described
in [runtime/desktop/NOTICE.md](runtime/desktop/NOTICE.md).
