class LocalSttError extends Error {
  constructor(code, message, action, details = null) {
    super(message);
    this.name = 'LocalSttError';
    this.code = code;
    this.action = action;
    if (details !== null) this.details = details;
  }
}

class InspectionSchemaError extends TypeError {}

const MISSING = Symbol('missing');
const MAX_DETAIL_DEPTH = 32;
const MAX_DETAIL_NODES = 1000;
const MAX_DETAIL_ARRAY_LENGTH = 256;
const MAX_DETAIL_OBJECT_KEYS = 256;
const MAX_INSPECTION_ERRORS = 64;
const MAX_TOTAL_CHARS = 128 * 1024;
const MAX_ID_CHARS = 256;
const MAX_PATH_CHARS = 16 * 1024;
const MAX_SOURCE_CHARS = 256;
const MAX_VERSION_CHARS = 1024;
const MAX_FINGERPRINT_CHARS = 1024;
const MAX_ERROR_CODE_CHARS = 256;
const MAX_ERROR_MESSAGE_CHARS = 64 * 1024;
const MAX_ERROR_ACTION_CHARS = 8 * 1024;
const MAX_DETAIL_KEY_CHARS = 256;
const MAX_DETAIL_STRING_CHARS = 64 * 1024;
const RESERVED_DETAIL_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TOP_LEVEL_FIELDS = new Set(['id', 'healthy', 'runtime', 'model', 'errors']);
const RUNTIME_FIELDS = new Set(['path', 'source', 'version']);
const MODEL_FIELDS = new Set(['path', 'source', 'fingerprint']);

function fail(message) {
  throw new InspectionSchemaError(message);
}

function reflectionFailure() {
  fail('Engine inspection contains unsafe schema data.');
}

function safeGetPrototypeOf(value) {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    reflectionFailure();
  }
}

function safeOwnKeys(value) {
  try {
    return Reflect.ownKeys(value);
  } catch {
    reflectionFailure();
  }
}

function safeDescriptor(value, key) {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    reflectionFailure();
  }
}

function safeIsArray(value) {
  try {
    return Array.isArray(value);
  } catch {
    reflectionFailure();
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidErrorDetails() {
  fail('Inspection error details must contain only JSON-safe plain data.');
}

function detailLimitExceeded() {
  fail('Inspection error details exceed safe limits.');
}

function invalidInspectionErrors() {
  fail('Engine inspection errors must be a dense standard array.');
}

function invalidInspectionErrorFields() {
  fail('Each inspection error requires own data fields for code, message, and action.');
}

function invalidInspectionSchema() {
  fail('Engine inspection contains an invalid schema field.');
}

function runtimeSchemaFailure() {
  fail('Engine inspection runtime must contain only documented data fields.');
}

function modelSchemaFailure() {
  fail('Engine inspection model must contain only documented data fields.');
}

function addText(value, maximum, state, invalid) {
  if (typeof value !== 'string') invalid();
  if (value.length > maximum) fail('Engine inspection text exceeds safe limits.');
  state.characters += value.length;
  if (state.characters > MAX_TOTAL_CHARS) fail('Engine inspection text exceeds safe limits.');
  return value;
}

function isArrayIndex(key, length) {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function ownDataProperty(value, key, invalid, required = false) {
  const descriptor = safeDescriptor(value, key);
  if (!descriptor) {
    if (required) invalid();
    return MISSING;
  }
  if (!hasOwn(descriptor, 'value')) invalid();
  return descriptor.value;
}

function arrayLength(value, invalid) {
  const length = ownDataProperty(value, 'length', invalid, true);
  if (!Number.isSafeInteger(length) || length < 0) invalid();
  return length;
}

function assertPlainObject(value, invalid) {
  if (!value || typeof value !== 'object' || safeGetPrototypeOf(value) !== Object.prototype) invalid();
}

function assertDocumentedFields(value, allowedFields, invalid) {
  for (const key of safeOwnKeys(value)) {
    if (typeof key !== 'string' || !allowedFields.has(key)) invalid();
    ownDataProperty(value, key, invalid, true);
  }
}

function cloneErrorDetails(value, state, depth = 0) {
  if (depth > MAX_DETAIL_DEPTH) detailLimitExceeded();
  state.nodes += 1;
  if (state.nodes > MAX_DETAIL_NODES) detailLimitExceeded();

  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return addText(value, MAX_DETAIL_STRING_CHARS, state, invalidErrorDetails);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) invalidErrorDetails();
    return value;
  }
  if (typeof value !== 'object' || state.ancestors.has(value)) invalidErrorDetails();

  state.ancestors.add(value);
  try {
    if (safeIsArray(value)) {
      if (safeGetPrototypeOf(value) !== Array.prototype) invalidErrorDetails();
      const length = arrayLength(value, invalidErrorDetails);
      if (length > MAX_DETAIL_ARRAY_LENGTH) detailLimitExceeded();
      for (const key of safeOwnKeys(value)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !isArrayIndex(key, length)) invalidErrorDetails();
        ownDataProperty(value, key, invalidErrorDetails, true);
      }
      const clone = [];
      for (let index = 0; index < length; index += 1) {
        clone.push(cloneErrorDetails(ownDataProperty(value, String(index), invalidErrorDetails, true), state, depth + 1));
      }
      return clone;
    }

    if (safeGetPrototypeOf(value) !== Object.prototype) invalidErrorDetails();
    const keys = safeOwnKeys(value);
    if (keys.length > MAX_DETAIL_OBJECT_KEYS) detailLimitExceeded();
    const clone = {};
    for (const key of keys) {
      if (typeof key !== 'string' || RESERVED_DETAIL_KEYS.has(key)) invalidErrorDetails();
      const descriptor = safeDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !hasOwn(descriptor, 'value')) invalidErrorDetails();
      const copiedKey = addText(key, MAX_DETAIL_KEY_CHARS, state, invalidErrorDetails);
      clone[copiedKey] = cloneErrorDetails(descriptor.value, state, depth + 1);
    }
    return clone;
  } finally {
    state.ancestors.delete(value);
  }
}

function normalizeInspectionError(error, state) {
  if (!error || typeof error !== 'object') invalidInspectionErrorFields();
  const code = addText(ownDataProperty(error, 'code', invalidInspectionErrorFields, true), MAX_ERROR_CODE_CHARS, state, invalidInspectionErrorFields);
  const message = addText(ownDataProperty(error, 'message', invalidInspectionErrorFields, true), MAX_ERROR_MESSAGE_CHARS, state, invalidInspectionErrorFields);
  const action = addText(ownDataProperty(error, 'action', invalidInspectionErrorFields, true), MAX_ERROR_ACTION_CHARS, state, invalidInspectionErrorFields);
  if (!code) fail('Each inspection error requires string code, message, and action fields.');
  const normalized = { code, message, action };
  const details = safeDescriptor(error, 'details');
  if (details) {
    if (!hasOwn(details, 'value')) invalidInspectionErrorFields();
    normalized.details = cloneErrorDetails(details.value, state);
  }
  return normalized;
}

function normalizeInspectionErrors(value, state) {
  if (!safeIsArray(value) || safeGetPrototypeOf(value) !== Array.prototype) invalidInspectionErrors();
  const length = arrayLength(value, invalidInspectionErrors);
  if (length > MAX_INSPECTION_ERRORS) invalidInspectionErrors();
  for (const key of safeOwnKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !isArrayIndex(key, length)) invalidInspectionErrors();
    ownDataProperty(value, key, invalidInspectionErrors, true);
  }
  const errors = [];
  for (let index = 0; index < length; index += 1) {
    errors.push(normalizeInspectionError(ownDataProperty(value, String(index), invalidInspectionErrors, true), state));
  }
  return errors;
}

function readAssetPath(value, state, invalid) {
  const path = ownDataProperty(value, 'path', invalid);
  if (path === MISSING || path === undefined || path === null) return null;
  return addText(path, MAX_PATH_CHARS, state, invalid);
}

function readAssetSource(value, state, invalid) {
  const source = ownDataProperty(value, 'source', invalid);
  if (source === MISSING || source === undefined) return 'unknown';
  return addText(source, MAX_SOURCE_CHARS, state, invalid);
}

function readAssetText(value, key, maximum, state, invalid) {
  const text = ownDataProperty(value, key, invalid);
  if (text === MISSING || text === undefined || text === null) return null;
  return addText(text, maximum, state, invalid);
}

function normalizeRuntime(value, state) {
  if (value === null || value === MISSING) return null;
  if (value === undefined) runtimeSchemaFailure();
  assertPlainObject(value, runtimeSchemaFailure);
  assertDocumentedFields(value, RUNTIME_FIELDS, runtimeSchemaFailure);
  return {
    path: readAssetPath(value, state, runtimeSchemaFailure),
    source: readAssetSource(value, state, runtimeSchemaFailure),
    version: readAssetText(value, 'version', MAX_VERSION_CHARS, state, runtimeSchemaFailure)
  };
}

function normalizeModel(value, state) {
  if (value === null || value === MISSING) return null;
  if (value === undefined) modelSchemaFailure();
  assertPlainObject(value, modelSchemaFailure);
  assertDocumentedFields(value, MODEL_FIELDS, modelSchemaFailure);
  return {
    path: readAssetPath(value, state, modelSchemaFailure),
    source: readAssetSource(value, state, modelSchemaFailure),
    fingerprint: readAssetText(value, 'fingerprint', MAX_FINGERPRINT_CHARS, state, modelSchemaFailure)
  };
}

function normalizeEngineInspection(value) {
  try {
    assertPlainObject(value, invalidInspectionSchema);
    assertDocumentedFields(value, TOP_LEVEL_FIELDS, invalidInspectionSchema);
    const state = { characters: 0, nodes: 0, ancestors: new Set() };
    const id = addText(ownDataProperty(value, 'id', invalidInspectionSchema, true), MAX_ID_CHARS, state, invalidInspectionSchema);
    if (!id) fail('Engine inspection requires an id.');
    const runtime = normalizeRuntime(ownDataProperty(value, 'runtime', invalidInspectionSchema), state);
    const model = normalizeModel(ownDataProperty(value, 'model', invalidInspectionSchema), state);
    const errorValue = ownDataProperty(value, 'errors', invalidInspectionSchema);
    if (errorValue !== MISSING && !safeIsArray(errorValue)) fail('Engine inspection errors must be an array.');
    const errors = errorValue === MISSING ? [] : normalizeInspectionErrors(errorValue, state);
    const inferredHealthy = Boolean(runtime && runtime.path && model && model.path && errors.length === 0);
    const healthyValue = ownDataProperty(value, 'healthy', invalidInspectionSchema);
    if (healthyValue !== MISSING && typeof healthyValue !== 'boolean') fail('Engine inspection healthy must be a boolean.');
    const healthy = healthyValue === MISSING ? inferredHealthy : healthyValue;

    if (healthy && (!runtime || !runtime.path || !model || !model.path)) {
      fail('A healthy engine inspection requires runtime and model paths.');
    }
    if (healthy && errors.length > 0) fail('A healthy engine inspection cannot contain errors.');
    return { id, healthy, runtime, model, errors };
  } catch (error) {
    if (error instanceof InspectionSchemaError) throw error;
    reflectionFailure();
  }
}

function isHealthyInspection(value) {
  try {
    return normalizeEngineInspection(value).healthy;
  } catch {
    return false;
  }
}

module.exports = {
  LocalSttError,
  isHealthyInspection,
  normalizeEngineInspection
};
