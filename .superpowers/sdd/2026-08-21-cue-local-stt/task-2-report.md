# Task 2 report — Parakeet sidecar and WebSocket protocol

## Delivered

- Added `ParakeetTranscriber` with normalized Task 1 inspection, bounded loopback-port startup, exact sherpa-onnx arguments, chunk-safe readiness parsing, restartable lifecycle generations, and failure-safe status observation.
- Added exact PCM16-to-float32 conversion and sherpa offline binary framing with bounded typed-input and sample-rate validation.
- Added independent per-channel queues: work is serialized within a channel while microphone and system requests can run concurrently.
- Added one-WebSocket-per-request transcription with binary send, JSON or trimmed-text result accumulation, literal `Done`, close-only success, stable protocol/timeout errors, listener cleanup, and duration-derived bounded timeouts.
- Added idempotent bounded shutdown that rejects queued/active work, closes sockets, signals only the owned child/process group with `SIGTERM`, and escalates to `SIGKILL` after two seconds when required.

## TDD and verification

- Initial RED: `node --test test/parakeet-transcriber.test.js` failed with `MODULE_NOT_FOUND` before production code existed.
- Additional RED cycles covered long chunked readiness output, rejected status-observer thenables, malformed-JSON fallback, retained ownership after a child process error, numeric CPU/Windows semantics, restartable port errors, a never-settling process stopper, and persistent readiness-timeout diagnostics.
- Focused suite: `node --test test/parakeet-transcriber.test.js` passes 29/29 and exits naturally.
- Full suite: `npm test` passes 283/283 and exits naturally.
- `node --check` passes for both source and test files.
- Whitespace/diff checks pass for both new files.

## Scope and concerns

- Changes are limited to Task 2's source, test, and report files.
- The existing `package-lock.json` modification and untracked audit extraction files were not modified or staged.
- OpenWhispr assets remain read-only; the adapter launches its own detached child in a temporary-directory cwd and only signals that owned child/process group.
- Transcription timeout is bounded to 10–120 seconds, with the value inside that range computed as four times audio duration.
- No remaining implementation concerns identified for this task.

## Review Round 1

- Reworked WebSocket aborts around terminal state: CONNECTING sockets retain their error sink through `close`, while established/closing sockets use forced termination. Real local `ws` subprocess tests under strict unhandled-rejection mode verify both CONNECTING abort and an OPEN peer that ignores the close handshake release their TCP handles.
- Added explicit owned-child records. A process `error` before or after readiness now starts bounded TERM/KILL cleanup, removes functional listeners, and makes restart join that cleanup. If an injected stopper throws or never settles, the child remains tracked by terminal-only listeners until its actual exit and cannot be confused with an unrelated process.
- Bounded audio to 30 seconds, matching the planned at-most-25-second segmentation contract. Inference timeout is now exactly `max(10 seconds, audio duration × 4)` with no independent cap.
- Bounded each channel by active-plus-pending count and retained frame bytes. Added stable `engine_overloaded` rejection, a one-megabyte WebSocket `maxPayload`/aggregate-result bound, and a 64-message result bound.
- Installed the generation's deferred start promise before publishing `starting`, so reentrant observers and concurrent callers join the same generation.
- Deep-froze the retained normalized inspection and return fresh normalized clones. Status payloads are deep-cloned and frozen independently per observer.
- RED verification reproduced every review finding before its fix, including the real `ws` uncaught CONNECTING error and retained OPEN TCP peer.
- Post-review verification: 40 focused tests and 294 full-suite tests pass; syntax, diff, and natural-exit checks pass.

## Review Round 2

- Spawn ownership is now recorded immediately when the returned value has a positive PID, a kill method, or live-process evidence. Missing pipe/event shapes, ownership-listener failures, and readiness-listener failures all join bounded TERM/KILL disposal before start rejection or replacement spawn; known terminal children also release their ownership-only listeners.
- No-argument `start()` now installs one generation and its deferred promise before publishing `starting` or invoking asynchronous inspection. Reentrant and concurrent callers join that exact promise through delayed inspection, inspection failure, and spawn failure, while a later retry creates exactly one fresh generation.
- Audio duration is classified from validated view metadata before byte conversion or the absolute backing-size check. Inputs beyond 30 seconds, including 192 kHz at 30 seconds plus one sample, return `audio_too_large`; public conversion/framing and sample-rate failures return stable `invalid_audio` and `invalid_sample_rate` `LocalSttError`s.
- Retained inspection and per-observer status clones now use own data-property definitions for every object key and array index. RED probes installed inherited Object and Array setters from status observers and confirmed that neither retained state nor another observer's snapshot can be intercepted.
- Each review residual was reproduced with a focused RED regression before its implementation. The malformed registration case additionally verifies the exact 2,000 ms TERM-to-KILL boundary and listener release without allocating a maximum-size audio buffer.
- Post-review verification: 50 focused tests, 304 full-suite tests, and 2 isolated real-`ws` strict subprocess tests pass and exit naturally. Source/test syntax checks and `git diff --check` pass, with no retained WebSocket TCP handles or test timers.

## Review Round 3

- Tightened child terminal evidence so only finite, nonnegative integer exit codes or signal names recognized by the host are terminal. `NaN`, infinity, negative, fractional, and fabricated-signal values remain owned through the exact bounded TERM/KILL sequence before a replacement generation may spawn; valid zero/nonzero exit codes release ownership without signaling.
- Preserved the exact standard-array `length` during frozen status cloning by defining the clone's own length before copying enumerable indices and properties. Dense arrays, fully sparse `Array(3)` values, trailing holes, and enumerable non-index properties now retain their native key, hole, JSON, and freezing semantics without inherited-setter writes.
- Both residuals were reproduced as focused RED failures before their minimal fixes. The terminal matrix exercises cleanup, listener release, and successful restart for every malformed numeric value.
- Post-review verification: 54 focused tests and 308 full-suite tests pass and exit naturally; isolated real-`ws`, syntax, and diff checks also pass.
