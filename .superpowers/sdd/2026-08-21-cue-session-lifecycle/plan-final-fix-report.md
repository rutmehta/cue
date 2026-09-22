# Session/lifecycle whole-plan final fixes

## Scope and baseline

The whole-plan review was applied on branch `codex/cue-rebuild` from `6f40db2c095ca7bdaaa056b3bf914e540c898423`. The starting suite passed **217/217**. The only pre-existing workspace changes were the protected user-owned `package-lock.json` and untracked `index.cjs`, `index.js`, and `main-CLCIkAdW.js`; none is included in this work.

The review covered five implementation boundaries and one documentation inconsistency: Electron display-media audio shape, authoritative renderer source reconciliation, streaming callback/timer lifetime, session/tray observer failure isolation, preferred-display persistence, and honest content-protection wording.

## RED evidence

Every implementation change began with a deterministic failing behavior test.

### Electron display-media contract

```sh
node --test test/display-media.test.js
```

Exited 1 with **0 passed and 1 failed** because the side-effect-free adapter did not yet exist. The test invokes the handler and requires the literal Electron 33 `Streams` result `{ video: source, audio: 'loopback' }`, not a boolean.

### Renderer source reconciliation and bootstrap ownership

```sh
node --test test/renderer-capture-lifecycle.test.js
```

Exited 1 with **13 passed and 3 failed**. The new probes demonstrated that no reconciler started both sources for an already-active snapshot, a rejected session command could not cancel its gesture-bootstrapped system capture, and no pure error mapper produced an actionable `gesture_required` source error.

### Streaming generation and reconnect ownership

```sh
node --test test/stt-status-gate.test.js test/stt-streaming-lifecycle.test.js
```

Exited 1 with **7 passed and 3 failed**. The callback-generation helper was absent, and both OpenAI Realtime and Deepgram called `connect()` after `disconnect()` because their scheduled retry closures were still live.

### Controller observer isolation and tray retry

```sh
node --test test/session-controller.test.js test/tray-menu.test.js
```

Exited 1 with **13 passed and 2 failed**. A throwing publisher escaped `SessionController.start()` before `startCapture`, while a failed native tray menu installation advanced the snapshot key and made the identical retry return `false`.

### Preferred-display persistence

```sh
node --test test/window-state.test.js
node --test test/main-lifecycle-source.test.js
```

The first command exited 1 with **4 passed and 2 failed**: multiple saved displays restored the first record instead of the preferred display, unplugging that preferred display restored an older primary record instead of recentering, and no atomic overlay-state persistence helper existed. The main integration probe separately exited 1 with **7 passed and 1 failed** because preferred-display persistence was not wired.

The documentation correction changes human-facing requirements and therefore has no synthetic source test: the plan's fabricated getter example and the plan/spec claims were compared directly against Electron 33.2.1's bundled `Streams` and `BrowserWindow` declarations.

## GREEN implementation

- Added a display-media request adapter whose callback always uses Electron's documented `'loopback'` audio discriminator. Main installs that adapter without a Windows boolean special case.
- Added renderer-local session capture reconciliation. The first active snapshot in any renderer generation starts both microphone and system audio, repeated active snapshots remain idempotent, and inactive snapshots stop both. Overlay commands still bootstrap display capture synchronously inside the user gesture; rejection stops that bootstrap generation. Non-gesture permission/activation failures publish a bounded `gesture_required` source error that tells the user how to recover.
- Added opaque streaming callback epochs and guarded transcript, interim, error, and status callbacks at creation. Stop and replacement invalidate the epoch before disconnect callbacks run. Both WebSocket adapters now own their reconnect timeout, suppress retry after explicit disconnect, and clear retry/keep-alive state during shutdown.
- `SessionController` catches publisher and individual subscriber exceptions, reports structured observer context, and continues both the state transition and later listeners. Main records those failures through AppLink diagnostics. The tray commits its snapshot key only after native menu construction and installation succeed, so the same state can retry.
- Overlay persistence now atomically stores `preferredDisplayId` beside immutable `boundsByDisplay`. Restore selects that display first. If it is absent, restore deliberately ignores older bounds from another display and recenters on the current primary; legacy records without a preference retain their previous compatible selection behavior.
- The plan and design now distinguish a successful protection request from later capture-path verification, state that Electron 33.2.1 has no `isContentProtected()` getter, and retain honest macOS best-effort language.

## Verification

Impacted combined coverage:

```sh
node --test test/display-media.test.js test/renderer-capture-lifecycle.test.js test/stt-status-gate.test.js test/stt-streaming-lifecycle.test.js test/stt-accuracy.test.js test/stt-provider-selection.test.js test/session-controller.test.js test/session-state.test.js test/tray-menu.test.js test/window-state.test.js test/main-lifecycle-source.test.js test/lifecycle.test.js test/capture-protection.test.js
```

Result: **88 passed, 0 failed, 0 cancelled/skipped/todo**.

Required full-suite leak check:

```sh
npm test
npm test
```

Results:

- Run 1: **228 passed, 0 failed**, duration `143.649334 ms`.
- Run 2: **228 passed, 0 failed**, duration `143.976792 ms`.
- Both processes returned normally with no retained reconnect, keep-alive, or subprocess handles.

Static and historical checks:

```sh
for cue_file in main.js preload.js renderer/renderer.js renderer/capture-lifecycle.js src/display-media.js src/session-controller.js src/stt-status-gate.js src/stt-streaming.js src/tray-menu.js src/window-state.js test/display-media.test.js test/main-lifecycle-source.test.js test/renderer-capture-lifecycle.test.js test/session-controller.test.js test/stt-status-gate.test.js test/stt-streaming-lifecycle.test.js test/tray-menu.test.js test/window-state.test.js; do node --check "$cue_file" || exit 1; done
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --check main.js
git diff --check -- . ':(exclude)package-lock.json'
git diff --check 90aa366..HEAD
```

All commands exited 0 with no output. The exact historical whitespace command will be repeated after the final commit so `HEAD` includes these changes.

## Self-review and remaining concerns

The final mutation review covers the realistic regressions from the findings: replacing `'loopback'` with `true`, omitting either source on first active reconciliation, failing to stop a rejected bootstrap, allowing any old streaming callback or reconnect timeout, rethrowing observer failures, advancing a tray key before native success, selecting the first saved display, or consulting the nonexistent protection getter each makes a focused check fail.

Media and native menu tests use deterministic adapters rather than physical microphone/display permission prompts or an OS tray. Target-platform smoke testing remains appropriate for Windows loopback delivery, Electron gesture behavior, native tray installation, and multi-monitor hot-unplug timing. No known test or static-check concern remains in the Node foundation.
