# Task 4: Main-process and preload integration

## Scope

Integrated the Task 1–3 session, window-policy, capture-protection, lifecycle, and tray modules into the existing Electron main/preload/legacy-renderer path. Existing capture, screenshot, LLM, settings, permissions, AppLink, navigation, shortcuts, local Whisper, and download paths remain in place behind the new lifecycle ownership.

## RED evidence

Initial command:

```sh
node --test test/ipc-contract.test.js test/main-lifecycle-source.test.js
```

Result before implementation: exit 1, 0 passed and 7 failed. The contract suite failed with `MODULE_NOT_FOUND` for `../src/ipc-contract`; the source suite independently identified duplicate quit listeners, disguised identity, missing controller/lifecycle/tray wiring, missing capture-protection ordering, missing display-aware bounds persistence, missing named preload APIs/unsubscribe behavior, and missing renderer snapshot/window-command consumption.

Self-review added one focused regression after discovering that the legacy `stt:status` handler could still override the snapshot-owned capture button:

```sh
node --test test/main-lifecycle-source.test.js
```

That run exited 1 with 6 passed and 1 failed, showing the two `stop-btn` class mutations in the legacy handler. Removing only those mutations made the regression pass.

## GREEN evidence

Focused command:

```sh
node --test test/ipc-contract.test.js test/main-lifecycle-source.test.js
```

Result after implementation and self-review fix: 9 passed, 0 failed.

The focused coverage verifies:

- exact immutable invoke/event names;
- one `will-quit`, `window-all-closed`, and legacy `app:quit` listener plus honest Cue identity;
- one authoritative `SessionController`, lifecycle coordinator, and tray controller construction path;
- content-protection application between every Cue `BrowserWindow` construction and `loadFile`;
- display-aware restore plus debounced per-display move/resize persistence;
- named preload APIs, allowlisted snapshot delivery, and unsubscribe behavior;
- one renderer snapshot subscription, initial snapshot request, explicit Hide/Quit commands, and removal of hover-driven click-through;
- prevention of legacy STT events overriding snapshot-owned session controls.

## Integration details

- `src/ipc-contract.js` is a side-effect-free CommonJS contract with frozen channel maps.
- Preload exposes `sessionGetSnapshot()`, `sessionCommand(command)`, `windowCommand(command)`, `settingsOpen()`, and `captureProtection()` while retaining all migration APIs. `cue.on()` returns a remover for allowed listeners.
- Main creates the controller once, broadcasts complete revisioned snapshots, routes legacy capture/AppLink operations through it, records live mic/system sources on actual PCM, and records transcript/LLM attribution in snapshots.
- Overlay restoration uses all Electron displays and Task 2's pure bounds helpers. Move and resize share one 500 ms persistence debounce, and the current display is selected with `screen.getDisplayMatching()`.
- Both the overlay and permission window apply Task 2 capture protection before `loadFile`; renderer code can request that exact structured result. Old Windows still requests Electron protection and reports `windows-black-fallback`; macOS reports `macos-best-effort`.
- The overlay is interactive by default. Close maps to Hide outside quit cleanup, activation recreates/shows and republishes, lock/unlock/recenter remain recoverable through main/tray commands, and hover no longer changes whole-window input behavior.
- One lifecycle coordinator owns session stop, local engine/AppLink stop, download cancellation, shortcut unregistration, window/tray destruction, and exit. Concurrent/direct/system quit paths converge on its memoized cleanup.
- The legacy renderer subscribes once before requesting the initial snapshot, rejects older revisions, maps phases to the existing listening control, and uses explicit main-owned Hide, Settings, and Quit commands.

## Full verification

Fresh pre-commit commands:

```sh
node --test test/ipc-contract.test.js test/main-lifecycle-source.test.js
npm test
for cue_file in src/ipc-contract.js main.js preload.js renderer/renderer.js test/ipc-contract.test.js test/main-lifecycle-source.test.js; do node --check "$cue_file" || exit 1; done
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --check main.js
git diff --check -- src/ipc-contract.js main.js preload.js renderer/renderer.js renderer/index.html test/ipc-contract.test.js test/main-lifecycle-source.test.js .superpowers/sdd/2026-08-21-cue-session-lifecycle/task-4-report.md
```

Results:

- Focused Task 4 tests: 9 passed, 0 failed.
- Full suite: 173 passed, 0 failed, 0 cancelled/skipped/todo; the process exited normally in 168 ms with no retained timer/process handles.
- Node syntax checks for all task-owned JavaScript exited 0.
- Electron's Node runtime parsed `main.js` successfully (exit 0).
- The task-owned whitespace check produced no findings.

## Changed files

- `src/ipc-contract.js`
- `main.js`
- `preload.js`
- `renderer/renderer.js`
- `renderer/index.html`
- `test/ipc-contract.test.js`
- `test/main-lifecycle-source.test.js`
- `.superpowers/sdd/2026-08-21-cue-session-lifecycle/task-4-report.md`

## Self-review

- The IPC contract contains only the five requested invokes and one snapshot event and has no Electron/process side effects.
- Existing preload methods remain available; only the new stable named methods consume the shared constants.
- Both window constructors call protection immediately and before load. No old-Windows protection skip remains, and exposed results retain Task 2's honest modes/reasons.
- Overlay bounds use `resolveOverlayBounds`; persistence uses copied state from `storeBoundsForDisplay`, is keyed by the matched display id, and is debounced for both move and resize.
- Cue identity is honest in `app.setName`, process title, BrowserWindow title, and document/visible Quit labels. No Microsoft Edge disguise remains.
- There is one construction site for each controller/coordinator/tray and exactly one required lifecycle/legacy quit listener. Close/activate/window-all-closed/quit paths preserve tray-backed behavior and do not recurse through `app.quit()`.
- The controller adapts existing `setCapturing`; legacy `capture:toggle` and AppLink capture actions call controller commands. Existing feature, settings, permissions, navigation, shortcut, and model-download IPC remain registered.
- Snapshots are broadcast whole and the renderer never derives the session button from classes, API keys, capture events, or STT status. Initial retrieval plus revision comparison closes the subscribe/request race.
- The visible Hide and Quit controls use stable commands. Hover-driven click-through is absent; legacy preload/main APIs remain temporarily available for compatibility.
- No unowned dependency/audit files are staged or modified by this task.

## Concerns

This milestone's automated integration checks are pure/source-based and do not open a real Electron window or request microphone/screen hardware. The overall design assigns deterministic Electron smoke and hardware-path verification to later integration/release work; the Task 4 Node suite exits without retained handles.
