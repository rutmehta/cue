const test = require('node:test');
const assert = require('node:assert/strict');
const { fitAnswerBounds } = require('../src/overlay-layout');
const area = { x: 0, y: 25, width: 1440, height: 875 };
const current = { x: 420, y: 33, width: 600, height: 410 };
const base = { area, current, token: 2, currentToken: 2, manual: false };

test('answer fit expands code while preserving top center', () => {
  assert.deepEqual(fitAnswerBounds({ ...base, width: 850, height: 680 }), { x: 295, y: 33, width: 850, height: 680 });
});
test('a short new answer contracts the previous large answer', () => {
  assert.deepEqual(fitAnswerBounds({ ...base, current: { x: 295, y: 33, width: 850, height: 680 }, width: 600, height: 290 }), { x: 420, y: 33, width: 600, height: 320 });
});
test('stream growth never repeatedly shrinks the same answer', () => {
  assert.deepEqual(fitAnswerBounds({ ...base, width: 600, height: 330, previous: { width: 800, height: 600 } }), { x: 320, y: 33, width: 800, height: 600 });
});
test('manual placement and stale requests cannot resize the window', () => {
  assert.equal(fitAnswerBounds({ ...base, width: 900, height: 750, manual: true }), null);
  assert.equal(fitAnswerBounds({ ...base, width: 900, height: 750, token: 1 }), null);
});
test('answer fit stays on small and negative-coordinate displays', () => {
  const bounds = fitAnswerBounds({ ...base, area: { x: -500, y: 0, width: 500, height: 400 }, current: { x: -500, y: 0, width: 500, height: 320 }, width: 900, height: 2000 });
  assert.deepEqual(bounds, { x: -500, y: 0, width: 500, height: 340 });
});
test('invalid renderer dimensions do not reach native window bounds', () => {
  for (const width of [NaN, Infinity, -1, '900']) assert.equal(fitAnswerBounds({ ...base, width, height: 400 }), null);
});
