# Contributing

Use Node.js 24.16+ or 26.1+. Work on disposable browser profiles and synthetic pages.
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
executable; a few fixture tests skip when Chrome is absent, while the native
picker integration requires it. `npm run test:runtime` exercises the Docker
adapter and readiness logic with test doubles and does not start containers.

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
For development, create a local archive and install that archive explicitly:

```sh
npm ci --ignore-scripts
npm test
npm run test:runtime
npm pack --ignore-scripts
openclaw plugins install ./pengying-clawser-0.4.1.tgz --force --accept-capabilities
openclaw clawser setup --dry-run
```

Run setup against a separate OpenClaw state/config and unused ports if a working
deployment already exists. Installing a plugin, running setup, enabling it and
reloading a live Gateway change that deployment; tests and packing do not.

## Changes and releases

Keep `browser-handoff` as the plugin ID and `browser_handoff` as the agent tool
unless an explicit compatibility migration is planned. Setup is a local operator
command, never an agent tool with general shell or administrative authority.
Preserve unrelated OpenClaw configuration and require matching ownership before
reusing persistent service or Docker resources.

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
