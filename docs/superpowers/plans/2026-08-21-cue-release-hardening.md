# Cue Integration and Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a launchable, honestly signed, correctly branded Cue `.app` and distributable archive with local runtime artifacts, migration, capture-protection diagnostics, smoke tests, license notices, and accurate documentation.

**Architecture:** Checksum/version manifests prepare native runtimes into project-local caches and `afterPack` copies them before signing. A platform-aware build orchestrator creates local ad-hoc or credentialed release artifacts and a verifier inspects their contents and signatures. Capture protection gains a user-triggered probe and deterministic policy tests; a smoke mode exercises real Electron window/tray/quit wiring without audio hardware.

**Tech Stack:** Electron 33.2.1, electron-builder 26, Node.js 22.12+, macOS `codesign`/`ditto`/`iconutil`, CMake + Xcode for whisper.cpp, GitHub Actions, `node:test`

**Spec:** `docs/superpowers/specs/2026-08-21-cue-rebuild-design.md`

## Global Constraints

- `npm run pack:mac` produces a launchable arm64 `dist/mac-arm64/Cue.app`; `npm run dist:mac` produces a distributable archive.
- Packaged apps contain configured local runtime artifacts, icon, honest bundle identity, renderer assets, usage descriptions, and license notices. Model weights remain user-managed and are not silently duplicated into the app.
- Local unsigned builds are ad-hoc signed and described as local-only. Public release uploads require Developer ID signing plus notarization credentials and must pass signature/Gatekeeper/staple verification.
- Capture protection is applied before each Cue window is shown. Windows receives excluded/black-fallback behavior; macOS is best effort; Linux is unsupported. Modern macOS ScreenCaptureKit exclusion is never guaranteed.
- The capture self-test proves only the local capture path it exercised and returns pass, fail, or indeterminate.
- Existing user settings migrate without losing API keys, provider/model choices, profiles, transcript preferences, or window placement.
- README claims must match executed behavior, including runtime prerequisites, artifact locations, privacy limits, and platform support.
- Preserve the user-owned `package-lock.json` changes; if package metadata must change, merge only the specific required keys rather than regenerating the lock.
- Keep the three competitor-audit extraction files out of every commit.
- Start each behavior with a failing test and keep `npm test` green after every task.

---

### Task 1: Reproducible local runtime preparation

**Files:**
- Create: `src/parakeet-runtime-manifest.js`
- Create: `scripts/prepare-parakeet-runtime.js`
- Create: `scripts/prepare-local-runtimes.js`
- Create: `scripts/verify-local-runtimes.js`
- Modify: `src/whisper-runtime-manifest.js`
- Modify: `scripts/prepare-whisper-runtime.js`
- Modify: `scripts/verify-whisper-runtime.js`
- Create: `build-resources/sherpa-onnx.LICENSE`
- Create: `build-resources/onnxruntime.LICENSE`
- Test: `test/parakeet-runtime-manifest.test.js`
- Test: `test/prepare-parakeet-runtime.test.js`
- Modify: `test/build-config.test.js`

**Interfaces:**
- Consumes: explicit source paths, installed OpenWhispr compatibility runtime, project cache, whisper.cpp v1.9.1 source, CMake/Xcode, and pinned checksums/metadata.
- Produces: `.cache/parakeet-runtime/<target>`, `.cache/whisper-runtime/<target>`, manifests, `prepareLocalRuntimes(options)`, and a verifier with nonzero exit on incomplete artifacts.

- [ ] **Step 1: Write failing Parakeet manifest/preparer tests**

```js
test('defines Darwin arm64/x64 runtime targets with required files', () => {
  const arm = getParakeetRuntimeTarget('darwin', 'arm64');
  assert.equal(arm.key, 'darwin-arm64');
  assert.deepEqual(arm.requiredFiles.sort(), ['libonnxruntime.1.27.0.dylib', 'sherpa-onnx-ws'].sort());
});

test('copies only validated runtime files from an explicit compatibility source', async () => {
  const harness = runtimePrepareHarness({
    sourceFiles: {
      'sherpa-onnx-ws-darwin-x64': { executable: true, architectures: ['x86_64', 'arm64'] },
      'libonnxruntime.1.27.0.dylib': { architectures: ['x86_64', 'arm64'] },
      'unrelated-secret': { executable: false }
    }
  });
  const result = await prepareParakeetRuntime({ platform: 'darwin', architecture: 'arm64', sourceDirectory: harness.source, cacheRoot: harness.cache, ...harness.dependencies });
  assert.deepEqual(harness.copied.sort(), ['libonnxruntime.1.27.0.dylib', 'sherpa-onnx-ws'].sort());
  assert.equal(result.manifest.source, 'explicit');
  assert.equal(result.manifest.target, 'darwin-arm64');
});
```

Add tests that reject missing files, wrong architecture, non-executable binaries, checksum mismatch, and an unmanaged output path. OpenWhispr discovery is allowed only on Darwin and is recorded as `source: 'openwhispr-compatibility'`.

- [ ] **Step 2: Implement the Parakeet runtime preparer**

On this Mac, source resolution is explicit `--source`/`CUE_PARAKEET_RUNTIME_SOURCE`, then the installed OpenWhispr `Contents/Resources/bin`, then an existing validated cache. Copy the universal `sherpa-onnx-ws-darwin-x64` as cache filename `sherpa-onnx-ws` plus `libonnxruntime.1.27.0.dylib`; inspect both with injected `lipo -archs` and require the target architecture. Preserve executable mode, write `sherpa-onnx.LICENSE`, `onnxruntime.LICENSE`, and `runtime.json` with `{ name, version, target, source, files, preparedAt }`.

For CI/release environments without OpenWhispr, accept a prebuilt directory only through the explicit source variable and validate the same contract. This makes the build deterministic without scraping a third-party application during release. The release workflow will prepare that directory from a pinned official sherpa-onnx build artifact before packaging.

- [ ] **Step 3: Repair whisper.cpp source preparation**

Set the v1.9.1 source archive SHA-256 to `98a57a88ef0e733b746544f8ea25157d3265fbf0dac5c32dbb527e6ef4dbfaac` and record tag commit `f049fff95a089aa9969deb009cdd4892b3e74916` in the runtime manifest. Resolve CMake in this order: `CUE_CMAKE`, `cmake` on PATH, then fail with `CMAKE_MISSING` and the exact macOS remediation `brew install cmake`. Keep builds in project-local cache, use `-DGGML_NATIVE=OFF`, target only `whisper-server`, and verify the output architecture with `lipo -archs` before writing `runtime.json`.

Add a test where the checksum mismatch leaves the prior valid cache untouched and a test where `CMAKE_MISSING` includes the remediation command. Do not weaken Windows/Linux release-asset checksums.

- [ ] **Step 4: Add combined preparation and verification commands**

`prepare-local-runtimes.js` accepts `--platform`, `--arch`, `--output-root`, and `--parakeet-source`, prepares both runtimes, and prints their two paths as JSON. `verify-local-runtimes.js` validates both manifests, executables, dependencies, architectures, and notices and exits 1 with all problems listed together.

Run: `node --test test/parakeet-runtime-manifest.test.js test/prepare-parakeet-runtime.test.js test/build-config.test.js`
Expected: PASS.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/parakeet-runtime-manifest.js src/whisper-runtime-manifest.js scripts/prepare-parakeet-runtime.js scripts/prepare-local-runtimes.js scripts/verify-local-runtimes.js scripts/prepare-whisper-runtime.js scripts/verify-whisper-runtime.js build-resources/sherpa-onnx.LICENSE build-resources/onnxruntime.LICENSE test/parakeet-runtime-manifest.test.js test/prepare-parakeet-runtime.test.js test/build-config.test.js
git commit -m "build: prepare both local speech runtimes"
```

### Task 2: Packaged-runtime enforcement and honest macOS app build

**Files:**
- Create: `scripts/build-mac.js`
- Create: `scripts/verify-packaged-app.js`
- Create: `scripts/build-cue-icon.js`
- Create: `build-resources/icon.svg`
- Modify: `scripts/after-pack.js`
- Modify: `electron-builder.cjs`
- Modify: `package.json`
- Modify: `.github/workflows/release.yml`
- Delete: `scripts/apply-icon.js`
- Delete: `scripts/build-icon.js`
- Modify: `test/build-config.test.js`
- Create: `test/packaged-app-verifier.test.js`

**Interfaces:**
- Consumes: Task 1 caches, electron-builder context, optional signing/notarization environment, and platform tools.
- Produces: `pack:mac`, `dist:mac`, runtime-enforced app assembly, Cue icon assets, ad-hoc local signing, credentialed release signing, and artifact verification.

- [ ] **Step 1: Write failing build-contract tests**

```js
test('mac scripts use the build orchestrator and product identity is Cue', () => {
  assert.equal(pkg.scripts['pack:mac'], 'node scripts/build-mac.js --dir --arm64');
  assert.equal(pkg.scripts['dist:mac'], 'node scripts/build-mac.js --zip --arm64');
  assert.equal(builder.productName, 'Cue');
  assert.equal(builder.appId, 'com.cue.overlay');
  assert.equal(builder.mac.icon, 'build-resources/icon.icns');
});

test('release packaging requires both local runtime directories', async () => {
  await assert.rejects(() => afterPack(packContext({ release: true, whisperExists: true, parakeetExists: false })), /Parakeet runtime.*required/);
});
```

Assert mac `extendInfo` contains `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`, and `NSScreenCaptureUsageDescription`. Assert `postinstall` no longer renames Electron and source contains no Edge executable/icon manipulation.

- [ ] **Step 2: Build honest icon and app configuration**

Create a 1024×1024 SVG: a graphite rounded square, cobalt inset speech/caption field, and an off-white open `C` waveform mark. `build-cue-icon.js` uses `sips` to rasterize 16, 32, 64, 128, 256, 512, and 1024 px images into an iconset and `iconutil -c icns` to produce `build-resources/icon.icns`; it validates every command and removes only its exact temporary iconset.

Set `productName: 'Cue'`, configure mac icon, retain `LSUIElement: true`, add screen usage copy, and include notices in `files`/`extraResources`. Remove Edge extraction scripts and the renaming `postinstall` entry. Leave unrelated dependency-lock entries untouched.

- [ ] **Step 3: Enforce runtimes in afterPack and orchestrate builds**

`afterPack` always copies matching prepared `whisper-runtime` and `parakeet-runtime` directories into `Contents/Resources` when `CUE_BUNDLE_LOCAL_STT=1`. When `CUE_RELEASE_BUILD=1`, missing/invalid runtimes fail the build instead of logging a skip. After copying, run the combined verifier against the packaged directories.

`build-mac.js` performs this exact sequence:

1. Build icon if missing or older than its SVG.
2. Prepare both runtimes for requested architecture.
3. Set `CUE_BUNDLE_LOCAL_STT=1` and `CUE_RELEASE_BUILD=1` for electron-builder.
4. For `--dir`, run electron-builder mac dir for the requested architecture, then use `codesign --force --deep --sign -` only when `MAC_SIGN !== '1'`.
5. For `--zip` with `MAC_SIGN === '1'`, require all Apple credentials and let electron-builder sign/notarize/staple the zip target.
6. For local `--zip` without a Developer ID, build/ad-hoc-sign the directory and archive it with `ditto -c -k --sequesterRsrc --keepParent`, labelling the output `Cue-<version>-mac-<arch>-local.zip`.
7. Run `verify-packaged-app.js` and print absolute artifact paths.

- [ ] **Step 4: Implement artifact and release gates**

The verifier checks product/bundle name, Info.plist usage strings, icon, main/preload/renderer files, both runtime manifests/executables/notices, executable target architecture, and `codesign --verify --deep --strict`. Credentialed releases additionally require `spctl --assess --type execute` and `xcrun stapler validate`; local builds report those two as not applicable rather than passing them.

Update the release workflow so upload runs only after `MAC_SIGN=1`, Developer ID material, Apple ID, app-specific password, team ID, runtime verification, signature verification, Gatekeeper assessment, and staple validation. Build x64 and arm64 separately from explicit validated runtime sources.

Run: `node --test test/build-config.test.js test/packaged-app-verifier.test.js`
Expected: PASS.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add scripts/build-mac.js scripts/verify-packaged-app.js scripts/build-cue-icon.js scripts/after-pack.js build-resources/icon.svg electron-builder.cjs package.json .github/workflows/release.yml test/build-config.test.js test/packaged-app-verifier.test.js
git rm scripts/apply-icon.js scripts/build-icon.js
git commit -m "build: produce an honest packaged Cue app"
```

### Task 3: Capture-protection self-test and Electron smoke mode

**Files:**
- Create: `src/capture-protection-self-test.js`
- Create: `src/smoke-reporter.js`
- Modify: `main.js`
- Modify: `preload.js`
- Modify: `renderer/settings.html`
- Modify: `renderer/settings.js`
- Test: `test/capture-protection-self-test.test.js`
- Create: `test/electron-smoke.test.js`

**Interfaces:**
- Consumes: Plan 1 protection helper, Electron BrowserWindow/desktopCapturer/screen/Tray, image samples, smoke environment, and control-center Diagnostics.
- Produces: `runCaptureProtectionSelfTest(dependencies)`, `captureProtectionSelfTest()` preload call, structured pass/fail/indeterminate diagnostics, and `CUE_SMOKE_TEST=1` process output.

- [ ] **Step 1: Write failing pure self-test tests**

```js
test('passes only when baseline marker is visible and protected marker is absent', async () => {
  const result = await runCaptureProtectionSelfTest(probeHarness({ baseline: 'marker', protected: 'background' }));
  assert.deepEqual(result, { outcome: 'pass', api: 'electron-desktopCapturer', protectionMode: 'windows-excluded', reason: 'The marker was excluded from this capture path.' });
});

test('returns fail when the protected marker remains and indeterminate without a baseline', async () => {
  assert.equal((await runCaptureProtectionSelfTest(probeHarness({ baseline: 'marker', protected: 'marker' }))).outcome, 'fail');
  assert.equal((await runCaptureProtectionSelfTest(probeHarness({ baseline: 'background', protected: 'background' }))).outcome, 'indeterminate');
});
```

Add cleanup assertions for capture denial, probe-window creation failure, timeout, and thrown image reads.

- [ ] **Step 2: Implement the user-triggered probe**

Create a temporary 96×96 checkerboard probe with exact RGB marker colors at a known primary-display position. Capture a full-resolution-enough thumbnail while unprotected and require the marker in the expected rectangle. Apply protection with the shared helper, wait two animation frames plus 100 ms, capture again, and compare. Always destroy the probe in `finally`; never use the real overlay or expose user content beyond local bitmap memory.

Return `{ outcome, api, protectionMode, reason, platform, electronVersion, testedAt }`. On modern macOS, append that ScreenCaptureKit-based third-party apps may still capture Cue even when this Electron path passes. Diagnostics labels the button `Test this capture path` and never `Verify complete invisibility`.

- [ ] **Step 3: Write the failing Electron smoke test**

```js
test('creates protected overlay/settings/tray and completes bounded quit', async () => {
  const result = await runElectronSmoke({ timeoutMs: 20_000 });
  assert.deepEqual(result.windows.sort(), ['overlay', 'settings']);
  assert.equal(result.overlay.contentProtected, true);
  assert.equal(result.tray.created, true);
  assert.equal(result.commands.includes('hide'), true);
  assert.equal(result.commands.includes('show'), true);
  assert.equal(result.quit.completed, true);
  assert.ok(result.quit.elapsedMs <= 5_500);
});
```

- [ ] **Step 4: Implement deterministic smoke mode**

When `CUE_SMOKE_TEST=1`, use a temporary userData path, bypass permission prompts and hardware capture, create overlay/control center/tray, apply content protection, send hide/show/recenter commands, collect structured facts through `SmokeReporter`, invoke the real lifecycle quit path, print one line prefixed `CUE_SMOKE_RESULT=`, and exit. Do not load API keys or the user's normal settings.

The Node test spawns `node_modules/.bin/electron .` with that environment, captures stdout, parses the one JSON line, fails on timeout/nonzero exit, and prints stderr only on failure.

- [ ] **Step 5: Run tests and commit**

Run: `node --test test/capture-protection-self-test.test.js test/electron-smoke.test.js`
Expected: PASS in the logged-in macOS desktop session.

Run: `npm test`
Expected: PASS.

```bash
git add src/capture-protection-self-test.js src/smoke-reporter.js main.js preload.js renderer/settings.html renderer/settings.js test/capture-protection-self-test.test.js test/electron-smoke.test.js
git commit -m "test: verify capture protection and electron lifecycle"
```

### Task 4: Settings migration, notices, and accurate documentation

**Files:**
- Create: `src/settings-migrations.js`
- Modify: `src/store.js`
- Create: `NOTICE`
- Modify: `README.md`
- Modify: `renderer/settings.html`
- Modify: `test/build-config.test.js`
- Create: `test/settings-migrations.test.js`
- Create: `test/readme-claims.test.js`

**Interfaces:**
- Consumes: legacy `cue-data.json`, final settings defaults/schema, bundled component versions/licenses, final shortcuts/platform/runtime behavior.
- Produces: versioned idempotent migrations, third-party notices, and documentation enforced by claims tests.

- [ ] **Step 1: Write failing migration tests**

```js
test('migrates legacy settings without losing secrets or model/window choices', () => {
  const legacy = { provider: 'anthropic', apiKeys: { anthropic: 'keep-me' }, models: { anthropic: { fast: 'a', smart: 'b' } }, windowX: 51, windowY: 72, resumeText: 'resume' };
  const migrated = migrateSettings(legacy);
  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(migrated.apiKeys.anthropic, 'keep-me');
  assert.deepEqual(migrated.models.anthropic, { fast: 'a', smart: 'b' });
  assert.equal(migrated.resumeText, 'resume');
  assert.equal(migrated.localStt.engine, 'auto');
  assert.equal(migrated.overlay.opacity, 0.94);
  assert.deepEqual(migrateSettings(migrated), migrated);
});
```

Convert `windowX/windowY` to the current primary-display bounds only after screen data is available; retain the legacy pair until Plan 1 stores the first keyed bounds. Preserve explicit `sttProvider`; only choose local when no explicit provider exists and healthy local assets were detected.

- [ ] **Step 2: Write failing README claims tests**

Assert README contains `npm run pack:mac`, `npm run dist:mac`, artifact paths, `Auto`, `Parakeet`, `whisper.cpp`, OpenWhispr read-only reuse, local-only fallback, content-protection self-test, ScreenCaptureKit limitation, Activity Monitor visibility, usage permissions, signed/notarized release requirements, and runtime prerequisites. Assert it does not contain `guaranteed invisible`, `MicrosoftEdgeUpdate`, or claims that all packaged builds contain a runtime without stating the build command.

- [ ] **Step 3: Implement migrations and notices**

Set `CURRENT_SCHEMA_VERSION = 2`. Migration adds exactly the new `localStt` and `overlay` defaults from the spec, `windowBoundsByDisplay: {}`, and shortcut defaults while deep-merging existing provider models/keys. Write the migrated file atomically only after a successful parse; a corrupt JSON file is copied to `cue-data.corrupt-<timestamp>.json` before defaults are written.

`NOTICE` identifies Cue GPL-3.0-or-later, whisper.cpp and ONNX Runtime MIT, sherpa-onnx Apache-2.0, and NVIDIA Parakeet TDT 0.6B v3 CC-BY-4.0 with direct project/model URLs and bundled-vs-user-managed status. Show notices in control-center About/Diagnostics.

- [ ] **Step 4: Rewrite README against shipped behavior**

Document install-from-source, runtime preparation, local `.app`, signed release, local model discovery, exact controls/shortcuts, source health, model selection, permission remediation, capture-protection outcomes/limitations, diagnostics, troubleshooting, and build verification. Remove contradictory macOS system-audio and runtime-inclusion sections plus vendor-style undetectability claims.

Run: `node --test test/settings-migrations.test.js test/readme-claims.test.js test/build-config.test.js`
Expected: PASS.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/settings-migrations.js src/store.js NOTICE README.md renderer/settings.html test/settings-migrations.test.js test/readme-claims.test.js test/build-config.test.js
git commit -m "docs: align Cue migration privacy and build guidance"
```

### Task 5: Produce and inspect the arm64 application

**Files:**
- Modify only if verification exposes a defect: files owned by Tasks 1-4
- Artifacts: `dist/mac-arm64/Cue.app`, `dist/Cue-<version>-mac-arm64-local.zip`

**Interfaces:**
- Consumes: all four implementation plans, installed build prerequisites, OpenWhispr compatibility assets, and final verifier.
- Produces: a launchable arm64 Cue app plus archive and a complete verification record.

- [ ] **Step 1: Establish the final automated baseline**

Run: `npm test`
Expected: every test passes.

Run: `node --test test/electron-smoke.test.js`
Expected: PASS.

- [ ] **Step 2: Prepare and verify native runtimes**

Run: `brew list cmake >/dev/null 2>&1 || brew install cmake`
Expected: CMake is available without modifying project files.

Run: `npm run prepare:local -- --platform darwin --arch arm64 --parakeet-source /Applications/OpenWhispr.app/Contents/Resources/bin`
Expected: both project-local caches are prepared and validated.

Run: `npm run verify:local -- --platform darwin --arch arm64`
Expected: PASS with whisper-server arm64 and sherpa-onnx-ws arm64/universal.

- [ ] **Step 3: Build the local application and archive**

Run: `npm run pack:mac`
Expected: absolute `dist/mac-arm64/Cue.app` path printed and verifier PASS.

Run: `npm run dist:mac`
Expected: absolute `dist/Cue-<version>-mac-arm64-local.zip` path printed and verifier PASS.

- [ ] **Step 4: Inspect and launch the artifact**

Run:

```bash
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Cue.app
file dist/mac-arm64/Cue.app/Contents/Resources/whisper-runtime/whisper-server
file dist/mac-arm64/Cue.app/Contents/Resources/parakeet-runtime/sherpa-onnx-ws
node scripts/verify-packaged-app.js dist/mac-arm64/Cue.app --local
open dist/mac-arm64/Cue.app
```

Expected: signature verification succeeds, both binaries include arm64, packaged verifier passes, and Cue launches with its own icon/identity. In the app, verify Parakeet discovery/transcription, whisper selection, Auto winner display, mic/system source state, hide/tray restore, control-center Save/Cancel, capture self-test disclosure, and Quit cleanup.

- [ ] **Step 5: Commit verification fixes only when required**

Run: `git diff --check 90aa366..HEAD && git status --short`
Expected: no whitespace errors; only the user's pre-existing lockfile and audit extractions remain unstaged; `dist/` and runtime caches remain ignored.

```bash
git add src renderer scripts build-resources main.js preload.js electron-builder.cjs package.json README.md NOTICE test .github/workflows
git commit -m "fix: close packaged app verification gaps"
```

If no source file changed, record the artifact paths, signature output, runtime architectures, test totals, launch result, and manual checks in the implementation report without creating an empty commit.
