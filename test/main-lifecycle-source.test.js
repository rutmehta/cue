const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');

function occurrences(source, pattern) {
  return (source.match(pattern) || []).length;
}

test('main has one lifecycle listener per exit boundary and an honest identity', () => {
  assert.equal(occurrences(mainSource, /app\.on\('will-quit'/g), 1);
  assert.equal(occurrences(mainSource, /app\.on\('window-all-closed'/g), 1);
  assert.equal(occurrences(mainSource, /ipcMain\.on\('app:quit'/g), 1);
  assert.match(mainSource, /app\.setName\('Cue'\)/);
  assert.doesNotMatch(mainSource, /MicrosoftEdgeUpdate|Microsoft Edge Update/);
});

test('main constructs one authoritative controller, lifecycle coordinator, and tray controller', () => {
  assert.equal(occurrences(mainSource, /new SessionController\(/g), 1);
  assert.equal(occurrences(mainSource, /createLifecycleCoordinator\(/g), 1);
  assert.equal(occurrences(mainSource, /createTrayController\(/g), 1);
  assert.match(mainSource, /IPC_EVENTS\.sessionSnapshot/);
  assert.match(mainSource, /IPC_INVOKES\.sessionGetSnapshot/);
  assert.match(mainSource, /IPC_INVOKES\.sessionCommand/);
  assert.match(mainSource, /IPC_INVOKES\.windowCommand/);
  assert.doesNotMatch(mainSource, /trayEnabled: true/);
  assert.match(mainSource, /getTraySnapshot/);
});

test('every Cue window applies content protection before loading renderer content', () => {
  const overlayStart = mainSource.indexOf('function createWindow()');
  const overlayEnd = mainSource.indexOf('// -------- STT flushing', overlayStart);
  const overlaySource = mainSource.slice(overlayStart, overlayEnd);
  assert.ok(overlaySource.indexOf('new BrowserWindow(') >= 0);
  assert.ok(overlaySource.indexOf('protectWindow(') > overlaySource.indexOf('new BrowserWindow('));
  assert.ok(overlaySource.indexOf('.loadFile(') > overlaySource.indexOf('protectWindow('));

  const permissionStart = mainSource.indexOf('function createPermissionsWindow()');
  const permissionEnd = mainSource.indexOf('// -------- launch', permissionStart);
  const permissionSource = mainSource.slice(permissionStart, permissionEnd);
  assert.ok(permissionSource.indexOf('new BrowserWindow(') >= 0);
  assert.ok(permissionSource.indexOf('protectWindow(') > permissionSource.indexOf('new BrowserWindow('));
  assert.ok(permissionSource.indexOf('.loadFile(') > permissionSource.indexOf('protectWindow('));
});

test('main restores and persists immutable per-display overlay bounds', () => {
  assert.match(mainSource, /resolveOverlayBounds\(/);
  assert.match(mainSource, /storeBoundsForDisplay\(/);
  assert.match(mainSource, /screen\.getDisplayMatching\(/);
  assert.match(mainSource, /\.on\('moved'/);
  assert.match(mainSource, /\.on\('resized'/);
});

test('preload exposes stable named session APIs and removable snapshot subscriptions', () => {
  for (const name of ['sessionGetSnapshot', 'sessionCommand', 'windowCommand', 'settingsOpen', 'captureProtection', 'sourceUpdate']) {
    assert.match(preloadSource, new RegExp(`${name}:`));
  }
  assert.match(preloadSource, /IPC_EVENTS\.sessionSnapshot/);
  assert.match(preloadSource, /return \(\) => ipcRenderer\.removeListener\(channel, listener\)/);
});

test('renderer source lifecycle and main STT/settings/clear paths update the controller', () => {
  assert.match(mainSource, /IPC_SENDS\.sourceUpdate/);
  assert.match(mainSource, /type: 'STT_UPDATED'/);
  assert.match(mainSource, /type: 'SETTINGS_UPDATED'/);
  assert.match(mainSource, /type: 'TRANSCRIPT_CLEARED'/);
  assert.match(rendererSource, /cue\.sourceUpdate\(/);
  assert.match(mainSource, /isOverlaySender\(event, win\)/);
  assert.match(mainSource, /parseSourceUpdatePayload\(payload\)/);
  assert.match(mainSource, /batchStatusForResult\(res\)/);
  assert.match(mainSource, /beginGracefulStop\(/);
  assert.match(mainSource, /finishGracefulStop\(/);
});

test('renderer consumes one authoritative snapshot stream and explicit window commands', () => {
  assert.equal(occurrences(rendererSource, /cue\.on\('session:snapshot'/g), 1);
  assert.match(rendererSource, /cue\.sessionGetSnapshot\(\)/);
  assert.match(rendererSource, /cue\.sessionCommand\('quit'\)/);
  assert.match(rendererSource, /cue\.windowCommand\('hide'\)/);
  assert.doesNotMatch(rendererSource, /cue\.setIgnoreMouse\(/);
});

test('legacy STT events cannot override snapshot-owned session controls', () => {
  const statusStart = rendererSource.indexOf("cue.on('stt:status'");
  const statusEnd = rendererSource.indexOf("cue.on('vad:state'", statusStart);
  const statusHandler = rendererSource.slice(statusStart, statusEnd);

  assert.doesNotMatch(statusHandler, /stop-btn/);
});
