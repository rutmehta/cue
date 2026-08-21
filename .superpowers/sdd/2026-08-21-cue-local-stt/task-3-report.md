# Task 3 report: Auto manager and Whisper adapter

## Outcome

Implemented a dependency-injected local STT manager that supports only Parakeet and Whisper, selects the sole healthy engine, uses an exact health-bound benchmark cache, races an uncached first utterance, and performs one visible local-to-local retry for uncommitted segments. No cloud provider or cloud fallback dependency exists in the manager or adapter. Review hardening added a shared initial-benchmark selection, generation-owned queues and startup ownership, cancellation-bounded late cleanup, hallucination-safe default validation, and truthful fallback/error snapshots.

Implemented a Whisper engine adapter that combines runtime discovery with mandatory model checksum verification, creates one `LocalWhisperTranscriber` per lifecycle generation, pairs direct requests by unique IDs, serializes requests per channel, bounds inputs/queues/timeouts/stops, and invalidates late callbacks safely. The existing streaming `LocalWhisperTranscriber` API remains compatible; an optional direct request ID bypasses segmentation for already-formed manager segments. Direct empty results now complete their matching request, and a public timeout retains wrapper capacity until the lower-level request terminates or the generation is stopped.

## Review fix loop

- Simultaneous mic/system work now shares one first-utterance Auto benchmark; later work waits on the shared engine-selection promise instead of failing with `not_started`.
- Manager jobs, channel tails, started engines, and starting engines are generation-owned. Stop abandons the old queue immediately, rejects its public jobs once, races startup against cancellation, and bounds both the immediate stop and any required late-success cleanup.
- Benchmark response selection remains first-valid for latency, while the persisted winner is the valid engine with the lowest finite elapsed value. Ties use deterministic engine order. Cache outcomes use strict `{ status, value }` tags for `valid`, `invalid`, `error`, and `timeout`, and the validator recomputes the deterministic winner before accepting a record.
- Fallback snapshots keep `activeEngine` null until the alternate has actually started, and alternate startup or inference failure ends with an explicit null active engine.
- Stop during inspection/start leaves `off` as the cancelled generation's final status. A restart uses a new manager queue/start promise, and Whisper startup also detaches from a cancellation-ignoring stale start.
- The manager's default validity predicate reuses `looksLikeHallucination`; known silence artifacts cannot win a benchmark or suppress local fallback.

## Files

- `src/local-stt-manager.js` — Auto/explicit selection, deterministic tagged cache validation, first-response versus fastest-cache benchmark selection, local fallback, immutable status publication, and generation-owned queues/startups.
- `src/whisper-engine.js` — runtime/model inspection, checksum error classification, transcriber lifecycle, request pairing, retained lower-terminal timeout capacity, and observer isolation.
- `src/local-whisper-transcriber.js` — optional direct request IDs propagated through transcript/error callbacks, including empty direct results, without changing legacy segmented behavior.
- `test/local-stt-manager.test.js` — simultaneous first-benchmark work, fastest/invalid/tie/error/timeout cache outcomes, truthful fallback statuses, hallucinations, abandoned queues, stale inspections, and bounded cancellation-ignoring startup coverage.
- `test/whisper-engine.test.js` — runtime/model integrity, request pairing, per-channel serialization, repeated retained-capacity timeouts, stale-start detachment, observer isolation, and bounded stop coverage.
- `test/local-whisper-transcriber.test.js` — direct request transcript/error/empty-result regression coverage.

## TDD and verification

- Baseline before edits: `npm test` — 308 passed, 0 failed.
- Each behavior was introduced with a focused failing test and then made green.
- Review baseline: `npm test` — 346 passed, 0 failed.
- Focused integration: `node --test test/local-stt-manager.test.js test/whisper-engine.test.js test/local-whisper-transcriber.test.js` — 58 passed, 0 failed.
- Complete suite: `npm test` — 361 passed, 0 failed.
- Syntax: `node --check` on all three production files and all three focused test files.
- Diff hygiene: `git diff --check`.
- Open-handle check: the 58 focused tests exited normally under an external five-second child-process watchdog.

## Preservation and concerns

- The pre-existing user-owned `package-lock.json` modification was not edited or staged.
- The three competitor-audit extraction files (`index.cjs`, `index.js`, and `main-CLCIkAdW.js`) were not edited or staged.
- Task 3 deliberately does not wire the new manager into `main.js`; integration belongs to the later plan task that owns main-process routing.
