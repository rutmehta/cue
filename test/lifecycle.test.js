const assert = require('node:assert/strict');
const test = require('node:test');

const { createLifecycleCoordinator } = require('../src/lifecycle');

test('hide keeps capture running, end stops it, and quit cleans up once', async () => {
  const calls = [];
  const lifecycle = createLifecycleCoordinator({
    platform: 'darwin',
    hideOverlay: () => calls.push('hide'),
    stopSession: async () => calls.push('stop-session'),
    stopLocalEngines: async () => calls.push('stop-engines'),
    cancelDownloads: () => calls.push('cancel-downloads'),
    unregisterShortcuts: () => calls.push('unregister'),
    destroyWindowsAndTray: () => calls.push('destroy'),
    exit: () => calls.push('exit')
  });

  await lifecycle.command('hide');
  await lifecycle.command('end-session');
  await Promise.all([lifecycle.command('quit'), lifecycle.command('quit')]);

  assert.deepEqual(calls, [
    'hide',
    'stop-session',
    'stop-session',
    'stop-engines',
    'cancel-downloads',
    'unregister',
    'destroy',
    'exit'
  ]);
});

test('window close maps to hide on every tray-backed platform', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const lifecycle = createLifecycleCoordinator({ platform, trayEnabled: true });
    assert.equal(lifecycle.closeDecision(), 'hide');
  }
});

test('window close quits only when a non-macOS app has no tray recovery', () => {
  assert.equal(createLifecycleCoordinator({ platform: 'darwin', trayEnabled: false }).closeDecision(), 'hide');
  assert.equal(createLifecycleCoordinator({ platform: 'win32', trayEnabled: false }).closeDecision(), 'quit');
  assert.equal(createLifecycleCoordinator({ platform: 'linux', trayEnabled: false }).closeDecision(), 'quit');
});

test('routes each accepted command to its distinct injected action', async () => {
  const calls = [];
  const lifecycle = createLifecycleCoordinator({
    showOverlay: () => calls.push('show'),
    hideOverlay: () => calls.push('hide'),
    collapseOverlay: () => calls.push('collapse'),
    startSession: () => calls.push('start'),
    pauseSession: () => calls.push('pause'),
    resumeSession: () => calls.push('resume'),
    stopSession: () => calls.push('end'),
    unlockInteraction: () => calls.push('unlock'),
    recenterOverlay: () => calls.push('recenter'),
    openSettings: () => calls.push('settings')
  });

  for (const command of ['show', 'hide', 'collapse', 'start', 'pause', 'resume', 'end-session', 'unlock', 'recenter', 'settings']) {
    await lifecycle.command(command);
  }

  assert.deepEqual(calls, ['show', 'hide', 'collapse', 'start', 'pause', 'resume', 'end', 'unlock', 'recenter', 'settings']);
});

test('rejects every unknown lifecycle command with TypeError', async () => {
  const lifecycle = createLifecycleCoordinator();

  await assert.rejects(lifecycle.command('toggle'), TypeError);
});

test('quit continues cleanup after a rejected or timed-out stop under one injected bound', async () => {
  const calls = [];
  let timeoutCallback;
  const lifecycle = createLifecycleCoordinator({
    stopSession: async () => {
      calls.push('stop-session');
      throw new Error('capture stopped badly');
    },
    stopLocalEngines: () => {
      calls.push('stop-engines');
      return new Promise(() => {});
    },
    cancelDownloads: () => calls.push('cancel-downloads'),
    unregisterShortcuts: () => calls.push('unregister'),
    destroyWindowsAndTray: () => calls.push('destroy'),
    exit: () => calls.push('exit'),
    setTimeout: (callback, delay) => {
      assert.equal(delay, 5_000);
      timeoutCallback = callback;
      return 1;
    },
    clearTimeout: (timer) => assert.equal(timer, 1)
  });

  const quitting = lifecycle.command('quit');
  await Promise.resolve();
  timeoutCallback();
  await quitting;

  assert.deepEqual(calls, ['stop-session', 'stop-engines', 'cancel-downloads', 'unregister', 'destroy', 'exit']);
});

test('quit invokes remaining teardown even when a post-stop cleanup never settles', async () => {
  const calls = [];
  const lifecycle = createLifecycleCoordinator({
    cancelDownloads: () => new Promise(() => {}),
    unregisterShortcuts: () => calls.push('unregister'),
    destroyWindowsAndTray: () => calls.push('destroy'),
    exit: () => calls.push('exit')
  });

  lifecycle.command('quit');
  await new Promise(setImmediate);

  assert.deepEqual(calls, ['unregister', 'destroy', 'exit']);
});
