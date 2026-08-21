'use strict';

const IPC_INVOKES = Object.freeze({
  sessionGetSnapshot: 'session:get-snapshot',
  sessionCommand: 'session:command',
  windowCommand: 'window:command',
  settingsOpen: 'settings:open',
  captureProtection: 'capture:protection'
});

const IPC_EVENTS = Object.freeze({
  sessionSnapshot: 'session:snapshot'
});

const IPC_SENDS = Object.freeze({
  sourceUpdate: 'session:source-update'
});

module.exports = { IPC_EVENTS, IPC_INVOKES, IPC_SENDS };
