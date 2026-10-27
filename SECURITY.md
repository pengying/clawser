# Security

## Reporting a vulnerability

Use [GitHub’s private vulnerability reporting form](https://github.com/pengying/clawser/security/advisories/new)
when it is available. Include the affected version, a minimal reproduction using
a disposable profile, the expected authorization boundary and the observed
behavior. If private reporting is unavailable, open a public issue asking for a
private reporting channel without publishing exploit details or credentials.

Do not attach invitation URLs, viewer cookies, VNC passwords, browser profiles,
private controller files, Gateway credentials, screenshots of signed-in pages or
unredacted session logs. There is no promised response time or bug bounty.

## Trust model

Clawser lets a trusted OpenClaw owner temporarily delegate viewing or control of
an entire dedicated Chromium profile. Every tab, dialog and signed-in session in
that profile may be visible to the recipient. Keep personal browser profiles
separate. A human controlling the browser can act with the authority of accounts
signed into that browser.

Invitation links are bearer credentials with one-browser redemption, one
concurrent viewer and a fixed expiry. Watch-only invitations cannot promote to
control. Control-capable invitations begin in watch mode and require an explicit
takeover. Reopening a link in the same browser can use its existing authenticated
cookie until the original expiry; it does not renew the lifetime.

Done, revocation, disconnect or absolute expiry retires the viewer. There is no
human-inactivity timeout. Heartbeats detect failed connections and abandoned
controller input actors; they do not measure whether the human is interacting.
Browser tabs, cookies and the profile persist after the viewer finishes.

The Cloudflare HTTPS tunnel is public network infrastructure. Its URL is not
itself an authorization boundary. Authentication belongs to Clawser’s viewer
protocol. Cloudflare is part of the transport trust boundary; do not use this
deployment if that is inappropriate for the data being viewed or entered.

The controller socket and state are private to the host user. CDP and VNC bind to
host loopback and must stay off the public network. The controller is the only
component that should connect the viewer to the private VNC backend. Never proxy
the Gateway, CDP or raw VNC endpoint to the public viewer origin.

## Browser and handback boundaries

The Docker runtime uses a dedicated profile volume, Chromium’s sandbox,
restricted capabilities, a read-only root filesystem and network restrictions.
It does not mount the host home directory or Docker socket into the browser
container. Local Docker access and the OpenClaw host account are trusted and
remain capable of bypassing these controls.

On handback, the controller fences incoming human input, retires the input actor
and checks its process/X client and held-input state. Writable handback also
requires a fresh browser observation before automation resumes. Uncertain
settlement keeps browser automation blocked. This does not prove previously
delivered browser events, navigation, downloads or remote requests have finished.

Coordination covers OpenClaw’s normal browser-tool path. It does not suspend
arbitrary shell tools, independent CDP clients or unrelated desktop operators.
Agents and operators must not use another route around the gate. A host or
browser compromise, browser exploit, malicious dependency or malicious website
can exceed the boundaries exercised by the test suite.

## Supported versions and verification

Security fixes target the latest tagged release. The initial validated desktop
platform is Linux x86_64 with Node.js 22+, Docker, user systemd and OpenClaw
2026.10.4+. Other host architectures and operating systems are unverified.

The prepublication security review covered the runtime/controller, authorization,
invitation lifecycle and handback behavior, with a focused 110-test suite and no
unresolved P0–P2 findings in that scope. This was a code review and targeted test
exercise, not a penetration test, independent certification or guarantee that no
vulnerabilities remain. Installation and packaging checks are additional release
work. CI uses disposable local browser fixtures and runtime adapters; ordinary
CI does not run the complete Docker desktop or test every physical phone.

Setup pins the downloaded cloudflared and noVNC versions and verifies their
SHA-256 checksums before use. The package does not bundle these downloads or a
prebuilt browser image. Release checksums detect archive changes relative to the
published checksum file; they are not an independent signature of the publisher.
