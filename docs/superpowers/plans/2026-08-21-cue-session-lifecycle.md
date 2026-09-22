# Cue Session and Lifecycle Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Cue's inferred capture/window state and duplicated shutdown handlers with one revisioned session controller, display-safe overlay placement, tested content-protection policy, and recoverable tray lifecycle.

**Architecture:** Pure CommonJS modules own state transitions, placement, capture-protection policy, and lifecycle decisions. `main.js` adapts Electron APIs to those modules and broadcasts complete `SessionSnapshot` values; preload and the legacy renderer consume a stable IPC contract that later plans can extend without reshaping main-process ownership.

**Tech Stack:** Electron 33.2.1, Node.js 22.12+, CommonJS, `node:test`, plain HTML/CSS/JavaScript

**Spec:** `docs/superpowers/specs/2026-08-21-cue-rebuild-design.md`

## Global Constraints

- The Electron main process owns one serializable `SessionSnapshot`; renderer code does not infer operational state from CSS classes, API keys, or button text.
- Collapse, Hide, Pause, End Session, Close Window, and Quit retain the distinct semantics specified in the design.
- Capture protection is supported only on macOS and Windows. Old Windows still calls Electron's API to receive its documented black-frame fallback; modern macOS is labelled best effort.
- Cue remains visible in Activity Monitor, privacy controls, and process inspection and uses the honest `cue`/`Cue` application identity.
- Existing settings, API keys, meeting context, transcript history, and LLM actions remain available.
- Preserve the pre-existing user-owned `package-lock.json` modification and do not stage the competitor-audit files `index.cjs`, `index.js`, or `main-CLCIkAdW.js`.
- Start each behavior with a failing test and keep `npm test` green after every task.

---

### Task 1: Revisioned session state and controller

**Files:**
- Create: `src/session-state.js`
- Create: `src/session-controller.js`
- Test: `test/session-state.test.js`
- Test: `test/session-controller.test.js`

**Interfaces:**
- Consumes: settings values `provider`, `models`, `smart`, `sttProvider`, and `localStt.engine`.
- Produces: `createInitialSnapshot(options)`, `reduceSession(snapshot, event)`, `deriveSessionPhase(snapshot)`, and `SessionController` with `getSnapshot()`, `subscribe(listener)`, `dispatch(event)`, `start()`, `pause()`, `resume()`, `stop()`, and `dispose()`.

- [ ] **Step 1: Write failing reducer tests**

```js
test('moves through start, degraded listening, pause, resume, and stop with revisions', () => {
  let state = createInitialSnapshot({ now: 1_000, settings: { sttProvider: 'local', localStt: { engine: 'auto' } } });
  state = reduceSession(state, { type: 'SESSION_START_REQUESTED', now: 2_000 });
  state = reduceSession(state, { type: 'SOURCE_UPDATED', source: 'mic', patch: { phase: 'live', level: 0.4 } });
  state = reduceSession(state, { type: 'SOURCE_UPDATED', source: 'system', patch: { phase: 'error', error: { code: 'permission_denied', message: 'Meeting audio permission denied' } } });
  assert.equal(state.session.phase, 'listening');
  assert.equal(state.session.degradedReason, 'Meeting audio permission denied');
  state = reduceSession(state, { type: 'SESSION_PAUSED', now: 5_000 });
  state = reduceSession(state, { type: 'SESSION_RESUMED', now: 8_000 });
  state = reduceSession(state, { type: 'SESSION_STOP_REQUESTED', now: 9_000 });
  state = reduceSession(state, { type: 'SESSION_STOPPED', now: 9_100 });
  assert.equal(state.session.phase, 'idle');
  assert.equal(state.session.elapsedMs, 4_000);
  assert.equal(state.revision, 7);
});

test('records interim/final source text and exact request model attribution', () => {
  let state = createInitialSnapshot({ now: 0, settings: {} });
  state = reduceSession(state, { type: 'TRANSCRIPT_INTERIM', source: 'mic', text: 'hel' });
  state = reduceSession(state, { type: 'TRANSCRIPT_FINAL', source: 'mic', text: 'hello' });
  state = reduceSession(state, { type: 'LLM_REQUEST_STARTED', id: 'r1', provider: 'openai', model: 'gpt-4o-mini', contextUsed: { screen: true, mic: true, system: false } });
  assert.equal(state.transcript.mic.interim, '');
  assert.equal(state.transcript.mic.final, 'hello');
  assert.equal(state.llm.activeModel, 'gpt-4o-mini');
  assert.deepEqual(state.request.contextUsed, { screen: true, mic: true, system: false });
});
```

- [ ] **Step 2: Run the reducer tests and verify the missing-module failure**

Run: `node --test test/session-state.test.js`
Expected: FAIL with `Cannot find module '../src/session-state'`.

- [ ] **Step 3: Implement the pure snapshot and transitions**

```js
const SOURCE_PHASES = new Set(['off', 'starting', 'live', 'recovering', 'error', 'unsupported']);
const SESSION_PHASES = new Set(['idle', 'starting', 'listening', 'paused', 'stopping', 'error']);

function createInitialSnapshot({ now = Date.now(), settings = {} } = {}) {
  const provider = settings.provider || 'openai';
  const tier = settings.smart ? 'smart' : 'fast';
  return {
    revision: 0,
    session: { phase: 'idle', startedAt: null, elapsedMs: 0, resumedAt: null, degradedReason: null },
    sources: {
      mic: { phase: 'off', level: 0, error: null },
      system: { phase: 'off', level: 0, error: null }
    },
    stt: { route: settings.sttProvider === 'local' ? 'local' : 'cloud', requestedEngine: settings.localStt?.engine || 'auto', activeEngine: null, model: null, phase: 'off', detail: null },
    llm: { provider, requestedModel: settings.models?.[provider]?.[tier] || null, activeModel: null, phase: 'idle', error: null },
    transcript: { mic: { interim: '', final: '' }, system: { interim: '', final: '' } },
    request: { id: null, phase: 'idle', contextUsed: { screen: false, mic: false, system: false }, error: null },
    createdAt: now
  };
}
```

Implement every event used in the two tests plus `STT_UPDATED`, `LLM_TOKEN_STARTED`, `LLM_REQUEST_FINISHED`, and `LLM_REQUEST_FAILED`. Reject an unknown source or invalid phase with a descriptive `TypeError`. Clone only changed branches, increment `revision` exactly once per accepted event, and derive `listening` when at least one source is `live`; derive `error` only when neither requested source can run.

- [ ] **Step 4: Write and pass deterministic controller tests**

```js
test('serializes commands and publishes full snapshots', async () => {
  const published = [];
  const calls = [];
  const controller = new SessionController({
    now: (() => { let value = 1_000; return () => value += 100; })(),
    startCapture: async () => calls.push('start'),
    stopCapture: async () => calls.push('stop'),
    publish: (snapshot) => published.push(snapshot)
  });
  await Promise.all([controller.start(), controller.start()]);
  await controller.pause();
  await controller.resume();
  await Promise.all([controller.stop(), controller.stop()]);
  assert.deepEqual(calls, ['start', 'stop', 'start', 'stop']);
  assert.ok(published.every((snapshot, index) => index === 0 || snapshot.revision >= published[index - 1].revision));
  assert.equal(controller.getSnapshot().session.phase, 'idle');
});
```

Run: `node --test test/session-state.test.js test/session-controller.test.js`
Expected: PASS. The controller must use one internal transition promise so duplicate/concurrent commands join the in-flight operation instead of spawning capture twice.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: all existing and new tests pass.

```bash
git add src/session-state.js src/session-controller.js test/session-state.test.js test/session-controller.test.js
git commit -m "feat: add authoritative session state"
```

### Task 2: Display-safe bounds and capture protection

**Files:**
- Create: `src/window-state.js`
- Create: `src/capture-protection.js`
- Test: `test/window-state.test.js`
- Test: `test/capture-protection.test.js`

**Interfaces:**
- Consumes: Electron `Display`-shaped values `{ id, workArea }`, saved per-display bounds, a BrowserWindow-like object, platform, Windows build, and `CUE_NO_PROTECT`.
- Produces: `resolveOverlayBounds(input)`, `storeBoundsForDisplay(saved, displayId, bounds)`, `applyContentProtection(win, options)`, and a structured protection result.

- [ ] **Step 1: Write failing window-state tests**

```js
test('restores the matching display and recenters when that display disappeared', () => {
  const displays = [
    { id: 10, workArea: { x: 0, y: 0, width: 1440, height: 900 } },
    { id: 20, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } }
  ];
  assert.deepEqual(resolveOverlayBounds({ displays, primaryDisplayId: 10, savedByDisplay: { 20: { x: 1600, y: 40, width: 800, height: 500 } } }), { x: 1600, y: 40, width: 800, height: 500, displayId: 20 });
  assert.deepEqual(resolveOverlayBounds({ displays: [displays[0]], primaryDisplayId: 10, savedByDisplay: { 20: { x: 1600, y: 40, width: 800, height: 500 } } }), { x: 360, y: 6, width: 720, height: 600, displayId: 10 });
});

test('keeps at least 96 pixels of the rail reachable and enforces 420 pixel minimum width', () => {
  const result = resolveOverlayBounds({ displays: [{ id: 1, workArea: { x: 0, y: 0, width: 1200, height: 800 } }], primaryDisplayId: 1, savedByDisplay: { 1: { x: 5000, y: -400, width: 200, height: 1200 } } });
  assert.deepEqual(result, { x: 1104, y: 0, width: 420, height: 800, displayId: 1 });
});
```

- [ ] **Step 2: Write failing platform-policy tests**

```js
for (const [platform, build, mode] of [
  ['darwin', 0, 'macos-best-effort'],
  ['win32', 22631, 'windows-excluded'],
  ['win32', 18363, 'windows-black-fallback']
]) {
  test(`applies protection on ${platform} ${build}`, () => {
    const calls = [];
    const result = applyContentProtection({ setContentProtection: (value) => calls.push(value) }, { platform, windowsBuild: build });
    assert.deepEqual(calls, [true]);
    assert.equal(result.mode, mode);
    assert.equal(result.configured, true);
  });
}

test('reports unsupported Linux without calling Electron', () => {
  let called = false;
  const result = applyContentProtection({ setContentProtection: () => { called = true; } }, { platform: 'linux' });
  assert.equal(called, false);
  assert.deepEqual(result, { configured: false, mode: 'unsupported', reason: 'Content protection is unavailable on Linux.' });
});
```

- [ ] **Step 3: Implement both pure helpers**

Use these exact protection modes: `macos-best-effort`, `windows-excluded`, `windows-black-fallback`, `unsupported`, `disabled`, and `error`. `CUE_NO_PROTECT` produces `disabled`. A throw from `setContentProtection(true)` produces `error`; a successful call reports that protection was requested but remains unverified until a later capture-path probe. Electron 33.2.1 has no `BrowserWindow.isContentProtected()` getter, so do not invent getter-based verification. On every supported Windows build call `setContentProtection(true)`; do not skip pre-19041 builds. macOS remains explicitly best effort.

Bounds defaults are `{ width: 720, height: 600 }`; minimums are `{ width: 420, height: 80 }`. Clamp height to the selected work area and keep at least 96 px horizontally plus the 40 px rail vertically reachable. `storeBoundsForDisplay` returns a new object and never mutates caller data.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/window-state.test.js test/capture-protection.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/window-state.js src/capture-protection.js test/window-state.test.js test/capture-protection.test.js
git commit -m "feat: make overlay placement and protection explicit"
```

### Task 3: Lifecycle decisions and tray recovery

**Files:**
- Create: `src/lifecycle.js`
- Create: `src/tray-menu.js`
- Test: `test/lifecycle.test.js`
- Test: `test/tray-menu.test.js`

**Interfaces:**
- Consumes: `SessionController`, Electron app/window/tray adapters, and a current `SessionSnapshot`.
- Produces: `createLifecycleCoordinator(dependencies)`, `buildTrayTemplate(snapshot, actions)`, and `createTrayController(dependencies)`.

- [ ] **Step 1: Write failing lifecycle tests**

```js
test('hide keeps capture running, end stops it, and quit cleans up once', async () => {
  const calls = [];
  const lifecycle = createLifecycleCoordinator({
    platform: 'darwin',
    hideOverlay: () => calls.push('hide'),
    stopSession: async () => calls.push('stop-session'),
    stopLocalEngines: async () => calls.push('stop-engines'),
    cancelDownloads: () => calls.push('cancel-downloads'),
    unregisterShortcuts: () => calls.push('unregister'),
    destroyWindowsAndTray: () => calls.push('destroy'),
    exit: () => calls.push('exit')
  });
  await lifecycle.command('hide');
  await lifecycle.command('end-session');
  await Promise.all([lifecycle.command('quit'), lifecycle.command('quit')]);
  assert.deepEqual(calls, ['hide', 'stop-session', 'stop-session', 'stop-engines', 'cancel-downloads', 'unregister', 'destroy', 'exit']);
});

test('window close maps to hide on every tray-backed platform', () => {
  const lifecycle = createLifecycleCoordinator({ platform: 'win32', trayEnabled: true });
  assert.equal(lifecycle.closeDecision(), 'hide');
});
```

- [ ] **Step 2: Write failing tray-template tests**

```js
test('tray template changes Start to Pause and always exposes recovery plus Quit', () => {
  const labels = buildTrayTemplate({ session: { phase: 'listening' } }, {}).filter(Boolean).map((item) => item.label);
  assert.deepEqual(labels, ['Show Cue', 'Pause Listening', 'End Session', 'Unlock Interaction', 'Recenter Overlay', 'Settings', 'Quit Cue']);
});
```

- [ ] **Step 3: Implement idempotent lifecycle and pure tray template**

`command()` accepts exactly `show`, `hide`, `collapse`, `start`, `pause`, `resume`, `end-session`, `unlock`, `recenter`, `settings`, and `quit`. Unknown commands reject with `TypeError`. Quit awaits session stop and local-engine stop with a 5-second overall bound before destroying UI and exiting. A second quit joins the first promise.

The tray controller creates one `Tray`, updates its menu when session phase changes, routes callbacks to `command()`, shows Cue on double-click, and safely destroys itself once. Use the existing app icon during this milestone; final icon assets belong to the release plan.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/lifecycle.test.js test/tray-menu.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle.js src/tray-menu.js test/lifecycle.test.js test/tray-menu.test.js
git commit -m "feat: separate hide end and quit lifecycle"
```

### Task 4: Main-process and preload integration

**Files:**
- Create: `src/ipc-contract.js`
- Modify: `main.js`
- Modify: `preload.js`
- Modify: `renderer/renderer.js`
- Modify: `renderer/index.html`
- Test: `test/ipc-contract.test.js`
- Test: `test/main-lifecycle-source.test.js`

**Interfaces:**
- Consumes: Tasks 1-3 modules and existing `setCapturing`, `runFeature`, settings store, permission flow, AppLink, and renderer audio methods.
- Produces: preload methods `sessionGetSnapshot()`, `sessionCommand(command)`, `windowCommand(command)`, `settingsOpen()`, and the `session:snapshot` event.

- [ ] **Step 1: Write failing contract/source tests**

```js
test('IPC contract has one invoke and one event namespace for session state', () => {
  assert.deepEqual(IPC_INVOKES.sessionGetSnapshot, 'session:get-snapshot');
  assert.deepEqual(IPC_INVOKES.sessionCommand, 'session:command');
  assert.deepEqual(IPC_INVOKES.windowCommand, 'window:command');
  assert.deepEqual(IPC_EVENTS.sessionSnapshot, 'session:snapshot');
});

test('main has one app quit listener and no disguised identity', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.equal((source.match(/app\.on\('will-quit'/g) || []).length, 1);
  assert.equal((source.match(/app\.on\('window-all-closed'/g) || []).length, 1);
  assert.equal((source.match(/ipcMain\.on\('app:quit'/g) || []).length, 1);
  assert.doesNotMatch(source, /MicrosoftEdgeUpdate|Microsoft Edge Update/);
});
```

- [ ] **Step 2: Add the stable IPC contract and preload surface**

```js
const IPC_INVOKES = Object.freeze({
  sessionGetSnapshot: 'session:get-snapshot',
  sessionCommand: 'session:command',
  windowCommand: 'window:command',
  settingsOpen: 'settings:open',
  captureProtection: 'capture:protection'
});
const IPC_EVENTS = Object.freeze({ sessionSnapshot: 'session:snapshot' });
```

Expose only those channel constants through named preload functions. Preserve existing methods during the migration. Add `session:snapshot` to the allowed subscription list and return an unsubscribe function from `cue.on()`.

- [ ] **Step 3: Integrate the controller, window policy, tray, and lifecycle in main**

Apply capture protection immediately after constructing every Cue BrowserWindow and before `loadFile`. Replace the primary-display-only restore with `resolveOverlayBounds`; persist debounced move and resize bounds keyed by `screen.getDisplayMatching(win.getBounds()).id`. Use product title `Cue` and `app.setName('Cue')`.

Create one `SessionController` in `launchApp`, adapt its capture operations to the existing `setCapturing`, and broadcast complete snapshots. Route session/window IPC and legacy `capture:toggle` through the controller. Closing the overlay prevents destruction and hides it unless quit cleanup is active. Create one tray and one lifecycle coordinator. Replace the two duplicate `will-quit`, two duplicate `window-all-closed`, and duplicate `app:quit` handlers with one of each.

On macOS, `window-all-closed` keeps the app alive. With a tray on Windows/Linux, it also stays alive. `will-quit` performs only the single coordinator cleanup path. `activate` recreates or shows the overlay and republishes the latest snapshot.

- [ ] **Step 4: Make the legacy renderer consume snapshots without redesigning it**

Subscribe once on DOM ready, request the initial snapshot, and map session phases to the existing capture button. Wire the visible quit button to `cue.sessionCommand('quit')`. Remove hover-driven calls that toggle whole-window mouse ignore; use the existing passthrough control, if present, to call `windowCommand('lock')`, and make the hide control call `windowCommand('hide')`. The full visual rewrite remains in Plan 3.

Run: `node --test test/ipc-contract.test.js test/main-lifecycle-source.test.js`
Expected: PASS.

- [ ] **Step 5: Run regression tests and commit**

Run: `npm test`
Expected: PASS with no open timer/process handles.

```bash
git add src/ipc-contract.js main.js preload.js renderer/renderer.js renderer/index.html test/ipc-contract.test.js test/main-lifecycle-source.test.js
git commit -m "feat: wire session lifecycle through main"
```

### Task 5: Foundation verification

**Files:**
- Modify only if verification exposes a defect: files owned by Tasks 1-4
- Test: all tests from Tasks 1-4 plus the existing suite

**Interfaces:**
- Consumes: complete foundation milestone.
- Produces: a green, reviewable milestone that later plans can treat as stable.

- [ ] **Step 1: Run focused foundation coverage**

Run: `node --test test/session-state.test.js test/session-controller.test.js test/window-state.test.js test/capture-protection.test.js test/lifecycle.test.js test/tray-menu.test.js test/ipc-contract.test.js test/main-lifecycle-source.test.js`
Expected: PASS.

- [ ] **Step 2: Run the complete suite twice to expose leaked timers**

Run: `npm test && npm test`
Expected: both runs pass and return to the shell.

- [ ] **Step 3: Run static checks**

Run: `git diff --check 90aa366..HEAD`
Expected: no whitespace errors.

Run: `node --check main.js && node --check preload.js && node --check renderer/renderer.js`
Expected: no syntax errors.

- [ ] **Step 4: Inspect repository scope**

Run: `git status --short`
Expected: the user-owned `package-lock.json` and the three audit extraction files may remain unstaged; no implementation file is untracked.

- [ ] **Step 5: Commit verification fixes only when Step 1-4 required them**

```bash
git add src main.js preload.js renderer test
git commit -m "fix: close session foundation verification gaps"
```

If no file changed, record the verification commands and outputs in the implementation report without creating an empty commit.
