'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { IPC_EVENTS, IPC_INVOKES, IPC_SENDS } = require('../src/ipc-contract');

test('IPC contract has stable invoke and event namespaces for session state', () => {
  assert.deepEqual(IPC_INVOKES, {
    sessionGetSnapshot: 'session:get-snapshot',
    sessionCommand: 'session:command',
    windowCommand: 'window:command',
    settingsOpen: 'settings:open',
    captureProtection: 'capture:protection'
  });
  assert.deepEqual(IPC_EVENTS, { sessionSnapshot: 'session:snapshot' });
  assert.deepEqual(IPC_SENDS, {
    sourceUpdate: 'session:source-update',
    sourcePcm: 'session:source-pcm'
  });
});

test('IPC namespaces are immutable', () => {
  assert.equal(Object.isFrozen(IPC_INVOKES), true);
  assert.equal(Object.isFrozen(IPC_EVENTS), true);
  assert.equal(Object.isFrozen(IPC_SENDS), true);
  assert.throws(() => {
    IPC_INVOKES.sessionCommand = 'other:command';
  }, TypeError);
});
