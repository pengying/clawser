# Install and maintain Clawser

## Supported host

The validated platform is Linux x86_64, Node.js >=24.16 <25 or >=26.1, and
OpenClaw 2026.10.4+ with its native trusted-tool-policy SDK. Native fixtures cover
2026.10.4 and 2026.10.7. Windows, macOS and ARM hosts remain unverified.
Run setup as the OpenClaw user, without `sudo`, with the same OpenClaw
state/config environment used by the Gateway. Start the Gateway first.

## Requirements

The default setup gives the agent its own browser on a private virtual screen.
The host needs:

- systemd user services, `flock` and `tar`
- Xvfb, x11vnc and python3
- the X client libraries libX11, libXRes, libXtst and libXi
- openbox, which is recommended but not required
- Google Chrome, or a Chromium that isn't a snap
- outbound HTTPS for the pinned cloudflared and noVNC downloads and the tunnel

Clawser needs no Docker and no root. Setup installs nothing. When something is
missing, it stops and prints the install command for your distribution. Ask the
machine's owner to run it, then rerun setup. These are the packages:

| Package manager | Command |
| --- | --- |
| apt | `sudo apt install xvfb x11vnc openbox python3 libx11-6 libxres1 libxtst6 libxi6` |
| dnf | `sudo dnf install xorg-x11-server-Xvfb x11vnc openbox python3 libX11 libXres libXtst libXi` |
| pacman | `sudo pacman -S xorg-server-xvfb x11vnc openbox python libx11 libxres libxtst libxi` |
| zypper | `sudo zypper install xorg-x11-server-Xvfb x11vnc openbox python3 libX11-6 libXRes1 libXtst6 libXi6` |
| apk | `sudo apk add xvfb x11vnc openbox python3 libx11 libxres libxtst libxi` |

Most desktops already have the four X client libraries. Setup prints only the
packages that are missing. Without openbox, setup warns
and continues. Popups and dialogs then open in the top-left corner without
stacking. Setup never installs a browser. It refuses a snap Chromium, because a
snap can't use the hidden folder where Clawser keeps its files.

The `--cdp` viewer needs only Node, OpenClaw, an already running Chromium with
a loopback CDP connection, and outbound HTTPS. See
[the CDP viewer](#the-cdp-viewer).

### For agents installing Clawser

1. Run `openclaw clawser setup --dry-run` first.
2. If it prints an install command, give it to the owner verbatim and wait.
   Never run `sudo` or a system package manager yourself.
3. Rerun setup after the owner confirms the install.
4. Never install a browser.

## Tagged Git installation

This guide describes v0.7.0. Tagged Git installation is the recommended
distribution path.

```sh
openclaw plugins install git:github.com/pengying/clawser@v0.7.0 --force --accept-capabilities
openclaw clawser setup --dry-run
openclaw clawser setup --yes
openclaw clawser doctor
```

The package is `@pengying/clawser`, the plugin ID is `browser-handoff`, and the
command is `openclaw clawser`. `--force` confirms native Git installation or
replacement. `--accept-capabilities` accepts the declared tool and trusted
browser-policy contracts. Installs, updates and enabling must use a supported
native command with `--accept-capabilities`; never hand-write acknowledgement
settings to make a contract warning disappear. Review the installation output
and follow its activation guidance.

OpenClaw puts each Git tag in its own folder. Clawser's user services point at
that folder, so rerun setup after every upgrade. See [Upgrade](#upgrade).

Check the [ClawHub package page](https://clawhub.ai/pengying/plugins/clawser)
for approved registry versions. ClawHub may lag GitHub.

## Choose the agent's browser

Setup has two options. Both run the agent's browser on the virtual screen.

### Option A: a new browser profile

This is the default. On a fresh install, plain `setup` creates a new, empty
Chrome profile that belongs to Clawser. On a 0.6.x CDP install, plain `setup`
takes over the CDP viewer's profile instead. See
[Upgrading from 0.6.x](#upgrading-from-06x). It adds an OpenClaw browser profile named `clawser` and
makes it the default. The previous default stays in OpenClaw's configuration.

The new browser starts with no logins. Sign in to sites from a handoff link the
first time the agent needs them.

### Option B: an existing browser profile

`setup --browser-profile <name>` hands a browser profile that OpenClaw already
has to Clawser. The profile must be attach-only, with a loopback CDP address,
and its browser must be running. Setup finds that browser through its CDP port.
It keeps the same profile folder and port, so the logins stay. It never copies,
moves or recreates the profile folder.

How setup moves that browser onto the virtual screen depends on what runs it:

- **Started from a desktop session.** Setup closes it gracefully and starts
  Clawser's browser service on the same profile.
- **Run by user services Clawser didn't write.** Setup backs up their unit files,
  then stops and disables them. It writes its own services with the same display
  number, profile folder and port.
- **Run by something setup doesn't recognize.** Setup stops with instructions and
  never kills it.

Setup refuses a headless browser, and a browser started without an absolute
`--user-data-dir`. A rerun refuses a browser whose profile folder changed since
setup. If nothing is listening on the profile's port, start that browser, then
rerun setup.

### Keyring cookies

Chrome on a Linux desktop often encrypts cookies with the desktop keyring.
Clawser's browser keeps cookies in a plain store protected by file permissions,
because nobody is at the machine to unlock a keyring after a reboot. It can't
read keyring cookies.

When option B finds keyring cookies, setup moves them by default. It exports
them over CDP before it stops the browser, then imports them into Clawser's
browser. After a move, sign in to Google once in a handoff link, and re-save any
saved site passwords. Use `--no-migrate-cookies` to skip the move. Setup then
warns how many cookies will be unreadable.

If setup can't read the cookies, it stops before closing anything:

```text
Could not read cookies from the running browser (<reason>). Nothing was stopped; rerun setup, or use --no-migrate-cookies.
```

If the import fails, setup finishes and prints:

```text
Warning: Moving cookies failed (<reason>); rerun setup to try again, or sign in again to sites that ask.
```

The export then stays in a private folder under the state directory. A rerun
imports it and removes it. Until then, doctor reports it in the `cookie export`
row.

### The CDP viewer

`setup --cdp` keeps the older viewer instead. It attaches to an existing,
already running browser through OpenClaw's configured CDP connection, and
shares one tab as screencast images. It never launches a browser. Dropdowns and
color fields get phone controls, but date pickers, file choosers, dialogs,
popups and browser menus don't reach the phone. See [CDP viewer
setup](#cdp-viewer-setup).

## Dry run and `--yes`

`setup --dry-run` prints the plan and changes nothing. The plan uses these lines:

```text
Browser profile: clawser (new and empty, at <stateDir>/browser/profile)
Browser profile: <name> (existing, at <profile folder>)
Browser profile: <name> (existing, at <profile folder>, folder <profile-directory>)
Display: :<number>
Browser: <path to Chrome>
Take over <unit> (its unit file is backed up first)
Stop <unit> again (Clawser replaced it)
Close the browser running in your desktop session (pid <pid>)
Move <count> keyring-encrypted cookies into the new browser
Move the cookies an earlier setup run saved into the new browser
Write <unit or file>
Start <unit>
Restart <unit>
Default browser profile: <previous> → <profile>
Default browser profile: <profile> (unchanged)
Warning: <message>
No files, downloads, services, or configuration were changed.
```

Only the lines that apply appear. An upgrade from a Docker desktop also prints
`Stop the Docker-era controller <unit>`. It then prints `Run yourself afterwards:`
before each command that removes the old container, network, volume and image.
Setup never runs those commands.

A real run needs `--yes` before it closes the agent's browser, takes over
services it didn't write, or moves cookies. Without `--yes`, it prints the plan,
then:

```text
This closes the agent's browser. Rerun with --yes to go ahead.
```

It changes nothing and exits with an error. There are no prompts.

## Services and linger

Setup writes five systemd user services, named `clawser-<role>-<hash>.service`.
The roles are `display`, `wm`, `browser`, `supervisor` and `desktop`. The hash
comes from the state directory. Setup and doctor print the exact names.

| Service | What it runs |
| --- | --- |
| display | Xvfb, a 1920x1080 virtual screen that listens on no network port |
| wm | openbox, with a config file Clawser generates |
| browser | the agent's Chrome on that screen |
| supervisor | one short-lived x11vnc per viewer session, on a private socket |
| desktop | the controller and the phone viewer |

The `wm` service is left out when openbox is unavailable. User services stop
when you log out unless lingering is on. When it's off, setup and doctor say:

```text
Linger is off, so these services stop when you log out. Run: loginctl enable-linger
```

## Setup options

```sh
openclaw clawser setup --help
openclaw clawser doctor --help
```

| Option | Default | Purpose |
| --- | --- | --- |
| `--dry-run` | Off | Print the plan without changing files, downloads, services or configuration |
| `--yes` | Off | Allow setup to close or take over the agent's browser and move cookies |
| `--browser-profile NAME` | `clawser`, a new profile | Option B: hand an existing OpenClaw browser profile to Clawser |
| `--no-migrate-cookies` | Off | Don't move keyring cookies into the agent's browser |
| `--state-dir PATH` | `${OPENCLAW_STATE_DIR:-~/.openclaw}/clawser` | Private state, receipts, profile and downloads |
| `--port PORT` | `19420` | Loopback controller and viewer port |
| `--cdp` | Off | Use the one-tab CDP viewer on an existing browser |
| `--novnc` | Default | Use the private virtual screen |

Use the same state directory for setup and doctor. Setup refuses a state
directory whose socket paths would be longer than 107 bytes. For a new profile,
the first setup picks the first free CDP port from 18820 to 18829 and records
it. Option B keeps the profile's own port. Setup refuses to start when another program
holds the CDP port or the controller port, and it names that program.

The `--container-name`, `--cdp-port`, `--vnc-port` and `--no-default-profile`
flags were removed in 0.7.0.

## Activation and doctor

Setup waits for a new matching active Gateway generation and local viewer readiness.
OpenClaw may briefly report `awaiting-commit` while a hot reload publishes its
configuration; browser tools remain unavailable during that transition. A successful
reload command alone does not prove activation. `doctor` reports the activation
phase, selected browser identity and public transport state. `active` with public
transport `warming` means the local service is ready while Cloudflare finishes
starting; creating a link waits for public readiness. A terminal activation failure
requires correcting the reported problem and reloading the plugin.

Follow setup's printed activation/reload instructions, then run:

```sh
openclaw plugins reload browser-handoff --wait
openclaw clawser doctor
```

Doctor is read-only. On a noVNC install it prints one row per check:

| Row | Checks |
| --- | --- |
| `platform`, `node`, `source paths`, `tar`, `flock`, `systemd user`, `openclaw` | Host prerequisites |
| `installation` | Clawser owns this state directory |
| `ownership` | The state directory and unit folder haven't moved |
| `configuration` | OpenClaw's browser and plugin settings match setup |
| `pinned assets` | cloudflared and noVNC still match their checksums |
| `host dependencies` | Xvfb, x11vnc, openbox and python3 are unchanged since setup |
| `window manager` | A warning when openbox is unavailable |
| `services` | Every Clawser service is active |
| `display` | The virtual screen is up |
| `browser window` | Chrome has a window on that screen |
| `CDP origin` | The browser profile still points at Clawser's browser |
| `profile directory` | The profile folder exists and only you can read it |
| `linger` | Lingering is on |
| `units current` | The unit files match what setup would write now |
| `controller health` | The controller is ready |
| `Gateway activation` | OpenClaw is running this setup |
| `cookie store` | Option B only: a warning when keyring cookies remain |
| `cookie export` | Option B only: a warning when a saved cookie export is waiting |

After the rows, doctor prints each unit name, the state directory and the
display. A `units current` failure that says "the plugin moved" means an
upgrade installed Clawser in a new folder. Rerun setup. A `CDP origin` failure
says to restore the profile, then rerun setup.

Before browser work, ask the verified owner session to call `browser_handoff`
with `action=tabs`; confirm the returned profile and expected task tab.

Every ordinary browser call runs on the host with the returned profile. A call
that omits `target` is routed to the host; any other target is refused.
Use the raw target ID from the tab list, never an OpenClaw display label like
`t1`. Startup/profile-management actions and sandbox, node, user-profile,
endpoint or MCP routing escapes are unavailable. Missing native APIs or current
configuration drift fail closed.

If plugin CLI registration is unavailable before activation, locate its directory
with `openclaw plugins inspect browser-handoff` and use the installed entry point:

```sh
node /absolute/path/to/installed-plugin/bin/clawser.mjs setup --dry-run
node /absolute/path/to/installed-plugin/bin/clawser.mjs setup --yes
node /absolute/path/to/installed-plugin/bin/clawser.mjs doctor
```

Replace the example path with the inspected installation location. This does not
replace the native capability-acceptance step. Developer installation is in
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Release archive alternative

Once published, download `pengying-clawser-0.7.0.tgz` and `SHA256SUMS` from the
[v0.7.0 release](https://github.com/pengying/clawser/releases/tag/v0.7.0) into the
same directory:

```sh
sha256sum --check SHA256SUMS
openclaw plugins install ./pengying-clawser-0.7.0.tgz --force --accept-capabilities
openclaw clawser setup --dry-run
openclaw clawser setup --yes
openclaw clawser doctor
```

The archive contains plugin/runtime source and viewer assets, not your browser
profile, a prebuilt browser or downloaded cloudflared/noVNC. Obtain the archive
and checksums from the intended release. Checksums verify against that published
file; they are not an independent publisher signature.

## Upgrade

1. Finish handoffs and pause browser work.
2. Install the new release:

   ```sh
   openclaw plugins install git:github.com/pengying/clawser@v0.7.0 --force --accept-capabilities
   ```

3. Check the plan:

   ```sh
   openclaw clawser setup --dry-run
   ```

4. Run setup:

   ```sh
   openclaw clawser setup --yes
   ```

5. Run `openclaw clawser doctor` and the owner-session tabs check before
   resuming browser work.

A `git:` install moves the plugin folder, so rerun setup after every upgrade.
The rerun points the services at the new folder. It restarts only the supervisor
and controller, never the display or the browser.

### Upgrading from 0.6.x

OpenClaw runs no plugin steps at install time, so the switch happens on the
next setup run.

- **A CDP install.** Links keep working through the CDP viewer until you rerun
  setup. Doctor warns "run setup to switch to noVNC, or setup --cdp to keep the
  CDP viewer". Plain setup then runs option B with the browser profile the CDP
  viewer already uses. Run `setup --cdp` to keep the CDP viewer.
- **A Docker desktop install.** Links stop working after the upgrade, and doctor
  says to rerun setup. Setup converts it to option A, because the container's
  profile can't move to Chrome on the host. It prints the commands that remove
  the old container, network, volume and image, and never runs them.

## Undoing setup

There is no restore command. Setup keeps a receipt at `<stateDir>/setup.json`.
Its `previousDefaultProfile` field holds the OpenClaw default before setup. Each
entry in its `replaced` list names a unit setup took over, and its `backup` field
is the folder holding the copy. Doctor prints the exact Clawser unit names.

1. Set the previous default profile back:

   ```sh
   openclaw config set browser.defaultProfile <previousDefaultProfile>
   ```

   If `previousDefaultProfile` is `null`, there was no default. Remove the
   setting instead. OpenClaw's config patch deletes a key set to `null`:

   ```sh
   printf '%s\n' '{"browser":{"defaultProfile":null}}' | openclaw config patch --stdin
   ```

2. Stop and disable Clawser's five services:

   ```sh
   systemctl --user disable --now clawser-display-<hash>.service clawser-wm-<hash>.service clawser-browser-<hash>.service clawser-supervisor-<hash>.service clawser-desktop-<hash>.service
   ```

3. If setup took over services, restart them. Setup only stopped and disabled
   them. Their unit files are still in place. Re-enable only the units whose
   `replaced[].wasEnabled` is `true`:

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now <each unit whose wasEnabled is true>
   ```

   The `replaced[].backup` folder holds copies, in case an original was later
   changed or removed. To restore one, copy it and any `<unit>.d` folder of
   drop-ins into the receipt's `unitDir`, usually `~/.config/systemd/user`.
   Then run `systemctl --user daemon-reload` again.

4. Turn off the noVNC handoff. Either run
   `openclaw config set plugins.entries.browser-handoff.config.desktop.enabled false`,
   or run `openclaw clawser setup --cdp`.

Then reload the plugin and run doctor. Undoing setup leaves the profile folder
and its logins in place.

## Disable or uninstall while keeping data

Finish handoffs and pause automation. On a noVNC install, first follow steps 1
and 2 of [Undoing setup](#undoing-setup). That stops Clawser's five services
before the plugin folder goes, so they can't restart against a deleted folder.
Then disable and uninstall the plugin:

```sh
openclaw plugins disable browser-handoff
openclaw plugins uninstall browser-handoff --dry-run
openclaw plugins uninstall browser-handoff
```

Uninstalling leaves Clawser's state directory and browser profile in place.
CDP disable/uninstall does not own, stop or delete Chrome or its tabs/cookies.
Keep private receipts and browser data for recovery. Select an intended
OpenClaw default before unrelated browser work; disabling does not change it.

## CDP viewer setup

The CDP viewer reuses an existing configured browser connection. Configure an
existing Chromium connection with an explicit loopback HTTP CDP origin and
`attachOnly=true`, then keep that browser running. For example, this **host
browser configuration** describes a connection that must already exist:

```json
{
  "browser": {
    "defaultProfile": "existing",
    "profiles": {
      "existing": {
        "driver": "openclaw",
        "engine": "chromium",
        "attachOnly": true,
        "cdpUrl": "http://127.0.0.1:19222"
      }
    }
  }
}
```

The name and port are examples; use the operator's actual configured connection.
A CDP origin cannot contain credentials, paths, queries or fragments. It must
match any configured CDP port. Custom MCP connection overrides are unsupported.
Setup verifies the Chromium `/json/version` endpoint. It never launches Chrome,
creates a Chrome user-data directory, copies cookies, guesses ports or falls
back to another browser. Missing or incompatible connections fail with guidance.

```sh
openclaw clawser setup --cdp --dry-run
openclaw clawser setup --cdp
openclaw clawser doctor
```

Add `--browser-profile NAME` to select another existing connection and make it
the OpenClaw default. This selects an OpenClaw connection; it does not create a
browser profile on disk. Setup replaces Clawser's share mappings with that one
selected connection, disables the noVNC handoff, configures the authenticated
Cloudflare viewer and preserves unrelated settings. It downloads cloudflared
2026.10.4 with a pinned SHA-256 checksum, then reloads the plugin. It does not
own the Chrome process.

The CDP state directory is `${OPENCLAW_STATE_DIR:-~/.openclaw}/clawser-cdp`,
containing its ownership receipt (`setup.json`) and verified `bin/cloudflared`.
Its viewer port defaults to the existing plugin port, otherwise `18796`. Runtime
tunnel state is kept under OpenClaw's private `browser-handoff` state. Keep
receipts private and intact.

Doctor follows the active backend. With the noVNC handoff off, it runs the CDP
checks: prerequisites, receipt ownership, pinned cloudflared, the current
profile and CDP binding, Chromium reachability, the local viewer, and the
public tunnel. A first setup rejects a busy viewer port. A repeat run permits
the busy port only with a completed matching receipt, verified binary, current
matching configuration and healthy local viewer. Do not delete receipts or
adopt an unrelated listener to bypass a conflict.

## Owner-requested groups

Group access defaults to `ownerGroupSessions: []` in both modes. Configure exact
trusted base session keys under `plugins.entries.browser-handoff.config`, for
example:

```json
{
  "ownerGroupSessions": [
    "agent:example:googlechat:channel:0123456789abcdef01234567"
  ]
}
```

The value is a placeholder, not a personal identifier. Copy actual keys from
trusted operator session metadata, without wildcards or thread entries. Google
Chat permits its base's `:thread:<24 lowercase hex>` suffix; other channels match
the base exactly. Never infer authority from message text, names or email.

Enable only with authenticated native per-message sender identity:
`senderIsOwner=true`, trusted `requesterSenderId` and `nativeChannelId`, and a
current nonsandboxed V2 invocation with valid session key/incarnation. Native
user turns may omit provenance (the SDK external-user default) or explicitly
use `kind=external_user`. Explicit automated provenance, subagents, cron, hooks
and heartbeat turns remain denied. A shared-admin HTTP agent proxy does not
establish per-sender ownership. Ordinary browser tools also require a complete
current native verified owner invocation.

Authenticated administrative API turns may use ordinary browser tools in an
exact `agent:<agent>:main` session when the native requester has
`senderIsOwner=true`, channel `webchat`, and no sender ID property. A supplied
malformed sender ID or contradictory host channel is rejected. This authority
comes from the authenticated API principal's `operator.admin` scope; human
attribution and group ownership still require native per-sender identity. The
complete native lifecycle, active browser binding, profile routing and handoff
fence continue to apply.

Only the owner's explicit request authorizes returning a link to that **same
requesting group/thread**. Disclose that any member can claim its one-use bearer
URL first. Other members cannot invoke browser tools or create, inspect, wait on
or revoke handoffs. Ownership remains bound to the requesting session and
incarnation. Do not post links elsewhere, in logs or durable memory.

Browser/plugin configuration drift, including changes to `ownerGroupSessions`,
retires old shares and denies further access until restart/reconciliation.
Checks run on requests/input/frames, with one-second idle polling for noVNC.

CDP permits invitations to different tabs (up to 100), one per same tab and one
human control session per Gateway. noVNC permits one active invite per controller.
Competing control is busy, never queued. Use distinct browser connections for
personal and family Gateways; one Chrome instance across Gateways is unsupported.
The gate covers normal OpenClaw browser tools, not shell commands or independent
CDP/manual desktop operators.

## Manual CDP transport configuration

For operator-managed connections without managed setup, leave `desktop.enabled`
false or absent. The default eligible host connection is included automatically;
optional plugin `profiles` mappings must exactly match eligible host connections.
A manually installed trusted cloudflared can be configured with:

```json
{
  "desktop": { "enabled": false },
  "port": 18796,
  "cloudflare": {
    "enabled": true,
    "binaryPath": "/opt/cloudflared/bin/cloudflared",
    "startupTimeoutMs": 90000
  }
}
```

Install/verify the binary as the operator. `binaryPath` must be absolute.
Cloudflare is mutually exclusive with Funnel; its startup timeout accepts
1000–180000 ms. Tunnel allocation warms after the listener starts; invitation
creation waits for public DNS/asset readiness. A tunnel failure retires viewer
access. Never expose CDP, the Gateway or raw VNC. Managed CDP doctor requires its
own setup receipt and is not an adoption tool for manual installations.

## Recovery and troubleshooting

- **Missing package:** setup prints the install command for your distribution.
  Ask the owner to run it, then rerun setup. Never run `sudo` from the agent.
- **A service is down:** doctor names it. Inspect it with
  `journalctl --user -u <unit>`.
- **The plugin moved:** an upgrade installed Clawser in a new folder. Rerun setup.
- **Connection unavailable (CDP viewer):** keep the configured browser running
  and verify its actual attach-only loopback connection. Do not guess ports or
  launch/copy a replacement browser to bypass setup.
- **Command missing:** inspect the plugin and use its installed standalone CLI
  until native CLI registration is active.
- **systemd prerequisite failure:** fix the OpenClaw user's session. Do not run
  setup as root.
- **Port, configuration or ownership conflict:** compare options and receipts.
  Preserve resources and choose a separate state directory for a new installation.
- **Tunnel not ready:** check DNS/outbound HTTPS. First-link startup allows up to
  90 seconds. Never expose CDP/VNC or the Gateway as a replacement endpoint.
- **Recovery required or uncertain input:** keep automation paused. Inspect the
  original browser/controller and follow the reported recovery guidance. Do not
  retry/replay input, clear ledgers, bypass the gate or treat another link as
  recovery. Take a fresh gated observation only after safe handback.
- **After maintenance:** reload `browser-handoff --wait`, run doctor and repeat
  the owner-session tabs check. Old invitations are not recovery mechanisms.

Issue reports should contain versions, redacted doctor output and error text,
not private state, browser data, signed-in screenshots or invitation credentials.
See [SECURITY.md](../SECURITY.md) for vulnerability reporting.

## Operator reconciliation after a failed control handback

This offline helper is for the noVNC handoff, not CDP handoffs.
If a control handoff reports `recovery_required`, keep browser automation paused.
An operator can reconcile one failed lease when the supervisor has already
retired its viewer and retained a valid input-fence receipt. This preserves the
browser, tabs and profile; it does not restart the browser or recreate
an invitation.

1. Stop the exact controller service reported for that installation. Keep its
   private configuration and journal intact.
2. Run the helper from the reviewed plugin source, using that installation's
   private controller configuration and the exact failed lease ID:

   ```sh
   node /absolute/path/to/installed-plugin/bin/reconcile-desktop.mjs /absolute/private/controller.json FAILED_LEASE_ID
   ```

3. Proceed only if it reports `ok: true`, `inputFenced: true`, and
   `snapshotObserved: true`. Restart the same controller service, reload the
   plugin with `openclaw plugins reload browser-handoff --wait`, then run doctor
   and the owner-session `tabs` check described above. Take a fresh browser
   observation before continuing the task.

The helper requires exclusive controller ownership, no outstanding browser calls,
no active viewer, unchanged browser/display generations, and a complete same-lease
retirement receipt newer than the failed actor. It keeps the original failed
journal until fresh observation and the final runtime checks pass. Any refusal
requires further operator investigation; do not delete the journal, force the
gate open, or treat an ordinary service restart as recovery.
