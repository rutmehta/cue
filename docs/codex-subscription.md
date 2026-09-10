# Codex subscription answers

Choose **Settings → Models → Codex subscription**. Cue uses the installed Codex CLI's managed ChatGPT sign-in. If disconnected, choose **Sign in with ChatGPT** and complete the browser flow. Cue does not copy Codex tokens into its settings or use the platform API key for this provider.

The `auto` model uses the account's default from Codex's live catalog. Fast uses low reasoning effort when supported; Quality uses the model's default effort. The model fields suggest available model IDs. Usage counts against the signed-in account's Codex allowance. There is no automatic API-provider fallback, credit purchase, or usage-reset redemption.

Each answer runs in an ephemeral Codex thread. Cue supplies the conversation prompt and, when screen capture is enabled and permitted, a screenshot. Shell, browser, app/plugin tools, inherited MCP servers, and environment access are disabled for these requests. Authentication and token refresh remain Codex's responsibility. The local CLI/application is a prerequisite; it is not bundled in Cue.

Local Parakeet transcription is independent of the answer provider and remains free of cloud transcription charges.

## Keyboard control

Press **Command + backslash (⌘\)** on macOS, or **Ctrl + backslash** elsewhere, to hide or bring back Cue from another application. Hiding does not stop listening or clear the answer. The shortcut also appears in the window-options menu. If another application owns the binding, Cue records a shortcut-unavailable diagnostic; the tray can still restore the overlay.

## Verification

The integration includes protocol tests for subscription-only authentication, streaming context, inherited-server isolation, timeout/exit cleanup, and active-stream liveness. On September 10, 2026, the installed macOS app rendered a real answer using an existing ChatGPT Pro sign-in. The global shortcut was verified through an offscreen → onscreen transition while Finder was active.

References: [Codex app server](https://learn.chatgpt.com/docs/app-server), [authentication](https://learn.chatgpt.com/docs/auth).
