# Clawser

**Let a human take over the agent’s browser from a phone, then hand it back.**

Clawser gives OpenClaw a temporary HTTPS link to the agent's browser. Open the
link in a regular mobile browser, take control for a CAPTCHA, login or sensitive
form step, then press **Done**. The agent checks the page again and continues
the pending task.

The recipient needs no VPN or app installation. A Cloudflare HTTPS tunnel exposes
only the authenticated viewer, never the Gateway or browser debugging endpoint.

## How it works

```text
phone ──HTTPS──> Cloudflare tunnel ──> controller (127.0.0.1)
                                            │
                                            ▼
                  supervisor ──starts──> x11vnc (private socket)
                                            │
                                    virtual screen (Xvfb + openbox)
                                                          │
agent ──browser tool──> Clawser gate ──CDP (127.0.0.1)──> Chrome on that screen
```

- **The agent has its own Chrome.** It runs on a virtual screen on the Gateway
  host, under five systemd user services that Clawser manages. It is not your
  everyday browser.
- **A link shows the whole browser.** You see the whole window and every tab in
  it, through noVNC. Native dropdowns, date pickers, file choosers, dialogs and
  popups all work.
- **Watch-only links** show what the agent is doing, without control.
- **No Docker.** Clawser needs Linux x86_64, systemd user services, Xvfb,
  x11vnc, python3, the X client libraries libX11, libXRes, libXtst and libXi,
  and Google Chrome or Chromium. openbox is recommended. Setup installs none of
  them. It prints the install command for whatever is missing.
- **Two ways to set up the browser.** Option A, the default, creates a new
  browser profile that starts with no logins. You sign in to sites through a
  handoff link the first time. Option B, `--browser-profile <name>`, takes over a
  browser profile OpenClaw already uses and keeps its logins. Setup closes that
  browser and restarts it on the virtual screen, so it needs `--yes`.
- **The CDP viewer is still available.** `setup --cdp` shares one tab of an
  existing browser instead. Dropdowns and color fields get phone controls.
  Date pickers, file choosers, dialogs, popups and browser menus don't reach the
  phone.
- **Upgrades need a setup run.** See [Upgrade](#upgrade).
- **Security, plainly.** There is no container and no network firewall around
  the browser. Chrome runs in its normal OS sandbox. Only your account can reach
  the VNC server and the virtual screen. Other accounts on the same machine can
  reach the browser's debugging port, so use a machine you don't share. Anyone
  who opens a link sees every tab in the agent's browser.

## Install

The validated host is **Linux x86_64**, **Node.js >=24.16 <25 or >=26.1**, and
**OpenClaw 2026.10.4+** with the native trusted-tool-policy API. Native fixtures
cover 2026.10.4 and 2026.10.7. Other operating systems and ARM hosts are unverified.
Start your OpenClaw Gateway before setup.

Install the tagged **v0.8.0** release from GitHub. ClawHub availability may lag
GitHub.

```sh
openclaw plugins install git:github.com/pengying/clawser@v0.8.0 --force --accept-capabilities
openclaw clawser setup --dry-run
openclaw clawser setup --yes
openclaw clawser doctor
```

`--accept-capabilities` accepts the declared tool and trusted browser-policy
contracts through OpenClaw. Use the supported native capability-acceptance flow
for installs, updates and enabling; do not hand-write acknowledgement settings.

The dry run prints exactly what setup will do and changes nothing. It shows
which browser setup will close and warns how many keyring-encrypted cookies
won't carry over. Add `--migrate-cookies` to move them. A real run refuses to
close a browser, take over services or move cookies without `--yes`.
Add `--browser-profile <name>` for option B, or `--cdp` for the CDP viewer.

Follow setup’s printed activation instructions, then run `doctor` and ask the
owner session to list tabs. See [installation and maintenance](docs/install.md)
for requirements, options A and B, keyring cookies, undoing setup and recovery.

### Upgrade

From 0.6.x, setup moves a CDP install to noVNC with the browser profile it
already uses. That profile must point at `127.0.0.1`, not `localhost`. Setup
refuses a `localhost` profile before it stops anything, and says how to fix it.
To keep the CDP viewer, run `setup --cdp` in step 3 instead. A
Docker desktop install becomes option A. Setup prints the commands that remove
its old Docker resources, and never runs them.

Finish any open handoffs, then:

1. Install the new version:

   ```sh
   openclaw plugins install git:github.com/pengying/clawser@v0.8.0 --force --accept-capabilities
   ```

2. Check the plan with `openclaw clawser setup --dry-run`.
3. Run `openclaw clawser setup --yes`.

A `git:` install moves the plugin folder, so rerun setup after every upgrade.

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

A noVNC link shares the **whole browser**: every tab, dialog and the browser's
clipboard during control. The CDP viewer shares the **selected tab**. Choose a
browser whose contents you intend to share.

Once you take control, a bar across the top of the noVNC viewer holds the
controls. Tap the page to tuck the bar away, and tap the small tab at the top
to bring it back. It comes back on its own if control ends. An amber eye means
you are watching, and a green pointer means you are in control.

In control, the center of the bar switches between **Touch** and **Trackpad**.
Touch works like a phone: tap to click, swipe to scroll, pinch to zoom, and
touch and hold, then drag, to press and drag. Trackpad moves an on-screen
pointer as you slide one finger. Tap to click at the pointer, and tap with two
fingers to right-click, for example to open Chrome's menu and choose Translate.
Tap, then touch and slide, to drag, and slide two fingers to scroll. The phone
remembers your choice. Under the **⋯** button are zoom, a Fit or 100% toggle,
and Copy and Paste.

To move text, use **Copy** and **Paste**, as on a phone. Double-tap a word, or
touch and hold, then drag, to select text. A small Copy bar appears just above
your finger and sends the selection to your phone. Touch and hold in a text
field for Paste, which sends your phone's clipboard text to that field. The bar
goes away at your next touch. Copy and Paste are also under **⋯**. When the phone blocks clipboard
access, a text box opens to copy or paste by hand. Only plain text moves. There
is no file transfer and no automatic clipboard sync. In the CDP viewer, your
phone's own paste works in a focused field, but nothing is copied back. Phone
autofill and passkeys don't transfer to the agent's browser.

CAPTCHA, login and form completion are manual human actions. Support varies by
site and phone. Neither viewer is native video; there are no guarantees about
frame rate, network latency or a site’s automation detection. Physical iOS
Safari coverage remains unverified.

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
seconds. Ending a handoff leaves the browser, tabs, cookies and profile intact.

noVNC allows one active invitation per controller. CDP allows invitations for
different tabs (up to 100), one invitation per same tab, and **one human control
session per Gateway**. Another takeover receives a busy response; there is no
queue. Use distinct browser connections for personal and family Gateways.
Sharing one Chrome instance across multiple Gateways is unsupported: there is no
cross-process control coordination.

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
Every ordinary browser call, including the handback snapshot, runs on the host
browser and that profile. A call that omits `target` is routed to the host; an
explicit sandbox or node target, another profile, MCP or endpoint overrides are
refused. Missing current APIs or changed
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

There is no container and no egress firewall. The agent's Chrome runs in its
normal OS sandbox, like any desktop Chrome. Neither viewer guarantees
containment of a compromised browser or safety of every website.

The VNC server listens only on a private socket in a folder only your account
can open. The virtual screen requires a cookie only your account can read. The
browser's debugging port listens on 127.0.0.1, where other accounts on the same
machine can reach it and control the browser. Use a machine you don't share.

Clawser coordinates OpenClaw’s normal browser-tool path. It does not stop
arbitrary shell commands, independent CDP clients or manual desktop operators.
Never use those routes to bypass a gate. Keep automation paused and follow
recovery guidance if input retirement or fresh observation cannot be established.

See [SECURITY.md](SECURITY.md) for the trust model and disclosure, and
[desktop runtime documentation](runtime/desktop/README.md) for the noVNC
implementation.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run test:desktop
npm run check:package
```

Browser fixtures require local Chrome/Chromium (`CHROME_BIN`). RFB pointer tests
also require pinned noVNC assets (`NOVNC_ASSETS_DIR`). Desktop tests skip when
Xvfb, x11vnc or python3 is missing.
See [CONTRIBUTING.md](CONTRIBUTING.md) for source installation and release checks.
Releases contain a plugin archive and SHA-256 checksums; there is no npm registry
publication step.

Licensed under [MIT](LICENSE). Third-party desktop runtime licenses are described
in [runtime/desktop/NOTICE.md](runtime/desktop/NOTICE.md).
