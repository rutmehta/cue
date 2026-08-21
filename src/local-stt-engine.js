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

function normalizeEngineInspection(value) {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Engine inspection must be an object.');
  }
  if (!value.id || typeof value.id !== 'string') {
    throw new TypeError('Engine inspection requires an id.');
  }

  const runtime = normalizeRuntime(value.runtime);
  const model = normalizeModel(value.model);
  const errors = Array.isArray(value.errors) ? value.errors : [];
  const inferredHealthy = Boolean(runtime && runtime.path && model && model.path && errors.length === 0);
  const healthy = value.healthy === undefined ? inferredHealthy : Boolean(value.healthy);

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
