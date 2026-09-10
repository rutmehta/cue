# Local speech on Apple Silicon

Cue's helper loads the Parakeet TDT v2 Core ML model already downloaded by SpeakType / FluidAudio:

`~/Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v2`

It reuses those model files, not SpeakType's running process. No local API server is required. The helper stays loaded while Cue is listening and handles both microphone and system audio through stdin/stdout. It calls the offline `AsrModels.load` API; it does not download a model or call a hosted transcription service.

Run `npm run prepare:local-speech` to compile the helper with Xcode's Swift toolchain. `npm run pack` and the macOS distribution scripts do this automatically. The build pins FluidAudio 0.15.6, includes its resource bundle and license, and emits the helper under `native/bin/` for packaging. Generated binaries and Swift build caches are ignored by Git.

The request protocol is one JSON object per line with an integer `id` and base64 `pcm` containing mono 16 kHz little-endian PCM16, at most 30 seconds. The helper emits `{"ready":true}` after loading, then `{ "id": ..., "text": ... }` or `{ "id": ..., "error": ... }` for each request. It exits on EOF. Models remain separate from the application bundle and are never modified by Cue.

Transcription uses a separate decoder state per request. Cue's utterance segmenter keeps capture continuous and emits replaceable previews during speech. Completed utterances remain in the transcript. The JavaScript bridge enforces input limits, bounded requests, readiness and transcription timeouts, and child-process cleanup.

On other platforms, the existing ONNX Parakeet / whisper.cpp engines remain available. Local mode never silently falls back to paid cloud transcription. Answer generation still uses the separately configured LLM provider.
