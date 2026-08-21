# Task 3 report: Auto manager and Whisper adapter

## Outcome

Implemented a dependency-injected local STT manager that supports only Parakeet and Whisper, selects the sole healthy engine, uses an exact health-bound benchmark cache, races an uncached first utterance, and performs one visible local-to-local retry for uncommitted segments. No cloud provider or cloud fallback dependency exists in the manager or adapter.

Implemented a Whisper engine adapter that combines runtime discovery with mandatory model checksum verification, creates one `LocalWhisperTranscriber` per lifecycle generation, pairs direct requests by unique IDs, serializes requests per channel, bounds inputs/queues/timeouts/stops, and invalidates late callbacks safely. The existing streaming `LocalWhisperTranscriber` API remains compatible; an optional direct request ID bypasses segmentation for already-formed manager segments.

## Files

- `src/local-stt-manager.js` — Auto/explicit selection, deterministic cache key and validation, first-result benchmark, background loser bound, local fallback, immutable status publication, per-channel queues, and restartable generation ownership.
- `src/whisper-engine.js` — runtime/model inspection, checksum error classification, transcriber lifecycle, request pairing, queue/timeout bounds, and observer isolation.
- `src/local-whisper-transcriber.js` — optional direct request IDs propagated through transcript/error callbacks without changing legacy streaming calls.
- `test/local-stt-manager.test.js` — zero/one/two-engine selection, cache health and shape, race/cap/timing, fallback, statuses, coalescing, queues, stop invalidation, and cancellation-ignoring startup coverage.
- `test/whisper-engine.test.js` — runtime/model integrity, packaged/prepared metadata, request pairing, cross-delivery prevention, per-channel serialization, lifecycle generations, bounds, observer isolation, and bounded stop coverage.
- `test/local-whisper-transcriber.test.js` — direct request transcript/error ID regression coverage.

## TDD and verification

- Baseline before edits: `npm test` — 308 passed, 0 failed.
- Each behavior was introduced with a focused failing test and then made green.
- Focused integration: `node --test test/local-stt-manager.test.js test/whisper-engine.test.js test/local-whisper-transcriber.test.js` — 43 passed, 0 failed.
- Complete suite: `npm test` — 346 passed, 0 failed.
- Syntax: `node --check` on all three production files and both new primary test files.
- Diff hygiene: `git diff --check`.
- Open-handle check: focused tests exited normally under an external five-second child-process bound.

## Preservation and concerns

- The pre-existing user-owned `package-lock.json` modification was not edited or staged.
- The three competitor-audit extraction files (`index.cjs`, `index.js`, and `main-CLCIkAdW.js`) were not edited or staged.
- Task 3 deliberately does not wire the new manager into `main.js`; integration belongs to the later plan task that owns main-process routing.
