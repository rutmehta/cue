# Screen-aware webcam overlay

Approved by user: translucent top-center near webcam, fresh screen context for answers, restrained adaptive placement, stable while reading. Keep Command-period as the global toggle and push tested checkpoints to rutmehta/cue, codex/cue-rebuild.

## Design

One translucent reading surface, not multiple glass cards. Native system text at 21–23px with short lines. Light palette: paper #f6f7f8, ink #18222b, muted #5e6b75. Dark palette: paper #24282c, ink #f0f2f4. Surface alpha adjustable; text remains fully opaque. Menus/settings remain solid for usability. Default frame 600×410 near the primary display's top-center; compact output reduces vertical gaze movement.

Placement analysis is local and heuristic: estimate edge density from a small screenshot bitmap, score nearby top-center candidates, and select a materially less busy region without moving far from the camera. It does not claim semantic understanding of important content. No background screenshot loop and no separate model request. The same fresh image is supplied to the answer model. Move once before generation; never on tokens or while reading. User dragging switches to manual placement; a menu action restores webcam anchoring.

## Tasks

- [x] Test and implement pure `src/overlay-layout.js`: on-screen camera bounds, density-based placement with bounded shifts, size caps, invalid image handling, stable choice on uniform images. Inputs are display bounds and a BGRA bitmap; no disk image persistence.
- [x] Extend `src/screen.js` to capture the requested display and return the fresh image plus local bitmap analysis, preserving the existing screenshot API. Test source/display matching and missing-source failure without substituting the wrong screen.
- [x] Integrate one-time layout at request start in `main.js`. Default fresh screen context for answer requests; maintain explicit permission/off status and provide a screen-context toggle. Keep request context metadata truthful. Manual position lock and camera reset must have explicit UI controls.
- [x] Apply translucent single-surface CSS, adjustable opacity, smaller initial frame, and readable focus states. Verify UI over light and dense backgrounds in the synthetic preview without disabling production capture protection.
- [x] Run full tests, install with the matching existing Apple Development identity, verify strict/deep AND designated requirement checks, then verify a real screen-aware answer. Commit/push only own source/test/docs changes. Preserve unrelated package-lock and root generated files.

## Verified result

415 tests pass. Compact controls fit at 520×320; the translucent 600×410 preview was inspected over a dense background. Installed app launched at 600×410, x=728/y=48. Matching Apple Development signature passed strict/deep and designated-requirement verification. A live Codex request showed Screen attached and returned a screenshot-aware answer. Screen-context toggle verified off and restored on. Review regressions cover opt-out during capture, new-chat cancellation, and truthful missing-image prompt metadata. Physical Command-period keypress remains awaiting user confirmation; shortcut registration is verified.
