# Cue Overlay and Control Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Cue's low-contrast, ambiguous overlay and in-overlay settings modal with a snapshot-driven readable session rail, exact LLM model attribution, and an accessible separate control center with atomic Save/Cancel behavior.

**Architecture:** Pure view-model and model-selection modules translate authoritative state/settings into presentation data. The overlay renderer owns only DOM interaction and response history; the normal control-center window stages a settings draft and commits it through an atomic main-process service. Main captures provider/model selection when each request starts and broadcasts that immutable attribution with the response.

**Tech Stack:** Electron 33.2.1, Node.js 22.12+, CommonJS, plain semantic HTML/CSS/JavaScript, `node:test`

**Spec:** `docs/superpowers/specs/2026-08-21-cue-rebuild-design.md`

## Global Constraints

- Overlay surface opacity defaults to 0.94 neutral graphite; off-white is primary text, cobalt is the operational accent, green is healthy/live, amber is recovery/degraded, and red is error.
- Interface text is at least 13 px, transcript text at least 15 px, answers 17-18 px with at least 1.5 line height, controls at least 32 px, and the primary session control at least 40 px high.
- The complete rail is draggable except controls. Click-through changes only through an explicit lock action and always has global shortcut/tray recovery.
- The overlay always exposes session phase/time, mic state, meeting-audio state, active STT engine, live transcript activity, and exact LLM provider/model.
- Every control has an accessible name, visible focus, and correct keyboard behavior. Tabs, dialogs, and live regions use semantic ARIA.
- Settings use explicit Save and Cancel. Failed Save leaves the control center open and the active runtime unchanged.
- Existing profile, prep, Q&A, style, AppLink, model download/import, meeting, resume, and action functionality remains available in the control center or overlay.
- Preserve Plans 1-2 session/STT IPC contracts and main-process ownership.
- Preserve the user-owned `package-lock.json` change and keep competitor-audit extraction files unstaged.
- Start each behavior with a failing test and keep `npm test` green after every task.

---

### Task 1: Atomic settings service and exact model resolution

**Files:**
- Create: `src/model-selection.js`
- Create: `src/settings-service.js`
- Modify: `src/store.js`
- Modify: `src/llm.js`
- Test: `test/model-selection.test.js`
- Test: `test/settings-service.test.js`
- Modify: `test/llm.test.js`

**Interfaces:**
- Consumes: current Cue settings schema, provider/tier/direct override, injected filesystem, and existing `createLLM` provider adapters.
- Produces: `resolveModelSelection(settings, request)`, `createSettingsService(options)`, `SettingsSaveError`, and `createLLM(settings, requestSelection)` returning exact `{ provider, model, tier }`.

- [ ] **Step 1: Write failing model-resolution tests**

```js
test('resolves Quick and Deep to exact configured models', () => {
  const settings = { provider: 'anthropic', models: { anthropic: { fast: 'claude-quick', smart: 'claude-deep' } } };
  assert.deepEqual(resolveModelSelection(settings, { tier: 'quick' }), { provider: 'anthropic', model: 'claude-quick', tier: 'quick' });
  assert.deepEqual(resolveModelSelection(settings, { tier: 'deep' }), { provider: 'anthropic', model: 'claude-deep', tier: 'deep' });
});

test('accepts only a configured direct override and never relabels it later', () => {
  const settings = { provider: 'openai', models: { openai: { fast: 'gpt-fast', smart: 'gpt-deep' } } };
  const resolved = resolveModelSelection(settings, { model: 'gpt-deep' });
  settings.models.openai.smart = 'new-model';
  assert.deepEqual(resolved, { provider: 'openai', model: 'gpt-deep', tier: 'deep' });
  assert.throws(() => resolveModelSelection(settings, { model: 'unconfigured-model' }), /configured Quick or Deep model/);
});
```

Use existing Gemini retired-model normalization after resolving the requested tier. Provider/model errors include the provider name and settings action.

- [ ] **Step 2: Write failing atomic-save tests**

```js
test('renames a complete temporary file and publishes only after success', async () => {
  const fs = atomicFsHarness();
  const published = [];
  const service = createSettingsService({ filePath: '/data/cue-data.json', fs, defaults: DEFAULTS, onSaved: (value) => published.push(value) });
  await service.save({ provider: 'openai', models: { openai: { fast: 'a', smart: 'b' } } });
  assert.deepEqual(fs.operations.map((entry) => entry.name), ['mkdir', 'writeFile', 'rename']);
  assert.equal(service.get().models.openai.fast, 'a');
  assert.equal(published.length, 1);
});

test('keeps active settings unchanged when rename fails', async () => {
  const fs = atomicFsHarness({ renameError: new Error('disk full') });
  const service = createSettingsService({ filePath: '/data/cue-data.json', fs, defaults: DEFAULTS });
  const before = service.get();
  await assert.rejects(service.save({ provider: 'gemini' }), (error) => error.code === 'settings_write_failed');
  assert.deepEqual(service.get(), before);
});
```

- [ ] **Step 3: Implement the model and settings modules**

`resolveModelSelection` maps `quick` to stored `fast` and `deep` to stored `smart`. Direct model override is accepted only when it equals one of those two configured IDs. Return a fresh immutable value.

`createSettingsService` deep-merges defaults without mutating them, enforces `MAX_AI_RULES_CHARS`, normalizes base URLs, validates provider/model/local-engine values, writes `${filePath}.${process.pid}.tmp` with mode `0o600`, then renames over the target. On write/rename failure, remove only that exact temp path, retain in-memory state, and throw `SettingsSaveError('settings_write_failed', ...)`. Existing `store.getSettings()`/`setSettings()` delegate to the service so callers keep working.

- [ ] **Step 4: Integrate exact selection into LLM construction**

Change `createLLM(settings, requestSelection = {})` to call `resolveModelSelection`; preserve the existing provider stream adapters and error mapping. Return `tier` beside `provider` and `model`. Update tests to assert the request override and configured tier reach each provider's stream arguments.

Run: `node --test test/model-selection.test.js test/settings-service.test.js test/llm.test.js`  
Expected: PASS.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`  
Expected: PASS.

```bash
git add src/model-selection.js src/settings-service.js src/store.js src/llm.js test/model-selection.test.js test/settings-service.test.js test/llm.test.js
git commit -m "feat: save settings atomically and resolve exact models"
```

### Task 2: Session view model and semantic overlay shell

**Files:**
- Create: `renderer/session-view.js`
- Replace: `renderer/index.html`
- Replace: `renderer/styles.css`
- Test: `test/session-view.test.js`
- Test: `test/overlay-accessibility.test.js`

**Interfaces:**
- Consumes: Plan 1 `SessionSnapshot` and configured overlay opacity.
- Produces: `deriveSessionView(snapshot, now)`, `formatElapsed(milliseconds)`, semantic overlay element IDs, and the broadcast-monitor visual system.

- [ ] **Step 1: Write failing view-model tests**

```js
test('describes healthy and degraded listening without inference', () => {
  const view = deriveSessionView(snapshot({
    session: { phase: 'listening', elapsedMs: 74_000, degradedReason: 'Meeting audio permission denied' },
    sources: { mic: { phase: 'live', level: 0.42, error: null }, system: { phase: 'error', level: 0, error: { message: 'Meeting audio permission denied' } } },
    stt: { activeEngine: 'parakeet', model: 'parakeet-tdt-0.6b-v3', phase: 'ready' },
    llm: { provider: 'openai', activeModel: 'gpt-4o-mini' }
  }));
  assert.equal(view.sessionLabel, 'Listening 01:14');
  assert.equal(view.sessionTone, 'degraded');
  assert.equal(view.sources.mic.label, 'Mic live');
  assert.equal(view.sources.system.label, 'Meeting audio error');
  assert.equal(view.sttLabel, 'Parakeet · parakeet-tdt-0.6b-v3');
  assert.equal(view.modelLabel, 'OpenAI · gpt-4o-mini');
});

test('uses explicit copy for every session phase', () => {
  const expected = { idle: 'Start listening', starting: 'Starting…', listening: 'Listening 00:00', paused: 'Paused 00:00', stopping: 'Stopping…', error: 'Listening error' };
  for (const [phase, label] of Object.entries(expected)) assert.equal(deriveSessionView(snapshot({ session: { phase, elapsedMs: 0 } })).sessionLabel, label);
});
```

- [ ] **Step 2: Write failing static accessibility tests**

Read `renderer/index.html` and assert:

```js
for (const id of ['session-control', 'mic-source', 'system-source', 'stt-engine', 'model-picker', 'collapse-button', 'lock-button', 'hide-button', 'overflow-button', 'answer-tab', 'transcript-tab', 'response-list', 'live-transcript', 'composer-input', 'send-button']) {
  assert.match(html, new RegExp(`id=["']${id}["']`));
}
assert.match(html, /role="tablist"/);
assert.match(html, /aria-live="polite"/);
assert.match(html, /aria-label="Quit Cue"/);
assert.doesNotMatch(html, /settings-scrim|prep-status/);
```

Check CSS contains `:focus-visible`, `@media (prefers-reduced-motion: reduce)`, `-webkit-app-region: drag`, control `min-height: 32px`, primary `min-height: 40px`, answer `font-size: 18px`, and no `backdrop-filter`.

- [ ] **Step 3: Implement the pure view model**

Return stable values for session label/tone/action, each source label/tone/level/error/action, STT label/tone/detail, model label, transcript text, request phase, and whether controls are disabled. Clamp levels to 0-1 and escape nothing here; renderer assigns strings with `textContent`.

- [ ] **Step 4: Replace markup and styling**

Use this semantic structure:

```html
<div id="app" data-phase="idle">
  <header id="session-rail" class="drag-region">
    <div class="brand-lockup" aria-label="Cue overlay"><span class="brand-mark" aria-hidden="true"></span><span>Cue</span></div>
    <button id="session-control" class="no-drag primary-control" type="button">Start listening</button>
    <button id="mic-source" class="no-drag source-chip" type="button" aria-label="Microphone status"></button>
    <button id="system-source" class="no-drag source-chip" type="button" aria-label="Meeting audio status"></button>
    <div id="stt-engine" role="status"></div>
    <button id="collapse-button" class="no-drag" type="button" aria-label="Collapse overlay"></button>
    <button id="lock-button" class="no-drag" type="button" aria-label="Enable click-through"></button>
    <button id="hide-button" class="no-drag" type="button" aria-label="Hide overlay"></button>
    <button id="overflow-button" class="no-drag" type="button" aria-label="Overlay menu"></button>
  </header>
  <main id="overlay-panel">
    <nav class="view-tabs" role="tablist" aria-label="Overlay view">
      <button id="answer-tab" role="tab" aria-controls="answer-panel" aria-selected="true">Answer</button>
      <button id="transcript-tab" role="tab" aria-controls="transcript-panel" aria-selected="false">Transcript</button>
    </nav>
    <button id="model-picker" type="button" aria-haspopup="menu"></button>
    <section id="answer-panel" role="tabpanel" aria-labelledby="answer-tab"><ol id="response-list" aria-live="polite"></ol></section>
    <section id="transcript-panel" role="tabpanel" aria-labelledby="transcript-tab" hidden><div id="live-transcript" aria-live="polite"></div><ol id="transcript-list"></ol></section>
    <form id="composer"><label class="sr-only" for="composer-input">Ask Cue</label><textarea id="composer-input"></textarea><button id="send-button" type="submit">Send</button></form>
  </main>
</div>
```

The overflow menu contains Settings, Recenter, Unlock Interaction, Clear Context, End Session, and `Quit Cue`. Preserve action buttons for What should I say, Assist, Follow-up, Recap, and LeetCode as labelled text controls above the composer. Use no emoji.

- [ ] **Step 5: Run tests and commit**

Run: `node --test test/session-view.test.js test/overlay-accessibility.test.js`  
Expected: PASS.

Run: `npm test`  
Expected: PASS.

```bash
git add renderer/session-view.js renderer/index.html renderer/styles.css test/session-view.test.js test/overlay-accessibility.test.js
git commit -m "feat: rebuild the readable session overlay"
```

### Task 3: Snapshot-driven overlay interactions and response history

**Files:**
- Create: `renderer/overlay-controller.js`
- Replace: `renderer/renderer.js`
- Modify: `preload.js`
- Modify: `main.js`
- Test: `test/overlay-controller.test.js`
- Test: `test/response-attribution.test.js`

**Interfaces:**
- Consumes: Task 2 view model, Plan 1 session/window IPC, Plan 2 audio capture, exact Task 1 model resolver, and existing ask/action/prep/AppLink functions.
- Produces: `createOverlayController(dependencies)`, response records `{ id, provider, model, tier, phase, text, error, request }`, scoped retry, explicit lock/hide/collapse actions, and keyboard tab/menu handling.

- [ ] **Step 1: Write failing controller tests**

```js
test('renders initial and subsequent full snapshots in revision order', async () => {
  const harness = overlayHarness();
  const controller = createOverlayController(harness.dependencies);
  await controller.start();
  harness.emitSnapshot(snapshot({ revision: 4, session: { phase: 'listening', elapsedMs: 10_000 } }));
  harness.emitSnapshot(snapshot({ revision: 3, session: { phase: 'idle' } }));
  assert.equal(harness.rendered.at(-1).revision, 4);
});

test('lock is explicit and recovery remains outside pointer interaction', async () => {
  const harness = overlayHarness();
  const controller = createOverlayController(harness.dependencies);
  await controller.command('lock');
  assert.deepEqual(harness.windowCommands, ['lock']);
  assert.equal(harness.mousemoveListeners, 0);
});
```

Add tests for session-control action by phase, collapse preserving session, hide preserving session, tab roving/arrow keys, Escape closing menus, exact model menu choices, and action/composer payloads.

- [ ] **Step 2: Write failing immutable attribution and retry tests**

```js
test('keeps the resolved model on a response after settings change and retries only it', () => {
  const history = createResponseHistory();
  history.start({ id: 'r1', provider: 'openai', model: 'gpt-4o-mini', tier: 'quick', request: { mode: 'ask', text: 'Explain this' } });
  history.token('r1', 'Partial');
  history.fail('r1', { code: 'network', message: 'Connection failed' });
  assert.deepEqual(history.retryPayload('r1'), { retryOf: 'r1' });
  assert.equal(history.get('r1').model, 'gpt-4o-mini');
});
```

- [ ] **Step 3: Implement controller and response history**

Subscribe once, discard snapshots with a lower revision, render all operational labels from `deriveSessionView`, and delegate audio start/stop to the capture module only after main commands succeed. Use `textContent` for transcript/model/error values. Maintain response nodes keyed by request ID; streaming creates a header immediately, appends tokens in place, adds a progress cursor, and replaces it with complete/error state. Error cards include one Retry button and preserve partial text.

Delete duplicated settings, audio, capture-state inference, hover click-through, and duplicate `startMic()` calls from the old renderer. Port existing Markdown-safe response formatting, transcript history, question history, AppLink consent, action modes, and document context indicators into focused helpers inside `overlay-controller.js`; no settings form remains in this window.

- [ ] **Step 4: Capture immutable model attribution in main**

`runFeature(mode, userText, requestSelection = {})` resolves `createLLM` once, creates a request ID, stores an immutable main-process request record `{ mode, text, provider, model, tier }`, and dispatches `LLM_REQUEST_STARTED` with exact provider/model/tier before `llm:start`. Every `llm:token`, `llm:done`, and `llm:error` includes that request ID. Retry accepts only `retryOf`, retrieves the original record in main, and uses its provider/model rather than renderer data or current settings; retain at most 100 records. Capture screenshot success/failure into `request.contextUsed.screen` rather than claiming screen context unconditionally.

Add preload `ask(payload)` validation for either `{ mode, text, selection }` or `{ retryOf }`; reject a mixed retry/new-request payload. Preserve global shortcut actions by supplying their configured Quick/Deep selection.

- [ ] **Step 5: Run tests and commit**

Run: `node --test test/overlay-controller.test.js test/response-attribution.test.js`  
Expected: PASS.

Run: `npm test && node --check renderer/renderer.js && node --check main.js`  
Expected: PASS.

```bash
git add renderer/overlay-controller.js renderer/renderer.js preload.js main.js test/overlay-controller.test.js test/response-attribution.test.js
git commit -m "feat: drive overlay and responses from exact state"
```

### Task 4: Separate control-center window

**Files:**
- Create: `renderer/settings.html`
- Create: `renderer/settings.js`
- Create: `renderer/settings.css`
- Create: `src/model-catalog.js`
- Modify: `main.js`
- Modify: `preload.js`
- Test: `test/model-catalog.test.js`
- Test: `test/settings-window.test.js`
- Test: `test/settings-accessibility.test.js`

**Interfaces:**
- Consumes: atomic settings service, local-engine/model overview APIs, existing document import/AppLink/model-manager methods, and capture-protection helper.
- Produces: one reusable 900×720 control-center BrowserWindow, staged form draft, explicit Save/Cancel, unsaved-close decision, model listing/testing APIs, and Audio/AI Models/Shortcuts/Appearance/Profile/Diagnostics sections.

- [ ] **Step 1: Write failing model-catalog tests**

```js
test('normalizes OpenAI-compatible and Ollama model lists', async () => {
  const fetch = routeFetch({
    'https://api.openai.com/v1/models': { data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] },
    'http://127.0.0.1:11434/api/tags': { models: [{ name: 'llama3.2:latest' }] }
  });
  assert.deepEqual(await listProviderModels({ provider: 'openai', apiKey: 'secret', fetch }), ['gpt-a', 'gpt-b']);
  assert.deepEqual(await listProviderModels({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', fetch }), ['llama3.2:latest']);
});
```

Support OpenAI, Custom, Groq, MiniMax, Azure OpenAI-compatible `/models`, Ollama `/api/tags`, and Gemini's authenticated models endpoint. Anthropic returns the configured Quick/Deep IDs because it has no general user-key model-list endpoint in this integration. Apply an 8-second timeout, never return keys, and convert auth/network/protocol failures into stable codes.

- [ ] **Step 2: Write failing window and staged-save tests**

```js
test('creates one protected normal settings window with required bounds', () => {
  const harness = settingsWindowHarness();
  const first = harness.openSettings();
  const second = harness.openSettings();
  assert.equal(first, second);
  assert.deepEqual(harness.browserWindowOptions, { width: 900, height: 720, minWidth: 760, minHeight: 600, show: false, backgroundColor: '#111317' });
  assert.equal(harness.protectionCalls, 1);
});

test('failed save keeps draft and window open', async () => {
  const harness = settingsRendererHarness({ saveError: { code: 'settings_write_failed', message: 'Could not save settings.' } });
  await harness.controller.save();
  assert.equal(harness.windowClosed, false);
  assert.equal(harness.errorText, 'Could not save settings.');
  assert.equal(harness.draft.provider, 'openai');
});
```

- [ ] **Step 3: Build the main-process window and IPC**

Create a framed, opaque, resizable BrowserWindow with the exact size/minimums above, product title `Cue Settings`, context isolation, and the same capture protection helper. Reuse it while alive. Load `renderer/settings.html`; show on `ready-to-show`.

Expose `settingsGet`, `settingsSave`, `settingsListModels`, `settingsTestProvider`, `settingsSetDirty`, `settingsClose`, `localSttInspect`, existing Whisper model actions, document import, shortcut registration status, AppLink callers, and capture-protection status. When a dirty window requests/receives native close, show a native message box with `Keep Editing` and `Discard Changes`; only discard destroys it.

- [ ] **Step 4: Build the staged accessible form**

Use a left navigation with real text labels and `<section aria-labelledby>`. Audio includes route, Auto/Parakeet/Whisper, runtime/model source/status, language/threads, download/import actions, and source permission diagnostics. AI Models includes provider, credentials/base URL, connection test, searchable `<input list>` Quick/Deep fields, and exact active selection. Shortcuts exposes every action and conflict. Appearance contains opacity 0.80-1.00, reset/recenter, and click-through default. Profile combines resume, JD, prep, Q&A, style, and AppLink access. Diagnostics shows versions, source/session/engine/model/protection/shortcuts, structured recent errors, and no secret values.

Clone settings into a draft on load. All inputs update only the draft and dirty flag. Save awaits validation/write, replaces the baseline on success, clears dirty, notifies the overlay, and closes only when the user chose Save & Close. Cancel compares draft/baseline and invokes discard handling. Tabs do not save.

- [ ] **Step 5: Run tests and commit**

Run: `node --test test/model-catalog.test.js test/settings-window.test.js test/settings-accessibility.test.js`  
Expected: PASS.

Run: `npm test && node --check renderer/settings.js && node --check main.js`  
Expected: PASS.

```bash
git add renderer/settings.html renderer/settings.js renderer/settings.css src/model-catalog.js main.js preload.js test/model-catalog.test.js test/settings-window.test.js test/settings-accessibility.test.js
git commit -m "feat: add an explicit cue control center"
```

### Task 5: Interaction, accessibility, and visual verification

**Files:**
- Modify only when verification exposes a defect: files owned by Tasks 1-4
- Test: `test/overlay-accessibility.test.js`
- Test: `test/settings-accessibility.test.js`
- Test: complete suite

**Interfaces:**
- Consumes: complete overlay/control-center milestone.
- Produces: keyboard-complete, readable, visually inspected renderer surfaces.

- [ ] **Step 1: Exercise keyboard contracts in tests**

Add deterministic tests for Tab order, Enter/Space activation, ArrowLeft/ArrowRight tab selection, Escape menu dismissal, focus restoration to the opener, settings focus staying inside a modal confirmation, reduced-motion CSS, and labelled icon controls. Assert every error/status live region uses `role="status"` or `role="alert"` as appropriate.

- [ ] **Step 2: Run automated and syntax verification**

Run: `npm test`  
Expected: PASS.

Run: `node --check renderer/session-view.js && node --check renderer/overlay-controller.js && node --check renderer/renderer.js && node --check renderer/settings.js`  
Expected: no syntax errors.

- [ ] **Step 3: Launch the app and inspect all core states**

Run: `npm start`  
Expected: overlay opens on the current display with a broad draggable rail. Inspect idle, starting, listening with both sources, degraded mic-only/system-only, paused, streaming answer, failed answer with Retry, transcript tab, collapsed, explicit click-through/unlock, hidden/tray restore, settings, and quit. Confirm answer text remains readable over a bright and dark background and no control clips at 420 px width.

- [ ] **Step 4: Inspect control-center persistence**

Change provider and model in the draft, Cancel, and confirm the overlay model label is unchanged. Reopen, Save a valid change, and confirm the overlay updates. Force a save error using a test-only injected unwritable path and confirm the window remains open with the draft intact; remove the injection and save normally.

- [ ] **Step 5: Commit verification fixes only when required**

```bash
git add renderer src main.js preload.js test
git commit -m "fix: close overlay and settings verification gaps"
```

If no file changed, record the inspected states, keyboard paths, and commands in the implementation report without creating an empty commit.
