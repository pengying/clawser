# Contributing

Use Node.js >=24.16 <25 or >=26.1. Work on disposable browser profiles and synthetic pages.
Never test a handoff against someone’s signed-in personal browser or publish live
invitation links, profile contents or private deployment artifacts.

## Local checks

```sh
npm ci --ignore-scripts
npm test
npm run test:desktop
npm run check:package
```

The unit suite includes browser fixtures. Set `CHROME_BIN` to a Chrome/Chromium
executable; a few fixture tests skip when Chrome is absent, while native picker
and CDP keyboard integration require it. The CDP fixtures cover focused-frame
keyboard authority, stale capability revocation and uncertain-input handling.
`npm run test:desktop` runs the supervisor, clipboard, X proof and openbox
tests. Tests that need Xvfb, x11vnc or python3 skip when the program is missing.
They start their own throwaway displays from `:140` to `:199`.

For the real noVNC/RFB pointer fixtures, download the pinned source archive:

```sh
curl --fail --location --proto '=https' --tlsv1.2 \
  https://codeload.github.com/novnc/noVNC/tar.gz/refs/tags/v1.7.0 \
  --output /tmp/clawser-novnc-1.7.0.tar.gz
printf '%s  %s\n' \
  b1003a11b6e6e8d8f7f5e5586daae7f8ca651d8aee0aa155ff9ac841c48f52c6 \
  /tmp/clawser-novnc-1.7.0.tar.gz | sha256sum --check
mkdir -p /tmp/clawser-novnc-1.7.0
tar -xzf /tmp/clawser-novnc-1.7.0.tar.gz \
  --strip-components=1 -C /tmp/clawser-novnc-1.7.0
NOVNC_ASSETS_DIR=/tmp/clawser-novnc-1.7.0 npm test
```

Additional disposable-browser checks:

```sh
npm run test:live
node test/native-browser.mjs
READINESS_MODES=headless node test/renderer-readiness.mjs
```

For the trusted-tool-policy contract, run against an actual supported OpenClaw
distribution (native fixtures cover 2026.10.4 and 2026.10.7):

```sh
node test/native-browser-policy-fixture.mjs /absolute/path/to/openclaw/dist
```

This fixture uses isolated state and checks native owner admission and route
confinement. Keep browser tests disposable; do not enable or reload a live Gateway
for routine validation.

These checks create temporary profiles and localhost fixtures. Screenshots and
results go to `test-artifacts/`, which must stay out of commits and packages.
Headless fixture flags do not describe the production Chromium sandbox.

## Host end-to-end check (opt-in)

`npm run test:e2e` installs a real setup with user services, so run it only on a
disposable machine, with `CLAWSER_HOST_E2E=1`:

```sh
CLAWSER_HOST_E2E=1 npm run test:e2e
```

Without that variable it prints a skip message and does nothing.

## Source installation

The supported user path is the tagged Git install in [the README](README.md).
For development, create a local archive and install its actual filename explicitly
(replace `VERSION` with the packed version):

```sh
npm ci --ignore-scripts
npm test
npm run test:desktop
npm pack --ignore-scripts
openclaw plugins install ./pengying-clawser-VERSION.tgz --force --accept-capabilities
openclaw clawser setup --dry-run
```

Default setup writes user services and starts a browser on a virtual screen.
Use a disposable machine or account, with separate OpenClaw state/config and
unused ports. Option B, `--browser-profile`, takes over a running browser, so
point it only at a disposable profile. Host packages come from the distribution;
setup only prints the install command. `setup --cdp` attaches to an existing
attach-only Chromium CDP connection and never launches Chrome. Run `doctor` with
the same mode/state after setup. Installing a plugin, running
setup, enabling it and reloading a live Gateway change that deployment; tests and
packing do not.

## Changes and releases

Keep `browser-handoff` as the plugin ID and `browser_handoff` as the agent tool
unless an explicit compatibility migration is planned. Setup is a local operator
command, never an agent tool with general shell or administrative authority.
Preserve unrelated OpenClaw configuration and require a matching original receipt
before reusing user services, state or a browser profile. Flipping
`desktop.enabled` must not adopt or delete them. Setup must never install
packages or run `sudo`. It must touch only its own browser profile, the one
named with `--browser-profile`, or, on an upgrade from the CDP viewer, the
profile that viewer already used. Keep distinct
browser connections for separate Gateways; there is no cross-process human-control
coordination for a shared Chrome.

The plugin declares a trusted native browser policy as well as its handoff tool.
Install, update and enable only through supported native OpenClaw commands with
`--accept-capabilities`; never manufacture acknowledgement configuration. Changes
must preserve native verified-owner checks on ordinary browser tools and handoff,
`target="host"` confinement, current-config checks, and fail-closed admission.
Keep CDP handback (`ended` without gate/recovery fault, then a fresh gated
snapshot) distinct from noVNC's mandatory `resumeAllowed=true` contract. Frame
keyboard authority is explicit manual focused-frame input, not verified autofill;
never collect field values in passive metadata or replay uncertain input.

For a release, update the package version and changelog, run the checks above,
inspect `npm pack --dry-run` and review the public files for credentials, private
paths, browser state and test artifacts. Validate a fresh archive install in an
isolated OpenClaw configuration. Publish a `v<package-version>` Git tag only after
review. The release workflow reruns CI, checks tag/version agreement, packs the
plugin and attaches the `.tgz` and `SHA256SUMS` to a GitHub Release. It does not
publish to npm.

GitHub Actions are pinned to full commit SHAs. Update pins deliberately after
checking the upstream release and the repository’s CI result. Changes to setup,
authorization, handback, network exposure or persistent-data ownership need
focused regression coverage and an independent review.

## Browser checks in CI

CI reads Chrome’s installed program files before starting browser fixtures. Fresh hosted runners can take several seconds to load those files; preparation is measured separately from viewer behavior. The tests retain their startup deadlines and cancellation checks. First-launch timing and process diagnostics are saved as workflow artifacts.
