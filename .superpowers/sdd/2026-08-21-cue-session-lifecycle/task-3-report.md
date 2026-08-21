# Task 3: Lifecycle decisions and tray recovery

## Scope

Implemented the task-owned lifecycle coordinator and tray controller without importing Electron directly. Both modules accept adapters at their boundaries.

## RED evidence

Command:

```sh
node --test test/lifecycle.test.js test/tray-menu.test.js
```

Result before implementation: exit 1. The suites failed because `../src/lifecycle` and `../src/tray-menu` did not exist (`MODULE_NOT_FOUND`).

## GREEN evidence

Command:

```sh
node --test test/lifecycle.test.js test/tray-menu.test.js
```

Result after implementation: 12 passed, 0 failed.

The focused coverage verifies:

- exact lifecycle command routing and unknown-command `TypeError` rejection;
- distinct hide, end-session, close, and quit behavior;
- one shared concurrent quit promise, parallel bounded stop operations, and teardown after rejected or hung cleanup;
- phase-sensitive tray labels, recovery actions, command routing, double-click show, menu refreshes, single Tray creation, and idempotent destruction.

## Full verification

Commands:

```sh
npm test
node --check src/lifecycle.js
node --check src/tray-menu.js
git diff --check -- src/lifecycle.js src/tray-menu.js test/lifecycle.test.js test/tray-menu.test.js
```

Results:

- `npm test`: 162 passed, 0 failed.
- Both syntax checks exited 0.
- The whitespace check produced no findings.

## Changed files

- `src/lifecycle.js`
- `src/tray-menu.js`
- `test/lifecycle.test.js`
- `test/tray-menu.test.js`
- `.superpowers/sdd/2026-08-21-cue-session-lifecycle/task-3-report.md`

## Self-review

- `command()` accepts only the specified eleven commands; all non-quit commands delegate through an injected action and unknown commands reject with `TypeError`.
- `end-session` invokes its stop action per command. `quit` memoizes one promise, launches session/local-engine stop concurrently, bounds that pair with one injectable 5-second timer, then invokes every remaining teardown even if another cleanup rejects or never settles.
- Close chooses hide on macOS and any tray-backed platform; Windows/Linux without a tray choose quit.
- The tray menu uses only injected `Tray`/`Menu` adapters, routes each menu and double-click action to `command()`, starts with a recovery menu, refreshes on session phase changes, and destroys exactly once.

## Concerns

None. Post-stop cleanup is deliberately invoked without awaiting arbitrary promises so a hung cancellation cannot prevent destruction and exit; this is covered by a deterministic test.
