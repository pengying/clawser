# Install and maintain Clawser

## Supported host

The validated platform is Linux x86_64, Node.js >=24.16 <25 or >=26.1, and
OpenClaw 2026.10.4+ with its native trusted-tool-policy SDK. Native fixtures cover
2026.10.4 and 2026.10.7. Windows, macOS and ARM hosts remain unverified.
Run setup as the OpenClaw user, without `sudo`, with the same OpenClaw
state/config environment used by the Gateway. Start the Gateway first.

Default CDP setup needs Node, OpenClaw, an already-running compatible Chromium
CDP connection and outbound HTTPS for pinned cloudflared and the tunnel. It does
not require Docker, systemd, `flock`, `tar` or a noVNC download. The optional
[noVNC desktop](#optional-novnc-desktop) has additional requirements.

## Tagged Git installation

This guide describes v0.5.0. Tagged Git installation is the recommended
distribution path.

```sh
openclaw plugins install git:github.com/pengying/clawser@v0.5.0 --force --accept-capabilities
openclaw clawser setup --dry-run
openclaw clawser setup
openclaw clawser doctor
```

The package is `@pengying/clawser`, the plugin ID is `browser-handoff`, and the
command is `openclaw clawser`. `--force` confirms native Git installation or
replacement. `--accept-capabilities` accepts the declared tool and trusted
browser-policy contracts. Installs, updates and enabling must use a supported
native command with `--accept-capabilities`; never hand-write acknowledgement
settings to make a contract warning disappear. Review the installation output
and follow its activation guidance.

Check the [ClawHub package page](https://clawhub.ai/pengying/plugins/clawser)
for approved registry versions. Older releases use the noVNC default and do not
provide this guide’s CDP-first setup.

## Existing browser connection

Default setup reuses OpenClaw's configured default browser connection. This is
not automatically the Chrome profile used for everyday OS browsing. Configure
an existing Chromium connection with an explicit loopback HTTP CDP origin and
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

To select another existing connection and make it the OpenClaw default:

```sh
openclaw clawser setup --browser-profile existing --dry-run
openclaw clawser setup --browser-profile existing
openclaw clawser doctor
```

This selects an OpenClaw connection; it does not create a browser profile on disk.
Setup replaces Clawser's share mappings with that one selected connection,
disables desktop/Funnel mode, configures the authenticated Cloudflare viewer and
preserves unrelated settings. It downloads cloudflared 2026.10.4 with a pinned
SHA-256 checksum, then reloads the plugin. It does not own the Chrome process.

The default private setup directory is
`${OPENCLAW_STATE_DIR:-~/.openclaw}/clawser-cdp`, containing its ownership receipt
(`setup.json`) and verified `bin/cloudflared`. Runtime tunnel state is kept under
OpenClaw's private `browser-handoff` state. Keep receipts private and intact.
Do not repurpose an old desktop state directory for CDP setup.

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

Managed CDP doctor is read-only. It checks prerequisites, receipt ownership,
pinned cloudflared SHA-256 and executable permissions, the current profile/CDP
binding, Chromium reachability, local viewer CSS and the public tunnel receipt
and CSS endpoint. It reports the selected profile and CDP origin. A healthy
browser alone does not prove the current plugin generation has reconnected.
Before browser work, ask the verified owner session to call `browser_handoff`
with `action=tabs`; confirm the returned profile and expected task tab.

Every ordinary browser call must use `target: "host"` and the returned profile.
Use the raw target ID from the tab list, never an OpenClaw display label like
`t1`. Startup/profile-management actions and sandbox, node, user-profile,
endpoint or MCP routing escapes are unavailable. Missing native APIs or current
configuration drift fail closed.

If plugin CLI registration is unavailable before activation, locate its directory
with `openclaw plugins inspect browser-handoff` and use the installed entry point:

```sh
node /absolute/path/to/installed-plugin/bin/clawser.mjs setup --dry-run
node /absolute/path/to/installed-plugin/bin/clawser.mjs setup
node /absolute/path/to/installed-plugin/bin/clawser.mjs doctor
```

Replace the example path with the inspected installation location. This does not
replace the native capability-acceptance step. Developer installation is in
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Release archive alternative

Once published, download `pengying-clawser-0.5.0.tgz` and `SHA256SUMS` from the
[v0.5.0 release](https://github.com/pengying/clawser/releases/tag/v0.5.0) into the
same directory:

```sh
sha256sum --check SHA256SUMS
openclaw plugins install ./pengying-clawser-0.5.0.tgz --force --accept-capabilities
openclaw clawser setup
openclaw clawser doctor
```

The archive contains plugin/runtime source and viewer assets, not your browser
profile, a prebuilt browser or downloaded cloudflared/noVNC. Obtain the archive
and checksums from the intended release. Checksums verify against that published
file; they are not an independent publisher signature.

## Setup options

```sh
openclaw clawser setup --help
openclaw clawser doctor --help
```

| Option | CDP default | Purpose |
| --- | --- | --- |
| `--dry-run` | Off | Validate and show the plan without changing files, downloads, services or configuration |
| `--state-dir PATH` | `${OPENCLAW_STATE_DIR:-~/.openclaw}/clawser-cdp` | Private CDP receipt and verified download |
| `--browser-profile NAME` | Existing OpenClaw default | Select an existing connection; setup also makes it default |
| `--port PORT` | Existing plugin port, otherwise `18796` | Loopback viewer listener |
| `--novnc` | Off | Explicitly provision or maintain the owned Docker desktop |

Use the same custom state directory for setup and doctor. A first setup rejects
a busy viewer port. A repeat run permits the busy port only with a completed
matching receipt, verified binary, current matching configuration and healthy
local viewer. A public tunnel outage does not prevent that local repeat-run
check; doctor still reports public readiness failure. Do not delete receipts or
adopt an unrelated listener to bypass a conflict.

## Optional noVNC desktop

Use this when the task needs full browser UI, automatic popup switching, native
OS dialogs or remote system clipboard access. It shares the entire dedicated
profile, including every tab and dialog; it does not move the current tab or
cookies from another browser. Group/private authorization does not choose the
backend.

The host additionally needs local Docker at `unix:///var/run/docker.sock`, a
working user systemd session, `flock`, `tar`, and outbound access for Docker/Debian
builds and noVNC. Remote Docker contexts are unsupported. The browser runtime
has a 3 GiB memory limit and 512 MiB shared memory; allow space for the image build.

```sh
openclaw clawser setup --novnc --dry-run
openclaw clawser setup --novnc
openclaw clawser doctor --novnc
```

This path downloads checksum-pinned cloudflared 2026.10.4 and noVNC 1.7.0, builds
the sandboxed Chromium image, installs a private user controller service and
merges its dedicated `handoff` browser connection. The first image build can take
several minutes. The container is created lazily on the first browser/handoff
operation. Setup normally makes `handoff` the default; `--no-default-profile`
keeps the previous default, and the task must select the returned desktop profile
explicitly. noVNC never automatically falls back to CDP.

| noVNC option | Default | Purpose |
| --- | --- | --- |
| `--state-dir PATH` | `${OPENCLAW_STATE_DIR:-~/.openclaw}/clawser` | Desktop ownership, controller configuration and downloads |
| `--browser-profile NAME` | `handoff` | Owned dedicated OpenClaw browser connection |
| `--port PORT` | `19410` | Loopback controller/viewer listener |
| `--cdp-port PORT` | `18812` | Loopback Chromium endpoint |
| `--vnc-port PORT` | `59092` | Loopback VNC endpoint |
| `--container-name NAME` | `openclaw-handoff-desktop` | Owned Docker container identity |
| `--no-default-profile` | Off | Preserve the current OpenClaw default |

`--cdp-port`, `--vnc-port`, `--container-name` and `--no-default-profile` require
`--novnc`. Doctor detects enabled desktop mode, but explicit `--novnc` is useful
when inspecting the original desktop while CDP is enabled. Repeat custom options.

Desktop state includes `setup.json`, `controller.json`, `bin/`, `vendor/` and
controller socket/ledger/runtime state under `state/`. Its user unit is
`clawser-desktop-<state-directory-hash>.service`; its profile volume is normally
`openclaw-handoff-desktop-profile`. Preserve both state and volume. Do not point
a new receipt at an existing container or delete receipts to evade ownership.
Done, expiry and controller stop keep the browser/profile. Restarting the
controller does not renew or restore invitations.

### For agents installing Clawser

This applies once the host display backend is enabled. Today's Docker desktop
needs no host display packages.

1. Run `openclaw clawser setup --novnc --dry-run` first.
2. If it prints an install command, give it to the owner verbatim and wait.
   Never run `sudo` or a system package manager yourself.
3. Rerun setup after the owner confirms the install.
4. Never install a browser.

## Switching backends

Finish handoffs and pause browser work before switching. There is no transfer of
tabs, cookies, logins, dialogs or unfinished forms between browsers.

To switch from an owned desktop to CDP, first select an eligible existing
OpenClaw connection with `setup --browser-profile NAME`. Use the separate CDP
state directory. CDP setup sets `desktop.enabled=false` while preserving its
stored desktop identity. This bit change does not stop, adopt or delete Docker
resources or volumes. Stop an unused owned desktop separately after verifying
its identity, if desired.

To return to that desktop, run `setup --novnc --dry-run`, then `setup --novnc`
using its **original installation path, receipt/state directory, profile, ports,
container name and default-profile choice**. For an untouched default instance:

```sh
openclaw clawser setup --novnc --state-dir "$HOME/.openclaw/clawser" --dry-run
openclaw clawser setup --novnc --state-dir "$HOME/.openclaw/clawser"
openclaw clawser doctor --novnc --state-dir "$HOME/.openclaw/clawser"
```

Substitute the original state path if `OPENCLAW_STATE_DIR` or options differed.
Only a matching original owned desktop can be reused. Changing package source or
installation path can break receipt identity; there is no automatic cross-source
ownership migration. For a manually managed older noVNC deployment, retain its
original operator configuration and desktop identity and explicitly enable its
original `desktop.enabled` setting; a new setup receipt cannot adopt it. Reload,
run the applicable diagnostics and check the owner-session tabs before resuming.

## Upgrade

1. Finish handoffs and pause browser work. Record the release, installation
   source/path, state/config environment, setup options and browser connection.
   Back up private configuration/state; back up a noVNC profile with a consistent
   Docker-volume procedure. Existing CDP browser data remains operator-owned.
2. Disable the plugin before replacing files. For noVNC also stop its exact
   controller unit:

   ```sh
   openclaw plugins disable browser-handoff
   systemctl --user stop 'clawser-desktop-<state-directory-hash>.service'
   ```

   The systemd command is only for noVNC; substitute the reported unit.
3. Keep the same installation source/path. Once the tag is published, a Git
   upgrade can use `openclaw plugins install
   git:github.com/pengying/clawser@v0.5.0 --force --accept-capabilities --no-enable`.
   While disabled, run the installed standalone setup entry point with
   `--dry-run`, then setup, retaining the mode and original state/options.
   noVNC requires `--novnc`; plain setup chooses CDP.
4. Follow activation guidance and use `--accept-capabilities` if enabling through
   a native enable command. Reload, run doctor and complete the owner-session
   tabs check before resuming browser work.

Preserve the original state/profile on conflicts. Do not repeatedly force
replacement or delete ownership evidence. Restore a known release when
appropriate. Rollback does not undo website actions or browser profile changes;
check state-format compatibility first.

## Disable or uninstall while keeping data

Finish handoffs and pause automation, then disable the plugin:

```sh
openclaw plugins disable browser-handoff
openclaw plugins uninstall browser-handoff --dry-run
openclaw plugins uninstall browser-handoff
```

CDP disable/uninstall does not own, stop or delete Chrome or its tabs/cookies.
Keep private receipts and operator browser data for recovery. Select an intended
OpenClaw default before unrelated browser work; disabling does not change it.

For noVNC, also disable and stop the exact controller unit:

```sh
systemctl --user disable --now 'clawser-desktop-<state-directory-hash>.service'
```

The browser container may remain running. To stop it, first verify its exact
identity against the private runtime receipt. For a matching default container,
`docker stop --time 8 openclaw-handoff-desktop` keeps the profile volume. Skip this
if no browser was started. Keep the private state, disabled unit and profile
volume; plugin uninstall does not remove those resources. Avoid volume pruning.
Reuse requires the original matching installation identity and options.

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

- **Connection unavailable:** keep the configured browser running and verify its
  actual attach-only loopback connection. Do not guess ports or launch/copy a
  replacement browser to bypass setup.
- **Command missing:** inspect the plugin and use its installed standalone CLI
  until native CLI registration is active.
- **Docker/systemd prerequisite failure:** these apply only to noVNC. Fix the
  OpenClaw user's access/session; do not run setup as root.
- **Port, configuration or ownership conflict:** compare options and receipts.
  Preserve resources and choose a separate identity for a new installation.
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

This offline helper is for the owned noVNC desktop, not CDP handoffs.
If a control handoff reports `recovery_required`, keep browser automation paused.
An operator can reconcile one failed lease when the supervisor has already
retired its viewer and retained a valid input-fence receipt. This preserves the
browser container, tabs and profile; it does not restart the browser or recreate
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
