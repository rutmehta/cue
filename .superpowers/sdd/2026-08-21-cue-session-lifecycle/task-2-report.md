# Task 2 report: display-safe bounds and capture protection

## Scope

Implemented the two pure CommonJS helpers specified by Task 2:

- `src/window-state.js`: deterministic display selection, restore/default placement, reachability clamping, and immutable per-display persistence.
- `src/capture-protection.js`: platform-aware content-protection policy with honest modes and structured failures.

## RED evidence

After adding the focused tests and before adding either source module, ran:

```sh
node --test test/window-state.test.js test/capture-protection.test.js
```

Result: failed as expected (2 failing test files, 0 passing), with `Cannot find module '../src/capture-protection'` and `Cannot find module '../src/window-state'`. The failure demonstrated that the tests required the new production modules rather than passing against existing behavior.

## GREEN and verification evidence

After implementation, ran:

```sh
node --test test/window-state.test.js test/capture-protection.test.js
```

Result: PASS — 10 tests passed, 0 failed.

Then ran:

```sh
npm test
git diff --check
! rg -n '[ \t]+$' src/window-state.js src/capture-protection.js test/window-state.test.js test/capture-protection.test.js
```

Result: PASS — full suite: 150 tests passed, 0 failed; no diff whitespace errors; no trailing whitespace in task-owned source/tests.

## Changed files

- `src/window-state.js`
- `src/capture-protection.js`
- `test/window-state.test.js`
- `test/capture-protection.test.js`

## Self-review

- Bounds resolution is Electron-free and deterministic; it accepts only display-shaped inputs and does not access Electron APIs.
- Defaults are 720×600, width has a 420 px minimum, and height has an 80 px minimum before being limited to the selected work area.
- The restore path selects a currently connected display that has saved bounds; when none exists it uses the primary display and default placement. It clamps placement so 96 px horizontally and 40 px of the rail vertically remain reachable.
- Bounds persistence builds new top-level and per-display objects, leaving the caller's saved map and bounds object unchanged.
- Protection policy calls Electron only for macOS and Windows. macOS returns `macos-best-effort`; Windows build 19041+ returns `windows-excluded`; older Windows returns `windows-black-fallback`; unsupported platforms return `unsupported`.
- `CUE_NO_PROTECT` returns `disabled` before accessing the BrowserWindow. Electron throws and failed/throwing verification return structured `error` results instead of escaping.
- The implementation intentionally does not claim universal capture invisibility; the macOS mode is explicitly best effort and older Windows remains an honest black-frame fallback.

## Concerns

None. This task provides pure helpers only; Electron integration (applying protection before showing/reapplying after window recreation and persisting actual window movement) remains the responsibility of later integration work.
