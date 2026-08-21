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

## Review Round 1

An independent integration review found one blocker, seven major defects, and one minor defect after the original Task 4 commit (`c6b6a7a50a6392c5cf92944e4bc13e88072bcf7f`). The repair scope was deliberately expanded to the minimum Task 1–3 helpers, AppLink, prompt construction, build identity configuration, and tests needed to close those integration gaps.

### Review RED evidence

Each finding received a deterministic regression before its implementation:

1. **Windows identity and real Electron capture-protection interface.** `node --test test/capture-protection.test.js test/build-config.test.js` initially reported 7 passed and 4 failed. The failures proved that `package.json` still invoked the disguise postinstall, the build still lacked Cue-owned executable naming, and protection incorrectly required a fabricated `isContentProtected()` getter absent from Electron 33.2.1's `BrowserWindow` interface.
2. **Authoritative source/STT/settings/clear lifecycle.** `node --test test/ipc-contract.test.js test/main-lifecycle-source.test.js` initially reported 7 passed and 3 failed: no source lifecycle send contract, no preload source reporter, and no main/renderer dispatch path. Reducer behavior tests additionally cover partial source failure/degradation, pause/resume, STT metadata, settings route/model changes, and clearing both authoritative transcript branches. A later existing-schema probe reported 8 passed and 1 failed because local `localWhisper` settings still appeared as requested engine `auto`.
3. **Opposite commands during transitions.** The deferred start/resume and quit probes initially reported 17 passed and 5 failed. A queued stop or pause never ran because every command received the first transition promise.
4. **Renderer capture races and sinks.** The new capture lifecycle test first failed with `MODULE_NOT_FOUND`. After the helper existed, an additional activation-failure probe reported 4 passed and 1 failed because the acquired stream was not disposed. The suite deterministically defers media acquisition/activation, checks duplicate-start coalescing, stops during both pending stages, and inspects the retained zero-gain worklet graph.
5. **AppLink/tray/controller split.** `node --test test/applink.test.js test/tray-menu.test.js test/main-lifecycle-source.test.js` reported 21 passed and 4 failed. It demonstrated that AppLink trusted the legacy PCM gate, action results echoed requested rather than actual state, visibility-only tray changes were suppressed, and main hard-coded tray availability.
6. **Exact LLM context attribution.** `node --test test/prompts.test.js` reported 8 passed and 2 failed because prompt construction did not return metadata. The regressions use a microphone turn outside Say's 16-turn window and LeetCode with both transcript sources to prove attribution comes only from material actually sent.
7. **Unsupported system-capture cleanup.** The renderer refactor removes the unbalanced `sysStarting` early return by running capability validation inside the generation-owned acquisition promise and reporting `unsupported` through the same `try`/promise settlement path.

### Review GREEN implementation

- Removed the postinstall identity hook and deleted all three scripts that renamed Electron, patched Microsoft product/company metadata, or copied Edge icons. Packaged identity now uses `productName: "Cue"`, `executableName: "cue"`, and the existing Cue logo glyph as an explicit scalable cross-platform build asset; development identity remains `app.setName('Cue')`.
- Capture protection now calls the shipped `setContentProtection(true)` API and reports `{ configured: true, verified: false }`: protection was requested, but exclusion is not falsely claimed as verified. Setter rejection remains the only supported-path error.
- Added the frozen `IPC_SENDS.sourceUpdate` contract and named preload reporter. Mic/system capture explicitly reports `starting`, `live`, `error`/`unsupported`, and `off`; main validates these updates through the session reducer. Partial failure now produces `listening` plus `degradedReason`, while dual failure produces `error`.
- Local, streaming, batch, fallback, error, and stop paths dispatch `STT_UPDATED` with the selected engine/model and honest phase. Streaming fallback replaces the failed engine with the actual batch provider, and shutdown disconnects cannot overwrite fallback/off state. Settings dispatch `SETTINGS_UPDATED`, including the existing `localWhisper` schema, and transcript clear dispatches `TRANSCRIPT_CLEARED`.
- Replaced the controller's single in-flight transition with an ordered promise queue. Only adjacent duplicate commands coalesce; distinct start/stop/pause/resume commands execute in order and re-read the resulting phase. Quit therefore shares the queued stop rather than dropping it.
- Added `renderer/capture-lifecycle.js`, loaded before the renderer. Each source has one generation and in-flight promise; stop invalidates pending capture, disposes late streams/graphs, and prevents an overwritten orphan. Both AudioWorklet and ScriptProcessor paths retain a zero-gain destination sink and disconnect it on stop.
- AppLink state and action responses derive from the authoritative controller snapshot. `set_capturing` awaits the controller result before recording or returning it. Legacy `capture:state` now derives from the same phase; `state.capturing` remains only the internal PCM routing gate.
- Tray snapshots combine the controller snapshot with actual `BrowserWindow.isVisible()` state. Menu refresh keys phase plus visibility and refreshes on show/hide/close/recovery. `createAppTray()` returns success, and that result configures the lifecycle close policy so tray-less Windows/Linux quit instead of becoming unreachable.
- `buildFeaturePrompt()` owns the exact transcript slice for every mode and returns its source attribution with the built text. LeetCode and Answer This include no transcript sources; failed/unused screenshots are not attributed.

### Review verification

Fresh final commands after self-review:

```sh
node --test test/applink.test.js test/build-config.test.js test/capture-protection.test.js test/ipc-contract.test.js test/lifecycle.test.js test/main-lifecycle-source.test.js test/prompts.test.js test/renderer-capture-lifecycle.test.js test/session-controller.test.js test/session-state.test.js test/tray-menu.test.js
npm test
for cue_file in electron-builder.cjs main.js preload.js renderer/capture-lifecycle.js renderer/renderer.js src/applink-state.js src/applink.js src/capture-protection.js src/ipc-contract.js src/prompts.js src/session-controller.js src/session-state.js src/tray-menu.js test/applink.test.js test/build-config.test.js test/capture-protection.test.js test/ipc-contract.test.js test/lifecycle.test.js test/main-lifecycle-source.test.js test/prompts.test.js test/renderer-capture-lifecycle.test.js test/session-controller.test.js test/session-state.test.js test/tray-menu.test.js; do node --check "$cue_file" || exit 1; done
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --check main.js
git diff --check -- . ':(exclude)package-lock.json'
```

Results:

- Focused impacted tests: **76 passed, 0 failed**.
- Full suite: **190 passed, 0 failed, 0 cancelled/skipped/todo**; the ordinary `npm test` process exited normally in 145 ms with no retained timer/process handles.
- All Node syntax checks and Electron's Node-runtime `main.js` parse exited 0.
- The tracked-change whitespace check produced no findings.
- The user-owned modified `package-lock.json` and untracked `index.cjs`, `index.js`, and `main-CLCIkAdW.js` were neither edited for this review nor staged.

### Review concerns

The deterministic renderer tests exercise capture ownership with deferred fake media resources rather than requesting real microphone/display permission. The capture-protection tests intentionally model Electron 33.2.1's real interface shape (`setContentProtection` with no nonexistent verification getter), but they do not claim OS-level exclusion. Hardware permission dialogs, Windows Task Manager presentation, and OS-specific screen-share exclusion still require release smoke testing on their target operating systems.
