const { LocalSttError, normalizeEngineInspection } = require('./local-stt-engine');
const { LocalWhisperTranscriber } = require('./local-whisper-transcriber');
const { DEFAULT_MODEL_ID, requireWhisperModel } = require('./whisper-model-catalog');
const { locateWhisperRuntime } = require('./whisper-runtime');

const CHANNELS = Object.freeze(['you', 'them']);
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 120000;
const DEFAULT_MAX_QUEUE_PER_CHANNEL = 16;
const DEFAULT_STOP_TIMEOUT_MS = 15000;
const MAX_SEGMENT_SECONDS = 30;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function stoppedError() {
  return new LocalSttError('stt_stopped', 'Local Whisper stopped before transcription completed.', 'Start Local Whisper again.');
}

function cloneFrozen(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozen));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const clone = {};
  for (const [key, child] of Object.entries(value)) clone[key] = cloneFrozen(child);
  return Object.freeze(clone);
}

function modelError(error) {
  const corruptCodes = new Set([
    'MODEL_CHECKSUM_MISMATCH',
    'ARTIFACT_CHECKSUM_MISMATCH',
    'ARTIFACT_SIZE_MISMATCH'
  ]);
  if (corruptCodes.has(error?.code)) {
    return {
      code: 'model_corrupt',
      message: 'The selected Whisper model failed mandatory checksum verification.',
      action: 'Download or import the selected Whisper model again.'
    };
  }
  return {
    code: 'model_missing',
    message: 'The selected Whisper model is missing or unreadable.',
    action: 'Download the selected Whisper model in Settings.'
  };
}

class WhisperEngine {
  constructor({
    modelId = DEFAULT_MODEL_ID,
    requireModel = requireWhisperModel,
    locateRuntime = locateWhisperRuntime,
    runtimeOptions = {},
    modelManager,
    transcriberFactory = (options) => new LocalWhisperTranscriber(options),
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    transcriptionTimeoutMs = DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
    maxQueuePerChannel = DEFAULT_MAX_QUEUE_PER_CHANNEL,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    onObserverError = () => {}
  } = {}) {
    if (!modelManager || typeof modelManager.verifyInstalledModel !== 'function') {
      throw new TypeError('WhisperEngine requires a checksum-verifying model manager.');
    }
    if (typeof requireModel !== 'function' || typeof locateRuntime !== 'function' || typeof transcriberFactory !== 'function') {
      throw new TypeError('WhisperEngine dependencies must be functions.');
    }
    this.id = 'whisper';
    this.modelId = modelId;
    this.requireModel = requireModel;
    this.locateRuntime = locateRuntime;
    this.runtimeOptions = { ...runtimeOptions };
    this.modelManager = modelManager;
    this.transcriberFactory = transcriberFactory;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.transcriptionTimeoutMs = transcriptionTimeoutMs;
    this.maxQueuePerChannel = maxQueuePerChannel;
    this.stopTimeoutMs = stopTimeoutMs;
    this.onObserverError = onObserverError;
    this.inspectionContext = null;
    this.transcriber = null;
    this.generation = 0;
    this.running = false;
    this.startPromise = null;
    this.stopPromise = null;
    this.requestCounter = 0n;
    this.requests = new Set();
    this.pendingById = new Map();
    this.channelTails = new Map(CHANNELS.map((channel) => [channel, Promise.resolve()]));
    this.statusListeners = new Set();
  }

  async inspect(settings = {}) {
    const modelId = settings.modelId || settings.localWhisper?.modelId || this.modelId;
    let runtime = null;
    let runtimeFailure = null;
    let model = null;
    let modelPath = null;
    let modelFailure = null;

    try {
      runtime = await this.locateRuntime({ ...this.runtimeOptions, ...settings.runtimeOptions });
      if (!runtime?.available || !runtime.executablePath || !runtime.runtimeDirectory) {
        runtimeFailure = {
          code: 'runtime_missing',
          message: runtime?.message || 'The local Whisper runtime is missing.',
          action: runtime?.message && /prepare:whisper/.test(runtime.message)
            ? runtime.message
            : 'Run npm run prepare:whisper to prepare the local runtime.'
        };
      }
    } catch (error) {
      runtimeFailure = {
        code: error?.code === 'EACCES' ? 'runtime_not_executable' : 'runtime_missing',
        message: error?.message || 'The local Whisper runtime could not be located.',
        action: error?.code === 'EACCES'
          ? 'Repair executable permissions or run npm run prepare:whisper again.'
          : 'Run npm run prepare:whisper for this platform.'
      };
    }

    try {
      model = this.requireModel(modelId);
      modelPath = await this.modelManager.verifyInstalledModel(model.id);
    } catch (error) {
      modelFailure = modelError(error);
    }

    const errors = [runtimeFailure, modelFailure].filter(Boolean);
    const inspection = normalizeEngineInspection({
      id: this.id,
      healthy: errors.length === 0,
      runtime: runtimeFailure ? null : {
        path: runtime.executablePath,
        source: runtime.source || ((runtime.isPackaged ?? this.runtimeOptions.isPackaged) ? 'packaged' : 'prepared'),
        version: runtime.version || null
      },
      model: modelFailure ? null : {
        path: modelPath,
        source: 'cue',
        fingerprint: model.sha256
      },
      errors
    });
    this.inspectionContext = errors.length === 0
      ? { inspection, runtime: { ...runtime }, model: { ...model }, modelPath, settings: { ...settings } }
      : null;
    return normalizeEngineInspection(inspection);
  }

  start(options = {}) {
    if (this.startPromise) return this.startPromise;
    if (this.running) return Promise.resolve();
    const waitForStop = this.stopPromise || Promise.resolve();
    const generation = this.generation + 1;
    this.generation = generation;
    const operation = waitForStop.then(() => this._performStart(options, generation));
    const exposed = operation.finally(() => {
      if (this.startPromise === exposed) this.startPromise = null;
    });
    this.startPromise = exposed;
    return exposed;
  }

  onStatus(callback) {
    if (typeof callback !== 'function') throw new TypeError('Whisper status observer must be a function.');
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  async _performStart(options, generation) {
    let context = this.inspectionContext;
    if (!context || (options.inspection && options.inspection.model?.path !== context.inspection.model?.path)) {
      const inspection = await this.inspect(options.settings || {});
      if (!inspection.healthy) {
        const reason = inspection.errors[0];
        throw new LocalSttError(reason.code, reason.message, reason.action);
      }
      context = this.inspectionContext;
    }
    if (generation !== this.generation) throw new LocalSttError('stt_stopped', 'Whisper startup was stopped.', 'Start Whisper again.');
    const localSettings = options.settings?.localWhisper || options.settings || context.settings.localWhisper || context.settings;
    const transcriber = this.transcriberFactory({
      sessionOptions: {
        executablePath: context.runtime.executablePath,
        runtimeDirectory: context.runtime.runtimeDirectory,
        modelPath: context.modelPath,
        language: context.model.englishOnly ? 'en' : (localSettings.language || 'auto'),
        threads: Number(localSettings.threads) || 0,
        tinydiarize: Boolean(context.model.tinydiarize)
      },
      onTranscript: (...args) => this._onTranscript(generation, ...args),
      onStatus: (...args) => this._onTranscriberStatus(generation, ...args),
      onError: (...args) => this._onTranscriberError(generation, ...args)
    });
    this.transcriber = transcriber;
    try {
      await transcriber.start();
    } catch (error) {
      if (this.transcriber === transcriber) this.transcriber = null;
      await Promise.resolve(transcriber.forceStop?.()).catch(() => {});
      throw error;
    }
    if (generation !== this.generation) {
      if (this.transcriber === transcriber) this.transcriber = null;
      await Promise.resolve(transcriber.forceStop?.() || transcriber.stop()).catch(() => {});
      throw new LocalSttError('stt_stopped', 'Whisper startup was stopped.', 'Start Whisper again.');
    }
    this.running = true;
  }

  transcribe(segment) {
    if (!this.running || !this.transcriber || this.stopPromise) return Promise.reject(stoppedError());
    let copy;
    try {
      copy = this._copyAndValidateSegment(segment);
    } catch (error) {
      return Promise.reject(error);
    }
    const channelCount = Array.from(this.requests).filter((request) => request.channel === copy.channel && !request.settled).length;
    if (channelCount >= this.maxQueuePerChannel) {
      return Promise.reject(new LocalSttError(
        'queue_full',
        `The ${copy.channel} Whisper queue is full.`,
        'Wait for pending Local Whisper transcription to finish.'
      ));
    }

    this.requestCounter += 1n;
    const completion = deferred();
    const request = {
      id: `whisper-${this.generation}-${this.requestCounter.toString(36)}`,
      channel: copy.channel,
      pcm16: copy.pcm16,
      generation: this.generation,
      completion,
      settled: false,
      timer: null,
      startedAt: null
    };
    this.requests.add(request);
    const previous = this.channelTails.get(copy.channel);
    const operation = previous.catch(() => {}).then(() => this._beginRequest(request));
    const tail = operation.catch(() => {}).finally(() => {
      this.requests.delete(request);
      if (this.channelTails.get(copy.channel) === tail) this.channelTails.set(copy.channel, Promise.resolve());
    });
    this.channelTails.set(copy.channel, tail);
    return completion.promise;
  }

  _beginRequest(request) {
    if (request.settled) return request.completion.promise.catch(() => {});
    if (!this.running || request.generation !== this.generation || !this.transcriber) {
      this._settleRequest(request, 'reject', stoppedError());
      return request.completion.promise.catch(() => {});
    }
    request.startedAt = this.now();
    this.pendingById.set(request.id, request);
    request.timer = this.setTimer(() => {
      this._settleRequest(request, 'reject', new LocalSttError(
        'transcription_timeout',
        'Local Whisper transcription timed out.',
        'Retry the segment or restart Local Whisper.'
      ));
    }, this.transcriptionTimeoutMs);
    try {
      this.transcriber.push(request.channel, request.pcm16, request.id);
    } catch (error) {
      this._settleRequest(request, 'reject', error);
    }
    return request.completion.promise;
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.running = false;
    this.generation += 1;
    for (const request of this.requests) this._settleRequest(request, 'reject', stoppedError());
    const transcriber = this.transcriber;
    this.transcriber = null;
    const wasStarting = Boolean(this.startPromise);
    const operation = Promise.resolve().then(async () => {
      if (transcriber) await this._boundedTranscriberStop(transcriber, wasStarting);
    });
    const exposed = operation.finally(() => {
      if (this.stopPromise === exposed) this.stopPromise = null;
    });
    this.stopPromise = exposed;
    return exposed;
  }

  async _boundedTranscriberStop(transcriber, force) {
    let timer = null;
    const stopping = Promise.resolve().then(() => (
      force && typeof transcriber.forceStop === 'function'
        ? transcriber.forceStop()
        : transcriber.stop()
    ));
    try {
      await Promise.race([
        stopping.catch(() => {}),
        new Promise((resolve) => { timer = this.setTimer(resolve, this.stopTimeoutMs); })
      ]);
    } finally {
      if (timer !== null) this.clearTimer(timer);
    }
  }

  _onTranscript(generation, channel, text, requestId) {
    if (generation !== this.generation || !this.running) return;
    const request = this.pendingById.get(requestId);
    if (!request || request.channel !== channel || request.generation !== generation) return;
    const elapsedMs = Math.max(0, this.now() - request.startedAt);
    this._settleRequest(request, 'resolve', Object.freeze({ text: String(text || '').trim(), elapsedMs }));
  }

  _onTranscriberStatus(generation, status) {
    if (generation !== this.generation) return;
    const snapshot = cloneFrozen(status || {});
    for (const listener of this.statusListeners) {
      try {
        const result = listener(cloneFrozen(snapshot));
        if (result && (typeof result === 'object' || typeof result === 'function')) {
          Promise.resolve(result).catch((error) => this._reportObserverError(error));
        }
      } catch (error) {
        this._reportObserverError(error);
      }
    }
  }

  _onTranscriberError(generation, error, channel, requestId) {
    if (generation !== this.generation || !this.running) return;
    const request = this.pendingById.get(requestId);
    if (request && (!channel || request.channel === channel)) {
      this._settleRequest(request, 'reject', error);
      return;
    }
    if (!requestId) {
      for (const active of this.requests) this._settleRequest(active, 'reject', error);
    }
  }

  _copyAndValidateSegment(segment) {
    if (!segment || typeof segment !== 'object' || !CHANNELS.includes(segment.channel)) {
      throw new LocalSttError('invalid_segment', 'Whisper requires channel "you" or "them".', 'Retry with valid local audio metadata.');
    }
    if (!Number.isInteger(segment.sampleRate) || segment.sampleRate !== 16000) {
      throw new LocalSttError('invalid_segment', 'Whisper requires PCM labelled at 16 kHz.', 'Resample local audio to 16 kHz before transcription.');
    }
    if (!Buffer.isBuffer(segment.pcm16) && !ArrayBuffer.isView(segment.pcm16)) {
      throw new LocalSttError('invalid_segment', 'Whisper requires PCM16 bytes.', 'Retry with valid local PCM16 audio.');
    }
    const source = Buffer.from(segment.pcm16.buffer, segment.pcm16.byteOffset, segment.pcm16.byteLength);
    if (source.length === 0 || source.length % 2 !== 0 || source.length > segment.sampleRate * 2 * MAX_SEGMENT_SECONDS) {
      throw new LocalSttError('invalid_segment', `Whisper accepts complete PCM16 samples up to ${MAX_SEGMENT_SECONDS} seconds.`, 'Retry with bounded local audio.');
    }
    return { channel: segment.channel, pcm16: Buffer.from(source), sampleRate: segment.sampleRate };
  }

  _settleRequest(request, method, value) {
    if (request.settled) return;
    request.settled = true;
    if (request.timer !== null) {
      this.clearTimer(request.timer);
      request.timer = null;
    }
    this.pendingById.delete(request.id);
    request.completion[method](value);
  }

  _reportObserverError(error) {
    try {
      const result = this.onObserverError(error, { kind: 'whisper-status' });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Status diagnostics cannot break local inference.
    }
  }
}

module.exports = {
  DEFAULT_MAX_QUEUE_PER_CHANNEL,
  DEFAULT_STOP_TIMEOUT_MS,
  DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
  WhisperEngine
};
