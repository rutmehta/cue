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

## Review Round 2

The scoped re-review of Round 1 found five remaining major boundary defects: untrusted renderer source updates, inexact batch/local STT attribution, a stop/restart capture-generation race with graph leaks, prompt metadata built from a different transcript window than the system prompt, and an early close interval before tray policy existed. Each defect received a deterministic regression before implementation.

### Round 2 RED evidence

1. **Authoritative source-update boundary and local callback generation.** `node --test test/source-update.test.js test/stt-status-gate.test.js` initially exited 1 with 0 passed and 2 failed because both new side-effect-free boundary modules were absent. The source probe includes foreign/destroyed sender rejection; inherited, extra, array, and empty shapes; invalid sources/phases; non-finite/out-of-range levels; and non-structured, extra-field, or over-limit errors. The reducer probe repeats malformed patches at the trusted internal boundary. The status gate probe demonstrates invalidation of a stopping local engine's callbacks.
2. **Exact STT adapter/model result.** `node --test test/stt.test.js` initially reported 1 passed and 1 failed because `createSTT` accepted no adapter injection and returned no exact model. Its deterministic OpenAI-failure/Groq-success probe confirms the configured OpenAI model is attempted first while the successful result identifies Groq's actual hardcoded `whisper-large-v3-turbo` model.
3. **Capture generation and transactional audio graphs.** `node --test test/renderer-capture-lifecycle.test.js` initially reported 5 passed and 4 failed. Stop followed immediately by restart reused the stale promise and performed only one acquisition; a throwing AudioWorklet connection retained handlers/nodes; the ScriptProcessor transaction helper was absent; and terminal dual-graph failure did not own and close the `AudioContext`.
4. **One complete prompt plan.** `node --test test/prompts.test.js` initially reported 10 passed and 2 failed because `buildFeatureRequest` did not exist. The probes place a salary question just outside Say's 16-turn window and supply mixed null/undefined/false/blank/wrong-channel turns, proving that category-specific system material, user-prompt rendering, and `contextUsed` must share one bounded validated set.
5. **Pre-coordinator close policy.** `node --test test/lifecycle.test.js test/main-lifecycle-source.test.js` initially reported 15 passed and 2 failed because no pre-coordinator decision helper existed and main did not route overlay close through it. The regression checks Windows/Linux default to Quit, macOS defaults to Hide, and an established coordinator remains authoritative.

### Round 2 GREEN implementation

- Added a side-effect-free source-update validator and sender guard. Main accepts reports only from the current live overlay `webContents`; payload and patch objects must be plain, exact, data-only shapes; source/phase are allowlisted; level is finite within `[0, 1]`; and error text/code are structured and bounded. The session reducer applies the same patch validator so trusted callers cannot inject fields or invalid values. Renderer error serialization clips to those limits before sending.
- Batch STT no longer preclaims the first configured provider or a settings model. Every adapter attempt carries its real provider/model, a successful result returns both, and main dispatches them only after that success. Streaming-to-batch fallback clears the failed engine until the batch attempt succeeds. Local Whisper callbacks are generation-gated; normal stop and force-stop invalidate the generation and clear the active model before the transcriber's terminal `off` callback can restore stale metadata.
- Renderer capture pending operations are generation-owned rather than globally reused. A stop invalidates the old promise, and an immediate restart starts a distinct acquisition while the late old resource is disposed. AudioWorklet and ScriptProcessor graph builders now roll back handlers and every created node on any connection failure. If neither graph activates, the helper closes its owned `AudioContext`; the renderer uses this single transactional path for both sources.
- Prompt construction now filters to non-empty text turns from only `you`/`them`, trims and per-turn bounds text, applies one mode-specific bounded turn window (including a 200-turn recap bound), detects category from that same plan, and uses the plan for both system context and user text. `contextUsed` is derived only after both prompt components are finalized, so excluded or invalid source turns are not attributed.
- Overlay close calls a pure policy helper even before lifecycle construction. A close in the tray-detection interval therefore quits on Windows/Linux instead of hiding an unreachable skip-taskbar window; macOS retains its hide/recovery convention, and the completed lifecycle/tray policy supersedes the default.

### Round 2 verification

Fresh final commands:

```sh
node --test test/source-update.test.js test/session-state.test.js test/stt-status-gate.test.js test/stt.test.js test/renderer-capture-lifecycle.test.js test/prompts.test.js test/lifecycle.test.js test/main-lifecycle-source.test.js
npm test
for cue_file in main.js renderer/renderer.js renderer/capture-lifecycle.js src/source-update.js src/session-state.js src/stt.js src/stt-status-gate.js src/prompts.js src/lifecycle.js; do node --check "$cue_file" || exit 1; done
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --check main.js
git diff --check -- . ':(exclude)package-lock.json'
```

Results:

- Focused impacted tests: **54 passed, 0 failed**.
- Full suite: **203 passed, 0 failed, 0 cancelled/skipped/todo**; ordinary `npm test` exited normally in 153 ms with no retained timer/process handles.
- All Node syntax checks and Electron's Node-runtime `main.js` parse exited 0.
- The tracked-change whitespace check produced no findings.
- The pre-existing user-modified `package-lock.json` and untracked `index.cjs`, `index.js`, and `main-CLCIkAdW.js` remain unstaged and were not used by the fix.

### Round 2 self-review and concerns

Each reviewer line was rechecked against the final diff: source updates have both sender and value boundaries; batch/local STT cannot publish configured-but-unused or shutdown-stale metadata; immediate capture restart and every partial graph failure have explicit ownership cleanup; transcript category/system/user/attribution share one validated bounded plan; and every pre/post-coordinator close branch has a reachable recovery or quit path. The Node suite exits cleanly and no process-wide import side effects were added to the new pure helpers.

As in Round 1, media tests use deterministic fake streams/nodes and do not exercise physical device permission UI. Exact STT metadata is adapter-tested without external network calls. Target-OS smoke testing remains necessary for Electron media graphs and the real tray-less startup/close interval.

## Review Round 3

The scoped re-review of Round 2 identified four terminal-semantics regressions: batch exhaustion left stale ready metadata, graceful local shutdown discarded successfully drained transcripts, Answer This lost category-specific profile context, and a throwing fallback observer escaped capture cleanup. The fixes preserve the established session authority while separating terminal status, transcript, prompt-category, and diagnostic-observer responsibilities.

### Round 3 RED evidence

The combined regression command was run before production changes:

```sh
node --test test/stt-status-gate.test.js test/prompts.test.js test/renderer-capture-lifecycle.test.js test/main-lifecycle-source.test.js
```

It exited 1 with **29 passed and 5 failed**:

1. The batch-result probe found no function that maps an exhausted provider chain to `{ phase: "error", activeEngine: null, model: null }`, and the main-source integration probe found no call before the error return.
2. The local callback probe found no lifecycle capable of suppressing shutdown statuses while keeping transcript delivery valid through a graceful drain. Main still invalidated its single generation before `LocalWhisperTranscriber.stop()`.
3. The Answer This table expected compensation, motivation, and behavioral categories from three selected questions but received `general` for the first case; category-specific salary/company/STAR material was consequently absent.
4. The capture graph probe threw `diagnostic observer failed` instead of constructing the valid ScriptProcessor fallback, proving the observer escaped before recovery or terminal context cleanup.

Each behavior then completed an isolated RED/GREEN cycle. The focused batch mapper, graceful callback gate/main wiring, Answer This request plan, and fallback observer probes passed individually before the combined verification run.

### Round 3 GREEN implementation

- `batchStatusForResult()` now maps every attempted batch result to authoritative metadata. Main publishes that update before handling/returning an all-provider error, so the snapshot becomes `error` with the provider's failure detail and clears both `activeEngine` and `model`. Successful attempts retain exact provider/model attribution through the same mapper.
- Local Whisper uses a callback lifecycle with separate transcript and status permissions. Graceful stop suppresses state/speech/error callbacks immediately but allows pending final transcripts until `stop()` completes its deliberate drain; only then is transcript delivery invalidated. Startup failure and quit-time `forceStop()` invalidate both channels immediately.
- The prompt plan now validates, trims, and bounds `userText`. For Answer This only, that selected question becomes the category-detection/system-context input while the unrelated transcript window remains empty. Compensation, motivation, and behavioral questions therefore receive the relevant profile material without setting mic/system attribution.
- AudioWorklet fallback notification is best-effort. A synchronous observer exception is contained, ScriptProcessor recovery still runs, and if recovery itself fails the existing terminal path closes the owned `AudioContext`.

### Round 3 verification

Final verification commands:

```sh
node --test test/stt-status-gate.test.js test/stt.test.js test/local-whisper-transcriber.test.js test/prompts.test.js test/renderer-capture-lifecycle.test.js test/main-lifecycle-source.test.js test/session-state.test.js
npm test
for cue_file in main.js renderer/capture-lifecycle.js src/prompts.js src/stt-status-gate.js test/main-lifecycle-source.test.js test/prompts.test.js test/renderer-capture-lifecycle.test.js test/stt-status-gate.test.js; do node --check "$cue_file" || exit 1; done
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --check main.js
git diff --check -- . ':(exclude)package-lock.json'
```

Results:

- Focused impacted tests: **47 passed, 0 failed**.
- Full suite: **207 passed, 0 failed, 0 cancelled/skipped/todo**; the ordinary process exited normally without retained timer/process handles.
- Node syntax checks, Electron's Node-runtime parse of `main.js`, and the tracked whitespace check all exited 0.
- The user-modified `package-lock.json` and untracked `index.cjs`, `index.js`, and `main-CLCIkAdW.js` remain outside the commit.

### Round 3 self-review and concerns

The final paths distinguish failure from configuration, graceful drain from forced cancellation, selected-question category input from transcript attribution, and diagnostics from graph ownership. No new Electron or import-time side effects were introduced; both new STT decisions remain pure and deterministically tested.

The local drain regression is covered by the pure callback lifecycle plus the existing real `LocalWhisperTranscriber` drain tests, using an injected in-memory session rather than a Whisper process. Audio graph recovery likewise uses deterministic nodes. Physical media devices, native Whisper shutdown, and OS permission UI remain release-smoke concerns.

## Review Round 4

The scoped re-review of Round 3 found three stale-work boundaries: unordered batch completions could overwrite newer terminal state or publish after stop, a timeout-abandoned local inference could publish after restart, and asynchronous fallback-observer rejection was not consumed. This round adds explicit epochs/generations at every asynchronous commit boundary.

### Round 4 RED evidence

The pre-implementation regression command was:

```sh
node --test test/stt-status-gate.test.js test/main-lifecycle-source.test.js test/local-whisper-transcriber.test.js test/renderer-capture-lifecycle.test.js
```

It exited 1 with **22 passed and 6 failed**:

1. The batch-attempt probe found no capture/attempt gate, the main integration probe found no begin/commit/invalidate wiring, and failure-detail normalization exposed an undefined 500-character bound. The scenarios commit a newer failure before an older success, stop with an attempt pending, and restart before the stale epoch completes.
2. Two deferred local Whisper probes timed out an inference whose abort deliberately did nothing, restarted the transcriber, and then resolved or rejected the old job. The old success was published alongside the fresh transcript, and the old failure reached `onError`.
3. The fallback observer returned a rejecting thenable. ScriptProcessor recovery succeeded, but the thenable was never adopted, proving its rejection had no attached consumer.

Each group then completed an isolated RED/GREEN cycle: the batch ordering/detail and main-source probes, both delayed local completion probes, and the asynchronous observer probe passed separately before combined verification.

### Round 4 GREEN implementation

- Added one process-wide batch attempt gate with monotonically increasing attempts and distinct capture epochs. Capture start opens a new epoch; normal stop and force-stop invalidate it. `flushChannel()` obtains a token before transcription and atomically commits it before publishing status, handling errors, or publishing transcript. A completion from an invalidated epoch or older than the latest committed attempt returns without changing the authoritative snapshot or transcript.
- Batch error detail now accepts only non-empty string content, trims it, and bounds it to 500 characters. Null, blank, boolean, object, and missing provider messages use the fixed actionable fallback `Speech-to-text providers failed.`
- `LocalWhisperTranscriber` now generation-tags every queued job. Start, timeout abandonment, and force-stop advance the generation. Jobs recheck both discard state and generation after `await session.transcribe()`, and the error path performs the same generation check. A delayed abort-ignoring success or failure therefore cannot escape into a restarted session, while a genuinely completed graceful drain still publishes normally.
- Audio fallback diagnostics now pass through `Promise.resolve(...).catch(() => {})` inside the existing synchronous guard. Synchronous throws and asynchronous/thenable rejections are both best-effort, are not awaited, and cannot interrupt ScriptProcessor recovery or terminal context cleanup.

### Round 4 verification

Final verification commands:

```sh
node --test test/stt-status-gate.test.js test/main-lifecycle-source.test.js test/stt.test.js test/local-whisper-transcriber.test.js test/renderer-capture-lifecycle.test.js test/session-state.test.js test/session-controller.test.js
npm test
for cue_file in main.js renderer/capture-lifecycle.js src/local-whisper-transcriber.js src/stt-status-gate.js test/local-whisper-transcriber.test.js test/main-lifecycle-source.test.js test/renderer-capture-lifecycle.test.js test/stt-status-gate.test.js; do node --check "$cue_file" || exit 1; done
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --check main.js
git diff --check -- . ':(exclude)package-lock.json'
```

Results:

- Focused impacted tests: **45 passed, 0 failed**.
- Full suite: **212 passed, 0 failed, 0 cancelled/skipped/todo**; ordinary `npm test` exited normally without retained timer/process handles.
- Node syntax, Electron's Node-runtime `main.js` parse, and tracked whitespace checks exited 0.
- The user-modified `package-lock.json` and untracked `index.cjs`, `index.js`, and `main-CLCIkAdW.js` remain outside the commit.

### Round 4 self-review and concerns

The final batch commit point guards status, error side effects, and transcript together, rather than protecting only presentation metadata. Stop and restart both invalidate pending work. Local jobs validate after the provider await and error catch, covering success, failure, timeout, force-stop, and later generation reuse. Fallback notification remains non-blocking while every rejection is consumed.

The ordering and delayed-completion tests are deterministic and network-free. Native provider cancellation, real Whisper processes that ignore abort, and browser AudioContext behavior remain target-runtime smoke-test concerns, but stale commits no longer depend on cancellation succeeding.

## Review Round 5

The scoped re-review of Round 4 exposed four isolation boundaries: one channel's newer batch result suppressed another channel's valid transcript, a timeout-abandoned local queue blocked fresh-generation work, a hostile promise `catch` accessor escaped best-effort diagnostic handling, and numeric attempt identifiers could alias after the safe-integer boundary. This round separates transcript eligibility from authoritative effect ordering and gives every asynchronous owner a non-reusable generation identity.

### Round 5 RED evidence

The pre-implementation regression command was:

```sh
node --test test/stt-status-gate.test.js test/local-whisper-transcriber.test.js test/renderer-capture-lifecycle.test.js
```

It exited 1 with **20 passed and 4 failed**:

1. The cross-channel gate probe committed a newer `them` result before an older `you` result. The older result was rejected wholesale instead of retaining transcript eligibility while yielding the global status effect.
2. The overflow probe initialized immediately below `Number.MAX_SAFE_INTEGER`; attempts restarted at the old numeric value rather than remaining unique across the boundary.
3. The local Whisper probe timed out an abort-ignoring stale inference, restarted the same transcriber, and queued fresh audio. The fresh job remained blocked behind the old queue instead of completing on the next turn.
4. The capture diagnostic probe returned a rejected native promise with an own throwing `catch` accessor. Recovery built the fallback graph, but observer handling read the hostile accessor once instead of attaching rejection handling through intrinsic promise machinery.

Each regression then passed in isolation before the combined focused and full-suite verification.

### Round 5 GREEN implementation

- The batch gate now issues an opaque `Symbol` capture epoch and `BigInt` attempt sequence. It tracks the latest authoritative status/error effect globally while tracking transcript eligibility independently per channel. A newer result from the opposite channel can therefore own session metadata without deleting valid in-epoch speech; same-channel older work and every invalidated-epoch completion remain rejected.
- Main supplies the channel when beginning an attempt and applies the gate's two decisions independently: status and error handling require effect ownership, while validated transcript publication requires channel transcript ownership. A result with neither permission exits before any side effect.
- `LocalWhisperTranscriber` owns a separate queue state for every start generation. Timeout and force-stop abandon the captured queue without reusing its tail; a restart immediately installs a fresh tail and pending count. Old promises retain rejection/finally consumers, but generation, queue identity, and abandoned-state checks prevent stale transcripts, errors, or `ready` status from entering the new session.
- Fallback-observer results are assimilated into a guaranteed fresh native promise, and rejection handling is attached with `Promise.prototype.then.call`. The code never consults result-controlled `catch` or `then` properties directly, does not await diagnostics, and preserves ScriptProcessor recovery and terminal cleanup.

### Round 5 verification

Final verification commands:

```sh
node --test test/stt-status-gate.test.js test/main-lifecycle-source.test.js test/stt.test.js test/local-whisper-transcriber.test.js test/renderer-capture-lifecycle.test.js test/session-state.test.js test/session-controller.test.js
npm test
for cue_file in main.js renderer/capture-lifecycle.js src/local-whisper-transcriber.js src/stt-status-gate.js test/local-whisper-transcriber.test.js test/main-lifecycle-source.test.js test/renderer-capture-lifecycle.test.js test/stt-status-gate.test.js; do node --check "$cue_file" || exit 1; done
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --check main.js
git diff --check -- . ':(exclude)package-lock.json'
```

Results:

- Focused impacted tests: **49 passed, 0 failed**.
- Full suite: **216 passed, 0 failed, 0 cancelled/skipped/todo**; ordinary `npm test` exited normally in 148 ms without retained timer/process handles.
- Node syntax, Electron's Node-runtime `main.js` parse, and tracked whitespace checks exited 0.
- The user-modified `package-lock.json` and untracked `index.cjs`, `index.js`, and `main-CLCIkAdW.js` remain outside the commit.

### Round 5 self-review and concerns

Every reviewer boundary was rechecked against the final commit path: global status ordering cannot suppress an opposite-channel transcript, invalid epochs and same-channel stale work remain closed, restart progress no longer depends on abandoned inference settlement, stale queue finalizers cannot publish into the new generation, diagnostic assimilation avoids result-owned continuation methods, and attempt identity does not reuse JavaScript numbers.

The concurrency regressions are deterministic and use deferred in-memory providers; the audio probe uses fake graph nodes. Real provider cancellation, native Whisper process behavior, and Electron AudioContext fallback remain target-runtime smoke-test concerns, but correctness no longer relies on cancellation or observer cooperation.

## Review Round 6

The scoped re-review of Round 5 found one remaining native-promise boundary: wrapping an observer result immediately triggers promise assimilation, which reads an own hostile `then` accessor before any rejection reaction is attached to the original rejected promise. Legacy graph recovery can therefore succeed while Node's strict unhandled-rejection policy terminates the process.

### Round 6 RED evidence

The regression runs the real capture graph in a subprocess with `--unhandled-rejections=strict`. Its fallback observer returns an otherwise-unconsumed rejected native promise whose own `then` and `catch` getters both throw. Before the production change:

```sh
node --test test/renderer-capture-lifecycle.test.js
```

exited 1 with **12 passed and 1 failed**. The subprocess exited 1 on the original `diagnostic rejection` even though the ScriptProcessor graph had recovered, proving the wrapper consumed only its own assimilation failure and left the native promise unhandled.

### Round 6 GREEN implementation

Fallback diagnostics now first invoke `Promise.prototype.then.call(observerResult, undefined, rejectionHandler)`. A genuine native promise receives its rejection reaction through the intrinsic method without reading result-controlled `then` or `catch` properties. Only when that intrinsic call rejects the receiver as non-native does the code assimilate the result into a guaranteed fresh native promise and attach the same intrinsic rejection handler there. Synchronous observer errors, generic thenables, plain values, and terminal graph cleanup retain their existing best-effort behavior.

### Round 6 verification

Final verification commands:

```sh
node --test test/renderer-capture-lifecycle.test.js
npm test
node --check renderer/capture-lifecycle.js
node --check test/renderer-capture-lifecycle.test.js
git diff --check -- . ':(exclude)package-lock.json'
```

Results:

- Focused capture lifecycle tests: **13 passed, 0 failed**. The strict subprocess exits 0 after reporting legacy recovery and zero reads of both hostile accessors.
- Full suite: **217 passed, 0 failed, 0 cancelled/skipped/todo**; ordinary `npm test` exited normally in 151 ms.
- Both Node syntax checks and the tracked whitespace check exited 0.
- The user-modified `package-lock.json` and untracked `index.cjs`, `index.js`, and `main-CLCIkAdW.js` remain outside the commit.

### Round 6 self-review and concerns

The intrinsic branch is first, non-awaiting, and applies only a rejection reaction; it therefore consumes genuine native promise rejection before any result-owned continuation property can run. The fallback branch preserves thenable assimilation on a fresh promise and attaches its handler intrinsically. The regression's separate strict subprocess is intentionally unpreconsumed, so reverting the ordering deterministically terminates it.

The remaining release concern is target-Electron AudioContext smoke testing; promise rejection ownership is covered under Node's strictest process-level policy.
