const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveOverlayBounds, storeBoundsForDisplay, storeOverlayBoundsState } = require('../src/window-state');

test('restores the matching display and recenters when that display disappeared', () => {
  const displays = [
    { id: 10, workArea: { x: 0, y: 0, width: 1440, height: 900 } },
    { id: 20, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } }
  ];

  assert.deepEqual(resolveOverlayBounds({
    displays,
    primaryDisplayId: 10,
    savedByDisplay: { 20: { x: 1600, y: 40, width: 800, height: 500 } }
  }), { x: 1600, y: 40, width: 800, height: 500, displayId: 20 });
  assert.deepEqual(resolveOverlayBounds({
    displays: [displays[0]],
    primaryDisplayId: 10,
    savedByDisplay: { 20: { x: 1600, y: 40, width: 800, height: 500 } }
  }), { x: 360, y: 6, width: 720, height: 600, displayId: 10 });
});

test('keeps at least 96 pixels of the rail reachable and enforces a usable minimum viewport', () => {
  const result = resolveOverlayBounds({
    displays: [{ id: 1, workArea: { x: 0, y: 0, width: 1200, height: 800 } }],
    primaryDisplayId: 1,
    savedByDisplay: { 1: { x: 5000, y: -400, width: 200, height: 1200 } }
  });

  assert.deepEqual(result, { x: 1104, y: 0, width: 520, height: 800, displayId: 1 });
});

test('clamps negative-display bounds without requiring Electron APIs', () => {
  const result = resolveOverlayBounds({
    displays: [{ id: 'left', workArea: { x: -1600, y: -200, width: 1600, height: 900 } }],
    primaryDisplayId: 'left',
    savedByDisplay: { left: { x: -5000, y: 1000, width: 900, height: 80 } }
  });

  assert.deepEqual(result, { x: -1600, y: 660, width: 900, height: 320, displayId: 'left' });
});

test('stores a copied bounds record for one display without mutating saved state', () => {
  const saved = { 1: { x: 12, y: 34, width: 720, height: 600 } };
  const bounds = { x: 44, y: 55, width: 800, height: 500 };
  const updated = storeBoundsForDisplay(saved, 2, bounds);

  assert.deepEqual(updated, {
    1: { x: 12, y: 34, width: 720, height: 600 },
    2: { x: 44, y: 55, width: 800, height: 500 }
  });
  assert.notEqual(updated, saved);
  assert.notEqual(updated[1], saved[1]);
  assert.notEqual(updated[2], bounds);
  assert.deepEqual(saved, { 1: { x: 12, y: 34, width: 720, height: 600 } });
  assert.deepEqual(bounds, { x: 44, y: 55, width: 800, height: 500 });
});

test('restores the preferred display among multiple saved displays and recenters when it is unplugged', () => {
  const primary = { id: 10, workArea: { x: 0, y: 0, width: 1440, height: 900 } };
  const secondary = { id: 20, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } };
  const savedByDisplay = {
    10: { x: 12, y: 18, width: 600, height: 400 },
    20: { x: 1660, y: 44, width: 840, height: 520 }
  };

  assert.deepEqual(resolveOverlayBounds({
    displays: [primary, secondary],
    primaryDisplayId: 10,
    preferredDisplayId: 20,
    savedByDisplay
  }), { x: 1660, y: 44, width: 840, height: 520, displayId: 20 });

  assert.deepEqual(resolveOverlayBounds({
    displays: [primary],
    primaryDisplayId: 10,
    preferredDisplayId: 20,
    savedByDisplay
  }), { x: 360, y: 6, width: 720, height: 600, displayId: 10 });
});

test('persisting overlay bounds atomically advances the preferred display without mutation', () => {
  const overlay = {
    opacity: 0.94,
    preferredDisplayId: 1,
    boundsByDisplay: { 1: { x: 10, y: 20, width: 720, height: 600 } }
  };
  const bounds = { x: 1500, y: 30, width: 800, height: 500 };

  const updated = storeOverlayBoundsState(overlay, 2, bounds);

  assert.deepEqual(updated, {
    opacity: 0.94,
    preferredDisplayId: 2,
    boundsByDisplay: {
      1: { x: 10, y: 20, width: 720, height: 600 },
      2: { x: 1500, y: 30, width: 800, height: 500 }
    }
  });
  assert.notStrictEqual(updated, overlay);
  assert.deepEqual(overlay, {
    opacity: 0.94,
    preferredDisplayId: 1,
    boundsByDisplay: { 1: { x: 10, y: 20, width: 720, height: 600 } }
  });
});
