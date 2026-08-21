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
