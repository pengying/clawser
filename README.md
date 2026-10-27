# Clawser

**Let a human take over the agent’s browser from a phone, then hand the same browser back.**

Clawser gives OpenClaw a temporary HTTPS link to a dedicated Chromium desktop.
Open it in a regular mobile browser to see tabs, the address bar, popups and native
dialogs. Take control for a CAPTCHA, login or sensitive form step, press **Done**,
and let the agent continue with the browser’s existing tabs and session.

- Full-screen viewer with movable, collapsible controls, pinch/pan and zoom buttons.
- Touch scrolling, **Drag once**, a mobile keyboard and Unicode text input.
- Plain-text clipboard transfer during control, with a manual fallback when the
  phone browser denies clipboard access. No file transfer or automatic clipboard sync.
- A persistent browser profile: finishing a handoff does not discard its cookies,
  tabs or open dialogs.
- Browser-tool coordination: human input is retired and checked before automation
  resumes; an uncertain handback keeps browser automation paused.

The recipient needs no VPN or app installation. The host runs the browser in
Docker and exposes the authenticated viewer through a Cloudflare HTTPS tunnel.

## Install

The first supported desktop release targets **Linux x86_64**, **Node.js 24.16+ on 24.x, or 26.1+** and
**OpenClaw 2026.10.4+**. The host needs Docker access, a working user systemd
session, `flock`, and outbound HTTPS. Start your OpenClaw Gateway before setup. Other operating systems and ARM hosts are
not validated for this release.

```sh
openclaw plugins install git:github.com/pengying/clawser@v0.3.1 --force --accept-capabilities
openclaw clawser setup
openclaw clawser doctor
```

The install command explicitly accepts Clawser’s declared plugin capabilities.

Setup verifies prerequisites, downloads checksum-pinned cloudflared and noVNC,
builds the browser image, installs a private user service and merges the required
OpenClaw settings. The initial image build can take several minutes. Review the
plan first with `openclaw clawser setup --dry-run`.

Setup makes the dedicated `handoff` browser profile the OpenClaw default. Use
`--no-default-profile` to keep your current default and select `handoff` explicitly
for the task. It does not import your personal browser’s cookies.

Follow the activation/reload instructions printed by setup, then run `doctor`.
See [installation and maintenance](docs/install.md) for release archives, custom
ports, upgrades, disable/uninstall and recovery.

The public project is **Clawser**. The plugin ID remains `browser-handoff`, the
agent tool remains `browser_handoff`, and the package remains
`openclaw-browser-handoff` for compatibility.

## Use it

Ask OpenClaw in your private owner conversation:

> Open the site in the handoff browser. If you need me to log in or solve a
> CAPTCHA, send me a Clawser link and wait for me to finish.

1. Open the private link on your phone. It starts in watch mode.
2. Press **Take control** if the invitation permits control.
3. Complete the manual step and press **Done**.
4. The agent takes a fresh browser observation before continuing.

The entire dedicated browser profile is shared, including its other tabs and
dialogs. Use a profile whose contents you intend the recipient to see. CAPTCHA,
login and form completion are manual human actions; support varies by site and
phone. A phone’s native autofill or passkeys do not automatically transfer into
the remote browser.

An invitation is a **bearer credential**. Deliver it privately and do not put it
in public chats, logs, issue reports or durable agent memory. One browser can
redeem it, and only one viewer connection is allowed at a time. Reopening it in
the same browser can resume its valid viewer cookie; another browser needs a new
invitation. Control always requires the explicit **Take control** button.

Invitations last **five minutes by default**, with a configurable lifetime from
30 seconds to **30 minutes**. Done, revocation, disconnect or absolute expiry
ends viewer access. There is **no human-inactivity timeout**: pausing to read a
page does not end access before the absolute deadline. A dropped connection may
take a heartbeat interval to detect. Creating a fresh tunnel can take up to
90 seconds; a link is returned only after public readiness checks.

## Safety and limits

The public HTTPS origin serves the viewer. The Gateway, local CDP endpoint, raw
VNC endpoint and controller socket must never be exposed through it. Docker
publishes CDP/VNC on loopback, and the controller uses an owner-only Unix socket.
Local Docker access remains a powerful host privilege.

During takeover, Clawser coordinates OpenClaw’s normal browser tools. It does not
stop arbitrary shell commands, independent CDP clients or a separate desktop
operator. Agents must not bypass the browser-tool gate. If input retirement or a
fresh browser observation cannot be established, keep automation paused and
follow the recovery instructions.

The dedicated Chromium runtime keeps Chromium’s sandbox enabled and restricts
ordinary browser egress. These controls do not guarantee containment of a
compromised browser or safety of every website. There are no guarantees about
mobile network latency, Cloudflare reachability or a site’s automation detection.
Physical iOS Safari coverage is still unverified.

See [SECURITY.md](SECURITY.md) for the trust model, disclosure and verification
scope, and [runtime documentation](runtime/desktop/README.md) for technical details.

## Agent tool

`browser_handoff` is available to a verified owner in private direct/main sessions.
It is unavailable to groups, unidentified callers, sandboxes and background tasks.

| Action | Parameters | Purpose |
| --- | --- | --- |
| `tabs` | Optional `profile` | List configured profiles or their browser tabs |
| `create` | `profile`, optional `targetId`, `permission`, `ttlSeconds`, `reason` | Create a private watch/control invitation |
| `status` | `id` | Check the current handoff and completion reason |
| `wait` | `id`, optional `timeoutSeconds` (1–60) | Wait for completion or receive current status |
| `revoke` | `id` | End this owner session’s invitation |

Use raw target IDs returned by `tabs`, not OpenClaw display labels such as `t1`.
The bundled skill guides the agent through private delivery, waiting and a fresh
browser snapshot after handback. Best-effort completion notifications may help
resume a dormant session; they do not guarantee recovery across process crashes.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run test:runtime
npm run check:package
```

Browser fixtures require a local Chrome/Chromium executable (`CHROME_BIN`). The
RFB pointer tests also require the pinned noVNC assets (`NOVNC_ASSETS_DIR`); CI
downloads and checks them before testing. Full Docker runtime tests are opt-in.
See [CONTRIBUTING.md](CONTRIBUTING.md) for source installation, test commands and
release checks. Releases contain a plugin archive and SHA-256 checksums; there is
no npm registry publication step.

Licensed under [MIT](LICENSE). Third-party runtime licenses are described in
[runtime/desktop/NOTICE.md](runtime/desktop/NOTICE.md).
