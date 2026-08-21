# Task 1 report — Local-engine contract and Parakeet discovery

## Delivered

- Added the common local-STT inspection contract and structured `LocalSttError`.
- Added read-only Parakeet runtime/model discovery with environment, Cue bundle/cache, and Darwin OpenWhispr precedence.
- Validated runtime file/executable status and all required model files without throwing for ordinary unhealthy states.
- Added deterministic SHA-256 fingerprints from required-file path, size, and mtime metadata only.
- Added the sherpa-onnx argument builder.

## Verification

- RED: `node --test test/local-stt-engine.test.js test/parakeet-runtime.test.js` failed before the modules existed.
- GREEN: focused suite passes with 11 tests.
- Full suite: `npm test` passes with 239 tests.
- Default inspection on this Mac found OpenWhispr's compatible runtime and cached `parakeet-tdt-0.6b-v3` model.

## Scope and concerns

- Changes are limited to Task 1's source, test, and report files.
- Discovery performs only filesystem metadata/access reads; it does not write, copy, or modify OpenWhispr assets.
- No remaining implementation concerns identified for this task.

## Review Round 1

- Normalized `LocalSttError` instances and compatible error objects into plain, IPC-safe `{ code, message, action, details? }` records at the inspection boundary.
- Error details are JSON-normalized so the inspection result also survives Electron-style structured cloning.
- Supplied `healthy` values must be booleans; supplied `errors` values must be arrays whose entries carry string code, message, and action fields. Malformed input is rejected by normalization and therefore cannot be selected by `isHealthyInspection`.
- RED verification: serialization and malformed-field matrix tests failed before the contract hardening.
- Post-review verification: 13 focused tests and 241 full-suite tests pass.
