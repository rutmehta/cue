const assert = require('node:assert/strict');
const test = require('node:test');

const {
  LocalSttError,
  isHealthyInspection,
  normalizeEngineInspection
} = require('../src/local-stt-engine');

test('normalizes an inspection and rejects incomplete healthy claims', () => {
  assert.deepEqual(normalizeEngineInspection({
    id: 'parakeet',
    runtime: { path: '/bin/p' },
    model: { path: '/models/p' }
  }), {
    id: 'parakeet',
    healthy: true,
    runtime: { path: '/bin/p', source: 'unknown', version: null },
    model: { path: '/models/p', source: 'unknown', fingerprint: null },
    errors: []
  });
  assert.throws(() => normalizeEngineInspection({ id: 'parakeet', healthy: true }), /runtime and model/);
});

test('normalization fills absent asset metadata even when fields are undefined', () => {
  const result = normalizeEngineInspection({
    id: 'parakeet',
    runtime: { path: '/bin/p', source: undefined, version: undefined },
    model: { path: '/models/p', source: undefined, fingerprint: undefined }
  });
  assert.deepEqual(result.runtime, { path: '/bin/p', source: 'unknown', version: null });
  assert.deepEqual(result.model, { path: '/models/p', source: 'unknown', fingerprint: null });
});

test('LocalSttError carries a stable code and action', () => {
  const error = new LocalSttError('runtime_missing', 'No Parakeet runtime found.', 'Prepare the runtime.');
  assert.deepEqual({ code: error.code, message: error.message, action: error.action }, {
    code: 'runtime_missing',
    message: 'No Parakeet runtime found.',
    action: 'Prepare the runtime.'
  });
});

test('health requires both assets and no structured errors', () => {
  assert.equal(isHealthyInspection({
    id: 'parakeet', runtime: { path: '/bin/p' }, model: { path: '/models/p' }
  }), true);
  assert.equal(isHealthyInspection({
    id: 'parakeet', runtime: { path: '/bin/p' }, model: { path: '/models/p' },
    errors: [new LocalSttError('model_incomplete', 'Incomplete.', 'Repair it.')]
  }), false);
  assert.equal(isHealthyInspection({ id: 'parakeet', healthy: true }), false);
});
