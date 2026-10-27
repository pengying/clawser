# Clawser publication and installation plan

**Goal:** Publish the tested browser-handoff implementation as a standalone OpenClaw plugin at pengying/clawser with a repeatable installation and setup path.

**Architecture:** Keep the reviewed runtime and browser_handoff tool, retaining plugin ID browser-handoff for compatibility. Brand the public project Clawser. Install the plugin from a versioned Git reference or release archive. An explicit local setup command verifies prerequisites and pinned downloads, builds the sandboxed browser image, configures a private user service, and merges only owned OpenClaw settings. Chat tools cannot perform setup or acquire general shell/admin authority.

**Tech stack:** Node22+, OpenClaw, Linux x86_64 Docker/systemd, pinned cloudflared/noVNC, GitHub Actions and Releases. Other platforms get clear unsupported-platform guidance rather than a partial install.

1. Create a clean standalone repository from runtime/source/test files, excluding private artifacts and workspace history.
2. Implement idempotent setup/doctor commands with dry-run, ownership/conflict checks, verified downloads, configuration merge, and shell-safe service rendering. Test downloads/checksums, preservation of unrelated config, conflicts and repeat runs with injectable system operations.
3. Add the OpenClaw CLI entry and manifest metadata; ensure setup remains available before desktop mode is configured.
4. Write a concise README with exact install/setup/doctor commands, requirements, privacy/access lifetime, upgrades and safe uninstall.
5. Add CI for unit/runtime tests and package contents, plus tagged release archives/checksums.
6. Validate fresh local archive installation in isolated OpenClaw state, setup planning and actual owned runtime provisioning without changing the existing working deployment.
7. Independently review setup and packaging changes, run appropriate checks, inspect the public payload for private data, then commit/push main and publish a versioned GitHub release.

The user explicitly authorized publishing to this repository and making installation easy. GitHub CLI is already authenticated. Preserve the currently working browser/profile and all unrelated host configuration.
