# Changes

## Unreleased

- Fix a way out of the browser for whoever holds a control link. The window manager on Clawser's virtual screen kept openbox's default menus and shortcuts. A right-click on the bare screen opened openbox's menu, which falls back to the system menu with a terminal in it, and keys such as Super+D (show desktop), Super+E (run a program) and Alt+F4 (close) still worked, so a person in control could open a terminal as the owner. Clawser's openbox config now keeps only focus and raise on click, Alt+Tab between windows, and moving or resizing a window with the mouse. It has no menu, command, desktop-switching, show-desktop, close or minimize action, and its menu is an empty file of Clawser's own. The generator handles a system `rc.xml` without openbox's namespace or without key and mouse sections, always writes both sections so openbox never falls back to its built-in Alt+F4, and checks its output against the allowlist on its own, refusing to write a config with anything else in it. Run `openclaw clawser setup --yes` once after upgrading: setup writes the new config and restarts the window manager, which leaves the browser and its tabs open. Until then the controller refuses control links with a message that says to run it, watch links still work, the Gateway log warns when the plugin starts, and `doctor` fails its new `window manager config` row. A setup run that stops after writing the new config but before restarting the window manager no longer counts as done: setup records the new config only once the window manager has restarted on it, the next run restarts it, and `doctor` fails while the running window manager is older than its config file.
- A noVNC handoff now ends once nobody has had it open for three minutes, with reason `abandoned`. Before, closing the tab or letting the phone sleep released control within about 20 seconds but kept the handoff, its x11vnc and the tunnel until the link expired, up to 30 minutes later. Reloading the page or a short network drop still reconnects to the same handoff. A link nobody has opened yet still waits for its expiry. `setup --viewer-idle-minutes N` changes the three minutes.
- The agent's browser can no longer open other programs on its screen. Chrome's Show in folder, opening a download, and accepting a `mailto:` or other protocol link start `xdg-open` or `xdg-email`, and Show in folder also asks the desktop's file manager over D-Bus. On the virtual screen that could open a file manager in front of whoever held control, or open a window on your own desktop. The browser now runs with refusing stand-ins for those launchers first on its `PATH`, in `<stateDir>/launchers`, and with no session bus. `setup --yes` writes them and restarts the browser once, and `doctor` checks them in a new `browser launchers` row. SECURITY.md now says what a control link can still reach: `file://` pages and Chrome's Save, upload and print dialogs read and write any file your account can, which only root-level Chrome policies would close.
- The noVNC tunnel now runs only while it is needed. Since 1.0.0 the controller started its public tunnel when it started and restarted it whenever it dropped, so the viewer was reachable from the internet around the clock, even with no handoff open. Now a link starts the tunnel, and it stops 10 minutes after the last handoff ends. Links inside those 10 minutes are as quick as before, but the first link after a quiet spell waits for the tunnel again, up to a minute. A dropped tunnel comes back only during a handoff or its 10 minutes. Two new setup flags change this: `--tunnel-idle-minutes N` sets the idle period, and `--tunnel always` brings back the always-on tunnel of 1.0.0. Setup remembers both. Doctor and setup now report the public transport as `on-demand` or `always-on`, as it actually runs.
- The docs, the plugin's config descriptions and a one-time Gateway log warning now say that in desktop mode the plugin's `port`, `publicBaseUrl`, `comparisonProxyUrl`, `funnel` and `cloudflare.enabled` settings do nothing. Only the CDP viewer reads them; the noVNC controller serves the viewer on the setup port with its own tunnel.
- The noVNC controller no longer keeps every handoff on record forever. It rewrote and synced the whole record on each change, and the list of finished handoffs it reports to the plugin would eventually have outgrown its 1 MB message limit. A finished handoff is now dropped an hour after the plugin has delivered its completion, however late that was, or a week after it ended if nothing ever did. A handoff that needs operator recovery is never dropped. The completion list now honours the plugin's limit of 50 at a time, oldest first, and the viewer forgets an ended handoff ten minutes after it ends.
- The plugin's list of ended agent sessions, which it uses to skip their handoff completions, no longer grows for as long as the Gateway runs. An entry now lasts an hour, longer than any handoff, the list holds at most 512, and it empties when the plugin stops. A session key that ended without an id therefore no longer silences a later session with the same key for good.
- A plugin generation that OpenClaw replaces without stopping it first now lets go of what it held. In noVNC mode it kept its connection to the controller, which accepts only 16, and its once-a-second completion check; a few such reloads could use up the controller's connections. It now stops the check and closes the connection, after any browser call still running on it finishes, so that call is never reported as uncertain. That includes a call whose admission was still on its way when the reload landed, and a call that finishes while a configuration change is revoking handoffs: its release now still reaches the controller, which used to keep it active and block the next take-control. In CDP mode the replaced generation kept its viewer listener, timers and cloudflared, and the listener held the port the new generation needed; it now closes them as a stop would.
- A cloudflared left running by a crashed or killed Gateway or controller no longer keeps an old public address pointed at the viewer. The tunnel now records its process as soon as it starts, and the next start stops that process first, but only when its command line shows it is Clawser's own cloudflared for the same state folder. The controller also checks for one when it starts.
- A supervisor restart or a host reboot during a noVNC handoff no longer locks the agent out of its browser. The restarted supervisor had no record of the handoff and refused to settle it, so the controller marked it `recovery_required` and paused every browser call, and the offline reconcile helper refused it too because the display had changed. Now the new supervisor proves that the handoff's viewer is gone and releases any key or button it held. For a control handoff the controller also takes a fresh look at the browser, and the handoff ends with reason `supervisor_restarted`. The controller waits up to 45 seconds for a supervisor that is still starting. When it starts, it checks again any handoff from an earlier supervisor boot that still needs recovery. A control handback that failed on the current boot still needs the operator, as before. The desktop runtime's operation lock is now taken over once the process that recorded it has exited. A controller killed in the middle of an operation used to leave the lock behind, and every later operation was refused until someone removed it.
- A Gateway restart or crash in the middle of a browser call no longer pauses browser automation for good. The call stayed `uncertain`, every controller start paused automation again because of it, and there was no supported way to clear it. Each call now records the Gateway process that made it. The controller clears the call once that process has exited, both when the controller starts and when the new Gateway's plugin connects. It never clears a call whose Gateway is still running. Calls that name no Gateway (Clawser 1.0.1 or earlier recorded none, and a Gateway whose process can't be checked, such as one in another PID namespace, records none either) are handled by a new offline command. Stop the controller, run `openclaw clawser recover` (try `--dry-run` first, and add `--abandon-calls` for those older calls after `openclaw gateway restart`), then start the controller again. See "After a restart, crash or reboot" in `docs/install.md`.
- A refused viewer connection is now closed rather than left half open, and stopping the viewer cuts any connection still open after two seconds, so a stuck client can no longer hold a connection slot or stall the shutdown and the tunnel teardown after it.

## 1.0.1

- New ClawHub and plugin descriptions that say what Clawser is for.
- The README install steps now let the agent install the plugin and run the setup dry run. The owner runs the `sudo` package command the dry run prints, then `setup --yes`.
- The README no longer lists a Node.js version. Clawser needs the same Node range as OpenClaw itself, and `docs/install.md` still states it. OpenClaw's opt-in Bun runtime is untested with Clawser.

## 1.0.0

- The first handoff link no longer waits for the secure tunnel. The controller now starts the tunnel when it starts, and starts it again a few seconds after it drops. Before, the first link after each restart waited up to a minute, while Cloudflare set up a new address.
- The agent skill now tells the agent to work the page itself before sending a link: close popups, scroll, retry another way, and read error messages. A link is the last resort. Once it does need one, it asks for the link right away.
- Text you paste into the agent's browser from your phone no longer stays on its clipboard after control ends. Before, a pasted password or code stayed there until the next paste or a restart, where the agent or a page could read it.
- The CDP viewer now gives each link its own request limits, as the noVNC viewer has since 0.7.5. Before, one limit of 100 requests a second covered the whole server, so a flood from someone without the link could stop the owner from opening the link, taking control or pressing Done.
- The README is shorter. It says what Clawser is for, how to install it from ClawHub, and how to use the viewer.

## 0.8.5

- Paste no longer shows a "Text pasted into the browser" notice. The text shows up in the field. A failed paste still says so.
- The Touch icon in the bar now shows two bent fingers beside the pointing one, so it reads as a hand.
- After you tap Copy or Paste in the small bar, it no longer pops back up a moment later.

## 0.8.4

- A tap on the agent browser's address bar now opens your phone's keyboard, with the layout for web addresses. In 0.8.0 to 0.8.3 the viewer opened it only when the page reported that it had lost focus. OpenClaw's own browser tool keeps the page reporting focus, so the keyboard did not open on most installs.
- Touch and hold now shows Paste, or Copy, while your finger is still down, as on Android. Lift to tap it. Slide instead and the bar gets out of the way while the hold drags, for example to select text. When you lift after a slide that selected text, Copy appears. A hold on the address bar offers Paste too.
- The "Holding… Lift to release" and "Hold released" notices are gone.

## 0.8.3

- On a Mac, the ⋯ sheet now names ⌘C and ⌘V. Chrome reports a Mac as macOS, and 0.8.2 didn't recognize that name. It showed Ctrl+C and Ctrl+V there instead. The shortcuts themselves already worked.

## 0.8.2

- The noVNC viewer now behaves like a desktop page when it is opened on a computer with a mouse. A click on the page closes the ⋯ sheet, as a tap does on a phone. In control, a click tucks the bar away and still clicks.
- On a computer, the bar no longer shows the Touch / Trackpad switch or the Keyboard button. Neither helps with a mouse and a real keyboard. A Trackpad choice saved on a phone does not carry over. A laptop with a touch screen keeps both, as a phone does.
- Copy and paste now work with the usual keyboard shortcuts on a computer. Ctrl+C or ⌘C copies the selection in the agent's browser to your computer. Ctrl+V or ⌘V pastes your computer's clipboard into the focused field. On a Mac, ⌘ works as it does in any other app. Other shortcuts, such as Ctrl+A, still go to the agent's browser unchanged. The ⋯ sheet names the shortcuts instead of the touch gestures.

## 0.8.1

- The bundled skill now tells OpenClaw that it runs only on Linux. `openclaw skills list` and `skills check` show it as unavailable on macOS and Windows, where setup refuses to install anyway. On Linux nothing changes.
- The skill names no required programs on purpose. The CDP viewer never runs x11vnc or python3, and the Gateway's PATH may not reach a Homebrew Xvfb. OpenClaw hides a skill whose programs it can't find, which would drop its consent rules on hosts where the tool still works. `clawser doctor` remains the check for the noVNC host programs.

## 0.8.0

- The noVNC viewer now has a bar built into the top edge of the screen. It replaces the floating panel and the side Controls tab. While you watch, the bar shows an amber eye on the left, Take control in the center, and ⋯ and Done on the right. In control, it shows a green pointer on the left, the Touch / Trackpad switch in the center, and Keyboard, ⋯ and Done on the right. Under ⋯ are zoom, a Fit or 100% toggle, Copy and Paste. Zoomed in, you can scroll the top of the browser out from under the bar.
- There is a new Trackpad mode, next to Touch in the center of the bar once you take control. Slide one finger to move an on-screen pointer, and tap to click at the pointer. Tap with two fingers to right-click, for example to open Chrome's menu and choose Translate. Tap, then touch and slide, to hold the button while dragging, and slide two fingers to scroll. The phone remembers the mode you chose.
- A tap on the page tucks the bar away so the whole browser is in view. That tap still clicks. A small tab at the top brings the bar back.
- The Drag once button is gone. Touch and hold already presses and drags, so it is no longer needed.

## 0.7.5

- Fix a way to block a handoff's owner. Each handoff had one budget of 30 requests a minute, charged before the cookie was checked. Anyone who learned a handoff's id could fill it with wrong guesses, and the owner's own requests, Take control, the stream and Done then failed for up to a minute at a time. They still could not see or control the browser. The gateway now checks the cookie or invitation first. A refused guess spends a guess budget of 30 a minute. A valid request spends a separate budget of 240 a minute, and Done spends none, so wrong guesses can no longer block the owner or the real invitation claim.
- Copy and Paste in the noVNC viewer now work as on a phone. Double-tap a word, or touch and hold, then drag, and a small Copy bar appears just above the finger. Touch and hold in a text field for Paste. A plain tap or an open keyboard no longer shows them. The bar goes away at the next touch, or once used. It replaces the larger floating buttons from 0.7.4.

## 0.7.4

- The noVNC viewer now opens the phone's keyboard when a tap puts the cursor in a text field, and picks the matching layout, such as a number pad for a phone number or a code. It closes the keyboard again when a tap lands outside a field, unless the owner opened it with the Keyboard button. A tap on Chrome's address bar opens it with the web address layout.
- After each tap, the viewer asks the gateway what the agent's browser has focused. The controller reads that from Chrome in an isolated script context, within 1.5 seconds. Only the kind of field and its keyboard type reach the viewer, never its contents, name or the page address. The check answers only while the owner holds control.
- These checks don't count toward the per-handoff limit on requests, so typing into a long form can't use it up. Requests with a wrong cookie still count.
- The Keyboard button still works everywhere. Use it when a tap doesn't open the keyboard: in Chrome's own dialogs and menus, while a JavaScript dialog is open, and on phones that only open a keyboard during the tap itself, such as iPhones.
- Take control now folds the noVNC viewer's controls away once control connects, so the whole browser is in view. The Controls tab at the edge brings them back. They come back on their own when control drops or the handoff ends, so Take control and the status line are in reach again.
- Copy and Paste no longer need the controls open. While the agent's browser has text selected, a Copy button floats over the browser. While the phone's keyboard is open, a Paste button sits above it and pastes without closing the keyboard. Each confirms with "Copied" or "Pasted".
- The focus check also says whether any text is selected, as a yes or no. The selected text itself never leaves the browser until the owner presses Copy. A selection in a password field doesn't count, since Chrome won't copy it.
- A double tap now selects a word. Chrome counts a double-click only when both clicks land within a few pixels, and two finger taps rarely do. A second tap within 400 ms and 12 pixels of the first now clicks exactly where the first one did.

## 0.7.3

- Fix handoff links that showed a black screen on some Android phones and then ended with "Viewer assets did not load in time". When noVNC 1.7.0 loads, it tests the browser's H.264 video decoder and waits for the result with no time limit. Some Android hardware decoders never answer, so the viewer never loaded and gave up after 12 seconds. The gateway now serves noVNC with a 2 second limit on that test. A decoder that hasn't answered counts as no H.264, and noVNC uses its other encodings. The gateway refuses to serve a noVNC whose test code differs from the pinned 1.7.0, rather than serving it with no limit.
- Opening a handoff link a second time in the same browser no longer ends the handoff. Only one viewer can hold the stream, so the second tab's stream was refused, and that tab treated the refusal as a failure and ended the handoff for both tabs. The owner saw "Viewer access ended" right away. The second tab now checks that the handoff is still live, says "This handoff is already open in another tab or window", and leaves the first tab connected.

## 0.7.2

- The skill now has the agent check the page is on the site the owner asked for, and fill only the fields a step requires. It asks the owner before it looks up saved details, such as a profile, contacts or memory, and before it reads a code from the owner's email or messages. It asks once per task, names the fields and the site, and uses them only there. Details given for one site or task don't carry over to another. A texted code can still come back as a chat reply, and the agent offers a handoff link for owners who would rather type it in themselves. It uses a code once and doesn't repeat or store it.
- Option B no longer moves keyring cookies by default. Moved cookies lose the keyring's encryption and are protected only by file permissions, so the move is now opt-in with `--migrate-cookies`. Without it, setup warns how many cookies won't carry over. An export that a failed import left behind still resumes on a rerun, since it may be the only readable copy of those logins; `--no-migrate-cookies` removes it.
- Option B refuses a browser profile folder that other users can read, before it stops anything. It used to warn and carry on. Run the `chmod 700` it prints, then rerun setup.

## 0.7.1

- Fix setup reruns on a noVNC install. Setup restarts the controller and then reloads the plugin, but the old plugin's shutdown tried to end open handoffs over its connection to the controller, which the restart had already closed. The shutdown failed, OpenClaw refused to swap the plugin, and handoffs stayed unavailable until the Gateway restarted. Shutdown now retries once over a new connection, since the controller keeps its handoff records on disk. A timeout is never retried, and a controller that still can't be reached fails as before. A host that already hit this in 0.7.0 needs one `openclaw gateway restart` after upgrading.

## 0.7.0

- Make noVNC on the host the default handoff. Setup gives the agent its own Google Chrome, or Chromium, on a private virtual screen run by five user services. A link shows the whole browser window and every tab, so native dropdowns, date pickers, file choosers, dialogs and popups work from a phone.
- Remove the Docker desktop. Clawser no longer builds an image, runs a container or needs Docker. The display, window manager, browser, supervisor and controller run as systemd user services. Setup needs Xvfb, x11vnc, python3 and four X client libraries: libX11, libXRes, libXtst and libXi. It recommends openbox. It installs none of them and prints the distro command for anything missing.
- Remove the `--container-name`, `--cdp-port`, `--vnc-port` and `--no-default-profile` flags. Passing one now fails. The standalone `bin/clawser.mjs` prints: "<flag> was removed in 0.7.0 along with the Docker desktop".
- Rerun setup after upgrading: run `openclaw clawser setup --dry-run`, then `openclaw clawser setup --yes`. A CDP install switches to noVNC with the browser profile it already uses. That profile must point at `127.0.0.1`; setup refuses `localhost` before it stops anything. A Docker desktop install converts to a new browser profile, and setup prints the Docker commands to remove its leftovers. Setup does not run them. A `git:` install moves the plugin folder, so rerun setup after every upgrade.
- Add option B, `--browser-profile <name>`, which hands an existing OpenClaw browser profile to Clawser and keeps its logins. It closes that browser, or takes over the user services that run it, only with `--yes`. Cookies encrypted with the desktop keyring move into the new browser over CDP. Sign in to Google once and re-save site passwords afterwards. `--no-migrate-cookies` skips the move.
- Keep the one-tab CDP viewer behind `setup --cdp`. Doctor tells an older CDP install to "run setup to switch to noVNC, or setup --cdp to keep the CDP viewer".
- Add doctor rows for the host install: `services`, `display`, `browser window`, `CDP origin`, `profile directory`, `linger` and `units current`. Option B installs also get `cookie store` and `cookie export` warnings.
- The noVNC viewer's Copy and Paste buttons now work through a small built-in clipboard helper, so the clipboard needs no extra package.
- Make handoffs work on hosts whose desktop session runs Wayland.
- Restart the agent's browser when a package upgrade replaces Chrome underneath it. A browser left running from the deleted binary could stop answering CDP, so every browser call hung. The supervisor waits until no handoff is in progress.
- Tell agents to fill in what they already know and trigger codes themselves before asking the owner for anything. A code texted to the owner's phone is now asked for as a chat reply, and a handoff link is only for steps the owner must do in person, such as a CAPTCHA. Agents had been sending a takeover link to "complete phone verification" when they could enter the saved number, press Send code, and ask only for the code.

## 0.6.3

- Route an ordinary browser call that omits `target` to the host browser instead of refusing it. OpenClaw's browser tool tells agents that `target` defaults to the host, so agents left it out and every first call failed with "Browser access requires target=\"host\"". Explicit sandbox or node targets, other profiles and endpoint overrides are still refused, and non-owners are still blocked.
- When an agent asks to list or manage browser profiles, the refusal now names the call to make instead: `action="tabs"` with `target="host"` and the configured profile.

## 0.6.2

- Accept a CDP installation that moved to a new directory. OpenClaw installs each Git tag into its own directory, so every Git upgrade failed setup and doctor with "Refusing unowned or incompatible CDP setup receipt". The receipt no longer records the package directory. noVNC still requires its original directory; install it from the release archive.
- Add a short upgrade section to the README and update the installation guide to match.
- Includes the 0.6.1 changes. ClawHub never published 0.6.1 because its hosted scanner failed before returning a verdict.

## 0.6.1

- Keep control in the CDP viewer when a tap, key or typed text takes the tab to another site. The input had already landed; only the follow-up read of the old page failed, and that dropped the phone back to watch mode on every cross-site link.
- Fit the whole shared page on screen in the CDP viewer by default. Wide screens, such as a phone held sideways or a desktop browser window, no longer cut off the bottom of the page. Zoom still enlarges from there.
- Tell agents that tool results are JSON text to parse before reading `url`. In Codex code mode an agent read `url` from the unparsed string and sent the owner a link that said "undefined".
- Close the stdin of host display smoke-test processes with a pipe instead of ignoring it. This keeps the release clear of a ClawHub static-analysis false positive.

## 0.6.0

- Support real press-and-hold from a phone in the noVNC viewer. A finger held still for 250 ms presses the remote button, later movement is sent while it is held, and lifting releases it. A quick tap is still one click, and a swipe still scrolls. Pinch, a hidden page, loss of control, Done and disconnect release the button.
- Keep a noVNC handoff alive when the phone's connection drops, for example when switching apps for a 2FA code. Input is fenced and settled as on Done, the invitation stays valid until it expires, and the same link reconnects in watch mode. Control requires Take control again. Done, revoke, expiry and VNC server failures still end the handoff.
- Add host display dependency resolution for the upcoming host noVNC backend. It is off by default and does not change setup or doctor in this release.

## 0.5.0

- Make the existing configured default attach-only Chromium CDP connection the standard setup path. Reuse its selected tab without launching a browser, creating a Chrome profile, copying cookies or falling back to another endpoint.
- Add a separate private CDP setup receipt, checksum-pinned cloudflared installation and read-only doctor checks for ownership, executable integrity, current browser binding, local viewer and public tunnel readiness. Keep Docker/noVNC desktop setup behind `--novnc`.
- Require native verified-owner authority for both ordinary browser tools and handoffs, with a declared trusted-tool policy, explicit host routing, current configuration binding and fail-closed endpoint/profile restrictions. Retire shares when browser/plugin configuration or group authorization changes.
- Separate service preparation from activation during native hot reloads; require a fresh matching published configuration, generation-safe readiness diagnostics and local backend checks before setup reports success.
- Recover stalled Chrome screencast painting with bounded, reader-demanded discarded viewport captures, without retrying input or changing browser geometry.
- Support explicit mobile Keyboard control of the focused opaque/cross-origin frame, with bounded capabilities revoked on navigation, stale state or loss of control. Keep passive metadata value-free and never replay uncertain input.
- Report backend-specific scope and handback: CDP shares one tab with active waits; noVNC shares a whole profile and requires `resumeAllowed=true`. Preserve existing browsers, tabs, profiles and strict desktop ownership across mode changes.

## 0.4.2 (included in 0.5.0)

- Generate new controller user units with `KillMode=mixed` so service stop preserves singleton authority through graceful input retirement, with bounded cleanup of remaining processes.
- Keep read-only desktop status checks independent of the mutation lock while retaining ownership validation, so diagnostics cannot block handback at that lock.

## 0.4.1

- Add explicit offline operator reconciliation for a failed control handback, retaining strict input-fence and fresh-observation checks without restarting the browser.
- Record bounded retirement failure codes for RPC, receipt, observation and journal boundaries without exposing raw errors.
- Dismiss the existing-tab viewer’s More controls on outside mouse or touch input while preserving remote clicks, typing and inside controls.
- Clarify that standard setup uses the same noVNC full-browser viewer across authorized channels; existing-tab CDP is an explicit compatibility mode, with no automatic fallback or browser-state transfer.

## 0.4.0

- Add explicit owner-authorized group handoffs with native sender and conversation checks; private access remains the default.
- Share existing browser tabs through optional Cloudflare transport and preserve healthy service ownership during cold tool discovery.
- Document group delivery scope and the existing-tab completion contract.

## 0.3.5

- Simplify JavaScript string construction and input-operation definitions for complete SkillSpector inspection.
- Preserve browser protocol text, key dispatch, input validation and setup escaping with regression coverage.

## 0.3.4

- Verify read-only cleanup independence from active automation without assuming disk writes finish within 100 milliseconds.

## 0.3.3

- Isolate browser-module loading from VNC readiness deadlines in the disposable CI fixtures.

## 0.3.2

- Prepare the scoped `@pengying/clawser` package for ClawHub distribution.
- Declare the tested OpenClaw build version required by registry validation.
- Retain the `browser-handoff` runtime ID and `browser_handoff` tool for existing configuration.

## 0.3.1

- Prepare Chrome program files before CI browser fixtures to handle slow file loading on fresh runners.
- Retain first-launch timing and bounded process diagnostics for CI investigations.

## 0.3.0

- Publish Clawser as a standalone OpenClaw plugin with versioned GitHub installs and release archives.
- Add explicit setup and doctor commands, pinned dependency checksums, managed private service configuration, and ownership-aware repeat runs.
- Preserve the active service lifecycle when OpenClaw cold-loads tool discovery.
- Add package validation and automated CI/release checks.

## 0.2.0

- Add persistent sandboxed Chromium/Xvfb with full browser chrome, tabs and native
  dialogs. Each human input epoch has a separate supervised VNC process.
- Add a full-screen viewer with movable/collapsible controls, native-size fit,
  mobile pinch/pan, continuous touch scrolling, Drag once and Unicode keyboard.
- Add control-only UTF-8 clipboard transfer and manual clipboard fallback; keep
  controls usable above mobile keyboards in portrait and landscape.
- Add durable browser-tool admission, asynchronous input retirement, verified
  process/X-client/key/button fences and post-handoff browser observation. Done
  preserves the browser/profile; uncertain outcomes keep automation paused.
- Add the private controller, startup singleton lock, independent input watchdog,
  on-demand Cloudflare transport and public DNS/HTTP readiness verification.
- Add owner-private OpenClaw link creation, safe waits, cancellation-aware session
  completion notifications and a skill for manual CAPTCHA/form intervention.

## 0.1.15

- Let noVNC control its canvas dimensions so visible pixels and pointer coordinates
  use the same scale. Bound the surrounding layout to the viewport.
- Add real RFB pointer-coordinate coverage for wide, tall, narrow, high-DPI and
  resized viewers.
- Add an explicitly opted-in synthetic LAN comparison mode with an exact private
  IPv4 address/port binding. Default HTTPS/loopback behavior is unchanged.
- Keep numeric byte, buffering and ping/pong timing diagnostics in owner status,
  plus an authenticated Funnel ingress observation. Never record screen/input data.

## 0.1.14

- Add an opt-in route for an independently authenticated, disposable noVNC
  comparison browser. Existing CDP handoff remains the default.
- The comparison starts with a server-enforced view-only credential, requires
  explicit takeover, and destroys its owned browser on Done, expiry or an
  unexpected disconnect. It does not return that browser to an agent.
- Bound startup, promotion and connection attempts; preserve cleanup-only access
  after failed destruction so Done can retry. Coordinate late creation with
  expiry/shutdown and retain ownership until exit is verified.
- Preserve the existing Funnel origin/port through a fixed loopback-only optional
  proxy. No public API can create a container or choose its upstream endpoint.

## 0.1.13

- Before clicks, scrolling and gesture starts, restore a minimized Chromium
  window and request one repaint before dispatching the original input. Normal
  windows skip the repaint; typing and gesture continuations avoid an additional
  window-state round trip. Uncertain input remains blocked and is never replayed.
- Bound viewer startup and state requests, prevent overlapping periodic polls,
  and discard stale connection responses. Temporary transport/server errors
  remain retryable; reconnection requires explicit takeover again.
- Add regressions for renderer readiness and connection lifecycle, plus an
  environment/lifecycle reliability matrix and a noVNC migration assessment.

## 0.1.12

- Defer native touch contact until movement establishes a swipe or drag. Stationary
  phone taps use atomic clicks at the original contact point, avoiding a reproduced
  Chrome touchStart stall when the target becomes hidden or minimized.
- Keep native touch gestures, synchronous phone-keyboard activation, tap slop,
  picker behavior and fail-closed input handling intact.
- Preserve recovery-required state across polling, frames, reconnect, expiry and
  Done. Disable takeover and refuse new control links while the gate is poisoned;
  watch-only diagnostic links remain possible.
- Report capture loss during active/held input as uncertain recovery before closing
  the viewer. Preserve the first failed CDP command alongside the pending command
  and safe input kind/phase, without command parameters.

## 0.1.11

- Add phone-side select/multi-select and classic RGB color controls. Keep passive
  metadata value-free; requested picker descriptors expose only visible labels,
  selection and current color. Validate one-use capabilities against current node,
  focus, document, options and value before applying native input/change events.
- Keep color hex entry and Apply/Cancel usable with Android's landscape keyboard.
  Ignore detached old picker handlers and obsolete responses. Cancel and unchanged
  choices do not mutate field values or emit unnecessary change events.
- Permit up to four input packets in flight while retaining serial execution,
  bounded batching/coalescing and per-packet acknowledgement timers. A failed input
  latches the stream closed before queued successors run; reconnect never replays
  input or silently reacquires control. Display updates progress between packets.

## 0.1.10

- Pace images and interaction metadata using acknowledgement from the viewer.
  Keep one display update in flight and replace old unsent frames with the latest
  view, so tunnel buffers cannot accumulate a long sequence of stale images.
- Send control replies before new display updates; coalesce unchanged metadata
  while preserving idle field-map freshness. Reconnect in watch mode if an image
  cannot decode. Preserve focus ordering when decoding is delayed.
- Retain bounded numeric timing aggregates in owner-private status, including
  after Done or expiry, to distinguish server work from viewer/network delays.
- Close recipients whose outbound buffer exceeds the safety ceiling rather than
  dropping control replies or growing the reply queue without limit.

## 0.1.9

- Reduce typing backlog over slower connections by sending up to eight already
  queued small edits together. Preserve individual native browser input events,
  focused-field validation, and one acknowledged packet in flight.
- Keep large pastes and Enter/navigation keys as separate ordered operations.
  Stop the remaining batch on changed focus, handback, expiry, disconnect, or
  input failure; keep uncertain browser outcomes blocked for operator recovery.

## 0.1.8

- Tolerate minor finger drift before treating a touch as a swipe, so normal taps
  can open the phone keyboard even with a desktop page scaled into the viewer.
- Map screenshot coordinates and editable fields consistently under remote page
  zoom/pan and scaled same-origin iframes. Clip iframe field metadata to the
  visible content so hidden fields cannot block typing into a visible field.
- Commit native Backspace once from its actual input event, and restore the
  proxy caret before deletion when Gboard resets it. Preserve composition and
  confirmed-field checks.

## 0.1.7

- Enable Take control only after the current stream confirms readiness and
  delivers a frame. Disable it throughout disconnect/reconnection, including
  when an old image finishes decoding after the socket closes.
- Replace the obsolete opening-page error with a stream-readiness explanation.

## 0.1.6

- Open valid invitations directly into the live watch view, with no landing page
  or opening button. Keep Take control explicit and show invalid-link errors.
- Resume existing viewer cookies automatically when reopening the same link.

## 0.1.5

- Contain rejected browser connection closes after uncertain input or failed
  gesture cancellation instead of allowing an unhandled rejection to restart
  the Gateway. Browser automation remains blocked when input is uncertain.
- Continue capture cleanup and detach the transport even if input cancellation
  fails. Record the failed browser command name without input parameters.

## 0.1.4

- Resume an existing authenticated viewer when its original invitation link is
  reopened. Keep claims single-use and preserve the original expiration.
- Request the initial Chromium paint for static background tabs, preventing a
  connected viewer from waiting indefinitely for its first frame without taking
  focus from the active tab.

## 0.1.3

- Persist a private write-ahead Funnel ownership receipt before creating a route.
  Gateway restarts recover only the exact unchanged route recorded by this plugin.
- Refuse unreceipted routes, quarantine ownership on observed configuration drift,
  and verify route removal before clearing recovery information.
- Bind ownership storage to the Gateway's stable service state directory and
  preserve transport cleanup when local listener cleanup fails.
- One-time exact-checked operator cleanup is required for legacy unreceipted
  routes; unrelated Tailscale services are never reset.
- Includes the reviewed native interaction and full-screen viewer from 0.1.2.
  Physical-phone acceptance remains pending.

## 0.1.2

- Direct phone-keyboard bridge with focus-bound edits, Backspace and IME support;
  existing field contents are not returned to the viewer.
- Bounded native pointer gestures for sliders and page dragging, with acknowledged
  gesture cleanup before the agent can resume on release, disconnect, or expiry.
- Reconnect waits for the previous stream's gesture cleanup before attaching.
- Suppress touch compatibility focus changes so a tapped field retains keyboard
  focus; defer uncancelable keyboard commits to input and reject unsafe replacements.
- Ordinary links/images retain touch scrolling; only explicitly draggable regions
  automatically select the mouse path.
- Mouse taps use atomic clicks; movement starts a click-ineligible mouse drag,
  allowing a matching left-button cleanup to release page capture without a click.

Candidate only: native interaction review, activation, and physical-phone acceptance
are required before calling this release production-verified.

- Edge-to-edge mobile viewer with floating controls and collapsible keyboard panel.
- Local pinch/button zoom, fit-width reset, two-finger pan, optional browser fullscreen.
- Acknowledged input flow control prevents rapid scrolling from overflowing the
  server queue and releasing human control. Adjacent scrolls are coalesced while
  click/text/key ordering is preserved.
- Definitive input rejection clears the pending acknowledgment state so another
  action can proceed; uncertain input still locks agent automation fail-closed.
- Expanded disposable-browser coverage includes latency/burst scrolling, pinch,
  landscape, overlay controls, and error recovery. Physical-phone recheck pending.

## 0.1.1

- Reject legacy HTTP/RPC tools.invoke browser calls before admission because
  affected runtimes do not emit completion hooks for that path. Use the normal
  session browser tool. Exact session/run isolation and admission counts remain.
