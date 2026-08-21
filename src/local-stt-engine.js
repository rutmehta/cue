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

function normalizeErrorDetails(details) {
  try {
    const json = JSON.stringify(details);
    if (json === undefined) throw new TypeError('not JSON serializable');
    return JSON.parse(json);
  } catch {
    throw new TypeError('Inspection error details must be JSON-serializable.');
  }
}

function normalizeInspectionError(error) {
  if (!error || typeof error !== 'object' ||
    typeof error.code !== 'string' || !error.code ||
    typeof error.message !== 'string' ||
    typeof error.action !== 'string') {
    throw new TypeError('Each inspection error requires string code, message, and action fields.');
  }
  const normalized = { code: error.code, message: error.message, action: error.action };
  if (hasOwn(error, 'details') && error.details !== undefined) {
    normalized.details = normalizeErrorDetails(error.details);
  }
  return normalized;
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
  if (hasOwn(value, 'errors') && !Array.isArray(value.errors)) {
    throw new TypeError('Engine inspection errors must be an array.');
  }
  const errors = (value.errors || []).map(normalizeInspectionError);
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
