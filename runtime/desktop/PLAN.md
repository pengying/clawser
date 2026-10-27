# Persistent desktop implementation plan

**Goal:** Keep the browser, tabs and profile alive across bounded human input leases.

**Architecture:** A dedicated container owns persistent Xvfb and ordinary Chromium. Its UID 1000 supervisor owns short lived x11vnc process groups. Native XRes client identity observations, process reaping and XTest/XSync form the handback barrier. The host adapter exposes structured operations and private ownership receipts.

**Tech Stack:** Node.js, Python 3, Docker, Xlib/XRes/XTest, Xvfb, Chromium, x11vnc.

1. Write and run failing adapter contract tests (validation, exact Docker ownership, stdin clipboard).
2. Implement adapter with bounded commands, exclusive operation locks, persistent volume and loopback bindings.
3. Write failing real integration tests requiring persistent tabs, Unicode clipboard, XRes actor identity and clean settlement.
4. Implement native identity/settlement helper and persistent supervisor; build dedicated image.
5. Run integration tests in an owned dedicated network/container; verify public internet, blocked private egress, browser chrome and no held inputs after handback.
6. Record exact results and isolation limitations in README and dedicated artifacts. Do not touch prototype resources.
