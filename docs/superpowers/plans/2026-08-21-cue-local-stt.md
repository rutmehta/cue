# Cue Local Speech-to-Text Engines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Parakeet and whisper.cpp reliable first-class local transcription engines, default local selection to the fastest healthy engine, and repair Cue's two-source Web Audio pipeline.

**Architecture:** A local STT manager consumes engine adapters with the same inspection/start/transcribe/stop contract. Parakeet uses a managed sherpa-onnx WebSocket sidecar and can reference OpenWhispr's installed model/runtime read-only; whisper.cpp is wrapped behind the same interface. Renderer capture owns devices and sample-rate conversion, while main owns engine choice, segmentation, fallback, and authoritative session status.

**Tech Stack:** Electron 33.2.1, Node.js 22.12+, CommonJS, `ws` 8.18, child processes, Web Audio/AudioWorklet, `node:test`

**Spec:** `docs/superpowers/specs/2026-08-21-cue-rebuild-design.md`

## Global Constraints

- `localStt.engine` defaults to `auto`; explicit values are `parakeet` and `whisper`.
- A local route never falls back to cloud. An engine crash may retry the uncommitted segment once on the other healthy local engine and must display the fallback reason.
- Parakeet requires `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, and `tokens.txt`.
- Runtime precedence is explicit environment override, Cue bundle, Cue cache, then read-only OpenWhispr compatibility runtime. Model precedence is explicit setting, Cue model directory, then read-only OpenWhispr cache.
- The Parakeet server uses loopback ports 6006-6029, a 15-second readiness bound, and the offline binary framing defined in the spec.
- Mic and system capture have one in-flight start each, report independent health/level values, measure the actual sample rate, resample before labelling PCM as 16 kHz, and use a zero-gain destination sink.
- Preserve Plan 1's session/lifecycle IPC names and main-process ownership.
- Preserve the user-owned `package-lock.json` modification and keep the three competitor-audit extraction files unstaged.
- Start each behavior with a failing test and keep `npm test` green after every task.

---

### Task 1: Local-engine contract and Parakeet discovery

**Files:**
- Create: `src/local-stt-engine.js`
- Create: `src/parakeet-runtime.js`
- Test: `test/local-stt-engine.test.js`
- Test: `test/parakeet-runtime.test.js`

**Interfaces:**
- Consumes: platform, architecture, `resourcesPath`, `appPath`, `userDataPath`, environment, home directory, and injected filesystem operations.
- Produces: `LocalSttError`, `normalizeEngineInspection(value)`, `isHealthyInspection(value)`, `fingerprintFiles(paths, fs)`, `inspectParakeet(options)`, `PARAKEET_REQUIRED_FILES`, and `buildParakeetArgs(options)`.

- [ ] **Step 1: Write failing engine-contract tests**

```js
test('normalizes an inspection and rejects incomplete healthy claims', () => {
  assert.deepEqual(normalizeEngineInspection({ id: 'parakeet', runtime: { path: '/bin/p' }, model: { path: '/models/p' } }), {
    id: 'parakeet', healthy: true,
    runtime: { path: '/bin/p', source: 'unknown', version: null },
    model: { path: '/models/p', source: 'unknown', fingerprint: null },
    errors: []
  });
  assert.throws(() => normalizeEngineInspection({ id: 'parakeet', healthy: true }), /runtime and model/);
});

test('LocalSttError carries a stable code and action', () => {
  const error = new LocalSttError('runtime_missing', 'No Parakeet runtime found.', 'Prepare the runtime.');
  assert.deepEqual({ code: error.code, message: error.message, action: error.action }, {
    code: 'runtime_missing', message: 'No Parakeet runtime found.', action: 'Prepare the runtime.'
  });
});
```

- [ ] **Step 2: Write failing discovery-precedence tests**

```js
test('prefers explicit runtime/model then Cue assets then OpenWhispr assets', async () => {
  const fs = fakeFs([
    '/explicit/runtime',
    '/explicit/model/encoder.int8.onnx', '/explicit/model/decoder.int8.onnx',
    '/explicit/model/joiner.int8.onnx', '/explicit/model/tokens.txt',
    '/Applications/OpenWhispr.app/Contents/Resources/bin/sherpa-onnx-ws-darwin-x64'
  ]);
  const result = await inspectParakeet({
    platform: 'darwin', architecture: 'arm64', fs,
    environment: { CUE_PARAKEET_RUNTIME: '/explicit/runtime' },
    explicitModelPath: '/explicit/model', homeDirectory: '/Users/test',
    resourcesPath: '/Cue.app/Contents/Resources', appPath: '/repo', userDataPath: '/data'
  });
  assert.equal(result.runtime.path, '/explicit/runtime');
  assert.equal(result.runtime.source, 'environment');
  assert.equal(result.model.path, '/explicit/model');
  assert.equal(result.model.source, 'settings');
  assert.equal(result.healthy, true);
});

test('finds the universal OpenWhispr runtime and cached model on this path shape', async () => {
  const result = await inspectParakeet(macFixtureWithOnlyOpenWhispr());
  assert.equal(result.runtime.path, '/Applications/OpenWhispr.app/Contents/Resources/bin/sherpa-onnx-ws-darwin-x64');
  assert.equal(result.runtime.source, 'openwhispr');
  assert.equal(result.model.path, '/Users/test/.cache/openwhispr/parakeet-models/parakeet-tdt-0.6b-v3');
  assert.equal(result.model.source, 'openwhispr');
});
```

- [ ] **Step 3: Implement the contract and discovery**

`PARAKEET_REQUIRED_FILES` is exactly:

```js
Object.freeze(['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'])
```

Inspection returns structured `runtime_missing`, `model_missing`, `model_incomplete`, and `runtime_not_executable` errors without throwing. Hash the required model files' path, byte size, and modification time into a SHA-256 fingerprint; do not hash 640 MB of contents during every settings render.

`buildParakeetArgs({ modelPath, port, threads })` returns:

```js
[
  `--tokens=${path.join(modelPath, 'tokens.txt')}`,
  `--encoder=${path.join(modelPath, 'encoder.int8.onnx')}`,
  `--decoder=${path.join(modelPath, 'decoder.int8.onnx')}`,
  `--joiner=${path.join(modelPath, 'joiner.int8.onnx')}`,
  `--port=${port}`,
  `--num-threads=${threads}`
]
```

On Darwin, accept OpenWhispr's `sherpa-onnx-ws-darwin-x64` only after its executable check succeeds; it is a universal arm64/x86_64 binary despite the suffix. Never write into OpenWhispr paths.

- [ ] **Step 4: Run focused and complete tests**

Run: `node --test test/local-stt-engine.test.js test/parakeet-runtime.test.js`  
Expected: PASS.

Run: `npm test`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/local-stt-engine.js src/parakeet-runtime.js test/local-stt-engine.test.js test/parakeet-runtime.test.js
git commit -m "feat: discover installed parakeet assets"
```

### Task 2: Parakeet sidecar and WebSocket protocol

**Files:**
- Create: `src/parakeet-transcriber.js`
- Test: `test/parakeet-transcriber.test.js`

**Interfaces:**
- Consumes: a healthy Task 1 inspection, injected `spawn`, `WebSocket`, port finder, clock/timers, and process stopper.
- Produces: `ParakeetTranscriber` with `inspect()`, `start(options)`, `transcribe({ channel, pcm16, sampleRate })`, `stop()`, `onStatus(callback)`, and exported `pcm16ToFloat32Buffer`/`buildOfflineMessage` helpers.

- [ ] **Step 1: Write failing framing and conversion tests**

```js
test('builds sherpa offline frame with little-endian header and float32 audio', () => {
  const pcm16 = Buffer.alloc(4);
  pcm16.writeInt16LE(-32768, 0);
  pcm16.writeInt16LE(16384, 2);
  const float32 = pcm16ToFloat32Buffer(pcm16);
  const frame = buildOfflineMessage(float32, 16000);
  assert.equal(frame.readInt32LE(0), 16000);
  assert.equal(frame.readInt32LE(4), 8);
  assert.equal(frame.readFloatLE(8), -1);
  assert.ok(Math.abs(frame.readFloatLE(12) - 0.5) < 0.0001);
});

test('rejects odd-length PCM and unsupported sample metadata', () => {
  assert.throws(() => pcm16ToFloat32Buffer(Buffer.alloc(3)), /complete 16-bit samples/);
  assert.throws(() => buildOfflineMessage(Buffer.alloc(8), 0), /sample rate/);
});
```

- [ ] **Step 2: Write fake-process/WebSocket lifecycle tests**

```js
test('starts once, waits for Listening on, sends Done, and stops once', async () => {
  const harness = createParakeetHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  const starts = Promise.all([engine.start(harness.inspection), engine.start(harness.inspection)]);
  harness.child.stderr.emit('data', Buffer.from('Listening on: 127.0.0.1:6006\n'));
  await starts;
  const request = engine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(3200), sampleRate: 16000 });
  harness.socket.emit('open');
  assert.equal(harness.socket.sent[0].readInt32LE(0), 16000);
  harness.socket.emit('message', Buffer.from('{"text":"hello world"}'));
  assert.equal(harness.socket.sent[1], 'Done');
  harness.socket.emit('close', 1000);
  assert.equal((await request).text, 'hello world');
  await Promise.all([engine.stop(), engine.stop()]);
  assert.equal(harness.spawnCalls.length, 1);
  assert.equal(harness.stopCalls.length, 1);
});
```

Add separate tests for spawn `error`, exit before readiness, a readiness timeout at 15,000 ms, malformed JSON falling back to trimmed text, close before any result, WebSocket error, transcription timeout, and child exit after readiness updating status to `error`.

- [ ] **Step 3: Implement the transcriber**

Find the first available port in 6006-6029. Spawn with `stdio: ['ignore', 'pipe', 'pipe']`, `windowsHide: true`, a safe temporary-directory `cwd`, and `detached: process.platform !== 'win32'`. Compute threads as `max(1, min(4, floor(cpuCount * 0.75)))`.

Treat stderr containing `Listening on:` as ready. The readiness timer is 15,000 ms and is cleared on every terminal path. Serialize transcription per channel. Each request opens `ws://127.0.0.1:<port>`, sends one binary frame on open, appends message data, sends the string `Done` after the result, and resolves only on close. Parse JSON `{ text }` when possible. Bound inference to `max(10_000, audioDurationMs * 4)`.

`stop()` rejects queued requests with `LocalSttError('engine_stopped', ...)`, closes sockets, sends SIGTERM to the child or process group, waits 2 seconds, then uses SIGKILL if still alive. It is idempotent and clears all timers/listeners.

- [ ] **Step 4: Run focused and complete tests**

Run: `node --test test/parakeet-transcriber.test.js`  
Expected: PASS with the process exiting naturally.

Run: `npm test`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parakeet-transcriber.js test/parakeet-transcriber.test.js
git commit -m "feat: transcribe with local parakeet"
```

### Task 3: Auto selection, benchmark cache, and whisper adapter

**Files:**
- Create: `src/local-stt-manager.js`
- Create: `src/whisper-engine.js`
- Modify: `src/local-whisper-transcriber.js`
- Test: `test/local-stt-manager.test.js`
- Test: `test/whisper-engine.test.js`

**Interfaces:**
- Consumes: `SessionController.dispatch`, Parakeet engine, existing `LocalWhisperTranscriber`, model manager/runtime locator, settings benchmark, and an injected `isValidTranscript(text)`.
- Produces: `LocalSttManager` with `inspect()`, `start(settings)`, `transcribe(segment)`, `stop()`, `getStatus()`, and `WhisperEngine` implementing the common contract.

- [ ] **Step 1: Write failing Auto-selection tests**

```js
test('selects the only healthy engine and never touches cloud', async () => {
  const parakeet = fakeEngine('parakeet', { healthy: true, text: 'local result', elapsedMs: 80 });
  const whisper = fakeEngine('whisper', { healthy: false, error: 'runtime_missing' });
  const manager = new LocalSttManager({ engines: [parakeet, whisper], loadBenchmark: () => null, saveBenchmark: async () => { throw new Error('not expected'); } });
  await manager.start({ requestedEngine: 'auto' });
  assert.equal(manager.getStatus().activeEngine, 'parakeet');
  assert.equal((await manager.transcribe(segment())).text, 'local result');
});

test('races the first valid utterance, publishes the winner, and caches timings', async () => {
  const saved = [];
  const parakeet = deferredEngine('parakeet');
  const whisper = deferredEngine('whisper');
  const manager = new LocalSttManager({ engines: [parakeet, whisper], loadBenchmark: () => null, saveBenchmark: async (value) => saved.push(value) });
  await manager.start({ requestedEngine: 'auto' });
  const pending = manager.transcribe(segment());
  parakeet.resolve({ text: 'hello', elapsedMs: 70 });
  assert.equal((await pending).engine, 'parakeet');
  whisper.resolve({ text: 'hello', elapsedMs: 240 });
  await manager.whenBenchmarkSettled();
  assert.equal(saved[0].winner, 'parakeet');
  assert.deepEqual(saved[0].elapsedMs, { parakeet: 70, whisper: 240 });
});

test('retries an uncommitted segment once on the other local engine', async () => {
  const first = failingEngine('parakeet', 'engine_exit');
  const second = fakeEngine('whisper', { healthy: true, text: 'recovered', elapsedMs: 300 });
  const manager = new LocalSttManager({ engines: [first, second], loadBenchmark: () => ({ winner: 'parakeet', cacheKey: combinedKey(first, second) }) });
  await manager.start({ requestedEngine: 'auto' });
  const result = await manager.transcribe(segment());
  assert.equal(result.text, 'recovered');
  assert.equal(result.engine, 'whisper');
  assert.match(manager.getStatus().detail, /Parakeet failed.*Whisper/i);
  assert.equal(first.calls.transcribe, 1);
  assert.equal(second.calls.transcribe, 1);
});
```

- [ ] **Step 2: Write failing whisper-adapter tests**

Assert that `inspect()` combines runtime and checksum-verified model state; `start()` creates one existing transcriber; `transcribe()` resolves the segment-specific final result; `stop()` prevents future pushes; and a local error is surfaced to the manager instead of setting a global cloud-fallback flag.

```js
test('whisper inspection reports a corrupt same-size model as unhealthy', async () => {
  const engine = new WhisperEngine(whisperHarness({ verifyError: Object.assign(new Error('checksum mismatch'), { code: 'MODEL_CHECKSUM_MISMATCH' }) }));
  const inspection = await engine.inspect();
  assert.equal(inspection.healthy, false);
  assert.equal(inspection.errors[0].code, 'model_corrupt');
});
```

- [ ] **Step 3: Implement manager and adapter**

The manager calls `inspect()` on all engines, starts only requested/healthy engines, and emits statuses `probing`, `loading`, `ready`, `transcribing`, `fallback`, and `error`. Explicit engines never race. Auto uses a valid cache only when its key matches `platform + arch + runtime versions + model fingerprints`.

For an uncached race, cap input at 15 seconds, resolve the user request on the first valid result, let the loser continue for no more than 15 additional seconds, then save `{ cacheKey, winner, elapsedMs, recordedAt }`. A valid transcript is non-empty and passes the existing `looksLikeHallucination` filter. Ignore a late loser after stop.

The whisper adapter uses per-request IDs to pair `onTranscript` callbacks with promises and keeps inference serialized per channel. It never calls cloud STT or mutates `sttDisabled`.

- [ ] **Step 4: Run focused and complete tests**

Run: `node --test test/local-stt-manager.test.js test/whisper-engine.test.js test/local-whisper-transcriber.test.js`  
Expected: PASS.

Run: `npm test`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/local-stt-manager.js src/whisper-engine.js src/local-whisper-transcriber.js test/local-stt-manager.test.js test/whisper-engine.test.js
git commit -m "feat: select the fastest healthy local stt"
```

### Task 4: VAD and model integrity repairs

**Files:**
- Modify: `src/vad.js`
- Modify: `src/utterance-segmenter.js`
- Modify: `src/whisper-model-manager.js`
- Test: `test/utterance-segmenter.test.js`
- Test: `test/whisper-model-manager.test.js`

**Interfaces:**
- Consumes: existing adaptive VAD, segmenter, catalog SHA-256 values, and model paths.
- Produces: false-start closure, an `onSpeechAbort` path, and model status that cannot call a corrupt file installed.

- [ ] **Step 1: Add the failing one-frame false-start regression**

```js
test('abandons a one-frame onset after trailing silence without collecting until stop', () => {
  const utterances = [];
  const states = [];
  const segmenter = new UtteranceSegmenter({
    channel: 'mic',
    vadOptions: { minSpeechFrames: 4, silenceFrames: 4 },
    onSpeechState: (_channel, speaking) => states.push(speaking),
    onUtterance: (_channel, pcm) => utterances.push(pcm)
  });
  pushFrames(segmenter, 1200, 1);
  pushFrames(segmenter, 0, 5);
  assert.equal(segmenter.collecting, false);
  assert.equal(utterances.length, 0);
  assert.deepEqual(states, [true, false]);
});
```

- [ ] **Step 2: Add failing model-integrity status tests**

Mock a same-byte-size file whose SHA differs, call `verifyInstalledModel`, and assert `MODEL_CHECKSUM_MISMATCH`. Then call `listModels({ verify: true })` and assert `{ installed: false, status: 'corrupt' }`. A verified model returns `{ installed: true, status: 'ready' }`. Cache successful verification by path/size/mtime for the process lifetime and invalidate it after file metadata changes.

- [ ] **Step 3: Implement the repairs**

Add `onSpeechAbort` to `AdaptiveVAD`. When trailing silence reaches `silenceFrames`, call `onSpeechEnd` for confirmed speech and `onSpeechAbort` otherwise; both return VAD to silence. In `UtteranceSegmenter`, abort clears collection/pre-roll and reports `speaking: false` without emitting PCM.

Make `WhisperModelManager.listModels({ verify = false } = {})` retain its cheap default for frequent rendering but support verified status for diagnostics/startup. `verifyInstalledModel` remains the mandatory start gate.

- [ ] **Step 4: Run focused and complete tests**

Run: `node --test test/utterance-segmenter.test.js test/whisper-model-manager.test.js`  
Expected: PASS.

Run: `npm test`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vad.js src/utterance-segmenter.js src/whisper-model-manager.js test/utterance-segmenter.test.js test/whisper-model-manager.test.js
git commit -m "fix: close false speech and reject corrupt models"
```

### Task 5: Idempotent renderer capture and main integration

**Files:**
- Create: `renderer/audio-utils.js`
- Create: `renderer/audio-capture.js`
- Modify: `renderer/audio-worklet-processor.js`
- Modify: `renderer/index.html`
- Modify: `renderer/renderer.js`
- Modify: `main.js`
- Modify: `preload.js`
- Test: `test/audio-utils.test.js`
- Test: `test/audio-capture.test.js`
- Test: `test/local-stt-integration.test.js`

**Interfaces:**
- Consumes: Plan 1 session controller/IPC, Task 3 local manager, `navigator.mediaDevices`, `AudioContext`, `MediaStream`, and renderer callbacks.
- Produces: `createAudioCapture(dependencies)` with `startMic()`, `startSystem()`, `pause()`, `resume()`, `stop()`, `getState()`, plus preload methods `sourceUpdate(source, patch)` and `sourcePcm(source, payload)`.

- [ ] **Step 1: Write failing resampling tests**

```js
test('resamples measured 48 kHz float audio to 16 kHz PCM with metadata', () => {
  const input = Float32Array.from({ length: 480 }, (_, index) => Math.sin(index / 12));
  const result = convertAudioBlock(input, 48000, 16000);
  assert.equal(result.sampleRate, 16000);
  assert.equal(result.pcm16.byteLength, 160 * 2);
  assert.ok(result.level > 0);
});
```

Use a stateful linear resampler so block boundaries do not duplicate/drop fractional samples. `renderer/audio-utils.js` exports through `module.exports` in Node tests and `window.CueAudioUtils` in the renderer.

- [ ] **Step 2: Write failing capture-controller tests**

```js
test('joins duplicate starts, wires a zero-gain sink, and reports actual rate', async () => {
  const harness = audioHarness({ sampleRate: 48000 });
  const capture = createAudioCapture(harness.dependencies);
  await Promise.all([capture.startMic(), capture.startMic()]);
  assert.equal(harness.mediaDevices.getUserMediaCalls, 1);
  assert.equal(harness.gain.gain.value, 0);
  assert.equal(harness.gain.connectedTo, harness.audioContext.destination);
  assert.deepEqual(harness.sourceUpdates.slice(0, 2).map((event) => event.patch.phase), ['starting', 'live']);
});

test('clears the system starting guard on unsupported mediaDevices', async () => {
  const capture = createAudioCapture(audioHarness({ noDisplayMedia: true }).dependencies);
  await capture.startSystem();
  await capture.startSystem();
  assert.equal(capture.getState().system.phase, 'unsupported');
  assert.equal(capture.getState().system.starting, false);
});
```

Add tests for no track, permission denied, device removed/recovery, one device-change restart, pause dropping PCM, stop preventing late worklet messages, and cleanup of stream/context/nodes.

- [ ] **Step 3: Implement renderer capture and worklet messages**

The worklet posts `{ samples, sampleRate, level }`, transferring `samples.buffer`. The capture module resamples to 16 kHz, converts to PCM16, and calls `sourcePcm(source, { pcm, sampleRate: 16000, sourceSampleRate, level })`. Both worklet and ScriptProcessor paths connect through a zero-gain sink to `AudioContext.destination`.

Track `micStartPromise` and `systemStartPromise`; clear each in `finally`. Map DOMException names to stable source error codes. Register one `devicechange` listener only while capture is active and debounce recovery by 500 ms.

Delete the duplicate embedded `startMic`/`startSystemAudio` code from `renderer.js`; instantiate the module once. Include `audio-utils.js` and `audio-capture.js` before `renderer.js` in `index.html`.

- [ ] **Step 4: Route local audio through the manager in main**

Replace direct `startLocalWhisper`/`localWhisperTranscriber` routing with one `LocalSttManager`. Main creates Parakeet and Whisper adapters, starts the requested local engine through session commands, and routes `{ pcm, sampleRate, sourceSampleRate, level }` only while the snapshot is listening. Segment PCM per source, send interim/final/status events through `SessionController.dispatch`, and publish the active engine/model/fallback detail.

Keep existing cloud streaming/batch paths for explicit cloud providers. If local start fails, set local STT/session error and send no audio to `createSTT` or `createStreamingSTT`. Stop/dispose prevents queued audio from entering an engine.

- [ ] **Step 5: Run verification and commit**

Run: `node --test test/audio-utils.test.js test/audio-capture.test.js test/local-stt-integration.test.js`  
Expected: PASS.

Run: `npm test && node --check main.js && node --check renderer/renderer.js`  
Expected: PASS.

```bash
git add renderer/audio-utils.js renderer/audio-capture.js renderer/audio-worklet-processor.js renderer/index.html renderer/renderer.js main.js preload.js test/audio-utils.test.js test/audio-capture.test.js test/local-stt-integration.test.js
git commit -m "feat: make two-source local transcription reliable"
```

### Task 6: Local STT verification on the installed machine

**Files:**
- Modify only if verification exposes a defect: files owned by Tasks 1-5
- Test: all local STT and existing tests

**Interfaces:**
- Consumes: the finished local engine/capture milestone and installed OpenWhispr assets.
- Produces: proof that discovery and sidecar startup work on this arm64 Mac without modifying OpenWhispr.

- [ ] **Step 1: Run the complete automated suite twice**

Run: `npm test && npm test`  
Expected: both runs pass and no child process remains.

- [ ] **Step 2: Run the Parakeet inspection command**

Run:

```bash
node - <<'NODE'
const { inspectParakeet } = require('./src/parakeet-runtime');
inspectParakeet().then((result) => {
  console.log(JSON.stringify(result, null, 2));
  if (!result.healthy) process.exitCode = 1;
});
NODE
```

Expected: healthy `true`, runtime source `openwhispr`, model source `openwhispr`, and no asset copied into Cue directories.

- [ ] **Step 3: Run a bounded sidecar smoke test**

Use the model's bundled `test_wavs` first WAV if present. Start `ParakeetTranscriber`, convert the fixture to the expected mono 16 kHz PCM only if its WAV header says another format, require a non-empty transcript, then call `stop()` in `finally`. The command must exit within 30 seconds after transcription.

- [ ] **Step 4: Verify no leaked sidecar**

Run: `pgrep -fl 'sherpa-onnx-(online-)?ws' || true`  
Expected: no Cue-started sidecar remains. An independently running OpenWhispr process must be identified by parent PID rather than killed.

- [ ] **Step 5: Commit verification fixes only when required**

```bash
git add src renderer main.js preload.js test
git commit -m "fix: close local stt verification gaps"
```

If no file changed, record the commands, transcript result, elapsed time, and cleanup result in the implementation report without creating an empty commit.
