# Existing default browser handoff design

## Authorized outcome

The operator requested CDP as the default handoff route, using the browser already
in use, with noVNC retained behind an explicit flag. The operator requested a
written plan followed by execution without waiting for another confirmation.

## Chosen approach

Attach to an existing, configured OpenClaw default browser over loopback CDP.
Clawser does not launch Chrome, create a Chrome profile, copy cookies, or fall
back to a Docker browser. Use the existing Cloudflare viewer transport. Keep
`desktop.enabled: true` and `setup --novnc` as explicit desktop opt-ins.

The alternatives were retaining noVNC as the default, or attaching multiple
Gateways to one personal browser. The former conflicts with the new request;
the latter requires cross-Gateway coordination and risks exposing the personal
browser through ordinary family-chat browser tools. This release uses distinct
existing browser connections per Gateway and forbids unsupported profile
selection. It does not claim shared-browser coordination across Gateways.

For this deployment, reuse the existing personal Google Chrome connection and
the already-running family Google Chrome browser. A connection alias may be
added to OpenClaw configuration to make the latter attach-only; this creates no
Chrome process, user-data directory, or cookie profile. Preserve the former
managed browser definition and process. Concrete identities and backups belong
in private deployment artifacts, not this public plan.

## Browser resolution and permissions

Use a shared resolver for setup, runtime and doctor. Resolve the configured
default profile unless an operator explicitly selects an existing profile.
Require a Chromium-compatible attach-only connection with an explicit loopback
CDP origin. Missing, closed or incompatible connections produce an actionable
error. Never guess a port or silently select another browser.

Pin the resolved profile/origin for a service generation. Check current default
selection through a supported current-config API, or fail closed if effective
selection cannot be established. A profile or endpoint change must invalidate
old shares and require service reconciliation; it must not retarget an invite.

Declare and register a trusted native tool policy. For ordinary browser tools,
require host-derived requester owner status, sender/channel identity, complete
tool lifecycle identifiers, an authorized session, and a permitted existing
browser profile. Reject absent identity, spoofed owner parameters, unconfigured
profiles and unavailable coordination before browser I/O. Keep the existing
`browser_handoff` owner/session/incarnation checks. Native fixtures established
that the policy API and per-turn requester authority work on both OpenClaw
2026.10.4 and the running 2026.10.7 builds. New policy capability acceptance must
go through the supported installer/enable commands.

## Setup and runtime

Default setup and doctor use CDP. Select the backend before checking desktop
prerequisites. CDP setup requires Node, OpenClaw, an existing eligible browser,
and a pinned Cloudflare binary; it does not invoke Docker, create a desktop
service, download noVNC, or provision a browser profile. Keep CDP setup state
separate from existing desktop ownership receipts. Preserve unrelated config,
owner group allowlists, existing browser data, and the desktop rollback path.

The legacy CDP service continues serving only the selected tab. noVNC remains
the full-browser option. Both routes retain one-use invitations, a single
viewer, expiry, explicit takeover, and browser automation gating. Unknown input
outcomes remain blocked; changing the default is not permission to bypass a
recovery fence or replay a checkout action.

## Input and performance

Test the actual CDP route before changing input behavior. Cover repeat handoffs
on one unchanged tab, navigation, mobile keyboard reopen, IME, clipboard, select
and color controls, touch scroll/drag, cross-origin frames and OOPIFs. Metadata
collection must remain value-free. A screenshot alone does not prove that a
cross-origin field can receive mobile typing. Any keyboard fallback must be an
explicit human-control action, target only the claimed tab, and be fenced on
navigation, disconnect and control release. Never silently reuse stale focus
tokens or retry uncertain edits.

Measure input delivery and visible frame return separately on loopback and
Cloudflare using the same browser and fixture. The old Funnel latency hypothesis
is not yet proven and must not substitute for measurements.

## Rollout and completion

Complete tests and independent reviews before live changes. Back up both
configurations, record browser identity/PIDs/target hashes, and verify the native
nonowner browser denial. Switch personal first, then family, keeping the browser
instances distinct. Use supported plugin installation and capability acceptance.
Do not place orders, submit the real checkout, send test chat messages, or inspect
password values. Use only an owned dummy tab for live interaction tests.

After default CDP handoffs pass, retire the unused noVNC viewer services. Preserve
their browser/profile state and ownership receipts for rollback; do not delete
volumes or discard unfinished user tabs. Publish the reviewed GitHub release and
verify a pristine install. Attempt ClawHub publication only after complete local
inspection; report a hosted scanner execution failure honestly rather than
bypassing review or repeatedly uploading identical artifacts.
