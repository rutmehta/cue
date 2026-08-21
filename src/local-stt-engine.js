class LocalSttError extends Error {
  constructor(code, message, action, details = null) {
    super(message);
    this.name = 'LocalSttError';
    this.code = code;
    this.action = action;
    if (details !== null) this.details = details;
  }
}

function normalizeRuntime(runtime) {
  if (!runtime) return null;
  return {
    ...runtime,
    path: runtime.path || null,
    source: runtime.source || 'unknown',
    version: runtime.version || null
  };
}

function normalizeModel(model) {
  if (!model) return null;
  return {
    ...model,
    path: model.path || null,
    source: model.source || 'unknown',
    fingerprint: model.fingerprint || null
  };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

const MAX_DETAIL_DEPTH = 32;
const MAX_DETAIL_NODES = 1000;
const MAX_DETAIL_ARRAY_LENGTH = 256;
const MAX_DETAIL_OBJECT_KEYS = 256;
const MAX_INSPECTION_ERRORS = 64;
const RESERVED_DETAIL_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function invalidErrorDetails() {
  throw new TypeError('Inspection error details must contain only JSON-safe plain data.');
}

function detailLimitExceeded() {
  throw new TypeError('Inspection error details exceed safe limits.');
}

function invalidInspectionErrors() {
  throw new TypeError('Engine inspection errors must be a dense standard array.');
}

function invalidInspectionErrorFields() {
  throw new TypeError('Each inspection error requires own data fields for code, message, and action.');
}

function isArrayIndex(key, length) {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function ownDataProperty(value, key, invalid) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !hasOwn(descriptor, 'value')) invalid();
  return descriptor.value;
}

function arrayLength(value, invalid) {
  const length = ownDataProperty(value, 'length', invalid);
  if (!Number.isSafeInteger(length) || length < 0) invalid();
  return length;
}

function cloneErrorDetails(value, state = { nodes: 0, ancestors: new Set() }, depth = 0) {
  if (depth > MAX_DETAIL_DEPTH) detailLimitExceeded();
  state.nodes += 1;
  if (state.nodes > MAX_DETAIL_NODES) detailLimitExceeded();

  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) invalidErrorDetails();
    return value;
  }
  if (typeof value !== 'object' || state.ancestors.has(value)) invalidErrorDetails();

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) invalidErrorDetails();
      const length = arrayLength(value, invalidErrorDetails);
      if (length > MAX_DETAIL_ARRAY_LENGTH) detailLimitExceeded();
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !isArrayIndex(key, length)) invalidErrorDetails();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !hasOwn(descriptor, 'value')) invalidErrorDetails();
      }
      const clone = [];
      for (let index = 0; index < length; index += 1) {
        const element = ownDataProperty(value, String(index), invalidErrorDetails);
        clone.push(cloneErrorDetails(element, state, depth + 1));
      }
      return clone;
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) invalidErrorDetails();
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_DETAIL_OBJECT_KEYS) detailLimitExceeded();
    const clone = {};
    for (const key of keys) {
      if (typeof key !== 'string' || RESERVED_DETAIL_KEYS.has(key)) invalidErrorDetails();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !hasOwn(descriptor, 'value')) invalidErrorDetails();
      clone[key] = cloneErrorDetails(descriptor.value, state, depth + 1);
    }
    return clone;
  } finally {
    state.ancestors.delete(value);
  }
}

function normalizeInspectionError(error) {
  if (!error || typeof error !== 'object') invalidInspectionErrorFields();
  const code = ownDataProperty(error, 'code', invalidInspectionErrorFields);
  const message = ownDataProperty(error, 'message', invalidInspectionErrorFields);
  const action = ownDataProperty(error, 'action', invalidInspectionErrorFields);
  if (typeof code !== 'string' || !code || typeof message !== 'string' || typeof action !== 'string') {
    throw new TypeError('Each inspection error requires string code, message, and action fields.');
  }
  const normalized = { code, message, action };
  const details = Object.getOwnPropertyDescriptor(error, 'details');
  if (details) {
    if (!hasOwn(details, 'value')) invalidInspectionErrorFields();
    normalized.details = cloneErrorDetails(details.value);
  }
  return normalized;
}

function normalizeInspectionErrors(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalidInspectionErrors();
  }
  const length = arrayLength(value, invalidInspectionErrors);
  if (length > MAX_INSPECTION_ERRORS) invalidInspectionErrors();
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !isArrayIndex(key, length)) invalidInspectionErrors();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !hasOwn(descriptor, 'value')) invalidInspectionErrors();
  }
  const errors = [];
  for (let index = 0; index < length; index += 1) {
    errors.push(normalizeInspectionError(ownDataProperty(value, String(index), invalidInspectionErrors)));
  }
  return errors;
}

function normalizeEngineInspection(value) {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Engine inspection must be an object.');
  }
  if (!value.id || typeof value.id !== 'string') {
    throw new TypeError('Engine inspection requires an id.');
  }

  const runtime = normalizeRuntime(value.runtime);
  const model = normalizeModel(value.model);
  const errorList = Object.getOwnPropertyDescriptor(value, 'errors');
  if (errorList && !hasOwn(errorList, 'value')) {
    throw new TypeError('Engine inspection errors must be an array.');
  }
  if (errorList && !Array.isArray(errorList.value)) {
    throw new TypeError('Engine inspection errors must be an array.');
  }
  const errors = errorList ? normalizeInspectionErrors(errorList.value) : [];
  const inferredHealthy = Boolean(runtime && runtime.path && model && model.path && errors.length === 0);
  if (hasOwn(value, 'healthy') && typeof value.healthy !== 'boolean') {
    throw new TypeError('Engine inspection healthy must be a boolean.');
  }
  const healthy = hasOwn(value, 'healthy') ? value.healthy : inferredHealthy;

  if (healthy && (!runtime || !runtime.path || !model || !model.path)) {
    throw new TypeError('A healthy engine inspection requires runtime and model paths.');
  }
  if (healthy && errors.length > 0) {
    throw new TypeError('A healthy engine inspection cannot contain errors.');
  }

  return { id: value.id, healthy, runtime, model, errors };
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
