const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFeatureRequest } = require('../src/prompts');

test('screen-aware suggestions acknowledge an actually attached screenshot', () => {
  const r = buildFeatureRequest('say', { settings: { screenContextEnabled: true }, screenIncluded: true, transcript: [] });
  assert.equal(r.contextUsed.screen, true);
  assert.match(r.system, /fresh screenshot/);
});

test('missing screen context never claims an attached screenshot', () => {
  const r = buildFeatureRequest('say', { settings: { screenContextEnabled: true }, screenIncluded: false, transcript: [] });
  assert.equal(r.contextUsed.screen, false);
  assert.match(r.system, /No screenshot/);
});

test('screen-off assist includes explicit absence guidance and no attachment metadata', () => {
  const r = buildFeatureRequest('assist', { settings: { screenContextEnabled: false }, screenIncluded: false, transcript: [] });
  assert.match(r.system, /No screenshot/); assert.equal(r.contextUsed.screen, false);
});

test('capture completed after opt-out discards image data', () => {
  const { acceptScreenCapture } = require('../src/screen-context-policy');
  assert.deepEqual(acceptScreenCapture({ captured: { imageDataUrl: 'private-image' }, enabled: false, requestEpoch: 1, currentEpoch: 1 }), { state: 'off' });
});

test('capture completed after clearing the chat cancels request before side effects', () => {
  const { acceptScreenCapture } = require('../src/screen-context-policy');
  assert.deepEqual(acceptScreenCapture({ captured: { imageDataUrl: 'private-image' }, enabled: true, requestEpoch: 1, currentEpoch: 2 }), { state: 'cancelled' });
});
