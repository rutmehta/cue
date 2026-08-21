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

test('normalizes errors into IPC-safe records that survive JSON and structured cloning', () => {
  const inspection = normalizeEngineInspection({
    id: 'parakeet', healthy: false,
    runtime: { path: '/bin/p' }, model: { path: '/models/p' },
    errors: [new LocalSttError(
      'model_incomplete',
      'The Parakeet model is incomplete.',
      'Download the missing files.',
      { missingFiles: ['tokens.txt'] }
    )]
  });
  const expectedError = {
    code: 'model_incomplete',
    message: 'The Parakeet model is incomplete.',
    action: 'Download the missing files.',
    details: { missingFiles: ['tokens.txt'] }
  };
  assert.equal(inspection.errors[0] instanceof LocalSttError, false);
  assert.deepEqual(inspection.errors, [expectedError]);
  assert.deepEqual(JSON.parse(JSON.stringify(inspection)), inspection);
  assert.deepEqual(structuredClone(inspection), inspection);
});

test('rejects malformed healthy and errors fields instead of coercing them', () => {
  const assets = { id: 'parakeet', runtime: { path: '/bin/p' }, model: { path: '/models/p' } };
  for (const healthy of [undefined, null, 'false', 0, 1, {}, []]) {
    assert.throws(
      () => normalizeEngineInspection({ ...assets, healthy }),
      /healthy.*boolean/i,
      `healthy=${String(healthy)}`
    );
  }
  for (const errors of [undefined, null, {}, 'not an array', new LocalSttError('x', 'x', 'x')]) {
    assert.throws(
      () => normalizeEngineInspection({ ...assets, errors }),
      /errors.*array/i,
      `errors=${String(errors)}`
    );
  }
  for (const error of [
    null,
    'missing',
    {},
    { code: 'runtime_missing', action: 'Install it.' },
    { code: 'runtime_missing', message: 'Missing.' },
    { message: 'Missing.', action: 'Install it.' },
    { code: 5, message: 'Missing.', action: 'Install it.' }
  ]) {
    assert.throws(
      () => normalizeEngineInspection({ ...assets, healthy: false, errors: [error] }),
      /error.*code.*message.*action/i
    );
  }
  assert.equal(isHealthyInspection({ ...assets, healthy: 'false', errors: [] }), false);
  assert.equal(isHealthyInspection({ ...assets, healthy: true, errors: {} }), false);
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
