# Persistent desktop implementation plan

**Goal:** Keep the browser, tabs and profile alive across bounded human input leases.

**Architecture:** The host runs Xvfb, openbox and the agent's Chrome as systemd user services. A supervisor service owns short-lived x11vnc process groups, one per viewer session, each on a private Unix socket. Native XRes client identity observations, process reaping and XTest/XSync form the handback barrier. The host adapter exposes structured operations over the supervisor's control socket.

**Tech Stack:** Node.js, Python 3 with ctypes, Xlib/XRes/XTest/XInput2, Xvfb, openbox, Chrome or Chromium, x11vnc. Host packages come from the distribution.

1. Write and run failing supervisor, clipboard and X proof tests against a throwaway Xvfb.
2. Implement the supervisor with bounded commands, private sockets and display/browser generations.
3. Write failing tests for actor identity, held-input settlement and clipboard ownership.
4. Implement the ctypes identity, settlement and clipboard helpers so hosts need no compiler or xclip.
5. Run an end-to-end setup on a disposable host: a watch and a control session over the private socket, no TCP listener, and held input released by settlement.
6. Record results and limits in README.md. Never touch an existing profile or user service in tests.
