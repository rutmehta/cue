const childProcess = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { LocalSttError, normalizeEngineInspection } = require('./local-stt-engine');
const { buildParakeetArgs } = require('./parakeet-runtime');

const LOOPBACK_HOST = '127.0.0.1';
const FIRST_PORT = 6006;
const LAST_PORT = 6029;
const READINESS_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 2_000;
const MIN_TRANSCRIPTION_TIMEOUT_MS = 10_000;
const MAX_AUDIO_DURATION_MS = 30_000;
const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 192_000;
const MAX_PCM16_BYTES = MAX_SAMPLE_RATE * 2 * MAX_AUDIO_DURATION_MS / 1000;
const MAX_FLOAT32_BYTES = MAX_PCM16_BYTES * 2;
const DEFAULT_MAX_CHANNEL_REQUESTS = 8;
const DEFAULT_MAX_CHANNEL_RETAINED_BYTES = MAX_FLOAT32_BYTES + 8;
const DEFAULT_MAX_RESULT_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESULT_MESSAGES = 64;

function localError(code, message, action, details = null) {
  return new LocalSttError(code, message, action, details);
}

function byteViewLength(value, description) {
  if (!Buffer.isBuffer(value) && !ArrayBuffer.isView(value)) {
    throw new TypeError(`${description} must be a Buffer or typed array.`);
  }
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0) {
    throw new RangeError(`${description} is too large.`);
  }
  return value.byteLength;
}

function asByteBuffer(value, description, maximumBytes) {
  const byteLength = byteViewLength(value, description);
  if (byteLength > maximumBytes) throw new RangeError(`${description} is too large.`);
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function pcm16ToFloat32Buffer(pcm16) {
  const input = asByteBuffer(pcm16, 'PCM audio', MAX_PCM16_BYTES);
  if (input.byteLength === 0) throw new RangeError('PCM audio must contain audio samples.');
  if (input.byteLength % 2 !== 0) {
    throw new RangeError('PCM audio must contain complete 16-bit samples.');
  }
  const output = Buffer.allocUnsafe(input.byteLength * 2);
  for (let inputOffset = 0, outputOffset = 0; inputOffset < input.byteLength; inputOffset += 2, outputOffset += 4) {
    output.writeFloatLE(input.readInt16LE(inputOffset) / 32768, outputOffset);
  }
  return output;
}

function validateSampleRate(sampleRate) {
  if (!Number.isSafeInteger(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    throw new RangeError(`The sample rate must be an integer from ${MIN_SAMPLE_RATE} to ${MAX_SAMPLE_RATE} Hz.`);
  }
}

function buildOfflineMessage(float32, sampleRate) {
  validateSampleRate(sampleRate);
  const audio = asByteBuffer(float32, 'Float32 audio', MAX_FLOAT32_BYTES);
  if (audio.byteLength === 0 || audio.byteLength % 4 !== 0) {
    throw new RangeError('Float32 audio must contain complete float32 samples.');
  }
  if (audio.byteLength > 0x7fffffff) throw new RangeError('Float32 audio is too large.');
  const message = Buffer.allocUnsafe(8 + audio.byteLength);
  message.writeInt32LE(sampleRate, 0);
  message.writeInt32LE(audio.byteLength, 4);
  audio.copy(message, 8);
  return message;
}

function tryPort(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      resolve(available);
    };
    server.once('error', () => finish(false));
    server.once('listening', () => server.close(() => finish(true)));
    server.listen({ port, host, exclusive: true });
  });
}

async function findFirstAvailablePort({ host, start, end }) {
  for (let port = start; port <= end; port += 1) {
    if (await tryPort(port, host)) return port;
  }
  throw localError(
    'port_unavailable',
    `No Parakeet port is available from ${start} through ${end}.`,
    'Close the process using a Parakeet port and try again.'
  );
}

function childKnownExited(child) {
  if (!child || (typeof child !== 'object' && typeof child !== 'function')) return true;
  try {
    if (Number.isInteger(child.exitCode) && child.exitCode >= 0) return true;
    if (typeof child.signalCode === 'string' &&
        Object.prototype.hasOwnProperty.call(os.constants.signals, child.signalCode)) return true;
  } catch {}
  return false;
}

function mayOwnSpawnedProcess(child) {
  if (!child || (typeof child !== 'object' && typeof child !== 'function')) return false;
  try {
    if (Number.isSafeInteger(child.pid) && child.pid > 0) return true;
  } catch {}
  try {
    if (typeof child.kill === 'function') return true;
  } catch {}
  try {
    return child.exitCode === null || child.signalCode === null;
  } catch {
    return false;
  }
}

function defaultStopProcess(child, signal, options) {
  if (!child || childKnownExited(child)) return;
  if (options.detached && process.platform !== 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error && error.code === 'ESRCH') return;
      throw error;
    }
  }
  if (typeof child.kill === 'function') child.kill(signal);
}

function defaultWebSocket() {
  return require('ws');
}

function removeListener(emitter, event, listener) {
  if (!emitter || !listener) return;
  if (typeof emitter.removeListener === 'function') emitter.removeListener(event, listener);
  else if (typeof emitter.removeEventListener === 'function') emitter.removeEventListener(event, listener);
}

function addListener(emitter, event, listener) {
  if (emitter && typeof emitter.on === 'function') emitter.on(event, listener);
  else if (emitter && typeof emitter.addEventListener === 'function') emitter.addEventListener(event, listener);
  else throw new TypeError(`Event source does not support ${event} listeners.`);
}

function safeClose(socket) {
  if (!socket || typeof socket.close !== 'function') return;
  try { socket.close(); } catch {}
}

function errorRecord(error) {
  return {
    code: error.code,
    message: error.message,
    action: error.action,
    ...(error.details === undefined ? {} : { details: error.details })
  };
}

function deepCloneFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  const isArray = Array.isArray(value);
  const clone = isArray ? [] : {};
  if (isArray) Object.defineProperty(clone, 'length', { value: value.length });
  for (const key of Object.keys(value)) {
    Object.defineProperty(clone, key, {
      value: deepCloneFreeze(value[key]),
      writable: true,
      enumerable: true,
      configurable: true
    });
  }
  return Object.freeze(clone);
}

function normalizeLimits(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Parakeet limits must be an object.');
  }
  const limits = {
    maxChannelRequests: value.maxChannelRequests ?? DEFAULT_MAX_CHANNEL_REQUESTS,
    maxChannelRetainedBytes: value.maxChannelRetainedBytes ?? DEFAULT_MAX_CHANNEL_RETAINED_BYTES,
    maxResultBytes: value.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
    maxResultMessages: value.maxResultMessages ?? DEFAULT_MAX_RESULT_MESSAGES
  };
  for (const [name, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError(`Parakeet ${name} must be a positive safe integer.`);
    }
  }
  return Object.freeze(limits);
}

function consumeRejection(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return;
  let then;
  try { then = value.then; } catch { return; }
  if (typeof then !== 'function') return;
  try { then.call(value, undefined, () => {}); } catch {}
}

class ParakeetTranscriber {
  constructor(dependencies = {}) {
    this._inspect = dependencies.inspect;
    this._spawn = dependencies.spawn || childProcess.spawn;
    this._WebSocket = dependencies.WebSocket === undefined ? defaultWebSocket() : dependencies.WebSocket;
    this._findPort = dependencies.findPort || findFirstAvailablePort;
    this._cpuCount = dependencies.cpuCount === undefined ? (() => os.cpus().length) : dependencies.cpuCount;
    this._platform = dependencies.platform || process.platform;
    this._tempDirectory = dependencies.tempDirectory || os.tmpdir();
    this._setTimeout = dependencies.setTimeout || setTimeout;
    this._clearTimeout = dependencies.clearTimeout || clearTimeout;
    this._now = dependencies.now || Date.now;
    this._stopProcess = dependencies.stopProcess || defaultStopProcess;
    this._limits = normalizeLimits(dependencies.limits);

    this.id = 'parakeet';
    this._state = 'idle';
    this._generation = 0;
    this._inspection = null;
    this._port = null;
    this._child = null;
    this._childListeners = null;
    this._startPromise = null;
    this._cancelGenerationStart = null;
    this._cancelReadiness = null;
    this._stopPromise = null;
    this._preserveStopError = false;
    this._failedChildCleanup = null;
    this._ownedChildren = new Map();
    this._observers = new Set();
    this._queues = new Map();
    this._active = new Set();
  }

  async inspect() {
    if (typeof this._inspect !== 'function') {
      throw new TypeError('Parakeet inspection dependency must be a function.');
    }
    return normalizeEngineInspection(await this._inspect());
  }

  onStatus(callback) {
    if (typeof callback !== 'function') throw new TypeError('Status observer must be a function.');
    this._observers.add(callback);
    return () => this._observers.delete(callback);
  }

  _emitStatus(status) {
    const value = { id: this.id, ...status };
    for (const observer of [...this._observers]) {
      try {
        const snapshot = deepCloneFreeze(value);
        const result = observer(snapshot);
        consumeRejection(result);
      } catch {}
    }
  }

  _validateDependencies() {
    for (const [name, value] of [
      ['spawn', this._spawn], ['WebSocket', this._WebSocket], ['port finder', this._findPort],
      ['setTimeout', this._setTimeout], ['clearTimeout', this._clearTimeout],
      ['clock', this._now], ['process stopper', this._stopProcess]
    ]) {
      if (typeof value !== 'function') throw new TypeError(`Parakeet ${name} dependency must be a function.`);
    }
    if (typeof this._cpuCount !== 'function' && !Number.isFinite(this._cpuCount)) {
      throw new TypeError('Parakeet CPU count dependency must be a finite number or function.');
    }
    if (typeof this._tempDirectory !== 'string' || !path.isAbsolute(this._tempDirectory)) {
      throw new TypeError('Parakeet temporary-directory cwd must be an absolute path.');
    }
  }

  _normalizeHealthyInspection(value) {
    const inspection = normalizeEngineInspection(value);
    if (inspection.id !== this.id || !inspection.healthy) {
      throw localError(
        'engine_unhealthy',
        'Starting Parakeet requires a healthy Parakeet inspection.',
        'Repair the reported Parakeet runtime or model problem and try again.'
      );
    }
    return inspection;
  }

  start(options) {
    if (this._state === 'starting' && this._startPromise) return this._startPromise;

    let inspection;
    try {
      this._validateDependencies();
      if (options === undefined) {
        if (typeof this._inspect !== 'function') {
          throw new TypeError('Parakeet inspection dependency must be a function.');
        }
      } else inspection = this._normalizeHealthyInspection(options);
    } catch (error) {
      return Promise.reject(error);
    }

    if (this._state === 'ready') return Promise.resolve(normalizeEngineInspection(this._inspection));
    if (this._state === 'stopping' && this._stopPromise) {
      return this._stopPromise.then(() => this.start(options === undefined ? undefined : inspection));
    }

    const generation = ++this._generation;
    this._state = 'starting';
    this._inspection = inspection ? deepCloneFreeze(inspection) : null;
    let settleResolve;
    let settleReject;
    let settled = false;
    const promise = new Promise((resolve, reject) => {
      settleResolve = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      settleReject = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
    });
    this._startPromise = promise;
    this._cancelGenerationStart = settleReject;
    this._emitStatus({ status: 'starting', message: 'Starting local Parakeet.' });
    Promise.resolve().then(async () => {
      if (this._failedChildCleanup) await this._failedChildCleanup;
      if (generation !== this._generation || this._state !== 'starting') {
        throw localError('engine_stopped', 'Parakeet stopped before it became ready.', 'Start Parakeet again.');
      }
      if (!inspection) {
        const inspected = this._normalizeHealthyInspection(await this.inspect());
        if (generation !== this._generation || this._state !== 'starting') {
          throw localError('engine_stopped', 'Parakeet stopped before it became ready.', 'Start Parakeet again.');
        }
        this._inspection = deepCloneFreeze(inspected);
      }
      await this._performStart(this._inspection, generation);
      settleResolve(normalizeEngineInspection(this._inspection));
    }).catch((error) => {
      if (generation === this._generation && this._state === 'starting') {
        this._state = 'error';
        this._emitStatus({ status: 'error', error: errorRecord(error) });
      }
      settleReject(error);
    });
    promise.then(
      () => {
        if (this._startPromise === promise) {
          this._startPromise = null;
          this._cancelGenerationStart = null;
        }
      },
      () => {
        if (this._startPromise === promise) {
          this._startPromise = null;
          this._cancelGenerationStart = null;
        }
      }
    );
    return promise;
  }

  async _performStart(inspection, generation) {
    let port;
    try {
      port = await this._findPort({ host: LOOPBACK_HOST, start: FIRST_PORT, end: LAST_PORT });
    } catch (cause) {
      if (cause instanceof LocalSttError) throw cause;
      throw localError(
        'port_unavailable',
        'Cue could not reserve a loopback port for Parakeet.',
        'Close the process using ports 6006-6029 and try again.',
        { cause: String(cause && cause.message || cause) }
      );
    }
    if (generation !== this._generation || this._state !== 'starting') {
      throw localError('engine_stopped', 'Parakeet stopped before it became ready.', 'Start Parakeet again.');
    }
    if (!Number.isInteger(port) || port < FIRST_PORT || port > LAST_PORT) {
      throw localError(
        'port_unavailable',
        'The Parakeet port finder returned a port outside 6006-6029.',
        'Repair the local port configuration and try again.'
      );
    }

    const count = Number(typeof this._cpuCount === 'function' ? this._cpuCount() : this._cpuCount);
    const threads = Math.max(1, Math.min(4, Math.floor((Number.isFinite(count) ? count : 1) * 0.75)));
    const detached = this._platform !== 'win32';
    let child;
    try {
      child = this._spawn(
        inspection.runtime.path,
        buildParakeetArgs({ modelPath: inspection.model.path, port, threads }),
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: this._tempDirectory, detached }
      );
      if (mayOwnSpawnedProcess(child)) {
        const record = this._trackOwnedChild(child, detached);
        if (record.trackingError) throw record.trackingError;
      }
      if (!child || typeof child.on !== 'function' || !child.stderr || typeof child.stderr.on !== 'function') {
        throw new TypeError('Spawn did not return a child process with piped stderr.');
      }
    } catch (cause) {
      if (child && this._ownedChildren.has(child)) await this._beginFailedChildCleanup(child);
      const error = localError(
        'runtime_spawn_failed',
        'The Parakeet runtime could not be started.',
        'Verify that the configured runtime is executable and compatible.',
        { cause: String(cause && cause.message || cause) }
      );
      if (generation === this._generation) {
        this._state = 'error';
        this._emitStatus({ status: 'error', error: errorRecord(error) });
      }
      throw error;
    }

    this._trackOwnedChild(child, detached);
    this._child = child;
    this._port = port;
    return new Promise((resolve, reject) => {
      let settled = false;
      let readinessText = '';
      let readinessTimer = null;

      const clearReadiness = () => {
        if (readinessTimer !== null) {
          this._clearTimeout(readinessTimer);
          readinessTimer = null;
        }
        removeListener(child.stderr, 'data', onData);
        if (this._cancelReadiness === cancelStart) this._cancelReadiness = null;
      };
      const removeChildListeners = () => {
        removeListener(child, 'error', onError);
        removeListener(child, 'exit', onExit);
        if (this._childListeners && this._childListeners.child === child) this._childListeners = null;
      };
      const failStart = (error, keepChild = false) => {
        if (settled) return;
        settled = true;
        clearReadiness();
        if (!keepChild) {
          removeChildListeners();
          if (this._child === child) this._child = null;
          this._port = null;
        }
        if (generation === this._generation && this._state !== 'stopping') {
          this._state = 'error';
          this._emitStatus({ status: 'error', error: errorRecord(error) });
        }
        reject(error);
        if (generation === this._generation && this._cancelGenerationStart) {
          this._cancelGenerationStart(error);
        }
      };
      const cancelStart = (error) => failStart(error, true);
      const onData = (chunk) => {
        if (settled || generation !== this._generation) return;
        const combined = `${readinessText}${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)}`;
        if (!combined.includes('Listening on:')) {
          readinessText = combined.slice(-256);
          return;
        }
        settled = true;
        clearReadiness();
        this._state = 'ready';
        this._emitStatus({ status: 'ready', message: 'Local Parakeet is ready.', port });
        resolve(inspection);
      };
      const onError = (cause) => {
        const error = localError(
          'runtime_spawn_failed',
          'The Parakeet runtime reported a process error.',
          'Verify that the configured runtime is executable and compatible.',
          { cause: String(cause && cause.message || cause) }
        );
        if (!settled) {
          failStart(error, true);
          this._beginFailedChildCleanup(child);
        } else {
          this._handleChildFailure(child, generation, error, true);
          this._beginFailedChildCleanup(child);
        }
      };
      const onExit = (code, signal) => {
        const error = localError(
          'engine_exit',
          `Parakeet exited unexpectedly${signal ? ` from ${signal}` : ` with code ${code}`}.`,
          'Restart the local speech engine.',
          { code: code === undefined ? null : code, signal: signal || null }
        );
        if (!settled) failStart(error);
        else if (this._state === 'error' && generation === this._generation && child === this._child) {
          removeChildListeners();
          this._child = null;
          this._port = null;
        } else if (this._state !== 'stopping') this._handleChildFailure(child, generation, error);
      };

      this._childListeners = { child, onError, onExit };
      this._cancelReadiness = cancelStart;
      try {
        addListener(child.stderr, 'data', onData);
        addListener(child, 'error', onError);
        addListener(child, 'exit', onExit);
      } catch (cause) {
        const error = localError(
          'runtime_spawn_failed',
          'Cue could not monitor the spawned Parakeet runtime.',
          'Verify that the configured runtime is executable and compatible.',
          { cause: String(cause && cause.message || cause) }
        );
        clearReadiness();
        removeChildListeners();
        Promise.resolve(this._beginFailedChildCleanup(child)).then(
          () => failStart(error),
          () => failStart(error)
        );
        return;
      }
      readinessTimer = this._setTimeout(() => {
        const error = localError(
          'readiness_timeout',
          'Parakeet did not become ready within 15 seconds.',
          'Verify the runtime and model, then try again.'
        );
        failStart(error, true);
        Promise.resolve(this._beginStop(true)).catch(() => {});
      }, READINESS_TIMEOUT_MS);
    });
  }

  _removeChildListeners(child = this._child) {
    const listeners = this._childListeners;
    if (!listeners || listeners.child !== child) return;
    removeListener(child, 'error', listeners.onError);
    removeListener(child, 'exit', listeners.onExit);
    this._childListeners = null;
  }

  _trackOwnedChild(child, detached) {
    if (this._ownedChildren.has(child)) return this._ownedChildren.get(child);
    let resolveExited;
    const exited = new Promise((resolve) => { resolveExited = resolve; });
    const record = {
      child, detached, exited, disposal: null, trackingError: null, finished: false,
      onError: () => {},
      onExit: null,
      finish: () => {
        if (record.finished) return;
        record.finished = true;
        removeListener(child, 'error', record.onError);
        removeListener(child, 'exit', record.onExit);
        this._ownedChildren.delete(child);
        resolveExited();
      }
    };
    record.onExit = record.finish;
    this._ownedChildren.set(child, record);
    try {
      addListener(child, 'error', record.onError);
      addListener(child, 'exit', record.onExit);
    } catch (error) {
      record.trackingError = error;
      removeListener(child, 'error', record.onError);
      removeListener(child, 'exit', record.onExit);
    }
    return record;
  }

  _disposeOwnedChild(child) {
    const record = this._ownedChildren.get(child);
    if (!record) return Promise.resolve();
    if (childKnownExited(child)) {
      record.finish();
      return Promise.resolve();
    }
    if (record.disposal) return record.disposal;
    const disposal = (async () => {
      let timer = null;
      const exited = await Promise.race([
        record.exited.then(() => true),
        new Promise((resolve) => {
          timer = this._setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
        })
      ].map((promise) => Promise.resolve(promise)));
      if (timer !== null) this._clearTimeout(timer);
      if (exited) return;
      this._signalChild(child, 'SIGKILL', record.detached);
      if (childKnownExited(child)) record.finish();
    })();
    record.disposal = Promise.resolve().then(() => {
      this._signalChild(child, 'SIGTERM', record.detached);
      return disposal;
    }).finally(() => {
      if (record.disposal) record.disposal = null;
    });
    return record.disposal;
  }

  _beginFailedChildCleanup(child) {
    this._removeChildListeners(child);
    const cleanup = this._disposeOwnedChild(child).then(() => {
      this._removeChildListeners(child);
      if (this._child === child) {
        this._child = null;
        this._port = null;
      }
    });
    this._failedChildCleanup = cleanup;
    cleanup.finally(() => {
      if (this._failedChildCleanup === cleanup) this._failedChildCleanup = null;
    }).catch(() => {});
    return cleanup;
  }

  _handleChildFailure(child, generation, error, retainChild = false) {
    if (generation !== this._generation || child !== this._child || this._state === 'error') return;
    this._state = 'error';
    this._removeChildListeners(child);
    if (!retainChild) {
      this._child = null;
      this._port = null;
    }
    this._rejectAll(error);
    this._emitStatus({ status: 'error', error: errorRecord(error) });
  }

  transcribe(options) {
    let frame;
    let channel;
    let timeoutMs;
    try {
      if (!options || typeof options !== 'object') throw new TypeError('A transcription request is required.');
      channel = options.channel;
      if (typeof channel !== 'string' || !channel.trim() || channel.length > 128) {
        throw new TypeError('Transcription channel must be a non-empty string.');
      }
      try {
        validateSampleRate(options.sampleRate);
      } catch (cause) {
        throw localError(
          'invalid_sample_rate',
          `Parakeet requires an integer sample rate from ${MIN_SAMPLE_RATE} to ${MAX_SAMPLE_RATE} Hz.`,
          'Provide the actual integer sample rate for this PCM segment.',
          { cause: String(cause && cause.message || cause) }
        );
      }
      let durationMs;
      try {
        const pcmByteLength = byteViewLength(options.pcm16, 'PCM audio');
        if (pcmByteLength === 0) throw new RangeError('PCM audio must contain audio samples.');
        if (pcmByteLength % 2 !== 0) {
          throw new RangeError('PCM audio must contain complete 16-bit samples.');
        }
        durationMs = (pcmByteLength / 2) / options.sampleRate * 1000;
        if (durationMs > MAX_AUDIO_DURATION_MS) {
          throw localError(
            'audio_too_large',
            'Parakeet accepts at most 30 seconds of audio per request.',
            'Split the audio into segments of 30 seconds or less.'
          );
        }
        const float32 = pcm16ToFloat32Buffer(options.pcm16);
        frame = buildOfflineMessage(float32, options.sampleRate);
      } catch (cause) {
        if (cause instanceof LocalSttError) throw cause;
        throw localError(
          'invalid_audio',
          'Parakeet requires complete PCM16 audio samples in a Buffer or typed array.',
          'Provide a non-empty, complete PCM16 segment and try again.',
          { cause: String(cause && cause.message || cause) }
        );
      }
      timeoutMs = Math.max(MIN_TRANSCRIPTION_TIMEOUT_MS, durationMs * 4);
      if (this._state !== 'ready' || !this._child || !this._port) {
        throw localError('engine_not_ready', 'Parakeet is not ready to transcribe.', 'Start Parakeet and try again.');
      }
    } catch (error) {
      return Promise.reject(error);
    }

    let queue = this._queues.get(channel);
    if (!queue) {
      queue = { running: false, pending: [], requestCount: 0, retainedBytes: 0 };
      this._queues.set(channel, queue);
    }
    if (queue.requestCount >= this._limits.maxChannelRequests ||
        queue.retainedBytes + frame.byteLength > this._limits.maxChannelRetainedBytes) {
      if (!queue.running && queue.pending.length === 0) this._queues.delete(channel);
      return Promise.reject(localError(
        'engine_overloaded',
        `Parakeet already has too much queued work for channel ${channel}.`,
        'Wait for the current transcription work to finish and try again.'
      ));
    }

    return new Promise((resolve, reject) => {
      const request = {
        channel, frame, timeoutMs, resolve, reject, settled: false, abort: null,
        queue, retainedBytes: frame.byteLength, released: false
      };
      queue.requestCount += 1;
      queue.retainedBytes += frame.byteLength;
      queue.pending.push(request);
      this._drainChannel(channel, queue);
    });
  }

  _settleRequest(request, error, value) {
    if (request.settled) return;
    request.settled = true;
    if (!request.released && request.queue) {
      request.released = true;
      request.queue.requestCount = Math.max(0, request.queue.requestCount - 1);
      request.queue.retainedBytes = Math.max(0, request.queue.retainedBytes - request.retainedBytes);
    }
    if (error) request.reject(error);
    else request.resolve(value);
  }

  _drainChannel(channel, queue) {
    if (queue.running) return;
    const request = queue.pending.shift();
    if (!request) {
      if (this._queues.get(channel) === queue) this._queues.delete(channel);
      return;
    }
    if (this._state !== 'ready') {
      this._settleRequest(request, localError('engine_stopped', 'Parakeet stopped before transcription began.', 'Start Parakeet again.'));
      this._drainChannel(channel, queue);
      return;
    }
    queue.running = true;
    this._active.add(request);
    this._runRequest(request).then(
      (value) => this._settleRequest(request, null, value),
      (error) => this._settleRequest(request, error)
    ).finally(() => {
      this._active.delete(request);
      request.abort = null;
      queue.running = false;
      this._drainChannel(channel, queue);
    });
  }

  _runRequest(request) {
    return new Promise((resolve, reject) => {
      let socket;
      let timer = null;
      let settled = false;
      let doneSent = false;
      let closeRequested = false;
      const results = [];
      let resultBytes = 0;
      let resultMessages = 0;
      let resultError = null;
      const startedAt = this._now();

      const clearTimer = () => {
        if (timer !== null) {
          this._clearTimeout(timer);
          timer = null;
        }
      };
      const cleanup = () => {
        clearTimer();
        removeListener(socket, 'open', onOpen);
        removeListener(socket, 'message', onMessage);
        removeListener(socket, 'error', onError);
        removeListener(socket, 'close', onClose);
      };
      const abortSocket = () => {
        if (closeRequested) return;
        closeRequested = true;
        if (!socket) {
          cleanup();
          return;
        }
        if (socket.readyState === 3) {
          cleanup();
          return;
        }
        if (socket.readyState === 0) {
          safeClose(socket);
          return;
        }
        if (typeof socket.terminate === 'function') {
          try { socket.terminate(); } catch { safeClose(socket); }
        } else safeClose(socket);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimer();
        reject(error);
        abortSocket();
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ text: results.join(' ').trim(), elapsedMs: Math.max(0, this._now() - startedAt) });
      };
      const sendDone = () => {
        if (doneSent) return;
        doneSent = true;
        try { socket.send('Done'); } catch (cause) {
          fail(localError(
            'protocol_failure',
            'Parakeet could not finish the transcription request.',
            'Restart the local speech engine and try again.',
            { cause: String(cause && cause.message || cause) }
          ));
        }
      };
      const onOpen = () => {
        try { socket.send(request.frame); } catch (cause) {
          fail(localError(
            'protocol_failure',
            'Parakeet could not receive the audio request.',
            'Restart the local speech engine and try again.',
            { cause: String(cause && cause.message || cause) }
          ));
        }
      };
      const onMessage = (data) => {
        if (settled) return;
        let text;
        try {
          let byteLength;
          if (typeof data === 'string') byteLength = Buffer.byteLength(data);
          else if (Buffer.isBuffer(data) || ArrayBuffer.isView(data) || data instanceof ArrayBuffer) byteLength = data.byteLength;
          else byteLength = Buffer.byteLength(String(data));
          resultMessages += 1;
          resultBytes += byteLength;
          if (resultMessages > this._limits.maxResultMessages || resultBytes > this._limits.maxResultBytes) {
            throw localError(
              'protocol_failure',
              'Parakeet returned more transcription data than Cue accepts.',
              'Restart the local speech engine and try a shorter segment.'
            );
          }
          if (Buffer.isBuffer(data)) text = data.toString('utf8');
          else if (ArrayBuffer.isView(data)) text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
          else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
          else text = String(data);
          text = text.trim();
          if (!text) throw new Error('The result was empty.');
          let parsed;
          try { parsed = JSON.parse(text); } catch {
            results.push(text);
            sendDone();
            return;
          }
          if (!parsed || typeof parsed !== 'object' || typeof parsed.text !== 'string' || !parsed.text.trim()) {
            throw new Error('The JSON result does not contain text.');
          }
          results.push(parsed.text.trim());
        } catch (cause) {
          if (cause instanceof LocalSttError) {
            fail(cause);
            return;
          }
          resultError = localError(
            'protocol_failure',
            'Parakeet returned an empty or malformed transcription result.',
            'Restart the local speech engine and try again.',
            { cause: String(cause && cause.message || cause) }
          );
        }
        sendDone();
      };
      const onError = (cause) => fail(localError(
        'protocol_failure',
        'The Parakeet WebSocket request failed.',
        'Restart the local speech engine and try again.',
        { cause: String(cause && cause.message || cause) }
      ));
      const onClose = () => {
        if (settled) {
          cleanup();
          return;
        }
        if (results.length === 0) {
          settled = true;
          cleanup();
          reject(resultError || localError(
            'protocol_failure',
            'Parakeet closed without a transcription result.',
            'Restart the local speech engine and try again.'
          ));
          return;
        }
        succeed();
      };

      request.abort = (error) => fail(error);
      try {
        socket = new this._WebSocket(`ws://${LOOPBACK_HOST}:${this._port}`, {
          maxPayload: this._limits.maxResultBytes
        });
        addListener(socket, 'open', onOpen);
        addListener(socket, 'message', onMessage);
        addListener(socket, 'error', onError);
        addListener(socket, 'close', onClose);
      } catch (cause) {
        fail(localError(
          'protocol_failure',
          'The Parakeet WebSocket could not be opened.',
          'Restart the local speech engine and try again.',
          { cause: String(cause && cause.message || cause) }
        ));
        return;
      }
      timer = this._setTimeout(() => fail(localError(
        'transcription_timeout',
        'Parakeet transcription timed out.',
        'Try a shorter audio segment or restart the local speech engine.'
      )), request.timeoutMs);
    });
  }

  _rejectAll(error) {
    for (const request of [...this._active]) {
      if (typeof request.abort === 'function') request.abort(error);
      else this._settleRequest(request, error);
    }
    for (const queue of this._queues.values()) {
      for (const request of queue.pending.splice(0)) this._settleRequest(request, error);
    }
  }

  _signalChild(child, signal, detached) {
    if (!child || childKnownExited(child)) return;
    try { consumeRejection(this._stopProcess(child, signal, { detached })); } catch {}
  }

  stop() {
    return this._beginStop(false);
  }

  _beginStop(preserveError) {
    if (this._stopPromise) {
      if (!preserveError) this._preserveStopError = false;
      return this._stopPromise;
    }
    if (this._state === 'idle' && !this._child && this._ownedChildren.size === 0 && this._active.size === 0 && this._queues.size === 0) {
      return Promise.resolve();
    }
    this._preserveStopError = preserveError;
    const promise = this._performStop();
    this._stopPromise = promise;
    promise.then(
      () => {
        if (this._stopPromise === promise) {
          this._stopPromise = null;
          this._preserveStopError = false;
        }
      },
      () => {
        if (this._stopPromise === promise) {
          this._stopPromise = null;
          this._preserveStopError = false;
        }
      }
    );
    return promise;
  }

  async _performStop() {
    ++this._generation;
    this._state = 'stopping';
    const stoppedError = localError(
      'engine_stopped',
      'Parakeet stopped before transcription completed.',
      'Start Parakeet again.'
    );
    if (this._cancelGenerationStart) this._cancelGenerationStart(stoppedError);
    if (this._cancelReadiness) this._cancelReadiness(stoppedError);
    this._rejectAll(stoppedError);

    const child = this._child;
    await Promise.all([...this._ownedChildren.keys()].map((ownedChild) => this._disposeOwnedChild(ownedChild)));

    this._removeChildListeners(child);
    this._child = null;
    this._port = null;
    this._inspection = null;
    this._cancelGenerationStart = null;
    this._cancelReadiness = null;
    this._queues.clear();
    this._active.clear();
    if (this._preserveStopError) this._state = 'error';
    else {
      this._state = 'idle';
      this._emitStatus({ status: 'off', message: 'Local Parakeet stopped.' });
    }
  }
}

module.exports = {
  ParakeetTranscriber,
  buildOfflineMessage,
  pcm16ToFloat32Buffer
};
