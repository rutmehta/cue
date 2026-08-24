# Task 5 report: renderer capture and main integration

## Outcome

- Added stateful measured-rate resampling and PCM16 conversion for microphone and system audio.
- Added one idempotent two-source renderer capture controller with duplicate-start joining, late-work invalidation, and cleanup.
- Replaced the Whisper-only main path with one `LocalSttManager` containing Parakeet and Whisper plus per-source utterance segmentation.
- Added a dedicated source PCM IPC contract and removed the legacy mic/system PCM channels.
- Fresh installs now default to local `auto`, selecting the fastest healthy installed local engine without cloud fallback.
- Added deterministic Parakeet runtime identity so benchmark cache records can be reused.

## TDD and verification

- New capture, resampling, integration, IPC, default-selection, and runtime-identity tests were observed failing before implementation.
- Focused integration suite: 42/42 passed.
- Full suite: 373/373 passed.
- Syntax checks and `git diff --check`: passed.

## Remaining verification

- Real installed-machine microphone/system-audio and Parakeet sidecar smoke tests remain in Task 6.
