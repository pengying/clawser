# Host noVNC as the default handoff

## Why

Clawser's default viewer today is the CDP viewer. It streams one tab as
screencast images. Anything the browser draws outside the page never reaches
the phone: native dropdown menus, date pickers, file choosers, permission
prompts, OS dialogs and popup windows. Clawser patches dropdowns and colour
fields with phone-native sheets, but every new control type needs more custom
code, and some can never work.

noVNC shows the real browser window, so every control the browser draws works
without special code. The operator chose noVNC as the default for that reason.

The existing noVNC desktop runs a separate Chromium in Docker. That loses the
agent's logins, because Chrome's cookie encryption on Linux is tied to the
host, and the container Chromium lacks Widevine and the Google Chrome brand,
which bot checks look at. The operator chose to run noVNC against Chrome on
the host instead, on a virtual screen, and to remove the Docker flow.

Priorities, in order: reliability (the human can always finish the step), ease
of use from a phone, responsiveness.

## Decisions the operator made

1. **noVNC on the host is the default.** No Docker. The agent's Chrome runs on
   a virtual X screen (Xvfb) with a small window manager (openbox). x11vnc
   shares that screen, and the phone views it through noVNC.
2. **The CDP viewer stays as an opt-in** for people who want to share an
   existing browser one tab at a time. It is not removed.
3. **Setup option A, the default: a new profile.** Setup creates a fresh Chrome
   profile owned by Clawser, runs it on the virtual screen, and makes it the
   agent's default browser. The person signs in to sites through handoff
   links the first time.
4. **Setup option B: an existing OpenClaw browser profile.** The person names
   a profile OpenClaw already has. Setup keeps its logins, closes that Chrome
   wherever it runs now, and restarts the same profile on the virtual screen.
5. **Take over hand-written services.** When option B finds the profile
   already running on a virtual screen under user services that Clawser did
   not write, setup takes them over and manages them from then on.
6. **Upgrades switch to noVNC**, using option B with the profile the person
   already configured.
7. **Remove the Docker desktop** and everything that only exists for it.
8. **The README explains plainly how it works.**
9. **The Chrome debugging port stays on loopback TCP.** OpenClaw needs an HTTP
   `cdpUrl`. Any other local user account can connect to it and control the
   agent's browser. Blocking that needs root, so it is a documented gap in the
   README and SECURITY.md, not a fix in this release.
10. **Disruptive steps need `--yes`.** `setup --dry-run` prints exactly what
    will happen, including which logins could be lost. A real run refuses to
    stop a running Chrome, take over services or migrate cookies unless `--yes`
    is passed. There are no interactive prompts.

## Goals

- A fresh install on Linux gets a working noVNC handoff from `setup` with no
  Docker and no root.
- The agent and the phone always see the same browser, by construction.
- Watch-only links let the person see what the agent is doing at any time.
- Option B keeps the person's existing logins wherever Chrome allows it, and
  says clearly when a sign-in will be needed again.
- Upgrading from 0.6.x moves CDP installs to noVNC with one `setup` run.
- The README, install guide and SECURITY.md describe the new design accurately.

## Non-goals

- Removing the CDP viewer.
- Container isolation, an egress firewall or seccomp on the host.
- Sharing the person's real desktop session. Wayland desktops can't be read by
  x11vnc, locked screens show the lock screen, and headless servers have none.
- Installing browsers or system packages, or running `sudo`.
- macOS or ARM support.
- A separate virtual screen per agent. One Gateway gets one agent browser.
- Phone polish beyond what already shipped, such as opening the keyboard
  automatically or latency tuning. These are follow-ups.

## Anti-goals

These would make the release a failure even if it works:

- Dropping someone's logins without warning. Option B must never quietly fall
  back to a new profile.
- Letting the network reach the VNC server, the Chrome debugging port or the
  X display, or letting another local user reach the VNC server or the display.
- Touching any Chrome profile other than the one Clawser owns (option A) or the
  one the person named (option B).
- Copying, moving or recreating an existing profile directory.
- Automating CAPTCHA solving.

## How it works

```text
phone ──HTTPS──> Cloudflare tunnel ──> controller (127.0.0.1) ──> x11vnc (private socket)
                                                                       │
                                                       virtual screen (Xvfb + openbox)
                                                                       │
agent ──browser tool──> Clawser gate ──CDP (127.0.0.1)──> Chrome on that screen
```

User services, all managed by Clawser:

| Service | Runs |
| --- | --- |
| display | Xvfb on a virtual screen, 1920x1080x24, no TCP, access control on |
| window manager | openbox with Clawser's own config file |
| browser | Google Chrome, or Chromium if Chrome is absent, on that screen |
| controller | The existing Node controller and the phone gateway |
| supervisor | Starts and retires x11vnc for each viewer session |

The services come back after a reboot. That needs systemd lingering. Setup
checks it and prints `loginctl enable-linger` when it's off.

### The virtual screen

The openbox and browser details below are already applied by hand on the
operator's box; the earlier notes are on the `novnc-host-chrome` branch at
`docs/plans/2026-10-28-novnc-dedicated-browser.md`.


- Xvfb runs with `-nolisten tcp` and with X access control on, using a cookie
  file readable only by the operator. Never `-ac`. The browser, window manager,
  supervisor and x11vnc get the cookie through `XAUTHORITY`. A client without
  the cookie must be refused.
- openbox uses a config file Clawser generates under its state directory. It
  never edits the person's own openbox config. The config removes title bars,
  maximizes Chrome's main window, keeps one desktop, and removes desktop
  switching so a stray scroll from the phone can't hide Chrome. Generate it from
  `/etc/xdg/openbox/rc.xml` with an XML parser, not regular expressions. The
  desktop count survives a window-manager restart, so set it with an EWMH
  `_NET_NUMBER_OF_DESKTOPS=1` message or start the display fresh.
- openbox is recommended, not required. Without it, popups land at the top-left
  corner with no stacking. Setup warns and continues.

### The browser

- Flags: `--ozone-platform=x11`, `--password-store=basic`,
  `--ignore-gpu-blocklist`, `--window-size=1920,1080`, `--window-position=0,0`,
  `--start-maximized`, `--no-first-run`, `--no-default-browser-check`,
  `--remote-debugging-address=127.0.0.1` and a fixed loopback port recorded in
  the setup receipt.
- `--password-store=basic` means Chrome starts signed in after a reboot with
  nobody at the machine. Cookies are then protected by file permissions only,
  so the profile directory must be mode 0700.
- `--ignore-gpu-blocklist` gives a real WebGL renderer under Xvfb. Never use
  `--enable-unsafe-swiftshader`.
- Setup never installs a browser. It prefers Google Chrome and falls back to
  Chromium, and fails with a clear message when neither exists.
- **Snap Chromium is refused** with a message to install Google Chrome or a
  non-snap Chromium. Snaps can't use dot-folders in the home directory, which
  is where the state directory lives. *(Builder's call, settled in review.)*

### The viewer

- The supervisor starts one x11vnc per viewer session with a fresh password,
  `-viewonly` for watch sessions, and retires it with the existing XTEST
  settlement when the session ends. The actor model in
  `runtime/desktop/supervisor.py` stays. Only its container assumptions change.
- x11vnc listens only on a Unix socket in a 0700 directory. Verified on the
  operator's box with x11vnc 0.9.17: `-unixsock <path> -rfbport 0 -no6
  -rfbportv6 -1` leaves no TCP listener. `-rfbport 0` alone still opened
  `[::]:5900` on every interface.
- The phone gateway (`src/novnc-probe.mjs`) connects to that socket instead of
  a loopback TCP port. Today it insists on `127.0.0.1` and a port.
- The XRes identity proof and XTEST settlement move from the compiled
  `x11-proof.cpp` to Python `ctypes` calls into `libX11`, `libXtst`, `libXi` and
  `libXRes`, so hosts need no compiler. These libraries are on any desktop
  Linux.

## Setup

`openclaw clawser setup` keeps its dry-run, setup and doctor shape.

### Option A, the default

- Creates `<stateDir>/browser/profile`, mode 0700.
- Adds an attach-only OpenClaw browser profile named `clawser` that points at
  the browser service's loopback CDP port.
- Makes `clawser` the OpenClaw default profile and sets `desktop.profile` to it.
  The previous default stays in OpenClaw's config, and the receipt records it so
  the change can be undone.
- Prints that the agent's browser starts with no logins.

### Option B: `--browser-profile NAME`

- `NAME` must be an existing attach-only OpenClaw profile with a loopback CDP
  origin, as today.
- Setup finds the Chrome serving that port, and its user-data directory, from
  the process that owns the listening socket.
- **If a user service Clawser didn't write runs that Chrome** (the hand-written
  case): back up the unit files into Clawser's state directory, stop and
  disable them, and write Clawser's units with the same display number,
  profile directory and port, so OpenClaw's browser settings don't change. The
  same goes for that screen's display and window manager services.
- **Flags on a taken-over Chrome.** Keep every existing flag and environment
  variable except the ones Clawser sets: display, ozone platform, password
  store, GPU blocklist, window size and position, start-maximized, debugging
  address and port. Refuse with instructions when the existing command line has
  `--headless`, or a `--user-data-dir` or `--profile-directory` that differs from
  what OpenClaw's profile points at. Never drop `--profile-directory`.
  *(Builder's call, settled in review.)*
- **If nothing is listening on the profile's port**, setup can't find its
  directory safely. It fails with "start that browser, then rerun setup". It
  never guesses a directory. *(Builder's call, settled in review.)*
- **If that Chrome was started some other way and nothing would restart it**,
  such as from a desktop session: close it gracefully with CDP `Browser.close`,
  wait for the process to exit, then start Clawser's browser service on the same
  profile directory.
- **If something setup doesn't recognize would restart it**: stop with
  instructions. Never kill it.
- **Keyring-encrypted cookies.** Setup checks how the profile's cookies are
  encrypted, from their version prefix, without reading their values. If they
  use the desktop keyring, setup offers a one-time migration: export cookies
  over CDP before stopping Chrome, import them into the restarted Chrome, and
  let them reach disk before anything restarts it. It then tells the person to
  sign in to Google once and re-save any saved site passwords. Cookie values go
  only into a 0600 temporary file in a 0700 directory that is deleted
  afterwards, and are never logged. Without the migration, the person is told
  which logins will be lost before anything stops.
- The profile directory is never copied, moved or recreated.
- Every step that stops Chrome, replaces services or migrates cookies needs
  `--yes` (decision 10). Without it, setup prints what it would do and exits
  non-zero.

### The CDP viewer: `--cdp`

- `setup --cdp` sets up today's CDP viewer against an existing browser,
  exactly as 0.6.x does, and writes `desktop.enabled: false`.
- The receipt records that CDP was chosen explicitly.

### Upgrading from 0.6.x

OpenClaw runs no plugin steps at install time, so the switch happens on the
next `setup` run. The README's upgrade steps say to run `setup --dry-run`, then
`setup --yes`.

- **A CDP install without the explicit-CDP mark:** plain `setup` runs option B
  with the profile already configured. Until then, links keep working through
  the CDP viewer, and doctor warns: "run setup to switch to noVNC, or setup
  --cdp to keep the CDP viewer".
- **A Docker desktop install:** the old controller config fails closed after
  the upgrade, and doctor says to rerun setup. Setup then runs option A,
  because the container's profile can't move to host Chrome. It lists the
  leftover Clawser-owned Docker containers, images and volumes with the
  commands to remove them. It doesn't remove them itself.

### Host dependencies

`src/host-deps.mjs` already resolves Xvfb and x11vnc, which are required, and
openbox, which is optional. It records each path and SHA-256 and smoke-tests
the set for real. It is switched off today. This release switches it on and
adds checks for `python3` and `xclip`, which the clipboard needs. When
something is missing, setup fails with the exact distro command, for example
`sudo apt install xvfb x11vnc openbox xclip`. Doctor re-checks the recorded
hashes. A changed system or Homebrew binary tells the operator to rerun setup.
Setup no longer runs `brew install`. It still finds and records Homebrew
binaries, but it only prints the install command for anything missing, like
any other package. *(Builder's call, settled in review.)*

### Doctor

Adds checks that:
- each service is active
- the display socket exists
- Chrome's window is on the shared screen
- the CDP origin is loopback
- the profile directory is 0700
- lingering is on

It keeps the existing controller, cloudflared, noVNC asset and host-dependency
checks. A keyring-encrypted cookie store is a warning, not a failure.

## Removing the Docker flow

- Delete `runtime/desktop/Dockerfile`, `entrypoint.sh`, `chromium-seccomp.json`,
  `MOBY-LICENSE` and the Docker `DesktopRuntime` adapter in
  `runtime/desktop/index.mjs`. The controller talks to the supervisor's socket
  directly.
- Remove the Docker steps from `src/setup.mjs`: image build, container and
  volume ownership, `docker.sock`, port audit, and the `--container-name`,
  `--cdp-port` and `--vnc-port` options.
- The supervisor's status reports `browserSandbox: true` and a container
  isolation string, and the controller and recovery refuse to run without them.
  Replace those fields with ones that describe the host truthfully: Chrome's
  OS sandbox and no egress firewall. Readiness gating must keep working.
- Update the tests, CI's Docker steps, `scripts/check-package.mjs`, the
  `package.json` files list and `test:runtime`, `src/cli.mjs` help, README,
  `docs/install.md`, SECURITY.md, CONTRIBUTING.md and
  `runtime/desktop/README.md`, `PLAN.md` and `NOTICE.md`.

## README

Rewrite "How it works" for the new default, in plain words:

- The agent's Chrome runs on a virtual screen on the Gateway host, as user
  services. It is not the person's everyday browser.
- A link shows that whole browser window, every tab in it, through noVNC.
  Native dropdowns, date pickers, file choosers, dialogs and popups all work.
- Watch-only links show what the agent is doing.
- No Docker. Needs Linux x86_64, systemd user services, Xvfb, x11vnc, openbox
  (recommended), python3, xclip, and Google Chrome or Chromium. Setup installs
  none of them and prints the command for whatever is missing.
- Option A and option B, and what each means for logins.
- The CDP viewer as the opt-in, with its one-tab scope and limits.
- Upgrade steps that include running `setup`.
- Security in plain words: no container or egress firewall; Chrome's normal OS
  sandbox; the VNC server and display are private to the operator; the
  debugging port is reachable by other local user accounts, so use a machine
  you don't share; whoever opens a link sees every tab in the agent's browser.

PR #5 describes the CDP design as the default, so close it in favour of this.

## Undoing setup

No restore command in this release. The receipt records the previous default
profile and where the replaced unit files were backed up, and
`docs/install.md` gets a short manual procedure: set the old default profile
back, reinstall the backed-up units, and restart them. *(Builder's call,
settled in review.)*

## Constraints

- Distributed through ClawHub and `git:` installs. No install scripts, no root.
- Linux x86_64, Node.js >=24.16 <25 or >=26.1, OpenClaw 2026.10.4+.
- The public repo carries no personal identifiers, account names or host paths.
- No live gateway, config, service or container changes on the operator's box
  without the operator's go. Taking over the box's services restarts the
  agent's Chrome, so do it while the agent is idle.
- Release as 0.7.0, through the usual PR, tag, offline scan, ClawHub publish
  and box upgrade.

## Acceptance

- CI on stock Linux, with Xvfb, x11vnc and openbox from apt and the runner's
  preinstalled Google Chrome: option A setup, then a watch and a control session over the private
  socket, an RFB banner, and a held key released by settlement.
- Unit tests for option A and B planning, takeover, the keyring check, the
  upgrade paths and `--cdp`.
- An X client without the cookie is refused, and x11vnc has no TCP listener.
- Option B without `--yes` stops nothing and changes nothing.
- An ordinary browser call and `browser_handoff tabs` list the same target IDs,
  and a VNC frame shows that tab.
- On the operator's box, with the operator's go: option B takes over the
  three hand-written services without losing logins. Then a physical phone
  test covers a native dropdown, a date picker, a file chooser, a popup
  window, press and hold, and backgrounding the phone browser and returning.

## Left to the builder

- Unit names, the display-number search, and the state-directory layout.
- Whether the supervisor is its own service or a child of the controller, as
  long as x11vnc processes never outlive it and a supervisor restart taints
  sessions the way a container restart does today.
- Where display and browser generations come from, such as each service's
  systemd invocation ID, as long as recovery detects a restarted display or
  browser.
- How the X cookie file is generated.
- Test structure, and which `runtime/desktop/test` files are ported versus
  rewritten.
