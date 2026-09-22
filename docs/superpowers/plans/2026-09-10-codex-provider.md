# Codex subscription provider implementation plan

Approved design: use the local Codex app-server and its managed ChatGPT authentication for Cue answers, with no paid API fallback or agent tools. Keep local Parakeet transcription unchanged. User additionally requested hide/show and ongoing GitHub checkpoints.

## Constraints

- Work on existing `codex/cue-rebuild`; preserve unrelated user changes.
- Push tested checkpoints to `fork` (rutmehta/cue), not upstream `origin`.
- Never read, copy, log, or commit authentication tokens. Codex owns authentication.
- Only explicit answer requests consume subscription usage. No purchases or automatic resets.

## Execution

- [ ] Adapter: write failing protocol tests for ChatGPT-only auth, model selection, streaming, error/exit/timeout cleanup, and disabled tool access. Implement `src/codex-provider.js` using JSON-RPC over a private child process's stdio. Discover executable from installed Codex locations. Check `account/read`, enumerate `model/list`, start ephemeral threads with no environments/tools, and map answer deltas/completion into Cue's streaming interface. Reject API-key authentication and server tool requests.
- [ ] Integration: test that `createLLM` accepts Codex without an API key. Add Codex settings, a managed browser-login button and connection status through narrow IPC endpoints. Retain all existing API keys and providers. Auto/default model selection must come from the live catalog; low effort for Fast and default effort for Quality.
- [ ] Shortcut: retain existing global CommandOrControl+Backslash toggle and lifecycle recovery behavior. Add the accelerator to the visible Hide control; verify hide then restore from outside Cue.
- [ ] Run targeted and full tests, live subscription streaming and failure checks. Install only verified source into the existing signed app; verify signature and visible answer output. Commit and push explicit source/test/docs paths, excluding generated binaries and user-owned root files/package-lock.json.

Live checks must include actual rendered answer text, not only a connected badge. If an OS login is required, hand browser authentication to the user.
