# Clawser

**Step into your OpenClaw agent's browser from your phone, then hand it back.**

Agents get stuck on CAPTCHAs, logins, 2FA prompts and "are you sure?" pages
that need a person. Clawser lets the agent send you a private link. Open it in
your phone's browser, take control, do the one step, and press **Done**. The
agent checks the page and carries on.

There is no app or VPN to install. The link opens over HTTPS from anywhere.

## Install

You need a Linux x86_64 host running OpenClaw 2026.10.4 or newer.

Ask your agent in your private owner chat:

> Install the ClawHub plugin @pengying/clawser and run its setup dry run.

The agent installs the plugin after you approve its declared capabilities. It
then runs `openclaw clawser setup --dry-run`, which checks the host and changes
nothing. Two steps stay with you:

1. **Host packages.** Clawser needs Xvfb, x11vnc, python3, a few X libraries
   and Google Chrome. The dry run prints the exact command for your
   distribution, and the agent passes it to you. It needs `sudo`, so run it
   yourself. For example:

   ```sh
   sudo apt install xvfb x11vnc openbox python3 libx11-6 libxres1 libxtst6 libxi6
   ```

2. **Setup.** When the dry run is clean, run:

   ```sh
   openclaw clawser setup --yes
   openclaw clawser doctor
   ```

   Setup restarts the agent's browser and reloads the plugin, so run it between
   tasks rather than asking the agent to run it mid-conversation.

To do it all by hand instead:

```sh
openclaw plugins install @pengying/clawser --accept-capabilities
openclaw clawser setup --dry-run
openclaw clawser setup --yes
openclaw clawser doctor
```

By default the agent gets a new browser profile with no logins. You sign in to
sites through a handoff link the first time. To keep the logins of a profile
OpenClaw already uses, add `--browser-profile <name>`.

**Upgrade** with `openclaw plugins update browser-handoff`, then run
`openclaw clawser setup --yes` again.

## Use it

Ask your agent as usual. It handles the page itself where it can. When it is
truly stuck on a step only you can do, it sends you a link and says what it
needs.

1. Open the link. You start out watching.
2. Tap **Take control** and do the step.
3. Tap **Done**. The agent takes a fresh look and continues.

On a phone:

- **Touch mode** works like a phone: tap to click, swipe to scroll, pinch to
  zoom. Touch and hold, then slide, to drag or select text.
- **Trackpad mode** moves an on-screen pointer. Tap to click, tap with two
  fingers to right-click, and slide two fingers to scroll.
- **The address bar** opens your phone's keyboard when you tap it.
- **Copy and Paste**: touch and hold offers Paste, or Copy when text is
  selected. Only plain text moves.
- **The top bar** tucks away while you work. Tap the small tab to bring it back.

On a computer, the mouse works directly, and Ctrl+C / Ctrl+V or ⌘C / ⌘V copy
and paste between your clipboard and the agent's browser.

## What to know

- **A link shows the whole browser**: every tab, dialog and menu. The agent's
  browser is its own Chrome on a hidden screen, not your everyday browser.
- **Links are one-use and private.** One device can open a link, and it expires
  after five minutes by default. Don't forward it.
- **The first link after a restart can take up to a minute** while the secure
  tunnel comes up. Later links are quick.
- **You do the step yourself.** Clawser never solves CAPTCHAs, types passwords
  you haven't given, or promises a site will accept the result.
- **Use a machine you don't share.** Other accounts on the same machine can
  reach the agent's browser.

## More

- [Installation and maintenance](docs/install.md): requirements, setup options,
  the one-tab CDP viewer, group chats, undoing setup and recovery.
- [SECURITY.md](SECURITY.md): the trust model and how to report a problem.
- [CONTRIBUTING.md](CONTRIBUTING.md): development and release checks.

The package is `@pengying/clawser`, the plugin ID is `browser-handoff`, and the
agent tool is `browser_handoff`. Licensed under [MIT](LICENSE). Third-party
runtime licenses are in [runtime/desktop/NOTICE.md](runtime/desktop/NOTICE.md).
