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

test('preserves safe nested error details exactly across IPC round trips', () => {
  const details = {
    model: {
      required: ['encoder.int8.onnx', 'decoder.int8.onnx'],
      missing: ['tokens.txt'],
      metadata: { size: 640000000, verified: false, retry: null }
    },
    attempts: [{ source: 'settings', usable: false }, { source: 'openwhispr', usable: true }]
  };
  const inspection = normalizeEngineInspection({
    id: 'parakeet', healthy: false,
    runtime: { path: '/bin/p' }, model: { path: '/models/p' },
    errors: [{ code: 'model_incomplete', message: 'Incomplete.', action: 'Repair.', details }]
  });
  assert.deepEqual(inspection.errors[0].details, details);
  assert.deepEqual(JSON.parse(JSON.stringify(inspection)), inspection);
  assert.deepEqual(structuredClone(inspection), inspection);
});

test('rejects recursively unsafe error details instead of silently converting them', () => {
  const assets = { id: 'parakeet', runtime: { path: '/bin/p' }, model: { path: '/models/p' } };
  const sparse = [];
  sparse[1] = 'value';
  const cycle = { name: 'cycle' };
  cycle.self = cycle;
  const customPrototype = Object.create({ inherited: true });
  customPrototype.value = 'not plain';
  const unsafeDetails = [
    ['function', () => {}],
    ['symbol', Symbol('detail')],
    ['bigint', 1n],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['negative infinity', -Infinity],
    ['Error', new Error('bad')],
    ['Date', new Date('2026-08-21T00:00:00.000Z')],
    ['Map', new Map([['key', 'value']])],
    ['Set', new Set(['value'])],
    ['non-plain prototype', customPrototype],
    ['sparse array', sparse],
    ['direct undefined', undefined],
    ['array undefined', [undefined]],
    ['undefined', { nested: undefined }],
    ['cycle', cycle]
  ];

  for (const [name, details] of unsafeDetails) {
    const value = {
      ...assets,
      errors: [{ code: 'model_incomplete', message: 'Incomplete.', action: 'Repair.', details }]
    };
    assert.throws(() => normalizeEngineInspection(value), /details.*plain/i, name);
    assert.equal(isHealthyInspection(value), false, name);
  }
});

test('copies accepted details without retaining proxies or mutating input', () => {
  const source = { nested: { value: 'original' }, files: ['tokens.txt'] };
  const proxyDetails = new Proxy(source, {
    get() { throw new Error('detail getter must not run'); }
  });
  const proxyError = new Proxy({
    code: 'model_incomplete', message: 'Incomplete.', action: 'Repair.', details: proxyDetails
  }, {
    get() { throw new Error('error getter must not run'); }
  });
  const inspection = normalizeEngineInspection({
    id: 'parakeet', healthy: false,
    runtime: { path: '/bin/p' }, model: { path: '/models/p' }, errors: [proxyError]
  });
  const details = inspection.errors[0].details;
  assert.notStrictEqual(details, proxyDetails);
  assert.notStrictEqual(details.nested, source.nested);
  assert.notStrictEqual(details.files, source.files);
  details.nested.value = 'changed';
  details.files.push('encoder.int8.onnx');
  assert.deepEqual(source, { nested: { value: 'original' }, files: ['tokens.txt'] });
  assert.deepEqual(JSON.parse(JSON.stringify(inspection)), inspection);
  assert.deepEqual(structuredClone(inspection), inspection);
});

test('rejects nonstandard detail/error arrays and lossy detail values', () => {
  const assets = { id: 'parakeet', runtime: { path: '/bin/p' }, model: { path: '/models/p' } };
  const error = { code: 'model_incomplete', message: 'Incomplete.', action: 'Repair.' };
  class DetailArray extends Array {}
  class ErrorArray extends Array {}
  const nullPrototypeArray = ['value'];
  Object.setPrototypeOf(nullPrototypeArray, null);
  const sparseErrors = [];
  sparseErrors[1] = error;
  for (const details of [new DetailArray('value'), nullPrototypeArray, -0]) {
    assert.throws(
      () => normalizeEngineInspection({ ...assets, errors: [{ ...error, details }] }),
      /details.*plain/i
    );
  }
  for (const errors of [new ErrorArray(error), sparseErrors]) {
    assert.throws(() => normalizeEngineInspection({ ...assets, errors }), /errors.*array/i);
    assert.equal(isHealthyInspection({ ...assets, errors }), false);
  }
});

test('rejects reserved detail keys and accessors without invoking getters', () => {
  const assets = { id: 'parakeet', runtime: { path: '/bin/p' }, model: { path: '/models/p' } };
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const details = JSON.parse(`{"${key}":"unsafe"}`);
    assert.throws(
      () => normalizeEngineInspection({
        ...assets,
        errors: [{ code: 'model_incomplete', message: 'Incomplete.', action: 'Repair.', details }]
      }),
      /details.*plain/i,
      key
    );
  }

  let calls = 0;
  const accessorError = { code: 'model_incomplete', action: 'Repair.' };
  Object.defineProperty(accessorError, 'message', {
    enumerable: true,
    get() { calls += 1; return 'Incomplete.'; }
  });
  assert.throws(
    () => normalizeEngineInspection({ ...assets, errors: [accessorError] }),
    /error.*field/i
  );
  assert.equal(calls, 0);

  const accessorInspection = { ...assets };
  Object.defineProperty(accessorInspection, 'errors', {
    enumerable: true,
    get() { calls += 1; return []; }
  });
  assert.throws(() => normalizeEngineInspection(accessorInspection), /errors.*array/i);
  assert.equal(calls, 0);
});

test('bounds deep, wide, and numerous detail values with controlled errors', () => {
  const assets = { id: 'parakeet', runtime: { path: '/bin/p' }, model: { path: '/models/p' } };
  const errorFor = (details) => ({ code: 'model_incomplete', message: 'Incomplete.', action: 'Repair.', details });
  let deep = 'leaf';
  for (let index = 0; index < 128; index += 1) deep = { deep };
  const wideObject = Object.fromEntries(Array.from({ length: 512 }, (_value, index) => [`key${index}`, index]));
  const wideArray = Array.from({ length: 512 }, (_value, index) => index);
  const manyNodes = Array.from({ length: 2048 }, () => ({ value: 'node' }));
  for (const details of [deep, wideObject, wideArray, manyNodes]) {
    assert.throws(
      () => normalizeEngineInspection({ ...assets, errors: [errorFor(details)] }),
      /details.*(plain|limit)/i
    );
  }
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
