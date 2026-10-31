# Host noVNC Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make noVNC against the host's own Chrome on a virtual screen the default Clawser handoff, keep the CDP viewer behind `--cdp`, and remove the Docker desktop. Release as 0.7.0.

**Architecture:** Five systemd user services, all written and owned by setup: Xvfb with an X cookie, openbox, Chrome, the Python supervisor, and the existing Node controller. The supervisor starts one x11vnc per viewer session on a private Unix socket and proves identity and settlement through `ctypes` calls into libX11, libXRes, libXtst and libXi. The controller talks to the supervisor over its Unix socket, and the phone gateway connects to x11vnc's socket instead of loopback TCP.

**Tech Stack:** Node.js 24.16+ (ESM, `node:test`, `node:sqlite`), Python 3 (stdlib only: `ctypes`, `xml.etree`, `socket`), systemd user units, Xvfb, x11vnc, openbox, Google Chrome or Chromium.

**Spec:** `docs/plans/2026-10-31-host-novnc-default-design.md`. Read it before any task. This plan argues from it.

## Global Constraints

- Linux x86_64 only. Node.js `>=24.16.0 <25 || >=26.1.0`. OpenClaw 2026.10.4+.
- No Docker, no root, no `sudo`, no install scripts, no `brew install`. Setup prints the distro command for anything missing.
- Xvfb runs with `-nolisten tcp` and `-auth <cookie file>`. Never `-ac`.
- x11vnc runs with `-unixsock <path> -rfbport 0 -no6 -rfbportv6 -1`. It must never open a TCP listener.
- Chrome flags Clawser sets: `--ozone-platform=x11 --password-store=basic --ignore-gpu-blocklist --window-size=1920,1080 --window-position=0,0 --start-maximized --no-first-run --no-default-browser-check --remote-debugging-address=127.0.0.1 --remote-debugging-port=<port>`. Never `--enable-unsafe-swiftshader`.
- Virtual screen: `1920x1080x24`, `-dpi 96`, extensions `XTEST X-Resource DAMAGE RANDR`.
- Profile directories Clawser creates are mode 0700. Every file holding a secret (X cookie, receipts, configs, cookie exports) is 0600 in a 0700 directory.
- Never copy, move or recreate an existing profile directory. Never touch a profile other than `<stateDir>/browser/profile` (option A) or the named one (option B).
- Setup never stops a Chrome, takes over a unit it did not write, or migrates cookies without `--yes`. Without it, setup prints the plan and returns `ok: false`.
- Cookie values are never logged and live only in a 0600 temp file inside a 0700 temp directory that is removed in a `finally`.
- Option A's OpenClaw profile name is `clawser`. Option A's CDP port is the first free port in `18820`–`18829` on first setup, recorded in the receipt and reused on reruns. The range is clear of the 18810–18814 ports Docker-era desktops published. There is no `--cdp-port` flag: the design removes it. Before writing anything, setup refuses when the CDP port or the controller port is held by anything other than Clawser's own units, and names the holder. The host controller's default port is `19420`, so it never collides with a running CDP viewer on `19410` during an upgrade.
- Setup refuses Snap Chromium: "Snap Chromium can't use the hidden folder where Clawser keeps its files. Install Google Chrome, or a Chromium that isn't a snap, then rerun setup."
- Unix socket paths must fit in 107 bytes. Setup refuses longer state directories before writing anything.
- The public repo and package carry no personal identifiers, account names or host paths.
- Commit as `Peng Ying <495700+pengying@users.noreply.github.com>`. Prefix commits with `LS_COMMENT_AUDIT=1`. Add files by name.
- No `xclip`. The clipboard uses `runtime/desktop/clipboard.py` over libX11, so it needs no package beyond Xvfb, x11vnc, openbox and python3.
- Tests that start Xvfb, x11vnc or Chrome skip when the binary is missing, and never use display `:20`, port `9222`, or any existing profile or user unit. The end-to-end test runs only when `CLAWSER_HOST_E2E=1`.

## Review Focus

1. **Rerunning setup on its own services.** A second `setup` run must recognize Clawser's own units as Clawser's. It must not treat them as hand-written, back them up, stop Chrome or ask for `--yes`. Covered in Task 8.
2. **A git upgrade moved the package directory.** Units point at the old `supervisor.py` and controller. Doctor must say "rerun setup". Setup must rewrite the owned units and restart only the supervisor and controller, never the display or Chrome. Covered in Tasks 7 and 9.
3. **Long state directory paths.** Socket paths over 107 bytes fail late and confusingly inside x11vnc or Python. Setup must refuse them up front with the path it computed. Covered in Task 7.
4. **Chrome or the display restarts.** While idle, the next handoff must just work with new generations and no taint. During a control session, the session must be retired and the supervisor tainted, as a container crash was. Covered in Task 4.
5. **Supervisor restart during a session.** The generations must change so the controller treats the session as lost, the way it treated a container restart. Covered in Task 4.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `runtime/desktop/xproof.py` (new) | ctypes X identity proof, settlement, held-input query and clipboard owner. Importable and a CLI with the same ops and JSON as the old `x11-proof`. |
| `runtime/desktop/openbox_config.py` (new) | Generates Clawser's `rc.xml` from the system one with `xml.etree`. |
| `runtime/desktop/test/input_fixture.py` (renamed from `input-fixture.py`) | Trusted test fixture that holds and releases a key and button outside any actor. The display comes from `DISPLAY`. |
| `runtime/desktop/supervisor.py` (rewritten) | Host supervisor. It watches the display and browser, runs per-session x11vnc actors on Unix sockets and serves the control socket. |
| `runtime/desktop/index.mjs` (rewritten) | `HostDesktopRuntime`: a Node client for the supervisor socket, with the existing lock and status semantics. |
| `src/host-display.mjs` (new) | X cookie file bytes and free display number search. |
| `src/host-units.mjs` (new) | Unit names, Chrome argument merging and unit file rendering. |
| `src/host-browser.mjs` (new) | Read-only discovery: browser binary, CDP listener process, process owner, display services and cookie encryption. |
| `src/cookie-migration.mjs` (new) | Export, import and flush cookies over CDP. |
| `src/host-setup.mjs` (new) | Plan, describe and apply option A and option B, plus host doctor checks. |
| `src/setup.mjs` (shrunk) | Options, mode selection, receipts, config patch and reload. All Docker code goes. |
| `runtime/desktop/clipboard.py` (new) | Owns or reads the X clipboard through libX11, replacing xclip. |
| `src/host-deps.mjs` | Enabled. Adds `python3`, removes `brew install`, and smoke-tests over a Unix socket. |
| `src/novnc-probe.mjs`, `src/desktop-controller.mjs`, `src/desktop-recovery.mjs`, `bin/*.mjs` | Socket endpoints and truthful readiness fields. |
| Deleted | `runtime/desktop/{Dockerfile,entrypoint.sh,chromium-seccomp.json,MOBY-LICENSE,x11-proof.cpp}`, `runtime/desktop/test/{adapter.test.mjs,fixtures.mjs,health.mjs,heartbeat.mjs,inspect.mjs,integration.mjs}` |

---

### Task 1: X display helpers

**Files:**
- Create: `runtime/desktop/xproof.py`, `runtime/desktop/openbox_config.py`, `src/host-display.mjs`
- Move: `runtime/desktop/test/input-fixture.py` → `runtime/desktop/test/input_fixture.py`
- Test: `runtime/desktop/test/xproof.test.mjs`, `runtime/desktop/test/openbox-config.test.mjs`, `test/host-display.test.mjs`

**Interfaces:**
- Produces, `xproof.py`, importable:
  - `clients() -> list[dict]` returns `[{clientId, pid}]`. It raises if any X client has no provable PID.
  - `settle(pids) -> dict` returns `{xClientsAbsent:True, heldInputCleared:True, xSyncComplete:True}`. It waits up to 5 s for `pids` to leave, then releases every pressed key and button with XTest and checks that none remain.
  - `absent(pids) -> dict` returns `{xClientsAbsent:True, heldInputCleared:False, xSyncComplete:True}`.
  - `held() -> bool`.
  - `selection_owner() -> dict` returns `{ownerWindow, pid}`.
  - `display_ok() -> bool`.
- Produces, `xproof.py` CLI: `python3 xproof.py clients|settle|absent|held|selection-owner [pids…]` prints one JSON line. On failure it exits 1 with the message on stderr. Each op opens `'unix/' + os.environ['DISPLAY']` with the cookie from `XAUTHORITY`.
- Produces, `openbox_config.py` CLI: `python3 openbox_config.py <source rc.xml> <dest>` writes the dest at mode 0600.
- Produces, `src/host-display.mjs`:
  - `xauthorityEntry(display: number, cookie: Buffer) -> Buffer` builds one FamilyWild (0xFFFF) entry: empty address, display number as decimal, `MIT-MAGIC-COOKIE-1`, a 16-byte cookie, every length a big-endian u16.
  - `freeDisplay(d, { from = 20, to = 99, socketDir = '/tmp/.X11-unix', lockDir = '/tmp' }) -> Promise<number>` returns the first N with neither `<socketDir>/X<N>` nor `<lockDir>/.X<N>-lock`, and throws when none is free.

- [ ] **Step 1: Write the failing tests**

`test/host-display.test.mjs`:
- `the X cookie file is one FamilyWild MIT-MAGIC-COOKIE-1 entry for the display` decodes `xauthorityEntry(20, Buffer.alloc(16, 7))`:
  - The family is `0xffff` and the address length is 0.
  - The number is `"20"`, the name is `"MIT-MAGIC-COOKIE-1"`, and the data is 16 bytes of 7.
  - The total length is `2+2+0+2+2+2+18+2+16`.
- `freeDisplay skips displays with a socket or a lock file`:
  - Create `X20` in a temp socket dir and `.X21-lock` in a temp lock dir. Expect `22`.
  - With `to: 21`, expect a rejection matching `/no free X display/i`.

`runtime/desktop/test/openbox-config.test.mjs`: a fixture `rc.xml` has `<desktops><!-- <number>4</number> --><number>4</number></desktops>`, keybinds and mousebinds using `GoToDesktop`, `SendToDesktop`, `DesktopNext` and `DesktopPrevious`, and an existing `<applications/>`. Run the CLI.
- `generated openbox config keeps one desktop and no desktop switching`:
  - Exactly one `desktops/number` exists, and its text is `1`.
  - No `action` element has a `name` among the four.
  - Keybinds left with no actions are removed.
- `generated openbox config hides title bars and maximizes only the browser's main window`:
  - `application[@class="*"]/decor` is `no`.
  - `application[@class="Google-chrome"][@role="browser"]/maximized` and `application[@class="Chromium"][@role="browser"]/maximized` are both `yes`.
  - The dest mode is `0o600`.

`runtime/desktop/test/xproof.test.mjs`: skip unless `Xvfb` and `python3` are on PATH. A helper writes `xauthorityEntry(0, cookie)` to `<tmp>/server-auth` and starts `Xvfb -displayfd 3 -auth <tmp>/server-auth -nolisten tcp -screen 0 640x480x24 +extension XTEST +extension X-Resource`. The server loads every cookie in its `-auth` file whatever the display number, but clients match the number, so once `-displayfd` reports N the helper writes `xauthorityEntry(N, cookie)` to `<tmp>/xauth` and points `XAUTHORITY` there.
- `an authorized client sees X clients with PIDs`: `clients` returns an array, and every entry has an integer `pid > 0`.
- `a client without the cookie is refused`: with `XAUTHORITY` pointing at an empty file, `clients` exits non-zero and stderr matches `/display unavailable/`.
- `settle releases a key and button held outside any actor`:
  - `python3 input_fixture.py hold` makes `held` return true.
  - `settle 999999` returns `heldInputCleared: true`.
  - Then `held` returns false, and `input_fixture.py query` returns `{shift:false, button1:false}`.
- `absent waits for the listed client to disconnect`: start a Python X client that holds the display for 300 ms, then run `absent <its pid>`. It returns `xClientsAbsent: true` after the client exits.
- `selection-owner names the clipboard owner's PID`: skip without `xclip`. With `xclip -quiet -selection clipboard -in` running, `pid` equals xclip's PID. (Task 1b replaces xclip here with Clawser's own helper.)

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/host-display.test.mjs runtime/desktop/test/openbox-config.test.mjs runtime/desktop/test/xproof.test.mjs`
Expected: FAIL on missing modules or files. The Xvfb tests run only on Linux.

- [ ] **Step 3: Implement the three modules**

- **`xproof.py`:** port `runtime/desktop/x11-proof.cpp` op for op, with the same error strings. Use `ctypes.CDLL` on `libX11.so.6`, `libXRes.so.1`, `libXtst.so.6` and `libXi.so.6`. Declare `argtypes` and `restype` for every call, the way `input-fixture.py` does. Install an X error handler that records the code. Keep the 5 s deadline and the 2 ms poll. Drop the `screenshot` op.
- **`input_fixture.py`:** take the display from `DISPLAY`.
- **`openbox_config.py`:**
  - Parse with `xml.etree.ElementTree` and register the openbox namespace as the default.
  - Remove every `desktops/number` and add one `1`.
  - Remove matching `action` elements and empty `keybind` and `mousebind` parents.
  - Replace `applications` with the three entries.
  - Write the result to a temp file, then rename it.
- **`host-display.mjs`:** write both functions to the signatures above.

- [ ] **Step 4: Run the tests and confirm they pass**

Run the same command on Linux with Xvfb and x11vnc on PATH.
Expected: PASS. On macOS, the Xvfb tests skip.

- [ ] **Step 5: Commit**

```bash
git add runtime/desktop/xproof.py runtime/desktop/openbox_config.py runtime/desktop/test/input_fixture.py src/host-display.mjs test/host-display.test.mjs runtime/desktop/test/xproof.test.mjs runtime/desktop/test/openbox-config.test.mjs
git rm runtime/desktop/test/input-fixture.py
LS_COMMENT_AUDIT=1 git commit -m "feat(desktop): X proof and openbox config helpers without a compiler"
```

---

### Task 1b: Built-in clipboard helper

**Files:**
- Create: `runtime/desktop/clipboard.py`
- Modify: `runtime/desktop/test/xproof.test.mjs` (the selection-owner test uses the new helper instead of xclip)
- Test: `runtime/desktop/test/clipboard.test.mjs`

**Interfaces:**
- Consumes: the Xvfb test helper from Task 1's `xproof.test.mjs`. Move it to `runtime/desktop/test/xvfb.mjs` and import it from both test files.
- Produces, the `clipboard.py` CLI. Both ops open `'unix/' + os.environ['DISPLAY']` with `XAUTHORITY` through `ctypes` on `libX11.so.6`. `argtypes` and `restype` are declared for every call.
  - `python3 clipboard.py own`:
    - Reads all of stdin as UTF-8 text, then creates an unmapped 1x1 window and calls `XSetSelectionOwner(CLIPBOARD)`.
    - If `XGetSelectionOwner` doesn't return that window, it exits 1 with `clipboard ownership refused`.
    - It answers `SelectionRequest` events for the targets `TARGETS`, `UTF8_STRING`, `STRING`, `TEXT` and `text/plain;charset=utf-8`. It writes the property on the requestor and sends a `SelectionNotify`. Any other target gets a `SelectionNotify` with property `None`.
    - It exits 0 on `SelectionClear`, SIGTERM or SIGINT.
    - Text longer than the display's maximum request size (`XExtendedMaxRequestSize`, or `XMaxRequestSize` when that is 0, times 4, minus 1024) exits 1 with `clipboard text too large`. INCR is not supported.
  - `python3 clipboard.py read`:
    - Converts `CLIPBOARD` to `UTF8_STRING` into a property on its own window, waits up to 1 s for `SelectionNotify`, then prints the bytes to stdout.
    - With no owner, a refused conversion or a timeout, it exits 1 with `clipboard unavailable`. An `INCR` reply exits 1 with `clipboard text too large`.
    - It deletes the property after reading.

- [ ] **Step 1: Write the failing tests** in `runtime/desktop/test/clipboard.test.mjs`. Skip unless `Xvfb` and `python3` are on PATH.
  - `text owned by the helper reads back exactly`: own `'Clipboard proof — 中文 🙂\nsecond line'`. `read` returns the same bytes.
  - `the helper is the provable selection owner`: while `own` runs, `xproof.py selection-owner` returns its PID.
  - `a newer owner replaces the old one and the old helper exits`: start two `own` processes one after the other. The first exits 0 within 1 s, and `read` returns the second text.
  - `read fails cleanly with no owner`: exit 1, stderr `clipboard unavailable`, and empty stdout.
  - `oversized text is refused`: 20 MiB of text on stdin exits 1 with `clipboard text too large`.
  - In `xproof.test.mjs`, `selection-owner names the clipboard owner's PID` no longer skips without xclip. It uses `clipboard.py own`.
- [ ] **Step 2: Run and confirm failure**: `node --test runtime/desktop/test/clipboard.test.mjs runtime/desktop/test/xproof.test.mjs` on Linux.
- [ ] **Step 3: Implement `runtime/desktop/clipboard.py`** to the interface above. Use `select` on `XConnectionNumber` with `XPending`, so signals are handled while waiting. Use `XEvent` as a ctypes union big enough for the largest event (192 bytes), with field structs for `XSelectionRequestEvent`, `XSelectionEvent` and `XSelectionClearEvent`.
- [ ] **Step 4: Run and confirm pass** on Linux, three times in a row.
- [ ] **Step 5: Commit**

```bash
git add runtime/desktop/clipboard.py runtime/desktop/test/clipboard.test.mjs runtime/desktop/test/xproof.test.mjs runtime/desktop/test/xvfb.mjs
LS_COMMENT_AUDIT=1 git commit -m "feat(desktop): own and read the X clipboard without xclip"
```

---

### Task 2: Host dependencies on, without brew install

**Files:**
- Modify: `src/host-deps.mjs`
- Test: `test/host-deps.test.mjs`

**Interfaces:**
- Consumes: `runtime/desktop/xproof.py` CLI (Task 1).
- Produces:
  - `HOST_DEPS` gains `python3` (probe `--version`, required, packages apt/dnf/pacman/zypper/apk `python3`; pacman `python`). There is no `xclip` entry: the clipboard uses `runtime/desktop/clipboard.py`.
  - `planHostDeps(recorded, d, h)` never returns `plan.brew`. A missing required binary throws `'Missing <names>.' + hint`. A missing openbox warns.
  - `installHostDeps(plan, d, { previous })` runs no install command. It only smoke-tests and records.
  - `smokeHostDeps(binaries, d, opts)` starts Xvfb with `-displayfd 3 -nolisten tcp -auth <tmp cookie>`, then openbox, then x11vnc with `-unixsock <tmp 0700 dir>/vnc.sock -rfbport 0 -no6 -rfbportv6 -1`. It checks the RFB banner over that socket, then runs `python3 <packageDir>/runtime/desktop/xproof.py clients` against the display. It reports failures by name: `Xvfb`, `openbox`, `x11vnc`, `python3`.
  - The rerun hint becomes `` `openclaw clawser setup` ``.

- [ ] **Step 1: Update the tests first**
  - Drop the Homebrew-install tests.
  - Keep: a Homebrew binary that is already installed is found and recorded with its Cellar version.
  - Add `a missing required binary fails with the distro command and runs no installer`: with no brew calls at all, expect `/sudo apt install .*python3/`, and the hint never names `xclip`.
  - Change `the real smoke test …` to assert x11vnc served RFB over the Unix socket. Assert `/proc/net/tcp` and `/proc/net/tcp6` held no listener owned by the x11vnc PID during the smoke run, using a `d.onSmokeVnc(pid)` hook that only tests pass.
  - Add `the smoke test reports python3 when the X proof helper fails`, using a fake `python3` that exits 1.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/host-deps.test.mjs`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement**

- Remove `brewPath`, `brewBinary`, `upgradedBrew` and the `plan.brew` branches.
- Keep finding binaries already under Homebrew prefixes, since `searchPaths` already includes them.
- Write the smoke test's temp cookie with `xauthorityEntry` from Task 1. The server loads every cookie in its `-auth` file, but clients match the display number, so write the server file before Xvfb starts and the clients' `XAUTHORITY` file after `-displayfd` reports the number.

- [ ] **Step 4: Run and confirm pass**

Run: `node --test test/host-deps.test.mjs` on Linux. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/host-deps.mjs test/host-deps.test.mjs
LS_COMMENT_AUDIT=1 git commit -m "feat(setup): require python3, never run brew install, smoke-test over a private socket"
```

---

### Task 3: Unit files and Chrome arguments

**Files:**
- Create: `src/host-units.mjs`
- Modify: `src/setup.mjs` (import `systemdArgument` from `host-units.mjs` instead of defining it)
- Test: `test/host-units.test.mjs`

**Interfaces:**
- Produces:
  - `CLAWSER_CHROME_FLAGS`: the frozen flag names Clawser owns. They are `--ozone-platform`, `--password-store`, `--ignore-gpu-blocklist`, `--window-size`, `--window-position`, `--start-maximized`, `--remote-debugging-address`, `--remote-debugging-port`, `--no-first-run` and `--no-default-browser-check`.
  - `unitNames(stateDir) -> { display, windowManager, browser, supervisor, controller }`:
    - The pattern is `clawser-<role>-<sha256(stateDir)[0..12]>.service`, with roles `display`, `wm`, `browser` and `supervisor`.
    - `controller` keeps today's `clawser-desktop-<same hash>.service`.
  - `chromeArgs({ existing = [], userDataDir, profileDirectory, cdpPort }) -> string[]`:
    - `existing` is the running Chrome's argv without `argv[0]`.
    - It drops every arg whose name, the part before `=`, is in `CLAWSER_CHROME_FLAGS`, then appends Clawser's flags with `cdpPort`.
    - It keeps `--user-data-dir=<userDataDir>` and `--profile-directory=<profileDirectory>` when given, and keeps all other args in order.
    - It throws `Refusing to take over a headless Chrome…` on `--headless` or `--headless=*`.
    - It throws `…--user-data-dir differs from the OpenClaw profile…` when `existing` has a different `--user-data-dir`, and the same for `--profile-directory`.
  - `renderUnits(input) -> Record<unitName, string>`. The `input` fields:
    - `names` and `display` (a number).
    - `xauthority`, the path.
    - `xvfb` and `openbox`, absolute paths. `openbox` is optional.
    - `openboxConfig`, a path.
    - `browser: { path, args, env }`, where `env` is extra environment to keep, as `[name, value]` pairs.
    - `python` and `supervisorScript`.
    - `supervisorConfig`, `node`, `controllerScript` and `controllerConfig`.
    - `marker`, the receipt path written in the header comment.

    Every value goes through the existing `systemdArgument` escaping, so move it here and export it.

- [ ] **Step 1: Write the failing tests**
  - `unit names are stable per state directory and keep the controller name`: two different dirs give different hashes. The controller name matches `/^clawser-desktop-[a-f0-9]{12}\.service$/`.
  - `chrome arguments replace only Clawser's flags and keep the rest in order`:
    - `existing = ['--user-data-dir=/p', '--profile-directory=Work', '--lang=fr', '--remote-debugging-port=1', '--window-size=800,600', 'about:blank']` with `cdpPort 9333`.
    - The result keeps `--user-data-dir=/p`, `--profile-directory=Work`, `--lang=fr` and `about:blank` in order.
    - It has exactly one `--remote-debugging-port=9333` and exactly one `--window-size=1920,1080`.
    - It includes every global-constraint flag.
  - `chrome arguments refuse headless and a mismatched profile`: three cases, `--headless=new`, `--user-data-dir=/other` and `--profile-directory=Other`. Each rejects with the messages above.
  - `the display unit has a cookie, no TCP and never -ac`: the text contains `-nolisten tcp`, `-auth "<xauth>"`, `1920x1080x24` and `Restart=always`, and does not match `/\s-ac(\s|$)/`.
  - `the browser unit waits for the display and restarts always`:
    - It has `Requires=` and `After=` the display, and `After=` the wm when openbox is given.
    - It sets `Environment="DISPLAY=:<n>"` and `Environment="XAUTHORITY=<path>"`, and has `UnsetEnvironment=WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS`. Without the session bus, file choosers can't open through the desktop portal on the person's real screen, where the phone can't see them.
    - Its `ExecStartPre=` waits for `/tmp/.X11-unix/X<n>`, with every `$` doubled for systemd.
    - It has `Restart=always`, `TimeoutStopSec=15`, and each Chrome arg quoted.
  - `the supervisor unit kills its x11vnc children with it`:
    - `KillMode=control-group`, `Restart=on-failure`, `UMask=0077` and `NoNewPrivileges=true`.
    - `Wants=` and `After=` the display and browser.
    - `ExecStart` is python, then the script, then the config.
  - `without openbox there is no window manager unit and nothing refers to one`.
  - `every unit is marked as Clawser's and installs into default.target`: each text starts with `# Managed by Clawser; ownership is recorded in`.

- [ ] **Step 2: Run and confirm failure**: `node --test test/host-units.test.mjs`
- [ ] **Step 3: Implement `src/host-units.mjs`** to the interfaces above. The controller unit text matches today's `unit()` in `src/setup.mjs` with two changes: `After=network-online.target <supervisor>`, and `Wants=<supervisor>`.
- [ ] **Step 4: Run and confirm pass**: `node --test test/host-units.test.mjs` (macOS is fine).
- [ ] **Step 5: Commit**

```bash
git add src/host-units.mjs src/setup.mjs test/host-units.test.mjs
LS_COMMENT_AUDIT=1 git commit -m "feat(setup): render Clawser's display, window manager, browser and supervisor units"
```

---

### Task 4: Host supervisor and runtime client; delete the Docker runtime

**Files:**
- Rewrite: `runtime/desktop/supervisor.py`, `runtime/desktop/index.mjs`
- Delete: `runtime/desktop/{Dockerfile,entrypoint.sh,chromium-seccomp.json,MOBY-LICENSE,x11-proof.cpp}`, `runtime/desktop/test/{adapter.test.mjs,fixtures.mjs,health.mjs,heartbeat.mjs,inspect.mjs,integration.mjs}`
- Port: `runtime/desktop/test/status.test.mjs`, `runtime/desktop/test/readiness.test.mjs`
- Modify, to keep every importer loading: `bin/desktop-controller.mjs` and `bin/reconcile-desktop.mjs` construct `new HostDesktopRuntime(runtimeOptions)` from the controller config's `runtime: { stateDir, controlSocket, cdpUrl }`. `src/setup.mjs` drops its `DesktopRuntime` import and the `runtime.owned()` call in `resources()`, since Task 7 deletes that Docker path. `scripts/check-package.mjs` swaps the deleted runtime files for `runtime/desktop/xproof.py` and `runtime/desktop/openbox_config.py` in its required list.
- Test: `runtime/desktop/test/supervisor.test.mjs`

**Interfaces:**
- Consumes: `xproof` (Task 1).
- Produces, the supervisor:
  - Invocation: `python3 supervisor.py <config.json>`. The config JSON (0600) is `{ display: number, xauthority, controlSocket, vncDir, cdpUrl }`, all paths absolute. `DISPLAY` and `XAUTHORITY` come from the unit.
  - Protocol: unchanged. One JSON request per connection on `controlSocket`, ended by a half-close, answered with one JSON response. The ops are `status`, `startViewer`, `promoteViewer`, `stopViewerAndSettle`, `heartbeatViewer`, `clipboardRead` and `clipboardWrite`, with today's arguments and errors.
  - `status` returns `{ ready, browserReady, displayGeneration, browserGeneration, epoch, tainted, heartbeatTimeoutMs, viewer, isolation: 'host-user-services', browserSandbox: 'chrome-os-sandbox', egressFirewall: false }`:
    - `ready` is true when the display socket exists, `xproof.display_ok()` passes, and the supervisor isn't tainted.
    - `browserReady` is true when `GET <cdpUrl>/json/version` answers within 2 s with `Browser` matching `^(Chrome|Chromium)/`.
  - Generations:
    - `displayGeneration = BOOT + ':' + <st_ino of /tmp/.X11-unix/X<display>>`.
    - `browserGeneration = BOOT + ':' + <guid from webSocketDebuggerUrl /devtools/browser/<guid>>`, or `BOOT + ':none'` until it is known.
    - `BOOT` is a fresh `uuid4` per supervisor process.
  - Watchdog, every 0.5 s:
    - If the display inode or browser guid changes from its last known value while an actor is active, retire it with `reason='critical_child_exit'` and set `tainted`.
    - When no actor is active, just adopt the new value.
    - A browser that doesn't answer makes `browserReady` false and never retires anything.
  - `startViewer` result: today's fields plus `socketPath`, which is `<vncDir>/vnc-<16 hex>.sock`. x11vnc args are `-display unix/:<n> -unixsock <socketPath> -rfbport 0 -no6 -rfbportv6 -1 -passwdfile <file in vncDir> -forever -shared -noxdamage -noxrecord -nosel -noprimary -noclipboard -nosetclipboard -nosetprimary -noremote -nocmds -o /dev/null`, plus `-viewonly` for watch. Readiness is a socket at `socketPath` plus the XRes proof of x11vnc's PID, replacing `listening(5900)`.
  - Retirement unlinks the socket and the password file.
  - The control socket is created under `umask 077`, and its directory must be 0700 and owned by the supervisor's user.
  - On start, before serving, the supervisor calls `xproof.settle([])` to release any key or button a previous supervisor's x11vnc left held. If held input remains, it starts tainted. A container restart cleared held input by restarting X; the host display outlives the supervisor, so this replaces that.
- Produces, `runtime/desktop/index.mjs`:
  - `supervisorRequest(socketPath, payload, { timeoutMs = 20_000, connect }) -> Promise<object>`. A missing or refused socket with `op === 'status'` returns `{ ready:false, phase:'starting' }`. Any other op rejects. A response with `error` rejects with `desktop <op>: <error>`.
  - `class HostDesktopRuntime`:
    - `constructor({ stateDir, controlSocket, cdpUrl, testHeartbeatTimeoutMs })` validates that `cdpUrl` is loopback HTTP.
    - The constructor throws `Desktop runtime config is from an older Clawser; rerun openclaw clawser setup` when `controlSocket` is missing, so a Docker-era `controller.json` fails closed.
    - Fields and methods: `cdpUrl`, `ensure() -> {cdpUrl, persistent:true}` (starts nothing), `status()`, `tabs()`, `startViewer({leaseId, role, expiresAt})`, `promoteViewer({leaseId})`, `stopViewerAndSettle({leaseId, mayBeWritable})`, `heartbeatViewer({leaseId, epoch})`, `clipboardRead({leaseId, epoch})` and `clipboardWrite(text, {leaseId, epoch})`.
    - Mutations keep today's `locked()` operation lock in `stateDir`. `status` and `heartbeatViewer` stay lock-free.
    - `tabs()` is unchanged.
    - `startViewer` and `promoteViewer` return the supervisor result with `socketPath`. The old `host` and `port` fields go.

- [ ] **Step 1: Write the failing tests**

Port `status.test.mjs` and `readiness.test.mjs` to `HostDesktopRuntime` against a fake Node `net` server on a temp Unix socket. Keep every assertion about lock ownership, lock-free status, and the cold socket. These run on macOS.

`supervisor.test.mjs` (Linux, skip without Xvfb, x11vnc or python3):
- Set up Xvfb on `-displayfd` with a cookie, plus a fake CDP HTTP server on `127.0.0.1:0` whose `/json/version` returns `{Browser:'Chrome/156.0', webSocketDebuggerUrl:'ws://127.0.0.1:<p>/devtools/browser/<guid>'}`, with the guid settable.
- Write the config and spawn the supervisor with `DESKTOP_TEST_HEARTBEAT_TIMEOUT_MS=2000`. Wait for the socket.

Tests:
- `status describes the host truthfully`: the four isolation fields equal the constants above, and `ready` and `browserReady` are both true.
- `browserReady drops when the browser stops answering, without retiring a session`: start a watch viewer, close the fake CDP server, and wait 1.5 s. `browserReady` is false, `viewer` still names the lease, and `tainted` is false.
- `a watch viewer serves RFB only on its private socket`:
  - `socketPath` is a socket inside `vncDir`, which is mode 0700.
  - `net.connect({path})` reads `/^RFB 003\.00[38]\n/`.
  - No LISTEN row in `/proc/net/tcp` or `/proc/net/tcp6` has an inode among `/proc/<x11vnc pid>/fd` socket inodes.
- `settling a control viewer releases a key held outside it`:
  - Start a control viewer, and `input_fixture.py hold` while it is active.
  - `stopViewerAndSettle({mayBeWritable:true})` returns `heldInputCleared:true`, `xClientsAbsent:true` and `vncProcessesExited:true`, and `socketPath` no longer exists.
  - `input_fixture.py query` gives all false.
- `a browser restart while idle changes browserGeneration and leaves the desktop usable`: change the guid and wait 1 s. The new generation is different, `tainted` is false, and a new watch viewer starts.
- `a browser restart during a control session retires it and taints the desktop`: start a control viewer and change the guid. Within 2 s `viewer` is null and `tainted` is true. `stopViewerAndSettle` for that lease returns `retirementReason:'critical_child_exit'`, and `startViewer` rejects `/quarantined/`.
- `a supervisor restart changes both generations and releases input its x11vnc left held`: hold a key with `input_fixture.py`, restart the process, and compare `status` before and after. `held` is false once the new supervisor serves.
- `clipboard round-trips for the control lease only`: port the clipboard assertions from the deleted `integration.mjs`. They run without xclip, through `clipboard.py`.

- [ ] **Step 2: Run and confirm failure**: `node --test runtime/desktop/test/*.test.mjs`
- [ ] **Step 3: Implement**

- **Supervisor:**
  - Keep the actor, heartbeat, retirement, clipboard and settlement-cache code paths of today's `supervisor.py`.
  - Replace each `xclip` call with Clawser's helper: `['xclip','-quiet','-selection','clipboard','-in','-target','UTF8_STRING']` becomes `[sys.executable, <dir>/clipboard.py, 'own']`, and `xclip … -out` becomes `[sys.executable, <dir>/clipboard.py, 'read']`. The owner process, PID proof and read-back checks stay the same.
  - Remove `InheritedProxy`, `listening`, the Xvfb, openbox and Chromium launches, the singleton cleanup, the `/proc/net/tcp` checks and `critical`.
  - Replace `proof(...)` subprocess calls with direct `xproof` function calls.
  - On SIGTERM, kill only actor and clipboard process groups. The display and browser aren't the supervisor's.
- **`index.mjs`:** connect with `net.connect({path})`.
- **Docker files and tests:** `git rm` them.

- [ ] **Step 4: Run and confirm pass**

Run: `node --test runtime/desktop/test/*.test.mjs` on Linux. Expected: PASS. Repeat the supervisor test file three times to catch timing flakes.

- [ ] **Step 5: Commit**

```bash
git add runtime/desktop/supervisor.py runtime/desktop/index.mjs runtime/desktop/test/status.test.mjs runtime/desktop/test/readiness.test.mjs runtime/desktop/test/supervisor.test.mjs bin/desktop-controller.mjs bin/reconcile-desktop.mjs src/setup.mjs scripts/check-package.mjs
git rm runtime/desktop/Dockerfile runtime/desktop/entrypoint.sh runtime/desktop/chromium-seccomp.json runtime/desktop/MOBY-LICENSE runtime/desktop/x11-proof.cpp runtime/desktop/test/adapter.test.mjs runtime/desktop/test/fixtures.mjs runtime/desktop/test/health.mjs runtime/desktop/test/heartbeat.mjs runtime/desktop/test/inspect.mjs runtime/desktop/test/integration.mjs
LS_COMMENT_AUDIT=1 git commit -m "feat(desktop): host supervisor on private sockets; remove the Docker runtime"
```

---

### Task 5: Controller, gateway and recovery on sockets

**Files:**
- Modify: `src/novnc-probe.mjs`, `src/desktop-controller.mjs`, `src/desktop-recovery.mjs`, `bin/desktop-controller.mjs`, `bin/reconcile-desktop.mjs`, `src/comparison-proxy.mjs` (comment only)
- Test: `test/novnc-probe.test.mjs`, `test/desktop-controller.test.mjs`, `test/desktop-recovery.test.mjs`, `test/production-viewer.test.mjs`, `test/novnc-pointer.test.mjs`

**Interfaces:**
- Consumes: `HostDesktopRuntime` (Task 4).
- Produces:
  - Registration endpoint: `{ endpoint: { path }, credentials }`. `validRegistration` requires an absolute `path` with no control characters, at most 107 bytes. It rejects a `host` or `port` with `Supervisor must register a private VNC socket`.
  - `NoVncProbeGateway` option `upstreamConnect({ path, signal }) -> Promise<net.Socket>`, renamed from `tcpConnect`. It defaults to `net.connect({ path })` with the same abort handling.
  - `DesktopController.registration(id)` returns `endpoint: { path: actor.socketPath }`.
  - Readiness gate, in `ensure()` and in recovery's `idle()`: `status.ready === true && status.browserReady === true`. The error is `Dedicated browser is not ready`. `browserSandbox` and `authenticatedInternetReady` are no longer read.
  - Controller config (`controller.json`): `{ stateDir, profile, port, socketPath, noVncAssetsDir, runtime: { stateDir, controlSocket, cdpUrl }, transport: { binaryPath, startupTimeoutMs } }`. Both bin entrypoints build `new HostDesktopRuntime(runtimeOptions)`.

- [ ] **Step 1: Update tests first**
  - Every fake registration becomes `{ endpoint: { path: '/tmp/fixture.sock' } }`.
  - Every `tcpConnect` option becomes `upstreamConnect`.
  - Add `registration with a TCP endpoint or relative path is refused`.
  - In `desktop-controller.test.mjs`, the capability loop checks `browserReady:false` and `ready:false`, rejecting `/not ready/`.
  - In `desktop-recovery.test.mjs`, `status()` returns `browserReady:true` with no sandbox fields, and add one case where `browserReady:false` gives `DESKTOP_RECOVERY_RUNTIME_NOT_IDLE_OR_CHANGED`.
- [ ] **Step 2: Run and confirm failure**: `node --test test/novnc-probe.test.mjs test/desktop-controller.test.mjs test/desktop-recovery.test.mjs test/production-viewer.test.mjs test/novnc-pointer.test.mjs`
- [ ] **Step 3: Implement** to the interfaces above.
- [ ] **Step 4: Run and confirm pass**: same command, then the full `npm test` on Linux.
- [ ] **Step 5: Commit**

```bash
git add src/novnc-probe.mjs src/desktop-controller.mjs src/desktop-recovery.mjs src/comparison-proxy.mjs bin/desktop-controller.mjs bin/reconcile-desktop.mjs test/novnc-probe.test.mjs test/desktop-controller.test.mjs test/desktop-recovery.test.mjs test/production-viewer.test.mjs test/novnc-pointer.test.mjs
LS_COMMENT_AUDIT=1 git commit -m "feat(desktop): connect viewers to x11vnc's private socket and gate on browser readiness"
```

---

### Task 6: Read-only browser discovery

**Files:**
- Create: `src/host-browser.mjs`
- Test: `test/host-browser.test.mjs`

**Interfaces:**
- Every function takes `d` with `d.fs`, `d.run`, `d.env`, `d.uid` and `d.procRoot`, which defaults to `'/proc'`. None of them start, stop or write anything.
- Produces:
  - `findBrowserBinary(d) -> Promise<{ path, brand: 'chrome'|'chromium' }>`. It searches PATH and `/opt/google/chrome/chrome` for `google-chrome-stable`, `google-chrome`, `chromium` and `chromium-browser`, in that order, then resolves `realpath`. It refuses Snap with the global-constraint message, and throws `No Google Chrome or Chromium found. Install Google Chrome, then rerun setup.` when nothing is found.
  - `isSnapBrowser(realPath, head) -> boolean` is true when `realPath` starts with `/snap/`, or when `head`, the first 4 KiB of a script, mentions `/snap/bin/` or `snap run`.
  - `listenerProcess(port, d) -> Promise<{ pid, address } | undefined>`:
    - It reads `<procRoot>/net/tcp` and `tcp6` for LISTEN rows (`st == 0A`) on `port`, maps the inode through `<procRoot>/<pid>/fd/*` symlinks (`socket:[inode]`), and keeps only processes owned by `d.uid`.
    - It returns the PID whose `exe` basename is `chrome` or `chromium` and whose argv has no `--type=`.
    - `address` is `'127.0.0.1'`, `'::1'` or the raw address.
  - `processInfo(pid, d) -> Promise<{ pid, exe, argv, env, cgroup }>`. It reads `exe`, the NUL-split `cmdline`, the NUL-split `environ` (as a `Map`) and the unified `cgroup` path.
  - `classifyOwner(cgroup, uid) -> { kind: 'user-unit', unit } | { kind: 'session' } | { kind: 'unknown', detail }`:
    - `user-unit` matches `/user.slice/user-<uid>.slice/user@<uid>.service/app.slice/<name>.service` (or without `app.slice`).
    - `session` matches a leaf of `session-*.scope` or `app-*.scope`.
    - Anything else is `unknown`.
  - `unitMainPid(unit, d) -> Promise<number>` comes from `systemctl --user show -p MainPID --value <unit>`.
  - `displayServices(display, d) -> Promise<{ xvfb?: processInfo, windowManager?: processInfo }>`. The `xvfb` entry is the process whose argv basename is `Xvfb` and whose `argv[1] === ':' + display`. The `windowManager` entry is an `openbox` process whose `env.get('DISPLAY') === ':' + display`.
  - `cookieEncryption(cookiesPath, d) -> Promise<{ total, v10, v11, other }>`. It opens `node:sqlite` read-only on `file:<path>?immutable=1` and runs `SELECT substr(encrypted_value,1,3) AS v, count(*) AS n FROM cookies GROUP BY v`. It never selects full values. A missing file returns all zeros.

- [ ] **Step 1: Write the failing tests** against a fake proc tree in a temp dir. The fd links are real symlinks to `socket:[123]`.
  - `the Chrome listening on the port is found through its socket inode, not its renderers`: two PIDs share the inode, and the one with `--type=renderer` is skipped.
  - `a listener owned by another user is ignored`, using `uid` from a stat override in the fake fs.
  - `a 0.0.0.0 listener reports its address so setup can refuse it`.
  - `owners are classified as user units, sessions or unknown`: four cgroup strings. A `system.slice` service is `unknown`.
  - `display services are found by display number`.
  - `cookie encryption counts version prefixes without reading values`: build a real sqlite file with 2 `v10` rows and 3 `v11` rows. The SQL runs through a spy, and a test asserts it contains `substr(encrypted_value,1,3)`.
  - `snap browsers are refused`: `/snap/chromium/123/usr/lib/chromium-browser/chrome` gives true, and a `#!/bin/sh\nexec /snap/bin/chromium "$@"` head gives true.
  - `findBrowserBinary prefers google-chrome-stable and resolves symlinks`.
- [ ] **Step 2: Run and confirm failure**: `node --test test/host-browser.test.mjs`
- [ ] **Step 3: Implement** to the interfaces above.
- [ ] **Step 4: Run and confirm pass** (macOS is fine, since the proc tree is a fixture).
- [ ] **Step 5: Commit**

```bash
git add src/host-browser.mjs test/host-browser.test.mjs
LS_COMMENT_AUDIT=1 git commit -m "feat(setup): read-only discovery of the browser, its owner, its display and its cookie store"
```

---

### Task 7: Setup option A, receipts, and removing Docker from setup

**Files:**
- Create: `src/host-setup.mjs`
- Modify: `src/setup.mjs`, `src/cli.mjs`
- Test: `test/setup.test.mjs` (rewritten for host mode), `test/cli.test.mjs`

**Interfaces:**
- Consumes: Tasks 1, 2, 3, 4 and 6.
- Produces, `src/setup.mjs` `options(argv, d)`:
  - Flags: `--state-dir`, `--browser-profile <name>`, `--port <n>` (default `19420`), `--dry-run`, `--yes`, `--cdp`, `--novnc` (an accepted no-op, and an error together with `--cdp`) and `--no-migrate-cookies`.
  - `--port` defaults to `19410` with `--cdp`, so existing CDP installs keep their viewer port.
- `--cdp-port`, `--vnc-port`, `--container-name` and `--no-default-profile` throw `<flag> was removed in 0.7.0 along with the Docker desktop`.
- Produces, mode selection in `runClawser`, in order:
  1. `--cdp` runs `runCdpSetup` with `o.explicitCdp = true`.
  2. `--browser-profile` runs option B.
  3. A host receipt runs its saved option and profile.
  4. A CDP receipt without `explicitCdp` runs option B with the CDP-bound profile. That path is Task 8.
  5. Otherwise, option A.

  Doctor: plugin `desktop.enabled === true` runs the host doctor (Task 9). Otherwise it runs the CDP doctor.
- Produces, the receipt `<stateDir>/setup.json`:
  - `identity: 'clawser-setup-v2'`, `uid`, `ownerId`, `option: 'new'|'existing'`, and `profile`, `cdpPort`, `port`, `display`, `stateDir`, `packageDir`, `execPath`.
  - `userDataDir`, `profileDirectory?`, `browser: { path }` and `previousDefaultProfile`.
  - `units: { [name]: sha256 }`, plus `configDigest`, `supervisorConfigDigest`, `openboxDigest` and `assetsDigest`.
  - `hostDeps`, `replaced: []` (Task 8) and `cookieMigration?` (Task 8).
  - A v1 receipt with `imageId` is a Docker install, handled below.
- Produces, `src/host-setup.mjs`:
  - `planHost(o, d, h) -> Promise<Plan>`. It is read-only. `Plan` holds `{ option, profile, display, cdpPort, userDataDir, browser, units: Record<name,text>, writes: [{path, digest}], start: [unit], restart: [unit], stop: [{ kind: 'unit', unit } | { kind: 'close-browser', pid }], takeover: [], cookies?, disruptive: boolean, warnings: [], dockerLeftovers?: [command] }`.
  - `describeHost(plan) -> string[]` gives one plain line per action for `--dry-run` and for a refusal without `--yes`.
  - `applyHost(plan, o, d, h) -> Promise<activation>`. It writes the profile dir (0700), the X cookie (fresh 16 random bytes, 0600, only when absent), the openbox config via `openbox_config.py`, `supervisor.json`, `controller.json` and the units. It runs `daemon-reload`, then `enable --now` in this order: display, wm, browser, supervisor, controller. It waits for controller health, then patches config and reloads exactly as today's `install()` does.
  - Config patch (option A): `browser.profiles.clawser = { cdpUrl: 'http://127.0.0.1:<cdpPort>', driver: 'openclaw', engine: 'chromium', attachOnly: true }` and `browser.defaultProfile = 'clawser'`, plus the plugin entry `{ enabled: true, config: { desktop: { enabled: true, socketPath, profile: 'clawser' }, cloudflare: { enabled: false } } }` and the existing allowlist merges. It never touches `config.profiles`.
- State layout under `<stateDir>`:
  - `setup.json`, `controller.json`, `xauthority`
  - `openbox/rc.xml`, `browser/profile/`
  - `state/` (the controller), `state/desktop.sock`
  - `state/runtime/` (the runtime lock dir), `state/runtime/supervisor.json`, `state/runtime/control.sock`, `state/runtime/vnc/`
  - `bin/cloudflared`, `vendor/novnc-1.7.0/`

  Every socket path is checked against 107 bytes in `planHost`.
- Rerun rules:
  - Rendered units equal to the recorded digests are left alone and not restarted.
  - If only `packageDir` or `execPath` changed, setup rewrites the supervisor and controller units and configs, then restarts only those two.
  - Any other difference from an owned digest is a refusal: "changed outside Clawser".
  - A file that exists without a recorded digest is a refusal: "unowned".
- Docker conversion: a v1 receipt with `imageId` in the same state dir:
  - Verify its controller config and unit digests, stop and disable its controller unit, and keep `vendor/` and `bin/cloudflared`.
  - Write a v2 receipt with option A, and add `dockerLeftovers` to the plan. These are printed commands, never run: `docker rm -f <containerName>`, `docker network rm <containerName>-net`, `docker volume rm <containerName>-profile` and `docker image rm <imageId>`.
  - Stopping its own old controller is not disruptive.

- [ ] **Step 1: Rewrite `test/setup.test.mjs` for host mode first**

Keep the harness shape: fake `run`, `fetch`, artifacts and activation fixture. Fake `systemctl` show, enable and daemon-reload. Inject `d.hostResolver` returning a fixed record, `d.findBrowserBinary`, `d.freeDisplay` and `d.randomBytes`. Drop all Docker fakes. Keep, adapted:
- the pinned downloads
- the trusted OpenClaw entrypoint binding
- the trusted package root
- unowned state dirs
- malformed config envelopes
- checksum failure
- preserving other profiles and allowlists
- reload retry and refusal
- the old-OpenClaw, platform and Node gates

New tests:
- `option A dry run lists the profile, display, units and default-profile change and changes nothing`: no write, enable or patch calls, and the output names `clawser`, `:20` and `<previous default> → clawser`.
- `option A creates a private profile, a cookie and five owned units, then makes clawser the default`:
  - The profile dir and xauthority modes are 0700 and 0600.
  - `enable --now` runs in order.
  - The patch matches the interface above, and `previousDefaultProfile` is recorded.
  - The final log says the agent's browser starts with no logins.
- `without openbox setup warns and writes four units`.
- `a rerun with the same inputs restarts nothing`: no `enable`, `restart` or `daemon-reload`, and no patch beyond the idempotent one.
- `a rerun after the package directory moved rewrites only the supervisor and controller units and restarts only them` (Review Focus 2).
- `state directories whose sockets exceed 107 bytes are refused before anything is written` (Review Focus 3).
- `snap Chromium is refused before anything is written`.
- `removed Docker flags explain they are gone`.
- `a Docker-era install converts to option A and prints its leftovers without running docker`: no `docker` command is ever run, the old controller is stopped, and four leftover commands are printed.
- `--novnc is accepted and --novnc with --cdp is refused`.

`test/cli.test.mjs`:
- The forwarded flags are now `--state-dir`, `--browser-profile`, `--port`, `--dry-run`, `--yes`, `--cdp`, `--novnc` and `--no-migrate-cookies`.
- The help text says noVNC is the default and `--cdp` keeps the one-tab viewer.

- [ ] **Step 2: Run and confirm failure**: `node --test test/setup.test.mjs test/cli.test.mjs`
- [ ] **Step 3: Implement**

- Move host logic into `src/host-setup.mjs`.
- From `setup.mjs`, delete `dockerHost`, `runtimeLabel`, `inspectDocker`, `resources`, the image build, `DesktopRuntime`, the container and VNC ports, and the `source paths` check for Dockerfile and seccomp.
- `prerequisites(d, desktop)` checks `systemctl --user show-environment`, `tar` and `flock`, and never `docker`. The platform message is `Clawser setup requires Linux x86_64 with systemd user services`.
- Keep `configSection`, `reloadPlugin`, `download`, `treeDigest`, `assets`, `atomicPrivate` and `systemdArgument`, the last one moved to `host-units.mjs`.

- [ ] **Step 4: Run and confirm pass**: `node --test test/setup.test.mjs test/cli.test.mjs test/host-deps.test.mjs`, then full `npm test` on Linux.
- [ ] **Step 5: Commit**

```bash
git add src/host-setup.mjs src/setup.mjs src/cli.mjs src/host-units.mjs test/setup.test.mjs test/cli.test.mjs test/host-deps.test.mjs
LS_COMMENT_AUDIT=1 git commit -m "feat(setup): host noVNC option A as the default; convert Docker installs"
```

---

### Task 8: Option B, takeover, cookie migration and upgrades from CDP

**Files:**
- Create: `src/cookie-migration.mjs`
- Modify: `src/host-setup.mjs`, `src/cdp-setup.mjs`, `src/setup.mjs`
- Test: `test/host-setup-existing.test.mjs`, `test/cookie-migration.test.mjs`, `test/cdp-setup.test.mjs`

**Interfaces:**
- Consumes: Task 6 discovery, Task 3 `chromeArgs`, Task 7 `planHost` and `applyHost`, `CdpConnection` from `src/cdp.mjs`.
- Produces, `src/cookie-migration.mjs`:
  - `exportCookies(cdpUrl, tempDir, d) -> Promise<{ path, count }>`: browser-target `Storage.getCookies`, written to `<tempDir>/cookies.json` at 0600, where `tempDir` is created by the caller with `mkdtemp` at 0700.
  - `importCookies(cdpUrl, path, d) -> Promise<{ count }>`: `Storage.setCookies` in batches of 500.
  - `flushCookies(cdpUrl, d, { timeoutMs = 60_000 }) -> Promise<void>`: `Browser.close`, then wait for the listener to go away and come back. systemd's `Restart=always` brings Chrome back.
- Produces, option B planning in `planHost` with `option: 'existing'`:
  1. The profile must be an existing attach-only loopback profile (reuse `resolveHandoffBrowser`). The port comes from its `cdpUrl`.
  2. Call `listenerProcess(port)`. If it's missing, throw `Nothing is listening on <cdpUrl>. Start that browser, then rerun setup.`. A non-loopback address is a refusal.
  3. `processInfo` gives the `userDataDir` and `profileDirectory` from argv. `findBrowserBinary`'s snap check applies to `exe`.
  4. Classify the owner:
     - A `user-unit` recorded in the receipt `units` is Clawser's own. That is a rerun: no takeover, no stop, not disruptive (Review Focus 1).
     - A `user-unit` whose `unitMainPid` equals the Chrome PID is a takeover. Add it to `takeover` with `{ unit, fragmentPath, wasEnabled }`. Do the same for its display's Xvfb unit and its window manager unit from `displayServices(env DISPLAY)` when those are user units. Keep that display number. An Xvfb outside a unit is a refusal: `Display :<n> is not run by a user service; stop it or move Chrome off it, then rerun setup.`.
     - A `session` owner means `stop: [{ kind: 'close-browser', pid }]` and a free display.
     - `unknown`, or a user unit whose main PID isn't Chrome, is a refusal: `<detail> would restart Chrome, so setup won't stop it. Stop it yourself, then rerun setup.`.
  5. `chromeArgs({ existing: argv.slice(1), userDataDir, profileDirectory, cdpPort: port })`. Environment: for a taken-over unit, keep its `Environment=` assignments from `systemctl --user show -p Environment` except `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY` and `DBUS_SESSION_BUS_ADDRESS`. For a session Chrome, keep only `LANG`, `LANGUAGE`, `LC_*` and `TZ` from its process environment. Never copy a whole session environment into a unit.
  6. `cookieEncryption(<userDataDir>/<profileDirectory || 'Default'>/Cookies)`. When `v11 > 0` and `--no-migrate-cookies` isn't set, `cookies = { migrate: true, count: v11 }`. With the flag, the plan carries the warning `<v11> keyring-encrypted cookies will be unreadable; you'll need to sign in to those sites again.`.
  7. The config patch sets `browser.defaultProfile` and `desktop.profile` to the named profile, so the agent and the phone share one browser. The receipt records `previousDefaultProfile`.
  8. Taking over the display unit restarts Xvfb, so the screen starts fresh with one desktop. No EWMH message is needed.
  9. `disruptive` is true if `takeover`, `stop` or `cookies.migrate` is set. A disruptive plan without `--yes` returns `{ ok: false, plan: describeHost(plan) }` before any write.
- Produces, the option B apply order inside `applyHost`:
  1. With cookies to migrate, run `exportCookies` while the old Chrome still runs.
  2. For each takeover, copy the fragment file and its drop-ins into `<stateDir>/backups/<ISO time>/`, then stop and disable the units. Record `replaced` in the receipt before stopping anything.
  3. For a session Chrome, send `Browser.close` and wait up to 30 s for the PID to exit. If it doesn't exit, refuse and restart nothing.
  4. Write and start Clawser's units as in Task 7.
  5. Run `importCookies` and `flushCookies`, then re-read the count with `Storage.getCookies`. Record `cookieMigration: { exported, imported, at }`. Remove the temp dir in a `finally`.
  6. Print: `Sign in to Google once in a handoff link, and re-save any saved site passwords.` when cookies were migrated.
- Produces, CDP changes in `src/cdp-setup.mjs`:
  - `--cdp` writes `explicitCdp: true` into the CDP receipt.
  - CDP doctor, when the receipt lacks `explicitCdp`, adds the warning row `run setup to switch to noVNC, or setup --cdp to keep the CDP viewer`.
  - Mode selection step 4 in Task 7 uses the CDP receipt's bound profile.

- [ ] **Step 1: Write the failing tests**

`test/host-setup-existing.test.mjs` uses a fake proc tree (Task 6 fixtures), fake `systemctl`, fake CDP fetch and WebSocket, and the Task 7 harness:
- `option B without --yes prints the takeover and stops, writes and starts nothing`:
  - `ok` is false, and the lines name the three units and the display.
  - Nothing is written under `XDG_CONFIG_HOME` or `stateDir`, and no stop, disable or enable call runs.
- `option B takes over hand-written units, keeping the display, profile, port and other flags`:
  - Backups exist with the original texts, and `replaced` is recorded before the first stop.
  - The new browser unit has `--user-data-dir=<dir>`, the original `--lang=fr` and port `9222`, on display `:20`.
- `option B refuses a headless or mismatched Chrome before changing anything`.
- `option B fails when nothing listens on the profile port`, matching `/Start that browser, then rerun setup/`.
- `option B closes a Chrome from the desktop session and waits for it to exit`.
- `option B refuses a Chrome that an unrecognized service would restart`.
- `rerunning option B on Clawser's own units takes nothing over and needs no --yes` (Review Focus 1).
- `a CDP install without the explicit mark upgrades through option B with its profile`: the CDP receipt and the `user` profile give `option: 'existing'` and `profile: 'user'`, and plugin `profiles` is untouched.

`test/cookie-migration.test.mjs` uses a fake CDP WebSocket server:
- `keyring cookies are exported before Chrome stops and imported after it starts, and the temp file is removed`: the order of calls is `getCookies`, stop, start, `setCookies`, `Browser.close`, `getCookies`, and the temp dir no longer exists.
- `the export file is 0600 in a 0700 directory and no cookie value reaches the log`: spy on `d.log` and assert no fixture value appears.
- `--no-migrate-cookies warns how many logins will be lost and migrates nothing`.
- `a failed import leaves the temp directory removed and reports the failure`.

`test/cdp-setup.test.mjs`:
- `setup --cdp marks the receipt explicit`.
- `CDP doctor warns to switch when the mark is missing`.

- [ ] **Step 2: Run and confirm failure**: `node --test test/host-setup-existing.test.mjs test/cookie-migration.test.mjs test/cdp-setup.test.mjs`
- [ ] **Step 3: Implement** to the interfaces above.
- [ ] **Step 4: Run and confirm pass**: same command, then full `npm test` on Linux.
- [ ] **Step 5: Commit**

```bash
git add src/cookie-migration.mjs src/host-setup.mjs src/cdp-setup.mjs src/setup.mjs test/host-setup-existing.test.mjs test/cookie-migration.test.mjs test/cdp-setup.test.mjs
LS_COMMENT_AUDIT=1 git commit -m "feat(setup): option B takes over an existing profile's Chrome with --yes; upgrade CDP installs"
```

---

### Task 9: Host doctor

**Files:**
- Modify: `src/host-setup.mjs`, `src/setup.mjs`
- Test: `test/host-doctor.test.mjs`

**Interfaces:**
- Produces: `diagnoseHost(o, p, saved, d, checks) -> Promise<activation>`. It pushes `{ name, ok, message?, warning? }` rows in this order:
  - `installation`, `ownership`, `configuration`, `pinned assets`
  - `host dependencies` (`verifyHostDeps`)
  - `services`: every recorded unit is `ActiveState=active`
  - `display`: the socket exists
  - `browser window`: the browser unit's `MainPID` is among `xproof clients` PIDs, run with the unit's `DISPLAY` and `XAUTHORITY`
  - `CDP origin`: the profile's `cdpUrl` is loopback and equals the receipt
  - `profile directory`: the mode is 0700
  - `linger`: `loginctl show-user <uid> -p Linger --value` is `yes`. Otherwise fail with `run: loginctl enable-linger`.
  - `units current`: rendered units equal the files. A `packageDir` mismatch fails with `the plugin moved; rerun openclaw clawser setup` (Review Focus 2).
  - `controller health`, `Gateway activation`
  - `cookie store`: a warning row when `v11 > 0`
- A v1 receipt with `imageId`, from a Docker install, yields one failing `installation` row: `This is a Docker desktop install from an older Clawser; rerun openclaw clawser setup`.
- Doctor runs only `systemctl --user show`, `loginctl show-user`, `python3 xproof.py clients` and reads. It never starts, stops, writes or downloads.

- [ ] **Step 1: Write the failing tests**:
  - `doctor passes on a healthy install and changes nothing`: every row is OK, and no mutating calls run.
  - Then one test per failure, each asserting its row's message: `an inactive service fails doctor`, `a missing display socket fails doctor`, `a browser window off the shared screen fails doctor`, `a group-readable profile directory fails doctor`, `linger off prints the enable-linger command`, `a moved plugin directory says to rerun setup`, `a Docker-era receipt says to rerun setup`, and `keyring cookies are a warning, not a failure`.
- [ ] **Step 2: Run and confirm failure**: `node --test test/host-doctor.test.mjs`
- [ ] **Step 3: Implement.** Replace the Docker `diagnose()` in `setup.mjs` with `diagnoseHost`. The doctor footer prints the unit names, the state dir and the display.
- [ ] **Step 4: Run and confirm pass**, then full `npm test` on Linux.
- [ ] **Step 5: Commit**

```bash
git add src/host-setup.mjs src/setup.mjs test/host-doctor.test.mjs
LS_COMMENT_AUDIT=1 git commit -m "feat(doctor): check the host services, display, browser window, profile and linger"
```

---

### Task 10: End-to-end acceptance and CI

**Files:**
- Create: `test/host-desktop-e2e.mjs`
- Modify: `.github/workflows/ci.yml`, `package.json` (scripts)

**Interfaces:**
- Consumes: `planHost` and `applyHost` with a stub OpenClaw config layer (`d.run` for `openclaw` only), `HostDesktopRuntime`, and `input_fixture.py`.
- Produces:
  - `npm run test:desktop` runs `node --test runtime/desktop/test/*.test.mjs`, replacing `test:runtime`.
  - `npm run test:e2e` runs `node test/host-desktop-e2e.mjs`. It exits 0 with "skipped" unless `CLAWSER_HOST_E2E=1`.

- [ ] **Step 1: Write the e2e script.** It runs on a disposable runner only. With `CLAWSER_HOST_E2E=1`:
  1. Apply option A into a temp state dir, with units in `~/.config/systemd/user` and the real browser from `CHROME_BIN`'s directory on PATH.
  2. Wait for `HostDesktopRuntime.status()` to report `ready` and `browserReady`.
  3. Assert that a raw Python X connection with `XAUTHORITY=/dev/null` is refused.
  4. Open a tab over CDP on a solid `#00ff00` data URL. `runtime.tabs()` lists the same target IDs as `GET /json/list`.
  5. Start a watch viewer. Do RFB 3.8 VNC auth over `socketPath` (the DES code from the deleted `integration.mjs`), request one raw framebuffer update, and assert the centre pixel is green.
  6. Assert that no TCP LISTEN row belongs to the x11vnc PID.
  7. Start a control viewer, hold a key with `input_fixture.py`, and settle with `mayBeWritable: true`. `query` shows nothing held.
  8. In a `finally`, stop and disable the units and delete them and the state dir.

  If `systemctl --user` is unavailable after enabling linger, run the rendered `ExecStart` argv arrays directly as children instead, and say so in the PR body.
- [ ] **Step 2: Add a CI job `host-desktop`** on `ubuntu-latest`:
  - Run `sudo apt-get update && sudo apt-get install -y xvfb x11vnc openbox`, then `sudo loginctl enable-linger "$USER"`.
  - Export `XDG_RUNTIME_DIR=/run/user/$(id -u)` and wait for `systemctl --user is-system-running --wait || true`.
  - Run `npm ci --ignore-scripts`, `npm run test:desktop`, then `CLAWSER_HOST_E2E=1 npm run test:e2e`.
  - In the existing `test` job, rename `Runtime adapter and readiness tests` to run `npm run test:desktop`.
  - Delete the trailing Docker comment.
- [ ] **Step 3: Run locally.** `npm run test:e2e` prints skipped. `npm run test:desktop` passes on Linux.
- [ ] **Step 4: Push the branch and confirm the CI job passes.** If it fails, fix it and record the cause in the PR body.
- [ ] **Step 5: Commit**

```bash
git add test/host-desktop-e2e.mjs .github/workflows/ci.yml package.json
LS_COMMENT_AUDIT=1 git commit -m "test(ci): host noVNC end to end on a stock runner"
```

---

### Task 11: Docs, package and version

**Files:**
- Modify: `README.md`, `docs/install.md`, `SECURITY.md`, `CONTRIBUTING.md`, `runtime/desktop/README.md`, `runtime/desktop/PLAN.md`, `runtime/desktop/NOTICE.md`, `skills/browser-handoff/SKILL.md` (only if it mentions Docker or the old default), `openclaw.plugin.json` (descriptions only), `scripts/check-package.mjs`, `package.json`, `package-lock.json`, `CHANGELOG.md`
- Test: `npm run check:package`

- [ ] **Step 1: README.** Rewrite "How it works" to every bullet in the spec's README section, in plain words.
  - Add a short diagram matching the spec's.
  - Upgrade steps: install the new version, `openclaw clawser setup --dry-run`, then `openclaw clawser setup --yes`.
  - Say that a git install moves the plugin, so rerun setup after every upgrade.
  - The CDP viewer section: `setup --cdp`, one tab, and the dropdown, picker and dialog limits.
- [ ] **Step 2: `docs/install.md`.**
  - Requirements, with the distro command, and option A versus option B.
  - What `--yes` covers and what the dry run shows.
  - Keyring cookies.
  - Linger.
  - **Undoing setup**, the manual procedure:
    1. `openclaw config set browser.defaultProfile <previousDefaultProfile from setup.json>`.
    2. `systemctl --user disable --now` the five `clawser-*` units.
    3. Copy the backed-up units from `<stateDir>/backups/<time>/` to `~/.config/systemd/user/`, run `daemon-reload`, then `enable --now` them.
    4. Set `plugins.entries.browser-handoff.config.desktop.enabled false` or run `setup --cdp`.
  - Remove every Docker section.
- [ ] **Step 3: `SECURITY.md`.** Cover:
  - No container and no egress firewall, only Chrome's OS sandbox.
  - The VNC server and display are private to the operator, through 0700 sockets and the X cookie.
  - The CDP port is reachable by other local accounts, so use a machine you don't share.
  - A link shows every tab.
  - Cookies under the basic store are protected by file permissions.

  Then update `CONTRIBUTING.md`, `runtime/desktop/README.md`, `PLAN.md` and `NOTICE.md`. Drop Moby and seccomp. Say host packages come from the distro.
- [ ] **Step 4: Package.**
  - `check-package.mjs` drops the Docker files and requires `runtime/desktop/supervisor.py`, `xproof.py`, `openbox_config.py`, `src/host-setup.mjs`, `src/host-units.mjs`, `src/host-browser.mjs`, `src/host-display.mjs` and `src/cookie-migration.mjs`.
  - `package.json` description: `Clawser: secure human takeover links for the agent's browser through noVNC, with an optional one-tab CDP viewer`. Keywords keep `novnc`.
  - Version `0.7.0` in `package.json` and `package-lock.json`.
  - A `CHANGELOG.md` entry for 0.7.0 that names the breaking changes: the default changed, Docker was removed, flags were removed, and setup must be rerun after the upgrade.
- [ ] **Step 5: Verify.** `npm run check:package` passes. `grep -ri docker README.md docs/install.md SECURITY.md CONTRIBUTING.md runtime src bin` finds only the Docker-conversion code, its leftover commands, and the changelog.
- [ ] **Step 6: Commit**

```bash
git add README.md docs/install.md SECURITY.md CONTRIBUTING.md runtime/desktop/README.md runtime/desktop/PLAN.md runtime/desktop/NOTICE.md skills/browser-handoff/SKILL.md openclaw.plugin.json scripts/check-package.mjs package.json package-lock.json CHANGELOG.md
LS_COMMENT_AUDIT=1 git commit -m "docs: explain host noVNC as the default and prepare 0.7.0"
```

---

### Task 12: Review, PR and release gates

- [ ] **Step 1:** Run a whole-branch review against the spec, then fix what it finds.
- [ ] **Step 2:** Run the full suite and `test:desktop` on Linux. Run the offline ClawHub scan on the packed archive with the pinned scanner image and no network. Diff the findings against 0.6.3. Process discovery, `/proc` reads and the cookie export are new and may add findings, so explain or fix each one.
- [ ] **Step 3:** Open the PR to `main` with a plain description. Close PR #5 with a comment pointing to this PR.
- [ ] **Step 4, needs the operator's go:** merge, tag `v0.7.0`, publish to ClawHub, and verify the release archive.
- [ ] **Step 5, needs the operator's go, with the agent idle:** on the operator's box:
  - Upgrade, then `setup --dry-run`, then `setup --yes` (option B takes over the hand-written services).
  - Run doctor, then the physical phone checks in the spec's Acceptance section.
