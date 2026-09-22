# Cue Rebuild Design

**Date:** 2026-08-21
**Status:** Approved in chat
**Scope:** Session lifecycle, local speech-to-text, overlay usability, model selection, control center, packaging, and verification

## Product intent

Cue should behave like a dependable local copilot rather than a collection of hidden toggles. A user must be able to tell, at a glance, whether Cue is listening, which audio sources are healthy, what is being transcribed, which speech engine is active, which language model produced a response, and how to hide, stop, or quit the application.

The rebuild keeps Cue's Electron application and its tested capture, prompt, meeting, and LLM integrations. It replaces ambiguous renderer-owned state with an authoritative session model, adds Parakeet beside whisper.cpp, and rebuilds the user-facing surfaces around explicit operational state.

## Goals

1. Make local transcription work on this Mac without requiring the user to rediscover or redownload an already installed model.
2. Support both Parakeet and whisper.cpp as first-class local engines. `Auto` is the default local-engine choice and selects the fastest healthy engine on the current machine.
3. Make recording and transcription state unambiguous, including independent microphone and meeting-audio health.
4. Make provider and model selection explicit and show the actual model used for each answer.
5. Make the overlay readable, draggable, resizable, recoverable, and predictable.
6. Separate collapse, hide, pause, end-session, close-window, and quit semantics.
7. Preserve existing meeting, screen-context, LeetCode, resume, notes, and cloud-provider functionality unless this specification explicitly changes its presentation.
8. Add automated coverage for the state transitions and failure modes that currently rely on visual inspection.
9. Apply the strongest supported screen-capture exclusion to the working overlay, expose an honest protection self-test, and produce a runnable macOS `.app` plus distributable archive.

## Non-goals

- Rewriting the application in React, TypeScript, or Swift.
- Adding text-to-speech or voice synthesis. OpenWhispr is reused only for speech-to-text assets.
- Hiding Cue from Activity Monitor, operating-system privacy controls, endpoint security, or process inspection.
- Claiming universal capture invisibility. Electron documents that modern macOS applications using ScreenCaptureKit can capture a protected Electron window because macOS no longer honors `NSWindowSharingNone` for that path. Cue will describe protection by tested capture path and retain an honest application/process identity.
- Adding autonomous transcript-triggered LLM suggestions in this rebuild. Live transcript, manual Ask, Say, Assist, and existing actions remain the interaction model.
- Uploading local audio to a cloud provider after a local-engine failure. A local route stays local and reports the failure.

## Relevant product research

Current Cluely separates hiding the widget, pausing audio, and ending a session; it also keeps a visible elapsed-time session rail. Current Interview Coder separates its normal dashboard from a lightweight working overlay, exposes source-labelled transcript activity, provides explicit pause/resume state, and offers display and shortcut recovery. Cue will adopt those interaction principles without copying either product's visual identity.

The older Project Aura repository at `/Users/rutmehta/Developer/overlord` provides useful references for explicit overlay modes and a native broad drag surface. Its audio and LLM implementations are not production-ready and will not be ported.

OpenWhispr 1.8.1 is installed at `/Applications/OpenWhispr.app`. Its Parakeet weights are at `~/.cache/openwhispr/parakeet-models/parakeet-tdt-0.6b-v3`. Cue may reference those model files read-only. The Parakeet model is CC-BY-4.0, and sherpa-onnx is Apache-2.0; notices must be included when Cue distributes either asset.

## Architecture

### Authoritative session state

The Electron main process owns one serializable `SessionSnapshot`. Renderer code never infers operational state from CSS classes, API keys, or button text.

```js
{
  revision: 0,
  session: {
    phase: 'idle' | 'starting' | 'listening' | 'paused' | 'stopping' | 'error',
    startedAt: null,
    elapsedMs: 0,
    degradedReason: null
  },
  sources: {
    mic: { phase: 'off' | 'starting' | 'live' | 'recovering' | 'error' | 'unsupported', level: 0, error: null },
    system: { phase: 'off' | 'starting' | 'live' | 'recovering' | 'error' | 'unsupported', level: 0, error: null }
  },
  stt: {
    route: 'local' | 'cloud',
    requestedEngine: 'auto' | 'parakeet' | 'whisper',
    activeEngine: null,
    model: null,
    phase: 'off' | 'probing' | 'loading' | 'ready' | 'transcribing' | 'fallback' | 'error',
    detail: null
  },
  llm: {
    provider: 'openai',
    requestedModel: null,
    activeModel: null,
    phase: 'idle' | 'streaming' | 'error',
    error: null
  },
  transcript: {
    mic: { interim: '', final: '' },
    system: { interim: '', final: '' }
  },
  request: {
    id: null,
    phase: 'idle' | 'capturing-context' | 'streaming' | 'complete' | 'error',
    contextUsed: { screen: false, mic: false, system: false },
    error: null
  }
}
```

State changes occur through a small reducer/controller module with idempotent `start`, `pause`, `resume`, `stop`, and source-update operations. Every state change increments `revision` and is broadcast as `session:snapshot`. A newly opened or restored window requests the latest full snapshot rather than replaying events.

The renderer still captures Web Audio because Electron's media APIs live there, but it reports source lifecycle and level data to main through explicit IPC. Main coordinates STT, session timing, fallback, shutdown, and presentation state.

### Module boundaries

- `src/session-state.js`: pure snapshot creation and transition reducer.
- `src/session-controller.js`: coordinates capture requests, timers, STT lifecycle, and snapshot publication.
- `src/local-stt-engine.js`: common local-engine result/status contract and validation helpers.
- `src/local-stt-manager.js`: discovery, health checks, Auto selection, failover, and cached benchmark choice.
- `src/parakeet-runtime.js`: runtime/model discovery and read-only OpenWhispr compatibility paths.
- `src/parakeet-transcriber.js`: sherpa-onnx WebSocket process/protocol adapter.
- Existing whisper modules: retained behind the local-engine interface and repaired where required.
- `src/window-state.js`: display-aware bounds validation and persistence.
- `src/lifecycle.js`: pure decisions for hide, close, end, and quit.
- `renderer/session-view.js`: pure view-model derivation from `SessionSnapshot`.
- `renderer/audio-capture.js`: idempotent mic/system capture and AudioWorklet graph ownership.
- `renderer/renderer.js`: action wiring, transcript/response presentation, and IPC subscription.
- `settings.html`, `renderer/settings.js`, and `renderer/settings.css`: normal control-center window.

Large existing files may be reduced only where extraction supports these boundaries. Unrelated behavior will not be rewritten.

## Local speech-to-text

### Engine contract

Each local engine exposes:

```js
{
  id,
  async inspect(),
  async start(options),
  async transcribe({ channel, pcm16, sampleRate }),
  async stop(),
  onStatus(callback)
}
```

`inspect()` returns structured runtime, model, source, compatibility, and actionable-error details. `transcribe()` returns final text and timing metadata. Engines serialize inference per channel and reject new work after shutdown.

### Parakeet

Cue recognizes the four required Parakeet assets: `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, and `tokens.txt`. Runtime resolution order is:

1. `CUE_PARAKEET_RUNTIME`, for development and explicit overrides.
2. A Cue-bundled sherpa-onnx runtime.
3. A Cue-managed cached runtime installed by the runtime preparation command.
4. The compatible universal runtime inside the installed OpenWhispr application, marked in diagnostics as an external compatibility runtime.

Model resolution order is:

1. An explicit Cue setting.
2. Cue's managed model directory.
3. OpenWhispr's existing Parakeet cache, referenced read-only.

Cue does not modify or delete OpenWhispr assets. The control center identifies the source and offers a later explicit import only if the user wants Cue-owned files.

The adapter launches sherpa-onnx on loopback using an available port in 6006-6029, waits no more than 15 seconds for readiness, and always terminates the child process on stop or app quit. The offline request is one binary WebSocket message containing little-endian `int32 sampleRate`, little-endian `int32 audioByteLength`, and float32 PCM samples; after receiving a transcription result the client sends `Done`. Spawn errors, readiness timeouts, malformed results, protocol errors, and unexpected exits are distinct statuses.

### whisper.cpp

The existing whisper model catalog, download, import, VAD, segmenter, and server-session code remain. The rebuild adds a reliable prebuilt runtime preparation path, validates runtime and model together, and ensures release packaging fails when the configured local runtime artifact is absent. Development mode may start without a runtime but must show the exact remediation command.

Model status uses checksum verification, not file size alone. The utterance segmenter must close a segment after a short abandoned speech onset rather than collecting until the maximum duration.

### Auto selection

`localStt.engine` defaults to `auto`. If only one engine is healthy, Auto selects it. If both are healthy and no valid benchmark exists, Cue races the first non-silent utterance of at most 15 seconds through both local engines and publishes the first non-empty, non-hallucinated result. The losing benchmark may continue in the background for no more than 15 additional seconds so Cue can record both elapsed inference times; a timeout makes the completed engine the winner. Cue caches the faster healthy engine. The cache key includes operating-system architecture, engine runtime versions, and model file identities. Later sessions use the cached winner while health checks run.

An engine crash causes a visible local-to-local fallback. Cue retries the uncommitted segment once on the remaining healthy local engine and updates `activeEngine` plus `detail`. Cue never falls from a local route to a cloud route automatically.

### Capture correctness

- Mic and system starts are idempotent and guarded by one in-flight promise each.
- AudioWorklet graphs include a zero-gain destination sink so Chromium keeps them alive without audible playback.
- The actual input sample rate is measured. PCM is resampled to the engine's requested rate before being labelled or transmitted.
- Unsupported system capture always clears its starting guard and becomes `unsupported`.
- Device changes trigger a bounded source restart and `recovering` state.
- A session is `listening` when at least one requested source is live. If another source failed or is unsupported, `degradedReason` is non-null and the UI says which source is unavailable.
- Stopping capture prevents additional PCM from entering a failed or closed transcriber.

## Windows and lifecycle

### Working overlay

The overlay remains transparent, capture-protected where supported, always on top, and bounded rather than display-sized. `setContentProtection(true)` is applied before the overlay is first shown and reapplied after recreation. Electron 33.2.1 exposes no `BrowserWindow.isContentProtected()` getter, so Cue reports `Protection requested` without claiming verification until a supported capture-path probe runs. On Windows 10 version 2004 and later this requests `WDA_EXCLUDEFROMCAPTURE`; on macOS it requests `NSWindowSharingNone` as a best-effort request. Linux is reported as unsupported. Default content width is 720 px; it has a 420 px minimum width and persists size and position per display. Restore logic intersects saved bounds with current displays and recenters safely when a display disappears.

Diagnostics distinguishes `Protection requested`, `Legacy capture probe passed`, `Legacy capture probe failed`, and `Unsupported capture path`. The self-test uses Electron's available desktop/window capture enumeration and a screenshot probe where the platform permits it. It never converts a successful protection request into an absolute invisibility claim. Modern macOS ScreenCaptureKit remains an explicitly disclosed unsupported exclusion path because only the capturing application controls ScreenCaptureKit's window/application exclusion filter.

The overlay is interactive by default. A visible lock control enables click-through intentionally. Click-through never toggles from pointer hover. A global shortcut and tray/menu action always return the overlay to interactive mode, so it cannot become unreachable.

The complete top rail is draggable except for controls. Native resizing remains available while interactive. Keyboard move commands shift the overlay in 24 px increments, with Shift increasing the step to 96 px. A `Recenter overlay` command recovers from bad placement.

### Control center

Settings move to a normal opaque control-center `BrowserWindow`, approximately 900×720 with a 760×600 minimum. Opening it never ends a session. It contains Audio, AI Models, Shortcuts, Appearance, and Diagnostics sections. Changes use explicit Save and Cancel; Save validates and persists one settings patch atomically. Closing with unsaved changes asks whether to discard them.

### Operation semantics

- **Collapse:** reduce the overlay to the session rail; capture continues.
- **Hide:** hide the overlay window; capture continues and the tray/menu remains available.
- **Pause:** suspend audio ingestion without discarding the session transcript or timer context.
- **End session:** stop capture and transcription, finalize transcript state, keep the app running, and preserve response history until a new session or explicit clear.
- **Close overlay window:** same user-visible effect as Hide.
- **Quit:** stop capture, stop local runtimes, cancel downloads safely, unregister shortcuts, destroy windows/tray, and exit.

There is exactly one handler for `window-all-closed` and one handler for `will-quit`. Application shutdown is idempotent. On macOS, closing windows does not quit; an explicit Quit command does. On Windows and Linux, the tray keeps the app alive while enabled.

A tray/menu-bar menu exposes Show/Hide, Start/Pause/Resume, End Session, Unlock Interaction, Recenter Overlay, Settings, and Quit. The visible overlay Quit button is wired and labelled. Existing global shortcuts remain, become configurable, and expose registration conflicts in Diagnostics.

## Overlay visual and interaction design

The visual reference is a broadcast confidence monitor: stable, legible, and operational. It uses an approximately 94% opaque neutral graphite surface, off-white primary text, restrained muted text, and one cobalt operational accent. Green is reserved for a healthy live source, amber for recovery/degraded state, and red for errors. Decorative blur and glow are not used as structural styling.

Minimum interface text is 13 px. Transcript text is at least 15 px. Generated answers are 17-18 px with a line height of at least 1.5. Controls have visible keyboard focus, accessible names, and at least a 32 px target; primary session controls are at least 40 px high.

The rail contains:

1. A broad drag region and Cue identity.
2. A labelled state control: `Start listening`, `Listening 02:14`, `Paused 02:14`, or `Stopping`.
3. Mic and Meeting source chips with state, compact level meter, and an actionable error popover.
4. The active speech engine badge.
5. Collapse, interaction lock, hide, and overflow controls.

Expanded content contains an Answer/Transcript switch, response history, live partial transcript, and composer. Streaming answers appear immediately with a progress cursor. Errors remain attached to the failed response with Retry; they are not rendered as answer prose. Every completed answer header shows provider and exact model.

ARIA tabs, dialogs, live regions, field labels, focus trapping, Escape behavior, and reduced-motion preferences are implemented. No icon-only control lacks an accessible name or tooltip.

## Model selection

The control center represents each supported LLM provider with connection state, API/base URL fields, and two exact model choices: Quick and Deep. Where a provider exposes model listing through an already authenticated endpoint, Cue offers a searchable select; manual model IDs remain supported.

The working overlay's model control shows `Provider · exact-model-id`, not only `Fast` or `Smart`. Selecting Quick or Deep resolves to the configured exact model, and an advanced menu can choose either configured model directly for the next request. The request captures the resolved provider/model at start, so a later settings change cannot relabel an in-flight or historical answer.

Settings persistence is awaited and atomic from the renderer's perspective. A failed save leaves the control center open with an inline actionable error. Switching sections cannot alter the active runtime until Save succeeds.

## Error handling and diagnostics

Errors are owned by the module that can recover from them and include a stable code, human message, and action when applicable. Required distinctions include permission denied, no device, unsupported system capture, device removed, local runtime missing, local model missing/corrupt, runtime spawn failed, readiness timeout, protocol failure, engine exit, cloud authentication, network failure, rate limit, and LLM generation failure.

Persistent operational errors remain visible until resolved or dismissed. Toasts are reserved for transient confirmation. Diagnostics shows application/platform versions, selected and active engines/models, runtime/model paths and sources, source state, registered shortcuts, and recent structured errors. It never displays secret key values.

## Persistence and migration

Existing settings are migrated without discarding API keys, provider choices, model IDs, profiles, or window position. New defaults are:

```js
{
  localStt: {
    engine: 'auto',
    parakeetModelPath: '',
    parakeetRuntimePath: '',
    benchmark: null
  },
  overlay: {
    clickThrough: false,
    collapsed: false,
    opacity: 0.94
  }
}
```

If a healthy local model is detected and the user has not explicitly chosen an STT provider, local Auto becomes the route. Existing explicit cloud or local choices remain unchanged. Secret storage behavior is not broadened in this rebuild.

## Testing strategy

Development follows test-driven development. Each behavior starts with a failing Node test or, for renderer-only behavior, a deterministic DOM/view-model test before implementation.

Required automated coverage:

- All legal and illegal session-state transitions, revision increments, elapsed-time behavior, and degraded-source rules.
- Hide/close/end/quit decisions and idempotent shutdown.
- Display-bound restore, clamping, per-display persistence, and recentering.
- Parakeet runtime/model discovery precedence and missing/corrupt asset errors.
- Parakeet spawn, readiness, request framing, response parsing, timeout, exit, and shutdown using fake process/WebSocket dependencies.
- Local Auto selection with zero, one, and two engines; benchmark cache keys; first-valid-result racing; crash fallback; and no cloud fallback.
- Whisper checksum status, runtime remediation, and short false-start VAD behavior.
- Capture start idempotence, unsupported-source guard reset, sample-rate metadata, and source-state view models.
- Atomic settings save, provider/model resolution, in-flight model attribution, and save failure behavior.
- Accessible labels/state copy and rendering of listening, paused, degraded, streaming, and error states.
- Build configuration requiring local runtime artifacts for release packages.

The existing `npm test` suite must remain green. A deterministic Electron smoke test must verify preload API exposure, overlay/control-center creation, content-protection application, quit wiring, and tray command routing without requiring microphone hardware. Packaging verification checks both macOS architectures supported by the current build configuration; Windows/Linux behavior remains covered by pure lifecycle, path, and build tests where those artifacts cannot be executed locally.

## Delivery decomposition

Implementation is split into four plans. Each plan ends in independently runnable, reviewed software:

1. **Session and lifecycle foundation:** authoritative state, source snapshots, window placement, hide/end/quit semantics, tray recovery, and lifecycle tests.
2. **Local STT engines:** Parakeet adapter/discovery, whisper adapter repair, Auto benchmarking/fallback, capture correctness, and engine diagnostics.
3. **Overlay and control center:** accessible visual rebuild, live source/transcript state, model selection and attribution, explicit settings persistence, and keyboard interaction.
4. **Integration and release hardening:** runtime preparation/packaging, migrations, capture-protection self-test and disclosure, Electron smoke coverage, documentation, license notices, and final cross-feature verification.

No milestone may silently weaken a requirement from an earlier milestone. Temporary compatibility code must be removed or explicitly documented before the fourth milestone completes.

## Acceptance criteria

The rebuild is complete when all of the following are true:

1. On this Mac, Cue discovers the installed OpenWhispr Parakeet model, starts a compatible runtime, and transcribes a non-silent fixture or live sample locally.
2. Cue can run whisper.cpp after its documented one-command runtime preparation path, and corrupt/missing assets are distinguished.
3. Local `Auto` records and displays which healthy engine won; a failure visibly falls back only to another local engine.
4. The overlay always shows session phase, elapsed time, mic state, meeting-audio state, STT engine, live transcript activity, and the exact LLM provider/model.
5. Start, pause, resume, end, collapse, hide, unlock/recenter, and quit all have distinct tested effects.
6. The user can drag from the full rail, resize while interactive, intentionally lock click-through, and recover without the pointer.
7. The control center saves model/provider settings atomically, and a failed save cannot appear successful.
8. The visible Quit command exits after bounded cleanup, and the app has no duplicate lifecycle handlers.
9. Protection is applied before the overlay is shown, visible in Diagnostics, and verified against the capture paths the host platform permits Cue to probe; modern macOS ScreenCaptureKit limitations are stated without an absolute invisibility claim.
10. `npm test`, the deterministic Electron smoke test, runtime verification, and release packaging checks pass from a clean checkout with documented prerequisites.
11. `npm run pack:mac` produces a launchable arm64 `Cue.app`, and `npm run dist:mac` produces a distributable archive. The app contains its icon, honest bundle identity, microphone/system-audio usage descriptions, renderer assets, and configured local runtime artifacts. Unsigned local builds use ad-hoc signing where supported; notarization remains a release-credential step.
12. README behavior, platform support, privacy/capture-exclusion language, local runtime requirements, build commands, artifact locations, and shortcuts match the shipped implementation.
