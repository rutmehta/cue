# macOS releases

Cue embeds Sparkle 2 through a small Node-API Objective-C++ bridge in Electron's main process. Sparkle owns the update UI, validates the signed feed and archive, and replaces/relaunches `com.cue.overlay`. The Cue tray menu exposes **Check for Updates…**. Checks are automatic; installation requires the user's choice. Development builds and other platforms do not load Sparkle.

The stable feed is `https://github.com/rutmehta/cue/releases/latest/download/appcast.xml`. Every macOS release must attach this filename, both architecture archives, and SHA256SUMS before becoming the latest release. Do not mark an unrelated release as latest without that feed. Signing configuration and the pinned Sparkle archive checksum live in `build-resources/sparkle.json`. The Ed25519 private key lives in macOS Keychain under account `cue`; never commit or print it.

## Build

1. Update the version in `package.json` and the root entries in `package-lock.json`. Add `docs/releases/<version>.html`.
2. Use macOS with Node headers, Xcode command-line tools, the Developer ID certificate, and a valid `notarytool` Keychain profile. `CUE_NODE_HEADERS` can override header discovery. Apple Silicon builds include the native FluidAudio helper; Intel builds omit it. Model weights remain user-managed.
3. Run `CUE_NOTARY_PROFILE=<profile> npm run release:mac`. `CUE_SIGN_IDENTITY` overrides the default Developer ID identity. This runs tests, builds both architectures, signs nested components inside-out, notarizes each app, staples and validates its ticket, runs Gatekeeper, creates archives, and uses Sparkle's `sign_update` to sign both archives and the combined feed. Archive signatures are also independently verified against Cue's public key. The feed lists Apple Silicon first (with an arm64 hardware requirement) and Intel second because `generate_appcast` rejects same-version archives in one directory. Sparkle picks the first compatible item; this also moves Rosetta installations to native Apple Silicon builds.
4. Inspect `dist/release-<version>/`. Each notarization JSON must report `Accepted`. Do not modify any archive after generating the appcast. The script refuses to overwrite an existing release directory.
5. Commit the exact released source, push it to your fork, and create/push `v<version>`. The fork's legacy tag workflow is disabled to avoid publishing unverified assets or racing the signed feed.
6. Create a draft GitHub release for that tag; upload both `.zip` files, `appcast.xml`, and `SHA256SUMS`. Publish the draft as latest only when all files are attached.
7. Download the public archives, check their hashes, extract the app, and verify `codesign --verify --deep --strict`, `xcrun stapler validate`, and `spctl --assess --type execute`. Run `Cue.app/Contents/MacOS/cue --cue-update-probe -SUEnableAutomaticChecks NO` to check the actual signed public feed without starting audio or opening permissions windows. It prints `CUE_UPDATE_PROBE` with `up-to-date` or `available`, and fails on a network/configuration/signature error.

For upgrade validation, use an isolated copy with a lower bundle version and the same signing identity/feed/key. Use the native Check for Updates UI and verify the replaced app's version, signature, and relaunch. Never change the version of the distributed archive after signing its feed.

Existing versions before 0.3.0 have no updater and require one manual installation. Keep bundle ID, feed URL, and Ed25519 public-key continuity in subsequent releases. Sparkle source and integration docs: https://sparkle-project.org/documentation/ .
