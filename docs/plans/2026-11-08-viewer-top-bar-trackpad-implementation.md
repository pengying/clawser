# Viewer top bar and Trackpad mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the noVNC viewer's floating panel with a top bar built into the screen edge, and add a Trackpad mode with an on-screen pointer and two-finger right click.

**Architecture:** All changes are in the phone page: `public/probe.html`, `public/probe.css` and `public/probe.js`. Trackpad gestures reuse the existing touch listener and send synthetic mouse events to noVNC's canvas, as Touch does today. The server, gateway, x11vnc and noVNC stay as they are.

**Tech Stack:** Plain browser JavaScript modules, noVNC 1.7.0 (pinned), `node:test` with headless Chrome over CDP and a fake RFB peer.

**Spec:** `docs/plans/2026-11-08-viewer-top-bar-trackpad-design.md`, with the mockup `docs/plans/2026-11-08-viewer-top-bar-mockup.html`. Read both before starting any task.

## Global Constraints

- noVNC stays at 1.7.0. Do not edit anything under the noVNC assets.
- CSP is unchanged: `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:`. Icons are inline `<svg>` in `probe.html`. No `style="…"` attributes in HTML. Setting `element.style.x` from script is fine.
- Every tap target is at least 44 × 44 CSS px, even when the drawn shape is smaller.
- Every icon-only button has an `aria-label`. `#status` stays an `aria-live="polite"` region with `role="status"`.
- `#status` keeps every message string it has today, word for word. Many tests match on them, for example `'Control connected.'`, `/Reconnecting in watch mode/`, `'Test browser destroyed.'`.
- Keep these element IDs and their behavior: `#viewport`, `#stage`, `#screen`, `#control`, `#done`, `#status`, `#keyboard`, `#copy`, `#paste`, `#zoom-in`, `#zoom-out`, `#zoom-level`, `#quick-actions`, `#quick-copy`, `#quick-paste`, `#clipboard-dialog`, `#keyboard-input`.
- `#viewport` keeps filling the whole screen. The bar overlays it.
- Every path that ends a gesture or a session releases any held mouse button: pinch, `touchcancel`, `visibilitychange` to hidden, loss of control, Done, disconnect.
- Mouse events the viewer synthesizes for noVNC are `new PointerEvent('mousedown' | 'mouseup' | 'mousemove', …)`, not `new MouseEvent(…)`. `MouseEvent` rounds `clientX`/`clientY` to whole CSS pixels. At Fit, one CSS pixel is about 4.7 desktop pixels, so whole pixels would leave Trackpad unable to reach most desktop pixels. A `PointerEvent` keeps fractions, and noVNC handles it as a normal mouse event.
- Right button: `button: 2`, `buttons: 2` on the press, `buttons: 0` on the release. noVNC maps that to RFB mask `4`. Left is mask `1`. Wheel masks are `0x78`.
- Commits add files by name and use the repository's noreply author and co-author lines.

## How to run tests

Browser tests need Linux Chrome (`CHROME_BIN`) and the pinned noVNC 1.7.0 assets (`NOVNC_ASSETS_DIR`), so they run on a Linux test host. Elsewhere, run only the plain unit tests, such as `test/trackpad.test.mjs`. Never run the full suite on a machine without both.

```bash
# One file, filtered by test name:
NOVNC_ASSETS_DIR=<novnc-1.7.0> node --test --test-name-pattern='right click' test/novnc-pointer.test.mjs
# Whole viewer files:
NOVNC_ASSETS_DIR=<novnc-1.7.0> node --test --test-concurrency=1 test/novnc-pointer.test.mjs test/novnc-probe.test.mjs test/novnc-second-tab.test.mjs test/production-viewer.test.mjs
# Full suite:
NOVNC_ASSETS_DIR=<novnc-1.7.0> npm test
```

Run them in the foreground; the full suite takes several minutes.

## Review Focus

1. **A pinch that starts in Trackpad while the left button is held for tap-then-drag.** The owner expects the button to be released before zooming, with no stray click. Test in Task 4.
2. **Rotating the phone, or the keyboard opening, while the pointer is near an edge.** The owner expects the pointer to stay on the remote screen and at the same desktop point. Test in Task 3.
3. **A Trackpad finger that starts on the bar or the hidden tab and slides onto the page.** The owner expects nothing sent to the remote screen. Test in Task 5.
4. **Switching from Trackpad to Touch, or losing control, in the middle of a held drag.** The owner expects the button released. Test in Task 4.
5. **A stored mode value that is garbage or that storage refuses**, for example in a private window. The owner expects Touch, and no error. Test in Task 6.

---

### Task 1: The top bar replaces the floating panel

**Files:**
- Modify: `public/probe.html` (the `#toolbar` aside, `#restore`, the notice paragraph)
- Modify: `public/probe.css`
- Modify: `public/probe.js` (toolbar move, collapse and restore code at about lines 336–400; `updateInputControls`; `openConnection`'s connect and disconnect handlers; `reconnectWatch`; `requestCleanup`; the Take control click handler)
- Test: `test/novnc-pointer.test.mjs`, `test/novnc-probe.test.mjs`

**Interfaces:**
- Produces in `probe.js`:
  - `hideBar(): void` slides the bar up and shows `#bar-tab`. It does nothing while watching, meaning `!controlReady`.
  - `showBar(): void` slides the bar down and hides `#bar-tab`.
  - `barHidden(): boolean`.
  - `setBarState(state: 'watching' | 'control'): void` swaps the left icon, the center control, and the right-side buttons.
- Produces in `probe.html`:
  - `#bar`, the header element for the bar. It replaces `#toolbar`.
  - `#bar-status`, the status badge. It holds two icons, `#icon-watching` and `#icon-control`, and has `aria-label` "Watching" or "In control".
  - `#bar-center`, which holds `#control` and `#input-mode`. `#input-mode` is created in Task 6. Leave an empty placeholder here.
  - `#bar-right`, which holds `#keyboard`, `#more`, `#done`.
  - `#bar-tab`, the hidden-state tab, `aria-label` "Show controls".
- Removed: `#toolbar`, `#drag-handle`, `#mode`, `#collapse`, `#restore`, `.notice`, `#drag-once`, `#zoom-fit`, `#zoom-actual` and their code. `#zoom-*` and `#copy`/`#paste` move into the ⋯ sheet in Task 2. Until then, keep them inside `#bar` with the `hidden` attribute, so their listeners still attach.

Layout values come from the mockup's CSS: `.sheet`, `.bar`, `.st`, `.seg`, `.ib`, `.txt`, `.go`, `.tab`.
- The bar is a `position: fixed` element at `top: 0; left: 0; right: 0`. Its padding is `calc(4px + var(--safe-top)) max(10px, var(--safe-right)) 4px max(14px, var(--safe-left))`.
- Its radius is `0 0 20px 20px`, background `rgba(18,26,34,.88)` with `backdrop-filter: blur(14px)`, and no top border.
- The row is a CSS grid, `grid-template-columns: minmax(0,1fr) auto minmax(0,1fr)`, 40 px tall.
- The hide animation is `transform: translateY(-104%)` over 220 ms ease. With `prefers-reduced-motion: reduce`, there is no transition.
- `#bar-tab` is 48 × 18 drawn, fixed at top center below the safe area, with radius `0 0 11px 11px`. Its tap area is 48 × 44, using padding or a transparent outline box.

`#status` moves out of the panel and becomes a pop-up. It is `position: fixed`, centered, with its top at `calc(var(--safe-top) + 56px)`, styled as the mockup's `.toast`.
- It shows when its text changes and fades after 4 s.
- When the text matches `/could not|failed|ended|another tab|Retry/i`, it stays until the text changes.
- Do not change any text written to it.

- [ ] **Step 1: Update the existing tests to the new controls, so they fail against the old page.**
  - Replace every `#collapse` click with `evaluate('__viewer.hideBar()')`. `probe.js` is a module, so its functions aren't global. Expose `window.__viewer = { hideBar, showBar, barHidden, zoomTo }` at the end of `probe.js`. It reveals nothing secret, and everything it can do, the owner can do with a tap.
  - Replace every `#restore` click with a real tap on `#bar-tab` through the `press` helper, or `__viewer.showBar()` where no touch emulation is set.
  - In the first pointer test, replace the `geometry.controlsVisible` check with `document.querySelector('#bar').getBoundingClientRect().bottom <= innerHeight`, and the restore-tab assertion with `!document.querySelector('#bar-tab').hidden`.
  - Delete the drag-handle part of "overlay, clipboard, mobile keyboard and pinch keep input intentional": the handle drag, the safe-left keyboard nudge and their asserts.
  - Delete the whole test "Drag once sends mapped mouse down/move/up and releases on pinch, cancel and Done". Hold and drag coverage stays in the stationary-touch test and in Task 4.
  - Replace every `#zoom-fit` click with `evaluate("__viewer.zoomTo('fit')")`, and every `#zoom-actual` click with `evaluate('__viewer.zoomTo(1)')`.
  - In `test/novnc-probe.test.mjs`, "Take control hides the controls once control connects, and a drop brings them back": `shown()` becomes `({ bar: !document.querySelector('#bar').classList.contains('bar-hidden'), tab: !document.querySelector('#bar-tab').hidden })`. Keep the three assertions with the new shape. Focus after hiding moves to `#bar-tab`.
  - In "viewer serves pinned noVNC…", add `assert.match(html, /id="bar"/)` and `assert.doesNotMatch(html, /id="drag-once"|id="restore"/)`.

- [ ] **Step 2: Add a new test for the bar's states.**

```js
test('the top bar shows Watching with Take control centered, and In control with Keyboard', { skip: !existsSync(chromePath) }, async (t) => {
  const { evaluate, waitFor } = await openProbeFixture(t, { signalPromotionClose: true, credentialsDemoting: 2 });
  await waitFor('fixture.rfbs.length === 1 && document.querySelector("#control").disabled === false', 'watch ready');
  const bar = () => evaluate(`(() => { const c = document.querySelector('#control').getBoundingClientRect(), b = document.querySelector('#bar').getBoundingClientRect();
    return { status: document.querySelector('#bar-status').getAttribute('aria-label'), top: b.top, centerOffset: Math.abs((c.left + c.right) / 2 - innerWidth / 2),
      keyboard: !document.querySelector('#keyboard').hidden, control: !document.querySelector('#control').hidden }; })()`);
  const watching = await bar();
  assert.equal(watching.status, 'Watching');
  assert.equal(watching.top, 0, 'the bar is flush with the top edge');
  assert.ok(watching.centerOffset <= 1, 'Take control sits in the exact center');
  assert.equal(watching.keyboard, false, 'Keyboard is not offered while watching');
  await evaluate('__viewer.hideBar()');
  assert.equal(await evaluate('document.querySelector("#bar-tab").hidden'), true, 'the bar never hides while watching');
  await evaluate('document.querySelector("#control").click()');
  await waitFor('fixture.rfbs.length === 2 && /Control connected/.test(document.querySelector("#status").textContent)', 'control connected');
  await evaluate('__viewer.showBar()');
  const control = await bar();
  assert.equal(control.status, 'In control');
  assert.equal(control.control, false, 'Take control is gone once in control');
  assert.equal(control.keyboard, true);
});
```

- [ ] **Step 3: Run the updated and new tests on the test host. Verify they fail.**

Run: `NOVNC_ASSETS_DIR=<novnc-1.7.0> node --test --test-name-pattern='top bar|Take control hides|viewer serves pinned' test/novnc-probe.test.mjs`
Expected: FAIL, because `#bar` and `__viewer` don't exist yet.

- [ ] **Step 4: Build the bar.** Restructure `probe.html` and `probe.css` as above.
  - In `probe.js`, delete `toolbarBounds`'s move helpers (`moveToolbar`, `keepToolbarVisible`) and the drag-handle listeners. Keep `toolbarBounds()`, renamed `visibleBounds()`, because the clipboard dialog and the quick-actions pill use it.
  - Replace `collapseToolbar` and `showToolbar` with `hideBar` and `showBar`. Call `setBarState('watching')` and `setBarState('control')` where `mode.textContent` is set today, and delete `mode`.
  - Keep the existing rules:
    - Take control's success path calls `hideBar()` and moves focus to `#bar-tab`.
    - A disconnect while in control calls `showBar()`.
    - `requestCleanup` calls `showBar()`.
    - `updateInputControls` drops `'drag-once'`.
  - Remove `dragOnce`, `setDragOnce`, and the `kind === 'drag'` branch in the touch listener.
  - Add the `#status` pop-up timer.
  - Add `window.__viewer = { hideBar, showBar, zoomTo }`.

- [ ] **Step 5: Run the viewer files on the test host. Verify they pass.**

Run: `NOVNC_ASSETS_DIR=<novnc-1.7.0> node --test --test-concurrency=1 test/novnc-pointer.test.mjs test/novnc-probe.test.mjs test/novnc-second-tab.test.mjs test/production-viewer.test.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 6: Commit** `public/probe.html public/probe.css public/probe.js test/novnc-pointer.test.mjs test/novnc-probe.test.mjs` with message `feat(viewer): a top bar built into the screen edge replaces the floating panel`.

---

### Task 2: The ⋯ sheet

**Files:**
- Modify: `public/probe.html`, `public/probe.css`, `public/probe.js`
- Test: `test/novnc-pointer.test.mjs`

**Interfaces:**
- Consumes: `#bar`, `#bar-right`, `showBar()` from Task 1.
- Produces:
  - `#more`, a button with `aria-label` "More controls" and `aria-expanded`.
  - `#more-sheet`, a region inside `#bar`, shown with `#more` pressed.
  - `#zoom-toggle`, which switches between Fit and 100%. Its `aria-label` reads "Fit to screen" when at 100% or zoomed, and "Actual size" at Fit.
  - `#hint`, the one-line help.
  - `openSheet(): void`, `closeSheet(): void`, `sheetOpen(): boolean`, all added to `window.__viewer`.
  - `setHint(mode: 'touch' | 'trackpad'): void`. Its text is `Swipe to scroll · pinch to zoom · hold, then drag` for touch, and `Slide to move · tap to click · two fingers to right-click or scroll` for trackpad.

The row order is fixed by the spec: `#zoom-out`, `#zoom-level`, `#zoom-in`, `#zoom-toggle`, a flexible gap, `#copy`, `#paste`. All are icon buttons, with icons from the mockup's `n-zo`, `n-zi`, `n-fit`, `n-copy` and `n-paste` symbols. Copy and Paste keep their current `title` text and gain `aria-label` "Copy" and "Paste". Opening the sheet makes `#bar` taller. It is not a separate popup.

- [ ] **Step 1: Write the failing test.**

```js
test('the ⋯ sheet holds zoom, Copy and Paste as icons, and a tap on the page only closes it', { skip: noVncSkip }, async t => {
  const { evaluate, press, tap, peers } = await phone(t, undefined);
  await evaluate('__viewer.showBar()');
  await press('#more');
  assert.equal(await evaluate(`document.querySelector('#more').getAttribute('aria-expanded')`), 'true');
  const sizes = await evaluate(`[...document.querySelectorAll('#more-sheet button')].map(b => { const r = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label'), w: r.width, h: r.height }; })`);
  assert.deepEqual(sizes.map(s => s.label), ['Zoom out', 'Zoom in', 'Actual size', 'Copy', 'Paste']);
  assert.ok(sizes.every(s => s.w >= 44 && s.h >= 44), 'every sheet button is a full finger target');
  await press('#zoom-toggle');
  assert.equal(await evaluate(`Number(document.querySelector('#zoom-level').dataset.scale)`), 1, 'the toggle goes to 100%');
  const before = peers.at(-1).pointers.length;
  await tap(960, 900);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(peers.at(-1).pointers.length, before, 'a tap on the page while the sheet is open sends nothing');
  assert.equal(await evaluate('__viewer.sheetOpen()'), false, 'that tap closes the sheet');
  assert.equal(await evaluate('__viewer.barHidden()'), false, 'and does not hide the bar');
});
```

`phone()` already hides the bar at its end through Task 1's update. `tap(960, 900)` aims low on the framebuffer, so it lands on the page, not on the bar.

- [ ] **Step 2: Run it on the test host. Verify it fails** because `#more` is missing.

Run: `NOVNC_ASSETS_DIR=<novnc-1.7.0> node --test --test-name-pattern='sheet' test/novnc-pointer.test.mjs`

- [ ] **Step 3: Build the sheet.**
  - Move the zoom buttons, `#copy` and `#paste` into `#more-sheet`, replacing `#zoom-fit` and `#zoom-actual` with `#zoom-toggle`.
  - Update `updateDisplay()`: it sets `#zoom-level`'s text to `Fit` when `zoomMode === 'fit'`, and to the percentage otherwise. It also updates `#zoom-toggle`'s label.
  - In the touch listener's `touchstart`, when `sheetOpen()` is true and the touch is on the page, call `closeSheet()` and swallow the whole gesture. Mark it `{ swallowed: true }`, so its move and end do nothing.
  - Closing on a second `#more` press works too.

- [ ] **Step 4: Run the viewer files on the test host. Verify they pass.**

- [ ] **Step 5: Commit** with message `feat(viewer): zoom, Copy and Paste move into an icon row under the bar`.

---

### Task 3: The Trackpad pointer model

The pointer's position math is the riskiest piece, so it gets its own module and plain unit tests that run without a browser.

**Files:**
- Create: `public/trackpad.js`, an ES module with no DOM access.
- Modify: `src/novnc-probe.mjs`, to serve `assets/trackpad.js` the same way as `probe.js`.
- Modify: `public/probe.js`, to `import` from `./trackpad.js`.
- Test: `test/trackpad.test.mjs` (new). A plain `node:test`, no browser.

**Interfaces:**
- Produces in `public/trackpad.js`:
  - `accelerate(dx: number, dy: number, dtMs: number): { dx: number, dy: number }`. It takes finger travel in CSS px and returns pointer travel in CSS px of screen space.
  - `movePointer(pointer: { x: number, y: number }, delta: { dx: number, dy: number }, scale: number, size: { width: number, height: number }): { x: number, y: number }`. The pointer is in framebuffer pixels, fractional allowed. It returns the new position clamped to `[0, width - 1] × [0, height - 1]`. The framebuffer delta is the screen delta divided by `scale`.
  - `followPointer(pointerScreen: { x: number, y: number }, view: { left: number, top: number, width: number, height: number }, margin: number): { dx: number, dy: number }`. It returns how far to scroll the viewport so the pointer stays at least `margin` px inside the visible area. It returns `{0, 0}` when the pointer is already inside.

Acceleration rule, from the spec:
- At a speed of 0.3 px/ms or less, the gain is exactly 1. One CSS px of finger travel moves the pointer one CSS px on screen.
- Above that, the gain rises smoothly up to 3 at 1.5 px/ms and stays at 3.
- Speed is `hypot(dx, dy) / max(dtMs, 1)`.
- The curve between those points is the builder's choice, but it must be monotonic.

- [ ] **Step 1: Write the failing unit tests.**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accelerate, movePointer, followPointer } from '../public/trackpad.js';

test('slow finger travel moves the pointer one to one on screen', () => {
  assert.deepEqual(accelerate(3, -4, 20), { dx: 3, dy: -4 });
});
test('fast finger travel is amplified, up to three times, and never shrinks', () => {
  const fast = accelerate(30, 0, 10);
  assert.ok(fast.dx > 30 && fast.dx <= 90);
  assert.equal(accelerate(300, 0, 10).dx, 900);
  let last = 0;
  for (let dt = 100; dt >= 1; dt--) { const { dx } = accelerate(10, 0, dt); assert.ok(dx >= last); last = dx; }
});
test('screen travel becomes framebuffer travel at the current scale, clamped to the screen', () => {
  const size = { width: 1920, height: 1080 };
  assert.deepEqual(movePointer({ x: 100, y: 100 }, { dx: 1, dy: 0 }, 0.2146, size).x.toFixed(2), (100 + 1 / 0.2146).toFixed(2));
  assert.deepEqual(movePointer({ x: 5, y: 5 }, { dx: -100, dy: -100 }, 0.5, size), { x: 0, y: 0 });
  assert.deepEqual(movePointer({ x: 1915, y: 1075 }, { dx: 100, dy: 100 }, 0.5, size), { x: 1919, y: 1079 });
});
test('the view scrolls only when the pointer nears its edge', () => {
  const view = { left: 0, top: 0, width: 400, height: 800 };
  assert.deepEqual(followPointer({ x: 200, y: 400 }, view, 40), { dx: 0, dy: 0 });
  assert.deepEqual(followPointer({ x: 390, y: 400 }, view, 40), { dx: 30, dy: 0 });
  assert.deepEqual(followPointer({ x: 10, y: 790 }, view, 40), { dx: -30, dy: 30 });
});
```

Add this Review Focus test, item 2:

```js
test('a pointer outside a shrunken screen is pulled back inside', () => {
  assert.deepEqual(movePointer({ x: 3000, y: -20 }, { dx: 0, dy: 0 }, 0.3, { width: 1920, height: 1080 }), { x: 1919, y: 0 });
});
```

- [ ] **Step 2: Run locally. Verify it fails** because the module is missing.

Run: `node --test test/trackpad.test.mjs`

- [ ] **Step 3: Implement the three functions in `public/trackpad.js`.** Add the `assets/trackpad.js` route in `src/novnc-probe.mjs` next to the `probe.js` route, with the same content type and cache headers. `probe.js` imports it as `import { … } from './trackpad.js'`, which resolves to `assets/trackpad.js`. Two test servers serve the viewer's files themselves, and both need the new file:
  - `test/novnc-pointer.test.mjs`, in `fixture()`: the line `const file = path.endsWith('/probe.css') ? … : 'probe.html'` gains a `path.endsWith('/trackpad.js') ? 'trackpad.js'` case, served as `text/javascript`.
  - `test/novnc-probe.test.mjs`, in `openProbeFixture`: add a `request.url === '/probe/novnc/assets/trackpad.js'` branch next to the `probe.js` one.
  - In "viewer serves pinned noVNC…", fetch `/probe/novnc/assets/trackpad.js` and assert status 200.

- [ ] **Step 4: Run locally. Verify it passes.** Then run `test/novnc-probe.test.mjs` and `test/production-viewer.test.mjs` on the test host, to confirm the new route serves the file.

- [ ] **Step 5: Commit** with message `feat(viewer): pointer movement, acceleration and follow math for Trackpad mode`.

---

### Task 4: Trackpad gestures

**Files:**
- Modify: `public/probe.html`, to add `#pointer`, an `aria-hidden` inline SVG, the mockup's `n-ptr` arrow at 15 × 21 CSS px.
- Modify: `public/probe.css`, `public/probe.js`
- Test: `test/novnc-pointer.test.mjs`

**Interfaces:**
- Consumes: `accelerate`, `movePointer`, `followPointer` from Task 3. `checkFocusAfterTap`, `offerQuickActions`, `releaseTouchDrag`, `cancelTouchInput` and `scrollTouch` already exist in `probe.js`.
- Produces in `probe.js`:
  - `let inputMode: 'touch' | 'trackpad'`, defaulting to `'touch'`.
  - `setInputMode(next: 'touch' | 'trackpad'): void`. In this task it only sets the variable, shows or hides `#pointer`, and calls `cancelTouchInput()`. Task 6 adds the switch UI and storage.
  - `pointer: { x: number, y: number } | null`, in framebuffer pixels.
  - `sendButton(x: number, y: number, button: 0 | 2, down: boolean): void`. It maps framebuffer to client coordinates and dispatches a `PointerEvent` of type `mousedown` on the canvas, or `mouseup` on `window`, with `button` and `buttons` set.
  - `movePointerTo(x: number, y: number): void`. It updates `pointer`, draws `#pointer` with its tip at that point, and, when controlling, dispatches a `PointerEvent('mousemove')` on `window` with the held buttons.
- Add `setInputMode` and `pointer` getters to `window.__viewer`.

Gesture rules, all from the spec. They apply only when `inputMode === 'trackpad'` and `controlReady`.

| Gesture | Recognized when | Sends |
| --- | --- | --- |
| Move | one finger moves more than 4 px, and it is not a tap-then-drag | `mousemove`, no buttons, after `accelerate` and `movePointer`. Then `followPointer` with a 40 px margin scrolls `#viewport` when zoomed past Fit. |
| Tap | one finger down and up within 250 ms, moving 8 px or less | left down and up at `pointer` |
| Double tap | a second tap within 350 ms of the first | a second left down and up at the same `pointer`. The pointer does not move between them. |
| Tap-then-drag | a finger lands within 350 ms of a tap and moves more than 4 px | left down at `pointer` when movement starts, `mousemove` with `buttons: 1` while it moves, left up on lift. Its first tap has already clicked, so the result is click, then press-drag-release. |
| Two-finger tap | two fingers down, both lifted within 250 ms, each moving 10 px or less | right down and up at `pointer` |
| Two-finger slide | two fingers move together, the distance between them changing less than 20 % | wheel events at `pointer`, reusing `scrollTouch`'s 50 px step logic with the midpoint's travel |
| Pinch | two fingers, the distance between them changing 20 % or more | `beginPinch`, as Touch does. Releases any held button first. |

- The pointer starts at the last Touch tap's framebuffer point. With no Touch tap, it starts at the center of the visible area.
- After a left click, call `checkFocusAfterTap` with the pointer's framebuffer `y`. After a double tap or a tap-then-drag, pass `offer` with the pointer's screen position, as Touch does.
- The `#pointer` element is `position: fixed`, `pointer-events: none`, z-index below the bar. Hide it when `inputMode !== 'trackpad'` or `!controlReady`.
- On `resize` and `visualViewport` resize, redraw `#pointer` from `pointer` and clamp it with `movePointer(pointer, {dx:0,dy:0}, …)`.

- [ ] **Step 1: Write the failing tests.** Use the `phone()` helper. Switch with `__viewer.setInputMode('trackpad')`. Read the pointer's screen position from `#pointer`'s rect. Its tip is the rect's top-left corner plus the SVG's 1.5 px inset; record that offset as a constant in the test.

```js
test('Trackpad: sliding moves the pointer without clicking, and a tap clicks at the pointer', { skip: noVncSkip }, async t => {
  const { evaluate, touch, peers } = await trackpadPhone(t);
  const peer = peers.at(-1), before = peer.pointers.length;
  const start = await evaluate('__viewer.pointer()');
  await touch('touchStart', [[200, 600]]); await touch('touchMove', [[230, 600]]); await touch('touchMove', [[260, 600]]); await touch('touchEnd', []);
  await settle();
  const moved = await evaluate('__viewer.pointer()');
  assert.ok(moved.x > start.x + 60 / scaleAtFit, 'the pointer moved right by at least the finger travel');
  assert.ok(peer.pointers.slice(before).every(e => (e.mask & 7) === 0), 'sliding never presses a button');
  await touch('touchStart', [[100, 700]]); await touch('touchEnd', []);
  await settle();
  const click = peer.pointers.slice(before).filter(e => e.mask === 1);
  assert.equal(click.length, 1);
  assert.ok(Math.abs(click[0].x - moved.x) <= 1 && Math.abs(click[0].y - moved.y) <= 1, 'the tap clicks at the pointer, not under the finger');
});

test('Trackpad: a two-finger tap right-clicks at the pointer', { skip: noVncSkip }, async t => {
  const { evaluate, touch, peers } = await trackpadPhone(t);
  const peer = peers.at(-1), before = peer.pointers.length, at = await evaluate('__viewer.pointer()');
  await touch('touchStart', [[150, 600]]); await touch('touchStart', [[150, 600], [230, 600]]); await touch('touchEnd', []);
  await settle();
  const masks = peer.pointers.slice(before).map(e => e.mask).filter((m, i, a) => m !== a[i - 1]);
  assert.deepEqual(masks.filter(m => m !== 0 || masks.length), [4, 0], 'right press then release');
  const press = peer.pointers.slice(before).find(e => e.mask === 4);
  assert.ok(Math.abs(press.x - at.x) <= 1 && Math.abs(press.y - at.y) <= 1);
});

test('Trackpad: the pointer reaches single desktop pixels at Fit', { skip: noVncSkip }, async t => {
  const { evaluate, touch, peers } = await trackpadPhone(t);
  const xs = new Set();
  for (let n = 0; n < 6; n++) {
    await touch('touchStart', [[200, 600]]); await touch('touchMove', [[205, 600]]); await touch('touchEnd', []);
    await settle(); xs.add(Math.floor((await evaluate('__viewer.pointer()')).x));
  }
  assert.ok(xs.size === 6, 'six small slides land on six different desktop columns');
  const before = peers.at(-1).pointers.length;
  await touch('touchStart', [[100, 700]]); await touch('touchEnd', []); await settle();
  const click = peers.at(-1).pointers.slice(before).find(e => e.mask === 1);
  assert.equal(click.x, Math.floor((await evaluate('__viewer.pointer()')).x), 'the wire carries the exact desktop column, not a whole-CSS-pixel rounding');
});

test('Trackpad: two quick taps land both clicks on one desktop pixel', { skip: noVncSkip }, async t => { /* two taps 100 ms apart; the two mask-1 packets have equal x and y */ });

test('Trackpad: tap then drag holds the left button through the slide and releases on lift', { skip: noVncSkip }, async t => {
  /* tap, then within 350 ms touchStart + three touchMoves + touchEnd.
     Masks after the first click: 1 (down) … 1 (moves, at least two) … 0 (up). The up lands at the final pointer. */
});

test('Trackpad: a held drag is released by pinch, a hidden page, switching to Touch, and Done', { skip: noVncSkip }, async t => {
  /* For each ending, start a tap-then-drag, keep the finger down, then:
     - add a second finger and spread it 40 % (pinch),
     - fire visibilitychange with document.hidden true,
     - __viewer.setInputMode('touch'),
     - click #done.
     After each, the last packet has mask 0 and document.captureElement is false. This covers Review Focus 1 and 4. */
});

test('Trackpad: two fingers sliding together scroll at the pointer without pressing a button', { skip: noVncSkip }, async t => { /* wheel masks (0x78) appear; no mask & 7 */ });
```

Add to the file:
- `trackpadPhone(t)`: calls `phone(t, undefined)` then `evaluate("__viewer.setInputMode('trackpad')")`, and exposes `touch`.
- `settle()`: waits 300 ms.
- `scaleAtFit`: read from `#zoom-level`'s `dataset.scale`.

Write the bodies left as comments above in full, in the style of the tests already in the file.

- [ ] **Step 2: Run on the test host. Verify they fail** because `setInputMode` is missing.

Run: `NOVNC_ASSETS_DIR=<novnc-1.7.0> node --test --test-name-pattern='Trackpad' test/novnc-pointer.test.mjs`

- [ ] **Step 3: Implement the gestures.**
  - Branch at the top of the existing window touch listener: `if (inputMode === 'trackpad' && controlReady && !accessEnded) return trackpadTouch(type, event.touches)`. Keep the listener's guards and `preventDefault` above that branch.
  - Write `trackpadTouch` as its own function with its own gesture state object. It reuses `beginPinch`, `scrollTouch` and the release paths.
  - Switch the existing Touch-mode synthetic events from `new MouseEvent` to `new PointerEvent` by changing `mouseOptions` and its call sites. That keeps both modes on one helper.
  - `cancelTouchInput` must also release a Trackpad-held button.

- [ ] **Step 4: Run the viewer files on the test host. Verify they pass,** including all existing Touch tests.

- [ ] **Step 5: Commit** with message `feat(viewer): Trackpad mode moves a pointer, clicks, right-clicks, drags and scrolls`.

---

### Task 5: Tap the page to hide, and overlay taps never leak

**Files:**
- Modify: `public/probe.js`
- Test: `test/novnc-pointer.test.mjs`

**Interfaces:**
- Consumes: `hideBar`, `showBar`, `barHidden`, `sheetOpen`, `closeSheet`, `inputMode`.

Rules from the spec:
- While in control, with the bar showing and the sheet closed, the first touch that starts on the page hides the bar. That same gesture then runs as normal. In Touch, a tap still clicks under the finger. In Trackpad, it still moves or clicks at the pointer.
- While watching, the bar never hides.
- A touch that starts on `#bar`, `#more-sheet` or `#bar-tab` is never handled by the page gesture code, even if it slides onto the page. Today's listener already skips touches whose path lacks `#viewport`. Keep that, and also skip any touch whose `touchstart` target is inside the bar or tab. Record `{ overlay: true }` so its later moves and end are ignored too.
- Taps on `#bar-tab` call `showBar()`. A downward drag on `#bar-tab` of 12 px or more also calls `showBar()`.

- [ ] **Step 1: Write the failing tests.**

```js
test('a tap on the page while in control hides the bar and still clicks there', { skip: noVncSkip }, async t => {
  const { evaluate, tap, peers } = await phone(t, undefined);
  await evaluate('__viewer.showBar()');
  const before = peers.at(-1).pointers.length;
  await tap(960, 900);
  await settle();
  assert.equal(await evaluate('__viewer.barHidden()'), true);
  assert.deepEqual(peers.at(-1).pointers.slice(before).map(e => e.mask), [1, 0], 'the same tap clicked once');
});

test('taps and slides that start on the bar, the sheet or the tab never reach the remote screen', { skip: noVncSkip }, async t => {
  /* For both modes (touch, trackpad), and both Fit and zoomed to 300 % and scrolled to the top so the canvas sits under the bar:
     - press the empty middle of #bar (between #bar-status and #bar-center),
     - press #bar-status,
     - press #more, then each sheet button except Copy and Paste, which talk to the clipboard,
     - hideBar(), then a touchStart on #bar-tab, touchMove 80 px down onto the page, touchEnd (Review Focus 3).
     After all of them, no packet with mask & 7 and no wheel packet arrived beyond what zoom buttons cause, which is none. */
});

test('showing and hiding the bar leaves zoom and scroll exactly where they were', { skip: noVncSkip }, async t => {
  /* zoomTo(2), set #viewport scrollLeft/scrollTop, showBar(), hideBar(), showBar(); dataset.scale, scrollLeft, scrollTop are unchanged. */
});

test('the hidden tab brings the bar back with a tap or a pull down', { skip: noVncSkip }, async t => {
  /* hideBar(); press('#bar-tab') → barHidden() is false and focus is on #more or the first bar button.
     hideBar(); touchStart on #bar-tab, touchMove 30 px down, touchEnd → barHidden() is false.
     hideBar(); touchStart on #bar-tab, touchMove 5 px down, touchEnd → this short wobble counts as a tap, so barHidden() is also false.
     None of these send a pointer packet. */
});
```

Write the commented bodies in full.

- [ ] **Step 2: Run on the test host. Verify they fail.**

- [ ] **Step 3: Implement the rules** in the window touch listener's `touchstart` branch, before choosing Touch or Trackpad handling.

- [ ] **Step 4: Run the viewer files on the test host. Verify they pass.**

- [ ] **Step 5: Commit** with message `feat(viewer): a tap on the page hides the bar, and the bar never passes taps through`.

---

### Task 6: The Touch / Trackpad switch, memory and hint

**Files:**
- Modify: `public/probe.html`, `public/probe.css`, `public/probe.js`
- Test: `test/novnc-pointer.test.mjs`

**Interfaces:**
- Consumes: `setInputMode` from Task 4, `setHint` from Task 2, `#bar-center` from Task 1.
- Produces:
  - `#input-mode`, a `role="radiogroup"` with `aria-label` "Input mode". It holds two `role="radio"` buttons, `#mode-touch` (`aria-label` "Touch") and `#mode-trackpad` (`aria-label` "Trackpad"), each with `aria-checked`.
  - The storage key `clawser.inputMode`, in `localStorage`. Values are `'touch'` or `'trackpad'`. Anything else, or an exception, means `'touch'`.
  - The storage key `clawser.trackpadHintShown`, `'1'` once shown.
  - `#trackpad-hint`, a pop-up in the `.toast` style, with the text `Slide to move the pointer. Tap to click. Two‑finger tap to right‑click.` It shows for 5 s, once per phone.

`setInputMode` now also:
- updates `aria-checked`,
- writes the storage key inside `try/catch`,
- calls `setHint`,
- shows `#trackpad-hint` on the first switch to Trackpad.

On page load, the stored mode applies once control connects. While watching, `#input-mode` is hidden, and Take control holds the center.

- [ ] **Step 1: Write the failing tests.**

```js
test('the Touch / Trackpad switch sits in the center, and the choice survives a reload', { skip: noVncSkip }, async t => {
  /* phone(); showBar(); #input-mode's center is within 1 px of innerWidth/2; press #mode-trackpad;
     aria-checked flips; #pointer is shown; #trackpad-hint is shown;
     Page.reload; wait for 'Control connected.'; #mode-trackpad has aria-checked "true"; #trackpad-hint stays hidden. */
});

test('a broken or missing stored mode falls back to Touch without an error', { skip: noVncSkip }, async t => {
  /* Before navigating, Page.addScriptToEvaluateOnNewDocument with
     localStorage.setItem('clawser.inputMode', 'banana'); load; #mode-touch is checked; no console errors.
     Then add a script that makes localStorage.getItem and setItem throw; reload; #mode-touch is checked;
     pressing #mode-trackpad still switches modes for this page. This covers Review Focus 5. */
});
```

Write the bodies in full. Collect console errors with `Runtime.consoleAPICalled` and `Runtime.exceptionThrown`.

- [ ] **Step 2: Run on the test host. Verify they fail.**

- [ ] **Step 3: Implement** the switch, storage, the hint, and the wiring in `setBarState`.

- [ ] **Step 4: Run the full suite on the test host. Verify it passes.**

Run: `NOVNC_ASSETS_DIR=<novnc-1.7.0> npm test`
Expected: PASS, 0 failures, 0 skipped among the noVNC files.

- [ ] **Step 5: Commit** with message `feat(viewer): a Touch / Trackpad switch the phone remembers`.

---

### Task 7: The real-desktop check, docs and version

**Files:**
- Create: `test/trackpad-e2e.mjs`, a manual check rebuilt from the throwaway rig described below.
- Modify: `package.json`, to add `"test:trackpad-e2e": "node test/trackpad-e2e.mjs"`.
- Modify: `README.md` lines ~125–135, where the viewer's controls are described.
- Modify: `CHANGELOG.md`, adding a `## 0.8.0` section at the top.
- Modify: `package.json`, `package-lock.json`, `README.md`, `docs/install.md`. Bump the version strings from the current release to `0.8.0` everywhere the previous bump touched them. Find them with `grep -rn '0\.7\.[0-9]' README.md docs/install.md package.json`.

**Interfaces:**
- Consumes: everything above. The script imports `NoVncProbeGateway` from `src/novnc-probe.mjs`, `readFocus` from `src/focus-state.mjs`, `CdpConnection` from `src/cdp.mjs`, and `dropStaleLock` from `runtime/desktop/test/xvfb.mjs`.

The script rebuilds, as a repo script, the throwaway rig used on 2026-11-08 to check tap input on a real desktop.
- It takes one argument, the noVNC assets dir.
- It picks a free display between 140 and 199. Never :20, never port 9222, never a real profile, never a `clawser-*` unit.
- It starts Xvfb at 1920 × 1080, openbox, and a disposable windowed Chrome with two tabs: a page of native radio buttons, and an `/other` page.
- It runs two x11vnc servers, watch and control, and the real `NoVncProbeGateway` with the real `readFocus`.
- The phone is a 412 × 915 headless Chrome at DPR 2.6, with touch emulation.

In Trackpad mode at Fit, it must show:
1. Sliding the pointer to the second tab in Chrome's tab strip and tapping makes `/other` the active tab. Check through the disposable Chrome's own CDP target list.
2. Moving onto the third radio button and tapping checks it.
3. A two-finger tap on the page opens Chrome's context menu. Detect it with `xdotool search --onlyvisible --class` for a new menu window on that display, or with a screenshot diff of the menu area. Pick whichever is reliable on the test host, and say which in a comment.

Then it shuts everything down and prints `PASS` or the first failure.

- [ ] **Step 1: Write `test/trackpad-e2e.mjs`.** Run it on the Linux test host:

```bash
node test/trackpad-e2e.mjs <novnc-1.7.0> 2>&1 | tee trackpad-e2e.log | tail -20
```

Expected: `PASS`.

- [ ] **Step 2: Run the leftover check on the test host.** Use a grep pattern that cannot match its own shell:

```bash
ps -eo pid,args | grep -E "[X]vfb :1[4-9][0-9]|[x]11vnc .*unix/:1[4-9][0-9]|[o]penbox.*:1[4-9][0-9]|[t]rackpad-e2e" || echo clean
```

Expected: `clean`. Any live `clawser-*` units on the host must still be active and untouched.

- [ ] **Step 3: Update README and CHANGELOG.**
  - The README's viewer paragraph now describes the top bar:
    - tap the page to tuck it away, tap the small tab to bring it back,
    - the eye and pointer status icons,
    - Touch and Trackpad with their gestures, including two-finger tap to right-click,
    - zoom and Copy/Paste under ⋯.
    - Remove the mention of Drag once and the side Controls tab.
  - The CHANGELOG's `0.8.0` section has one bullet each for: the top bar; Trackpad mode and right click; tap to hide; Drag once removed, with the reason that touch-and-hold covers it.
  - Plain sentences, as in the existing entries.

- [ ] **Step 4: Bump the version to 0.8.0.**

- [ ] **Step 5: Run the full suite on the test host once more. Verify it passes.**

- [ ] **Step 6: Commit** with message `feat(viewer): real-desktop Trackpad check, docs and version 0.8.0`.

Do not merge, tag, release, install on the test host or publish to ClawHub. Those wait for the owner's explicit go, as does PR #13.
