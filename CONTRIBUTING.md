# Contributing

Use Node.js >=24.16 <25 or >=26.1. Work on disposable browser profiles and synthetic pages.
Never test a handoff against someone’s signed-in personal browser or publish live
invitation links, profile contents or private deployment artifacts.

## Local checks

```sh
npm ci --ignore-scripts
npm test
npm run test:runtime
npm run check:package
```

The unit suite includes browser fixtures. Set `CHROME_BIN` to a Chrome/Chromium
executable; a few fixture tests skip when Chrome is absent, while native picker
and CDP keyboard integration require it. The CDP fixtures cover focused-frame
keyboard authority, stale capability revocation and uncertain-input handling.
`npm run test:runtime` exercises the Docker adapter and readiness logic with test
doubles and does not start containers.

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

## Full Docker runtime checks (opt-in)

Read [the runtime guide](runtime/desktop/README.md) before running these commands.
They build an image and create named Docker resources and a persistent test
profile. Use a disposable development host, and check that the documented test
names and ports are free.

```sh
docker build -t openclaw-handoff-desktop:20261027 runtime/desktop
node runtime/desktop/test/integration.mjs
node runtime/desktop/test/inspect.mjs
node runtime/desktop/test/heartbeat.mjs
```

The integration test deliberately retains its owned desktop for inspection.
Runtime test names/ports can be overridden with `DESKTOP_NAME`,
`DESKTOP_CDP_PORT`, `DESKTOP_VNC_PORT` and `DESKTOP_IMAGE`. Do not reuse production
names, state directories or profile volumes.

## Source installation

The supported user path is the tagged Git install in [the README](README.md).
For development, create a local archive and install its actual filename explicitly
(replace `VERSION` with the packed version):

```sh
npm ci --ignore-scripts
npm test
npm run test:runtime
npm pack --ignore-scripts
openclaw plugins install ./pengying-clawser-VERSION.tgz --force --accept-capabilities
openclaw clawser setup --dry-run
```

Default setup attaches to an existing configured attach-only Chromium CDP
connection. Create only disposable development connections and use separate
OpenClaw state/config and unused viewer ports. `--browser-profile` selects an
existing connection; setup must not launch Chrome, create a Chrome user-data
directory or copy cookies. Docker desktop provisioning requires explicit
`setup --novnc`; its additional tools and resources are not CDP prerequisites.
Run `doctor` with the same mode/state after setup. Installing a plugin, running
setup, enabling it and reloading a live Gateway change that deployment; tests and
packing do not.

## Changes and releases

Keep `browser-handoff` as the plugin ID and `browser_handoff` as the agent tool
unless an explicit compatibility migration is planned. Setup is a local operator
command, never an agent tool with general shell or administrative authority.
Preserve unrelated OpenClaw configuration and require matching original receipt,
installation source/path and identity before reusing persistent service or Docker
resources. Flipping `desktop.enabled` must not adopt or delete them. Keep distinct
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
