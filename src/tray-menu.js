function noOp() {}

function action(actions, name) {
  const camelCase = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  return actions[name] || actions[camelCase] || noOp;
}

function sessionPhase(snapshot) {
  return snapshot && snapshot.session && snapshot.session.phase;
}

function snapshotKey(snapshot) {
  return `${sessionPhase(snapshot) || 'none'}:${Boolean(snapshot?.overlay?.visible)}`;
}

function buildTrayTemplate(snapshot = {}, actions = {}) {
  const phase = sessionPhase(snapshot);
  const overlayVisible = Boolean(snapshot.overlay && snapshot.overlay.visible);
  const sessionAction = phase === 'listening'
    ? { label: 'Pause Listening', click: action(actions, 'pause') }
    : phase === 'paused'
      ? { label: 'Resume Listening', click: action(actions, 'resume') }
      : { label: 'Start Listening', click: action(actions, 'start') };

  return [
    overlayVisible
      ? { label: 'Hide Cue', click: action(actions, 'hide') }
      : { label: 'Show Cue', click: action(actions, 'show') },
    sessionAction,
    { label: 'End Session', click: action(actions, 'end-session') },
    { label: 'Unlock Interaction', click: action(actions, 'unlock') },
    { label: 'Recenter Overlay', click: action(actions, 'recenter') },
    { label: 'Settings', click: action(actions, 'settings') },
    ...(typeof actions.checkForUpdates === 'function' ? [{ label: 'Check for Updates…', click: actions.checkForUpdates }] : []),
    { label: 'Quit Cue', click: action(actions, 'quit') }
  ];
}

function createTrayController(dependencies = {}) {
  const { Tray, Menu, icon, command = noOp, sessionController } = dependencies;
  if (typeof Tray !== 'function') {
    throw new TypeError('A Tray constructor must be provided.');
  }
  if (!Menu || typeof Menu.buildFromTemplate !== 'function') {
    throw new TypeError('A Menu adapter with buildFromTemplate() must be provided.');
  }
  if (typeof command !== 'function') {
    throw new TypeError('A tray command handler must be a function.');
  }

  const tray = new Tray(icon);
  if (dependencies.title && typeof tray.setTitle === 'function') tray.setTitle(dependencies.title);
  if (dependencies.tooltip && typeof tray.setToolTip === 'function') tray.setToolTip(dependencies.tooltip);
  const getSnapshot = dependencies.getSnapshot
    || (sessionController && sessionController.getSnapshot && sessionController.getSnapshot.bind(sessionController))
    || (() => ({}));
  let destroyed = false;
  let currentSnapshotKey = Symbol('no-snapshot');
  let unsubscribe = noOp;

  function dispatch(name) {
    try {
      return Promise.resolve(command(name)).catch(noOp);
    } catch {
      return Promise.resolve();
    }
  }

  function update(snapshot = getSnapshot()) {
    const nextKey = snapshotKey(snapshot);
    if (destroyed || nextKey === currentSnapshotKey) return false;
    const template = buildTrayTemplate(snapshot, {
      show: () => dispatch('show'),
      hide: () => dispatch('hide'),
      start: () => dispatch('start'),
      pause: () => dispatch('pause'),
      resume: () => dispatch('resume'),
      'end-session': () => dispatch('end-session'),
      unlock: () => dispatch('unlock'),
      recenter: () => dispatch('recenter'),
      settings: () => dispatch('settings'),
      checkForUpdates: dependencies.checkForUpdates,
      quit: () => dispatch('quit')
    });
    tray.setContextMenu(Menu.buildFromTemplate(template));
    currentSnapshotKey = nextKey;
    return true;
  }

  update();
  if (sessionController && typeof sessionController.subscribe === 'function') {
    unsubscribe = sessionController.subscribe(update) || noOp;
  } else if (typeof dependencies.subscribe === 'function') {
    unsubscribe = dependencies.subscribe(update) || noOp;
  }
  if (typeof tray.on === 'function') {
    tray.on('double-click', () => dispatch('show'));
  }

  return {
    tray,
    update,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try {
        Promise.resolve(unsubscribe()).catch(noOp);
      } catch {
        // Destroying the tray remains mandatory when subscriber cleanup fails.
      } finally {
        if (typeof tray.destroy === 'function') tray.destroy();
      }
    }
  };
}

module.exports = {
  buildTrayTemplate,
  createTrayController
};
