const test = require('node:test');
const assert = require('node:assert');
const { createVisibilityLatch } = require('../src/visibility-latch');

test('an explicit hide wins when macOS native visibility remains stale', () => {
  const nativeWindow = { isVisible: () => true };
  const visibility = createVisibilityLatch(true);

  visibility.markHidden();

  assert.strictEqual(nativeWindow.isVisible(), true);
  assert.strictEqual(visibility.isVisible(), false);
  assert.strictEqual(visibility.toggleAction(), 'show');

  visibility.markVisible();
  assert.strictEqual(visibility.toggleAction(), 'hide');
});

test('a hide requested while a window loads remains the desired state', () => {
  const visibility = createVisibilityLatch(false);

  visibility.markVisible();
  visibility.markHidden();

  assert.strictEqual(visibility.isVisible(), false);
  assert.strictEqual(visibility.toggleAction(), 'show');
});
