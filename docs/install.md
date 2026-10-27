# Install and maintain Clawser

## Supported host

The initial desktop release is validated on Linux x86_64 with Node.js 24.16+ on 24.x, or 26.1+,
OpenClaw 2026.10.4+, Docker access, a working user systemd session and `flock`.
Use the local Docker daemon at `unix:///var/run/docker.sock`; remote Docker contexts are not supported.
Start your OpenClaw Gateway before setup so its final plugin reload can finish.
Run setup as the same user that runs OpenClaw. Do not run it with `sudo`.

The host needs outbound HTTPS for GitHub downloads, Docker/Debian image builds
and the Cloudflare tunnel. The browser runtime has a 3 GiB memory limit and a
512 MiB shared-memory allocation; leave room for the host and image build too.
The first image build can take several minutes or longer on a slow host. Windows, macOS and ARM hosts are
not supported by this first validated installer.

## ClawHub installation

```sh
openclaw plugins install clawhub:@pengying/clawser@0.3.2 --accept-capabilities
openclaw clawser setup --dry-run
openclaw clawser setup
openclaw clawser doctor
```

The explicit `clawhub:` prefix works with the supported OpenClaw versions.
ClawHub lists the package after its registry checks finish. The package uses the
same setup and persistent browser as the GitHub distribution.

## Tagged Git installation

```sh
openclaw plugins install git:github.com/pengying/clawser@v0.3.2 --force --accept-capabilities
openclaw clawser setup --dry-run
openclaw clawser setup
openclaw clawser doctor
```

The Git tag selects a release. `--force` confirms installation or replacement;
review OpenClaw’s install output and any deployment-specific activation guidance.
The package is named `@pengying/clawser`, the plugin ID is
`browser-handoff`, and the public command is `openclaw clawser`.

Setup downloads cloudflared 2026.10.4 and noVNC 1.7.0 from their upstream projects,
checks their pinned SHA-256 hashes, builds the sandboxed Chromium image and
installs a private controller as a user systemd service. It merges the dedicated
browser profile, plugin settings and tool permission into OpenClaw configuration
without replacing unrelated entries. Setup is a local operator command; a chat
agent cannot invoke it through `browser_handoff`.

Follow setup’s printed activation/reload instructions. After controller
maintenance, let an active owner turn settle, then run:

```sh
openclaw plugins reload browser-handoff --wait
openclaw clawser doctor
```

Before resuming browser work, ask the agent in its normal private owner session
to invoke `browser_handoff` with `action=tabs` and `profile=handoff`. Confirm the
expected profile’s tabs are available. A healthy service or controller alone
does not prove the current plugin generation has reconnected. Keep browser work
paused if this session-level check fails.

If the plugin CLI route is unavailable before activation, locate the installed
plugin directory with `openclaw plugins inspect browser-handoff`, then run its
standalone entry point:

```sh
node /absolute/path/to/installed-plugin/bin/clawser.mjs setup --dry-run
node /absolute/path/to/installed-plugin/bin/clawser.mjs setup
node /absolute/path/to/installed-plugin/bin/clawser.mjs doctor
```

Replace the example path with the reported installed location. Developer source
installation is described in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Release archive alternative

Download `pengying-clawser-0.3.2.tgz` and `SHA256SUMS` from the
[v0.3.2 release](https://github.com/pengying/clawser/releases/tag/v0.3.2) into the
same directory, then:

```sh
sha256sum --check SHA256SUMS
openclaw plugins install ./pengying-clawser-0.3.2.tgz --force --accept-capabilities
openclaw clawser setup
openclaw clawser doctor
```

The archive contains plugin/runtime source and browser viewer assets. Setup
fetches noVNC/cloudflared and builds the browser image separately. It does not
contain your browser profile or a prebuilt browser binary. Checksums verify the
archive against the published checksum file; obtain both from the intended
release.

## Options and persistent state

```sh
openclaw clawser setup --help
openclaw clawser doctor --help
```

| Setup option | Default | Purpose |
| --- | --- | --- |
| `--dry-run` | Off | Show the plan without provisioning or changing configuration |
| `--state-dir PATH` | `${OPENCLAW_STATE_DIR:-~/.openclaw}/clawser` | Private setup/controller data and verified downloads |
| `--browser-profile NAME` | `handoff` | Dedicated OpenClaw browser profile |
| `--port PORT` | `19410` | Loopback viewer listener |
| `--cdp-port PORT` | `18812` | Loopback Chromium endpoint |
| `--vnc-port PORT` | `59092` | Loopback VNC endpoint |
| `--container-name NAME` | `openclaw-handoff-desktop` | Owned Docker desktop name |
| `--no-default-profile` | Off | Keep the current OpenClaw default browser profile |

Use the same `--state-dir` for setup and doctor when customizing it. Keep the
same OpenClaw state/config environment for installation, setup and later
maintenance. Choose unused ports and a distinct container name for a separate
installation. Do not point a new state directory at an existing desktop container
or profile volume.

Setup makes `handoff` the default browser profile unless
`--no-default-profile` is supplied. That profile has all of its own tabs, cookies,
logins and dialogs; personal browser cookies are not imported. Keep secrets out
of files intended for sharing.

Private setup files include `setup.json`, `controller.json`, verified downloads
under `bin/` and `vendor/`, and controller socket/ledger/runtime state under
`state/`. The user service is named
`clawser-desktop-<state-directory-hash>.service`; setup and doctor identify the
specific instance. The dedicated browser profile is stored in a Docker volume,
normally `openclaw-handoff-desktop-profile`. Both the private state directory and
the profile volume matter for recovery. Do not delete ownership receipts to work
around a conflict.

Done, disconnect and invitation expiry close viewer access while preserving the
browser/profile. Stopping the controller service also leaves Chromium’s container
and profile in place. A service restart does not renew or restore old invitations.
The browser container is created lazily on the first browser/handoff operation;
it may not exist yet immediately after setup.

## Upgrade

1. Finish active handoffs and pause browser work. Record the current release,
   setup options, private state location and service name. Back up the private
   configuration/state and persistent profile using a consistent Docker-volume
   backup procedure before changing versions.
2. Disable the plugin and stop its controller before replacing plugin files:

   ```sh
   openclaw plugins disable browser-handoff
   systemctl --user stop 'clawser-desktop-<state-directory-hash>.service'
   ```

   Replace the unit placeholder with the exact name reported for your instance.
3. Keep the current installation source. For a ClawHub installation, install the
   reviewed version with `openclaw plugins install
   clawhub:@pengying/clawser@0.3.2 --force --accept-capabilities --no-enable`.
   For a Git installation, use `openclaw plugins install
   git:github.com/pengying/clawser@v0.3.2 --force --accept-capabilities --no-enable`.
   Replace the version when upgrading. Changing installation source can change
   durable paths and requires an operator migration. While disabled, use its
   standalone `bin/clawser.mjs` entry point shown above to run `setup --dry-run`
   and then `setup`. Use the **same state directory, profile, ports and container
   name** as the existing installation. Repeat `--no-default-profile` if you used
   it before.
4. Follow the printed activation instructions, enable the plugin if needed, run
   doctor and complete the owner-session `tabs` check above before resuming.

Keep the original state/profile intact if an upgrade reports an ownership or
configuration conflict. Do not repeatedly force replacement or delete receipts.
Review the error and restore the previous known release if appropriate. A release
archive rollback does not roll back browser profile changes or remote website
actions; check release notes for state-format compatibility.

## Disable or uninstall while keeping data

Finish the current handoff and pause automation first. Disable the plugin, then
disable and stop the exact controller unit reported by setup/doctor:

```sh
openclaw plugins disable browser-handoff
systemctl --user disable --now 'clawser-desktop-<state-directory-hash>.service'
```

If `handoff` is the default browser profile, select another existing profile in
OpenClaw before doing unrelated browser work. Disabling the plugin does not
change that browser selection.

An already running browser container remains running after the controller stops.
To stop it as well, verify its exact container identity against the private
runtime ownership receipt, then stop that container. Skip this step if the
installation has not started a browser yet. For the default owned container:

```sh
docker stop --time 8 openclaw-handoff-desktop
```

Stopping keeps the profile volume. Use your configured name for a custom
installation, and do not stop a container whose ownership does not match.

To remove the plugin package, inspect OpenClaw’s removal plan and then uninstall:

```sh
openclaw plugins uninstall browser-handoff --dry-run
openclaw plugins uninstall browser-handoff
```

Keep the private state directory, the disabled unit and the dedicated Docker
profile volume if you want to recover the session later. Uninstalling the plugin
does not remove those external resources. Avoid Docker volume pruning and
profile-directory deletion. Reinstallation with the same state and setup options
can reuse the owned desktop; follow activation and doctor checks again.

## Recovery and troubleshooting

- **Command missing:** inspect the plugin installation and use the standalone
  `bin/clawser.mjs` path above until the plugin CLI registration is available.
- **Docker/systemd prerequisite failure:** run doctor as the OpenClaw user and
  fix that user’s Docker access or user service session. Do not solve it by
  running setup as root.
- **Port, configuration or ownership conflict:** compare the requested setup
  options with the existing private receipt. Preserve the existing resources and
  choose a separate identity for an additional installation.
- **Tunnel not ready:** check host DNS and outbound HTTPS access to Cloudflare.
  First-link startup allows up to 90 seconds. Do not expose local CDP/VNC or the
  Gateway as an alternative public endpoint.
- **Recovery required after uncertain input:** keep browser automation paused.
  Inspect the owned browser and controller, follow the reported recovery guidance
  and perform a fresh owner-session observation before issuing more input. Do
  not clear the ledger or bypass the gate to make the warning disappear.
- **After a controller restart:** reload `browser-handoff --wait`, run doctor and
  repeat the owner-session `tabs` check. Old links are not a recovery mechanism.

When reporting an issue, include versions, the redacted doctor result and the
error text. Do not attach private state, browser profile data, signed-in
screenshots, invitation URLs or viewer credentials. See [SECURITY.md](../SECURITY.md)
for vulnerability reporting.
