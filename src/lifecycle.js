const COMMAND_ACTIONS = Object.freeze({
  show: 'showOverlay',
  hide: 'hideOverlay',
  collapse: 'collapseOverlay',
  start: 'startSession',
  pause: 'pauseSession',
  resume: 'resumeSession',
  'end-session': 'stopSession',
  unlock: 'unlockInteraction',
  recenter: 'recenterOverlay',
  settings: 'openSettings'
});

const DEFAULT_QUIT_TIMEOUT_MS = 5_000;

function noOp() {}

function invoke(action) {
  return Promise.resolve().then(action);
}

function ignoreFailure(action) {
  try {
    Promise.resolve(action()).catch(noOp);
  } catch {
    // Quit must complete its remaining cleanup even when one step fails.
  }
}

function createLifecycleCoordinator(dependencies = {}) {
  const {
    platform = process.platform,
    trayEnabled = false,
    timeoutMs = DEFAULT_QUIT_TIMEOUT_MS,
    setTimeout: scheduleTimeout = setTimeout,
    clearTimeout: cancelTimeout = clearTimeout
  } = dependencies;
  let quitPromise = null;

  function actionFor(command) {
    return dependencies[COMMAND_ACTIONS[command]] || noOp;
  }

  async function awaitStopOperations() {
    const stopOperations = [
      invoke(dependencies.stopSession || noOp),
      invoke(dependencies.stopLocalEngines || noOp)
    ];
    let timeoutId;
    const timeout = new Promise((resolve) => {
      timeoutId = scheduleTimeout(resolve, timeoutMs);
    });

    try {
      await Promise.race([Promise.allSettled(stopOperations), timeout]);
    } finally {
      cancelTimeout(timeoutId);
    }
  }

  async function quit() {
    await awaitStopOperations();
    ignoreFailure(dependencies.cancelDownloads || noOp);
    ignoreFailure(dependencies.unregisterShortcuts || noOp);
    ignoreFailure(dependencies.destroyWindowsAndTray || noOp);
    ignoreFailure(dependencies.exit || noOp);
  }

  function command(name) {
    if (name === 'quit') {
      if (!quitPromise) quitPromise = quit();
      return quitPromise;
    }
    if (!Object.hasOwn(COMMAND_ACTIONS, name)) {
      return Promise.reject(new TypeError(`Unknown lifecycle command: ${String(name)}`));
    }
    return invoke(actionFor(name));
  }

  return {
    command,
    closeDecision: () => (platform === 'darwin' || trayEnabled ? 'hide' : 'quit')
  };
}

function decideWindowClose(platform, coordinator) {
  if (coordinator && typeof coordinator.closeDecision === 'function') {
    return coordinator.closeDecision();
  }
  return platform === 'darwin' ? 'hide' : 'quit';
}

module.exports = {
  DEFAULT_QUIT_TIMEOUT_MS,
  createLifecycleCoordinator,
  decideWindowClose
};
