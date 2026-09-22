const test = require('node:test');
const assert = require('node:assert/strict');
const { gestureBounds } = require('../src/window-gesture');
const start = { x: 100, y: 50, width: 600, height: 400 };
test('left edge expands left while keeping the right edge fixed', () => {
  assert.deepEqual(gestureBounds(start, 'left', -100, 0), { x: 0, y: 50, width: 700, height: 400 });
  assert.deepEqual(gestureBounds(start, 'left', 300, 0), { x: 180, y: 50, width: 520, height: 400 });
});
test('right edge expands independently and dragging preserves size', () => {
  assert.deepEqual(gestureBounds(start, 'right', 100, 0), { ...start, width: 700 });
  assert.deepEqual(gestureBounds(start, 'move', -200, 80), { ...start, x: -100, y: 130 });
});
