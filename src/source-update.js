const SOURCES = new Set(['mic', 'system']);
const SOURCE_PHASES = new Set(['off', 'starting', 'live', 'recovering', 'error', 'unsupported']);
const PATCH_KEYS = new Set(['phase', 'level', 'error']);
const MAX_ERROR_CODE_CHARS = 64;
const MAX_ERROR_MESSAGE_CHARS = 500;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, allowed, { required = [] } = {}) {
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key))) return false;
  if (required.some((key) => !Object.hasOwn(value, key))) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => 'value' in descriptor);
}

function validateError(error) {
  if (error === null) return null;
  if (!exactKeys(error, new Set(['code', 'message']), { required: ['message'] })) {
    throw new TypeError('Source error must contain a message and optional code.');
  }
  if (Object.hasOwn(error, 'code') && (typeof error.code !== 'string' || !error.code.trim() || error.code.length > MAX_ERROR_CODE_CHARS)) {
    throw new TypeError('Source error code is invalid.');
  }
  if (typeof error.message !== 'string' || !error.message.trim() || error.message.length > MAX_ERROR_MESSAGE_CHARS) {
    throw new TypeError('Source error message is invalid.');
  }
  return Object.hasOwn(error, 'code')
    ? { code: error.code, message: error.message }
    : { message: error.message };
}

function validateSourcePatch(patch) {
  if (!exactKeys(patch, PATCH_KEYS) || Object.keys(patch).length === 0) {
    throw new TypeError('Source patch must be a non-empty plain object with known fields.');
  }
  const clean = {};
  if (Object.hasOwn(patch, 'phase')) {
    if (!SOURCE_PHASES.has(patch.phase)) throw new TypeError(`Invalid source phase: ${patch.phase}`);
    clean.phase = patch.phase;
  }
  if (Object.hasOwn(patch, 'level')) {
    if (!Number.isFinite(patch.level) || patch.level < 0 || patch.level > 1) {
      throw new TypeError('Source level must be a finite number between 0 and 1.');
    }
    clean.level = patch.level;
  }
  if (Object.hasOwn(patch, 'error')) clean.error = validateError(patch.error);
  return clean;
}

function parseSourceUpdatePayload(payload) {
  if (!exactKeys(payload, new Set(['source', 'patch']), { required: ['source', 'patch'] })) {
    throw new TypeError('Source update payload must contain exactly source and patch.');
  }
  if (!SOURCES.has(payload.source)) throw new TypeError(`Unknown source: ${String(payload.source)}`);
  return { source: payload.source, patch: validateSourcePatch(payload.patch) };
}

function isOverlaySender(event, overlayWindow) {
  return Boolean(
    event && overlayWindow && !overlayWindow.isDestroyed()
    && event.sender === overlayWindow.webContents
  );
}

module.exports = {
  isOverlaySender,
  parseSourceUpdatePayload,
  validateSourcePatch
};
