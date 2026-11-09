# noVNC viewer: top bar and Trackpad mode

## Why

The noVNC viewer is the phone page the owner opens from a handoff link. It
shows the agent's whole Chrome window, which runs on a virtual screen
(1920 × 1080), shrunk to fit the phone.

Two problems came out of real use on 2026-11-08.

**Small targets are hard to hit.** At Fit on a 412 px wide phone, one phone
pixel covers about 4.7 desktop pixels. A native radio button is about 3 phone
pixels across. Chrome's tab strip is about 9 phone pixels tall, and a tab
only switches inside a band about 6 px tall. The owner tried to switch tabs
and pick a radio button and both missed. A loopback test showed every tap
was delivered and clicked exactly where it landed. Nothing was lost. The
finger is just too coarse at that scale.

**There is no right click.** The owner wants to right-click a Chinese page
and pick Translate to English. The viewer only ever sends the left button.

On top of that, the owner finds the controls panel utilitarian. The hidden
"Controls ›" tab is 86 × 44 px, which feels large.

Input already reaches the desktop as real mouse events. The viewer turns
touches into mouse events on noVNC's canvas. noVNC sends them to x11vnc over
RFB, and x11vnc injects them into the X server. CDP is used only for the
read-only focus check. So adding a right button and a pointer mode is a
viewer change only. The server, gateway and x11vnc stay as they are.

Priorities, in order: reliability (the human can always finish the step),
ease of use from a phone, responsiveness.

## Goals

1. A **Trackpad mode** with an on-screen pointer the owner moves like a laptop
   trackpad. It gives precise aim at Fit, and right click.
2. A **Touch / Trackpad switch** that is always one tap away while in control.
3. A **sleeker control bar** built into the top of the screen, replacing the
   floating panel, the ⠿ move handle and the side "Controls ›" tab.

## Non-goals

- No change to the CDP viewer (`public/index.html`, `viewer.js`). This is
  the noVNC viewer only (`public/probe.html`, `probe.js`, `probe.css`).
- No change to how input reaches the desktop. No new server messages, no
  x11vnc flags, no new RFB features.
- No new keyboard features. The Keyboard button and its auto-open behave as
  today.
- No light theme.

## Anti-goals

These would make it a failure even if it technically works.

- **Touch mode gets worse.** Touch is the default and must keep every
  behavior it has today: tap, double tap to select a word, swipe to scroll,
  pinch to zoom, pan when zoomed, touch-and-hold then drag, the Copy and
  Paste pill, and keyboard auto-open.
- **The owner can't find the controls.** Done and Take control must always
  be reachable. The hidden tab must be easy to hit.
- **A mouse button is left held down.** Every path that ends a gesture or a
  session must release any button that is down. That includes pinch, a
  hidden page, losing control, Done and disconnect. This already holds for
  touch-and-hold and must hold for Trackpad drags too.
- **Taps on the bar leak to the page.** A tap on any bar, sheet or tab
  control must never also reach the remote browser.

## The control bar

The owner picked the layout from mockups. Here is what they decided. The
final mockup is next to this file: `2026-11-08-viewer-top-bar-mockup.html`.
It draws every state at real phone size (412 × 915), and frame 3 animates
hiding and showing. Its icons and colors are the reference for the look.

### Shape and placement

- The bar is built into the top edge of the viewer page. It sits flush
  against the top with square top corners. Only the bottom-left and
  bottom-right corners are rounded, about 20 px.
- It spans the full width.
- **No grabber line** on its bottom edge.
- **Tight padding.** A 40 px row of controls with about 4 px above and
  below, so the bar is about 48 px tall plus the top safe-area inset.
- Same dark glass look as the mockup: a translucent dark fill, a background
  blur, a faint border, and a soft shadow underneath.

### The bar overlays the page

The owner decided the bar and the hidden tab float over whatever is
beneath them. Showing or hiding the bar never changes the zoom or moves the
remote screen. `#viewport` keeps filling the whole screen, as today.

- **A tap on anything in the overlay never reaches the page.** That covers
  every bar button, the status icon, empty space in the bar, the ⋯ sheet
  and the hidden tab with its full 44 × 44 tap area. The owner asked for
  this explicitly.
- At Fit in portrait, the remote screen sits in the middle of the phone,
  so the bar covers nothing. In landscape, or zoomed in and panned to the
  top, it covers the top of the remote screen, which is Chrome's tab strip.
  In control, a tap on the page hides the bar, so the strip is one tap away.
- When zoomed past Fit, the scroll area gets extra room at the top equal
  to the bar's height. The owner can then pan the top of the remote screen
  down below the bar, without the view zooming. (My call, see below.)

### Narrow phones

On a 412 px phone, the In-control row fits with exact centering. On
narrower phones, about 360 px, it may not. Give way in this order:

1. Tighten gaps between the right-side buttons, keeping 44 × 44 tap areas.
2. Only then let the center control drift off exact center.

Done keeps its text label. It is the one action that must never be
mistaken.

### Contents

The bar has three columns. Status on the left, one main control in the
exact center of the screen, everything else on the right. The center column
is centered on the screen, not on the leftover space.

| State | Left | Center | Right |
| --- | --- | --- | --- |
| Watching | Amber eye icon | **Take control** (accent green) | ⋯, Done |
| In control | Green pointer icon | **Touch / Trackpad** switch | Keyboard, ⋯, Done |

The owner asked for icons instead of the words. Each status icon sits in a
round tinted badge, amber for watching and green for in control. Its
accessible name is "Watching" or "In control", so screen readers still
hear the state. A tap on it does nothing.

The switch is a two-part segmented control with a hand icon (Touch) and a
trackpad icon (Trackpad). The active half is filled with the accent green.

If the owner's link is watch-only, Take control stays disabled as today.

### The ⋯ menu

Tapping ⋯ makes the same sheet taller. It is not a separate popup. It adds
one row of icon buttons:

- Zoom out, the current level (for example "Fit" or "150%"), Zoom in.
- Fit / 100%, one button that toggles between them.
- A gap, then Copy and Paste.

Under the row is one line of help for the current mode. In Touch it reads
roughly "Swipe to scroll · pinch to zoom · hold, then drag". In Trackpad it
describes the Trackpad gestures.

A tap on ⋯ again closes it. **A tap on the page while ⋯ is open only
closes the sheet.** It does not hide the bar and does not click. The owner
agreed. This is the one exception to "a tap on the page also does what it
normally does".
In Trackpad mode a click would land at the pointer, not under the finger,
so a tap meant to close a menu could press something the owner never aimed
at.

### Hiding and showing

- **Tapping the page hides the bar** while in control. The bar slides up
  into the top edge with a short animation.
- What's left is a small tab hanging from the top center, about 48 × 18 px,
  the same shape as the bar in miniature, with a ⌄ chevron. Its tap area is
  at least 44 × 44 px.
- **Tapping the tab** slides the bar back down. Pulling the tab down should
  work too.
- **While watching, the bar never hides.** Take control is the only thing
  to do. (Builder note: this is my call, see "Calls I made".)
- When control connects, the bar hides on its own, as the panel does today.
  Losing control brings it back with Take control in reach, as today.
- Respect reduced motion. With `prefers-reduced-motion`, show and hide
  without the slide.

### Status messages

Today, status text lives inside the panel. With the bar, short messages
like "Copied to this device", "Holding… Lift to release" or "Reconnecting in
watch mode…" show as a small pop-up just under the bar or tab, then fade
after a few seconds. Messages that need action stay until resolved. They
show whether the bar is visible or hidden.

The status element must stay an `aria-live` region so screen readers still
hear it.

### What is removed

- The floating 310 px panel, its ⠿ move handle and keyboard moving.
- The "Controls ›" side tab and the ‹ collapse button.
- **Drag once.** Touch-and-hold (250 ms) already covers sliders, text
  selection and press-and-hold challenges, and Trackpad adds tap-then-drag.
  The owner agreed it isn't needed.
- The long help paragraph. Its content moves to the one-line hint in ⋯ and
  the first-time Trackpad hint.

### What stays

- The Copy / Paste pill that appears just above the finger after a
  selection or a hold in a field. It is separate from the bar.
- The clipboard dialog and keyboard input as they are.

## Trackpad mode

The owner approved this behavior before the UI work started.

### The pointer

- An on-screen pointer drawn by the viewer at phone size, about 15 × 21 px,
  black with a white outline. It stays the same size at every zoom, so it is
  visible at Fit.
- The pointer's tip is the exact point that clicks. The viewer tracks it in
  desktop coordinates.
- It appears only in Trackpad mode and only while in control.
- When the owner switches to Trackpad, the pointer starts where they last
  tapped, or at the center of the visible area if there is no recent tap.

### Gestures

| Gesture | Result |
| --- | --- |
| One finger slide | Moves the pointer. Relative, like a laptop trackpad. |
| One finger tap | Left click at the pointer. |
| Two quick taps | Double click at the pointer. Both clicks land on the same spot. |
| Two finger tap | **Right click** at the pointer. |
| Tap, then touch and slide | Left button held while sliding. Lift to release. For sliders, text selection, drag-and-drop. |
| Two finger slide | Scrolls the page under the pointer. |
| Pinch | Zooms the phone view, as in Touch. |

- **Acceleration.** Slow finger movement moves the pointer slowly for
  precise aim. Fast movement covers more ground, so a quick flick crosses
  the screen. At slow speeds, one phone pixel of finger travel should move
  the pointer about one phone pixel on screen, whatever the zoom.
- **The view follows the pointer when zoomed.** If the pointer nears the
  edge of the visible area, the view pans so the pointer stays in sight.
- **Pointer moves are sent to the desktop.** Hover effects, tooltips and
  menus that open on hover should work.
- **Right click** must open Chrome's context menu at the pointer, including
  Translate to English on a foreign-language page.

### Shared behavior with Touch

- After a left click, the same focus check runs as in Touch, so the keyboard
  opens for text fields and the address bar.
- The Copy / Paste pill appears after a selection made with a double tap or
  a held drag, near the pointer.
- The Keyboard button, Copy and Paste in ⋯, and the clipboard dialog work
  the same in both modes.

### Switching and memory

- The phone remembers the last mode, Touch or Trackpad, across handoffs on
  the same phone. Touch is the default the first time.
- The first time the owner switches to Trackpad, a short hint shows the
  main gestures: "Slide to move the pointer. Tap to click. Two‑finger tap to
  right‑click."

## Hard constraints

- **Release every held button.** Reuse today's release paths for pinch,
  `visibilitychange`, loss of control, Done and disconnect, and extend them
  to the right button and Trackpad drags.
- **noVNC 1.7.0 stays pinned.** Use its existing mouse event path. A right
  click is a synthetic `mousedown` / `mouseup` with `button: 2` and
  `buttons: 2`. noVNC converts that to RFB button 3 through
  `RFB._convertButtonMask`. The viewer may need to stop the phone browser's
  own context menu on the canvas.
- **Content Security Policy is unchanged.** `src/novnc-probe.mjs` serves the
  viewer with `script-src 'self'; style-src 'self'; img-src 'self' data:`.
  Icons must be inline SVG in the HTML, or `data:` images. No icon font from
  a CDN, no inline style attributes that need `unsafe-inline`.
  (Note: setting `element.style.x` from script is allowed under CSP. Inline
  `style="…"` attributes in the HTML are not.)
- **Tap targets stay at least 44 × 44 px**, even where the drawn shape is
  smaller.
- **Accessibility.** Every icon-only button needs an `aria-label`. The
  switch should expose which mode is on, for example as a radio group or
  `aria-pressed`. Focus moves sensibly when the bar hides and shows.
- **Safe areas.** The bar sits below the top safe-area inset. The ⋯ sheet and
  pop-ups respect the left and right insets in landscape.

## Testing

The existing browser tests in `test/novnc-pointer.test.mjs` and
`test/novnc-probe.test.mjs` drive the real viewer against a fake RFB server
in headless Chrome. Many of them click `#collapse`, `#restore`, `#drag-once`
or `#drag-handle`. These need moving to the new bar. Behavior they cover
must keep passing. For example, "Take control hides the controls once
control connects, and a drop brings them back".

New coverage should include at least:

- A two-finger tap sends a right press and release at the pointer on the
  RFB wire.
- Trackpad slide moves the pointer without clicking. A tap then clicks at
  the pointer's mapped desktop coordinates.
- Tap-then-drag holds button 1 through the slide and releases on lift, on
  pinch, on a hidden page, and on Done.
- Two quick taps in Trackpad land both clicks on the same desktop pixel.
- Tapping the page while in control hides the bar. While watching, it does
  not.
- A tap on any part of the bar, the ⋯ sheet or the hidden tab sends nothing
  on the RFB wire, in both Touch and Trackpad, at Fit and zoomed so the
  remote screen sits under the bar.
- Showing and hiding the bar leaves the zoom and scroll position unchanged.
- The chosen mode survives a reload.

### Real-desktop check

A real-desktop check is required before release, but it is not part of
`npm test`. It runs by hand on the Linux box, like `npm run test:e2e`.

- Add it to the repo as a script, for example `test/trackpad-e2e.mjs`.
  It is rebuilt from a throwaway rig used on 2026-11-08 that is not in the
  repo. That rig ran a scratch Xvfb display (140–199) at 1920 × 1080,
  openbox, a disposable windowed Chrome with two tabs, two x11vnc servers,
  and the real `NoVncProbeGateway` with the real `readFocus`. The phone was
  a 412 × 915 headless Chrome at DPR 2.6 with touch emulation.
- It must never use display :20, port 9222, a real profile, or the live
  `clawser-*` units.
- At Fit it must show that Trackpad can switch Chrome tabs and pick a
  native radio button.
- For right click, checking that Chrome's context menu opens at the pointer
  is enough. The Translate item depends on Chrome's language settings and
  the profile, so it isn't asserted. The owner checks Translate by hand on
  their phone after release. The owner agreed to this split.

## Calls I made

The owner didn't decide these. I chose them and they can be changed.

1. **A tap on the page while in control both hides the bar and does what
   the tap would normally do.** In Touch it also clicks there. In Trackpad
   it also clicks at the pointer. The owner never has to tap twice.
2. **The bar doesn't hide while watching.**
3. **Extra scroll room at the top when zoomed**, so the remote tab strip
   can be panned out from under the bar.
4. **On narrow phones, spacing gives way before exact centering.** Done
   keeps its label.
5. **An eye for watching and a pointer for in control**, in amber and
   green badges.
6. **Status messages become pop-ups**, shown whether the bar is up or down.
7. **Fit and 100% become one toggle button** in ⋯ to fit one row.
8. **Touch is the default** for a phone that has never chosen.

## Left to the builder

- Exact acceleration curve and constants, as long as slow movement is about
  1:1 on screen and a flick crosses the screen.
- Exact timings: the double-tap window, the tap-then-drag window, the
  two-finger tap window, and the slide animation length.
- Exact icon artwork, colors and blur values, close to the mockups.
- How the pointer is drawn: a DOM element over the canvas, or drawn on a
  second canvas.
- How Trackpad's two-finger scroll maps to wheel events. Reuse the Touch
  scroll code where it fits.
- Whether to keep `#status` as the pop-up element or add a new one, as long
  as it stays an `aria-live` region.
- How to restructure the tests that use the removed controls.
