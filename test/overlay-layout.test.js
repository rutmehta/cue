const test = require('node:test');
const assert = require('node:assert/strict');

test('camera layout centers inside the work area including negative display coordinates', () => {
  const { cameraBounds } = require('../src/overlay-layout');
  assert.deepEqual(cameraBounds({ x: -1600, y: 30, width: 1600, height: 900 }), { x: -1100, y: 38, width: 600, height: 410 });
});

test('camera layout fits a small screen without spilling below or beyond it', () => {
  const { cameraBounds } = require('../src/overlay-layout');
  const b = cameraBounds({ x: 0, y: 20, width: 540, height: 350 });
  assert.ok(b.x >= 0 && b.x + b.width <= 540);
  assert.ok(b.y >= 20 && b.y + b.height <= 370);
});

test('uniform imagery keeps the camera center instead of shifting arbitrarily', () => {
  const { chooseOverlayBounds, cameraBounds } = require('../src/overlay-layout');
  const display = { bounds: { x: 0, y: 0, width: 1600, height: 1000 }, workArea: { x: 0, y: 30, width: 1600, height: 940 } };
  const image = { width: 160, height: 100, bitmap: Buffer.alloc(160 * 100 * 4, 220) };
  assert.deepEqual(chooseOverlayBounds(display, image), cameraBounds(display.workArea));
});

test('dense content under the right side shifts the overlay left but stays near the camera', () => {
  const { chooseOverlayBounds } = require('../src/overlay-layout');
  const display = { bounds: { x: 0, y: 0, width: 1600, height: 1000 }, workArea: { x: 0, y: 30, width: 1600, height: 940 } };
  const bitmap = Buffer.alloc(160 * 100 * 4, 240);
  for (let y = 3; y < 50; y++) for (let x = 80; x < 120; x++) {
    const v = (x + y) % 2 ? 0 : 255; const i = (y * 160 + x) * 4;
    bitmap[i] = bitmap[i + 1] = bitmap[i + 2] = v;
  }
  const b = chooseOverlayBounds(display, { width: 160, height: 100, bitmap });
  assert.ok(b.x < 500); assert.ok(b.x >= 380); assert.equal(b.y, 38);
});

test('missing or malformed bitmap falls back to camera bounds', () => {
  const { chooseOverlayBounds, cameraBounds } = require('../src/overlay-layout');
  const d = { bounds: { x: 0, y: 0, width: 1600, height: 1000 }, workArea: { x: 0, y: 30, width: 1600, height: 940 } };
  assert.deepEqual(chooseOverlayBounds(d, { width: 2, height: 2, bitmap: Buffer.alloc(2) }), cameraBounds(d.workArea));
});
