const assert = require('node:assert/strict');
const test = require('node:test');

const { parseSourceUpdatePayload, isOverlaySender } = require('../src/source-update');
const { createInitialSnapshot, reduceSession } = require('../src/session-state');

test('accepts only an exact plain source lifecycle payload and returns a clean copy', () => {
  const payload = {
    source: 'mic',
    patch: { phase: 'error', level: 0.25, error: { code: 'denied', message: 'Permission denied' } }
  };
  const parsed = parseSourceUpdatePayload(payload);

  assert.deepEqual(parsed, payload);
  assert.notStrictEqual(parsed, payload);
  assert.notStrictEqual(parsed.patch, payload.patch);
  assert.notStrictEqual(parsed.patch.error, payload.patch.error);
});

test('rejects non-plain, extra, malformed, and unbounded source lifecycle values', () => {
  const valid = { source: 'system', patch: { phase: 'live', level: 0.5, error: null } };
  const invalid = [
    null,
    [],
    Object.assign(Object.create({ inherited: true }), valid),
    { ...valid, injected: true },
    { source: 'screen', patch: valid.patch },
    { source: 'mic', patch: [] },
    { source: 'mic', patch: {} },
    { source: 'mic', patch: { ...valid.patch, injected: true } },
    { source: 'mic', patch: { level: NaN } },
    { source: 'mic', patch: { level: -0.01 } },
    { source: 'mic', patch: { level: 1.01 } },
    { source: 'mic', patch: { error: 'denied' } },
    { source: 'mic', patch: { error: { code: 'x', message: 'y', injected: true } } },
    { source: 'mic', patch: { error: { code: 'x'.repeat(65), message: 'bounded' } } },
    { source: 'mic', patch: { error: { code: 'bounded', message: 'x'.repeat(501) } } }
  ];

  for (const payload of invalid) {
    assert.throws(() => parseSourceUpdatePayload(payload), TypeError);
  }
});

test('the reducer enforces source patch invariants even for trusted main events', () => {
  const state = createInitialSnapshot({ now: 0 });
  for (const patch of [
    { phase: 'live', injected: true },
    { level: {} },
    { level: Infinity },
    { error: 'broken' }
  ]) {
    assert.throws(
      () => reduceSession(state, { type: 'SOURCE_UPDATED', source: 'mic', patch }),
      TypeError
    );
  }
});

test('only the live overlay webContents is an authorized source reporter', () => {
  const overlayContents = {};
  const overlay = { isDestroyed: () => false, webContents: overlayContents };
  assert.equal(isOverlaySender({ sender: overlayContents }, overlay), true);
  assert.equal(isOverlaySender({ sender: {} }, overlay), false);
  assert.equal(isOverlaySender({ sender: overlayContents }, { ...overlay, isDestroyed: () => true }), false);
  assert.equal(isOverlaySender({ sender: overlayContents }, null), false);
});
