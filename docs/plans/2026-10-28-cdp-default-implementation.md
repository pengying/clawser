# CDP Default Browser Implementation Plan

> Execution: use the executing-plans workflow task by task, with independent
> implementation workers and review checkpoints in this session.

**Goal:** Reuse the existing default browser through CDP by default, with no
browser launch or Docker dependency, while retaining noVNC as an explicit option.

**Architecture:** Resolve one existing browser connection per Gateway, protect
ordinary browser execution using native per-turn owner authority, and retain the
selected-tab CDP viewer and Cloudflare transport. Split CDP operator setup from
desktop provisioning. Keep desktop mode behind `desktop.enabled` / `--novnc`.

**Tech Stack:** Node ESM, OpenClaw trusted tool policy and V2 contexts, Chromium
CDP, ws, Cloudflare Quick Tunnel, disposable browser fixtures.

## Baseline and constraints

- Base commit: `1374e1244b420414b9fed3e4f1f0ed04b5470d7d`.
- Existing code checks: 384 main tests and 25 runtime tests pass.
- Preserve owner group authorization, transport fencing and uncertain-input
  failures. No live browser launch, cookie copy, order submission, or chat sends.
- Distinct existing browser connections for personal and family Gateways.
- Keep all production work in isolated worktrees and versioned deployment copies.
- Disposable headless test fixtures are allowed; they are not production browsers.

## Task 1: Resolver and native browser access policy

**Files:** create `src/browser-config.mjs`, `src/browser-policy.mjs`; modify
`index.mjs`, `openclaw.plugin.json`; add `test/browser-config.test.mjs` and
`test/browser-policy.test.mjs`; extend `test/plugin.test.mjs` as appropriate.

1. Write failing tests for the configured default, explicit existing selection,
   missing/closed/incompatible browser, nonloopback URLs, and attach-only rules.
2. Define a resolver contract returning mode, selected profile, validated CDP
   origin and the permitted profile mapping. Avoid browser/process creation.
3. Write failing native policy tests for owner/nonowner/missing requester,
   spoofed parameters, a subsequent nonowner in the same group session, aliases,
   stale/unavailable service, unconfigured profile and default/endpoint drift.
   Require current-config API failure/incompleteness to deny execution. Verify
   the native executor's effective profile agrees, including host/sandbox/node
   and alternate-endpoint routing arguments.
4. Register `clawser-browser-access` through `registerTrustedToolPolicy`, declare
   its manifest contract, and use host `ctx.requester` facts. Fail closed if the
   required SDK API is unavailable. Keep discovery/CLI metadata inert.
5. Make omitted handoff profile use the resolved default and return its name in
   `tabs` results. Pin each live service generation and invalidate stale shares.
   A configuration change during human control or a pending browser call must
   retain uncertain input/automation fences instead of discarding the gate.
6. Run `node --test test/browser-config.test.mjs test/browser-policy.test.mjs
   test/plugin.test.mjs`, then the real native policy fixture on 10.4 and 10.7.
   Verify nonowner browser I/O count stays zero. Commit this task separately.

## Task 2: CDP setup/doctor and explicit noVNC flag

**Files:** create `src/cdp-setup.mjs`; modify `src/setup.mjs`, `src/cli.mjs`;
add `test/cdp-setup.test.mjs`; extend `test/cli.test.mjs`, `test/setup.test.mjs`.

1. Add failing tests showing default setup never calls Docker, launches a browser,
   creates a Chrome user-data directory, downloads noVNC or installs a desktop unit.
2. Add `--novnc` option forwarding. Select mode before desktop prerequisites.
   Existing desktop tests must opt into that route explicitly.
3. Use the shared resolver and supported native configuration patching. Preserve
   unrelated settings and group allowlists. Default CDP keeps the current browser
   selection; an explicit operator profile selection uses an existing connection.
4. Give CDP its own ownership/state namespace. Refuse conflicting unowned state;
   preserve desktop receipts. Explicit CDP setup may disable the desktop mode
   flag without adopting or changing its resources; preserve its identity fields.
   Enabling, reusing or provisioning a desktop still requires matching ownership
   (or an exact inert disabled configuration with no identity on first install).
5. Install/verify the pinned Cloudflare binary and patch CDP transport settings,
   disabling the plugin's old Funnel selection without touching unrelated routes.
6. Make doctor inspect only the selected backend and remain read-only. Report the
   exact existing browser/profile, readiness and actionable missing prerequisites.
7. Test dry-run, repeat setup, bad ownership, absent default, unavailable CDP,
   Docker absent, desktop opt-in and a complete desktop-to-CDP-to-noVNC round
   trip with the original desktop receipt/socket/profile identity. Commit
   separately.

## Task 3: CDP input regressions and measured latency

**Files:** modify only as required by reproductions: `src/cdp.mjs`,
`src/interaction-metadata.mjs`, `public/viewer.js`, `public/editing.js`,
`public/picker.js`; extend focused input/viewer tests and add repeated/cross-frame
fixtures under `test/`.

1. Reproduce the old keyboard guard and repeated-open reports with a real browser.
   Include a cross-origin iframe and an OOPIF case, not only a simple same-origin
   form. Retain the existing More outside-click regression.
2. Establish failing tests before each product fix. Do not infer that selecting a
   dropdown proves editable focus. Inspect only dummy form values in tests.
3. Keep same-origin metadata/picker assistance value-free. If a native keyboard
   fallback is needed, require explicit human control and navigation/input fencing;
   validate that design independently before implementing it.
4. Verify text/password/textarea/contenteditable, IME/suggestions, keyboard reopen,
   selection, select/color picker, clipboard, touch scroll/drag, page navigation,
   disconnects, stale capabilities and late/uncertain input failures.
5. Record loopback and public Cloudflare timings for input-to-target and visible
   frame delivery using one browser/fixture. Report measured limits honestly.
6. Run focused tests, then the full suite once after fixes. Commit coherent fixes.

## Task 4: Integration, reviews and operator documentation

**Files:** `README.md`, `docs/install.md`, `SECURITY.md`,
`skills/browser-handoff/SKILL.md`, `CHANGELOG.md`, package metadata and CI as needed.

1. Integrate nonconflicting task commits in the coordinator worktree. Obtain a
   spec review, then an independent security/code review; resolve findings.
2. Document CDP as default, its selected-tab scope, existing-browser prerequisite,
   no automatic launch/fallback, owner-only normal browser access, profile limits,
   and one Gateway per browser. Document `--novnc` and backend-specific handback.
3. Run `npm test`, `npm run test:runtime`, `npm run check:package`; require no
   unexpected skips. Run stock native install/policy verification with consent.
4. Package the exact release artifact and run local ClawScan/SkillSpector. Require
   complete inspection of shipped files; investigate deterministic parser failures
   without weakening security checks or hiding required runtime code.
5. Prepare a new minor release for the changed defaults. Preserve existing tags.

## Task 5: Personal and family live rollout

**Private artifacts:** use a new private deployment directory; no credentials,
browser URLs, sender IDs or invitation secrets in the repository.

1. Save current config/service identities and browser PID/target hashes. Verify
   the existing personal Google Chrome endpoint and separate family browser.
2. Configure existing attach-only connections. A new connection alias is allowed;
   starting a new Chrome process or creating/copying its user-data profile is not.
3. Install the reviewed plugin through the exact running native CLI with
   `--accept-capabilities`; never hand-edit capability acceptance. Preserve the
   private Google ingress and its verified sender/owner policy.
4. Prove owner browser access and nonowner denial before browser I/O using real
   native wrappers and fake targets. Never manufacture a live chat-owner turn.
5. Switch personal first. Test an owned dummy tab through actual Cloudflare CDP
   viewer for repeated takeover/type/pickers/Done and safe handback. Close only
   the dummy tab and keep original browser targets/PIDs unchanged.
6. Switch family using its distinct existing browser. Repeat the smoke test and
   verify the exact owner-group allowlist is preserved. No real form submission.
7. Retire unused noVNC viewer services only after successful CDP validation; retain
   desktop browser/profile state and receipts for explicit opt-in or rollback.
8. Verify new defaults, SDK service health, no unintended browser/Docker launches,
   no active test leases, no leftover test processes, and preserved original tabs.

## Task 6: Distribution and final report

1. Run CI, publish the immutable GitHub tag/archive, and verify its checksums and
   source inventory with an anonymous pristine OpenClaw install.
2. Attempt ClawHub publication once only after complete local inspection. Record
   its exact receipt and version status. A hosted scanner execution error is an
   external blocker, not evidence of a clean verdict or permission to bypass it.
3. Report the live backend/browser selections, measured latency, tested controls,
   optional noVNC route, preservation/rollback state and any remaining limits.
   Do not claim the earlier OOM or Funnel hypothesis proved every historical stall.
