# Changes

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
