const { LocalSttError, normalizeEngineInspection } = require('./local-stt-engine');

const ENGINE_IDS = Object.freeze(['parakeet', 'whisper']);
const CHANNELS = Object.freeze(['you', 'them']);
const BENCHMARK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const BENCHMARK_LOSER_TIMEOUT_MS = 15000;
const DEFAULT_MAX_QUEUED_TRANSCRIPTIONS = 32;
const DEFAULT_STOP_TIMEOUT_MS = 15000;
const MAX_SEGMENT_SECONDS = 30;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneStatus(status) {
  return deepFreeze({
    phase: status.phase,
    requestedEngine: status.requestedEngine,
    activeEngine: status.activeEngine,
    detail: status.detail
  });
}

function buildBenchmarkCacheKey(inspections, { platform = process.platform, arch = process.arch } = {}) {
  if (!Array.isArray(inspections)) throw new TypeError('Benchmark inspections must be an array.');
  const byId = new Map(inspections.map((value) => [value.id, value]));
  return JSON.stringify({
    platform,
    arch,
    engines: ENGINE_IDS.map((id) => ({
      id,
      runtimeVersion: byId.get(id)?.runtime?.version ?? null,
      modelFingerprint: byId.get(id)?.model?.fingerprint ?? null
    }))
  });
}

function engineTitle(id) {
  return id === 'whisper' ? 'Whisper' : 'Parakeet';
}

function stoppedError() {
  return new LocalSttError('stt_stopped', 'Local speech recognition stopped before transcription completed.', 'Start a new local transcription session.');
}

function queueFullError() {
  return new LocalSttError('queue_full', 'The local transcription queue is full.', 'Wait for pending local transcription to finish.');
}

function normalizeResult(result, engineId) {
  if (!result || typeof result !== 'object') return { text: '', elapsedMs: null, engine: engineId };
  return {
    ...result,
    text: typeof result.text === 'string' ? result.text : '',
    elapsedMs: Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0 ? result.elapsedMs : null,
    engine: engineId
  };
}

class LocalSttManager {
  constructor({
    engines,
    platform = process.platform,
    architecture = process.arch,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    loadBenchmark = () => null,
    saveBenchmark = async () => {},
    isValidTranscript = (text) => typeof text === 'string' && text.trim().length > 0,
    dispatch = () => {},
    onObserverError = () => {},
    benchmarkMaxAgeMs = BENCHMARK_MAX_AGE_MS,
    benchmarkLoserTimeoutMs = BENCHMARK_LOSER_TIMEOUT_MS,
    maxQueuedTranscriptions = DEFAULT_MAX_QUEUED_TRANSCRIPTIONS,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS
  }) {
    if (!Array.isArray(engines) || engines.length !== 2 ||
        new Set(engines.map((engine) => engine?.id)).size !== 2 ||
        !ENGINE_IDS.every((id) => engines.some((engine) => engine?.id === id))) {
      throw new TypeError('LocalSttManager requires exactly parakeet and whisper engines.');
    }
    for (const engine of engines) {
      for (const method of ['inspect', 'start', 'transcribe', 'stop']) {
        if (typeof engine[method] !== 'function') throw new TypeError(`The ${engine.id} engine requires ${method}().`);
      }
    }
    if (typeof loadBenchmark !== 'function' || typeof saveBenchmark !== 'function' ||
        typeof isValidTranscript !== 'function' || typeof dispatch !== 'function') {
      throw new TypeError('LocalSttManager dependencies must be functions.');
    }
    if (!Number.isInteger(maxQueuedTranscriptions) || maxQueuedTranscriptions < 1) {
      throw new TypeError('maxQueuedTranscriptions must be a positive integer.');
    }

    this.engines = new Map(engines.map((engine) => [engine.id, engine]));
    this.platform = platform;
    this.architecture = architecture;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.loadBenchmark = loadBenchmark;
    this.saveBenchmark = saveBenchmark;
    this.isValidTranscript = isValidTranscript;
    this.dispatch = dispatch;
    this.onObserverError = onObserverError;
    this.benchmarkMaxAgeMs = benchmarkMaxAgeMs;
    this.benchmarkLoserTimeoutMs = benchmarkLoserTimeoutMs;
    this.maxQueuedTranscriptions = maxQueuedTranscriptions;
    this.stopTimeoutMs = stopTimeoutMs;

    this.status = cloneStatus({ phase: 'off', requestedEngine: null, activeEngine: null, detail: null });
    this.listeners = new Set();
    this.inspections = new Map();
    this.healthyIds = [];
    this.startedEngines = new Set();
    this.failedEngines = new Set();
    this.activeEngineId = null;
    this.fallbackDetail = null;
    this.requestedEngine = null;
    this.cacheKey = null;
    this.needsBenchmark = false;
    this.benchmarkPending = Promise.resolve();
    this.generation = 0;
    this.generationStop = deferred();
    this.running = false;
    this.startPromise = null;
    this.stopPromise = null;
    this.jobs = new Set();
    this.channelTails = new Map(CHANNELS.map((channel) => [channel, Promise.resolve()]));
  }

  onStatus(callback) {
    if (typeof callback !== 'function') throw new TypeError('Status observer must be a function.');
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  getStatus() {
    return cloneStatus(this.status);
  }

  inspect(settings = {}) {
    return this._inspectEngineIds(ENGINE_IDS, settings).then((values) => deepFreeze(values.map((value) => deepFreeze(normalizeEngineInspection(value)))));
  }

  start(settings = {}) {
    if (this.startPromise) return this.startPromise;
    if (this.running) return Promise.resolve(this.getStatus());
    const waitForStop = this.stopPromise || Promise.resolve();
    const generation = this.generation + 1;
    this.generation = generation;
    this.generationStop = deferred();
    const operation = waitForStop.then(() => this._performStart(settings, generation));
    const exposed = operation.finally(() => {
      if (this.startPromise === exposed) this.startPromise = null;
    });
    this.startPromise = exposed;
    return exposed;
  }

  async _performStart(settings, generation) {
    const requestedEngine = settings.requestedEngine || 'auto';
    if (!['auto', ...ENGINE_IDS].includes(requestedEngine)) {
      throw new LocalSttError('invalid_engine', `Unknown local engine: ${requestedEngine}`, 'Choose Auto, Parakeet, or Whisper.');
    }
    this.requestedEngine = requestedEngine;
    this.failedEngines.clear();
    this.fallbackDetail = null;
    this.cacheKey = null;
    this.needsBenchmark = false;
    this._emit({ phase: 'probing', requestedEngine, activeEngine: null, detail: null });

    const ids = requestedEngine === 'auto' ? ENGINE_IDS : [requestedEngine];
    const inspections = await this._inspectEngineIds(ids, settings);
    this._assertGeneration(generation);
    this.inspections = new Map(inspections.map((value) => [value.id, value]));
    this.healthyIds = inspections.filter((value) => value.healthy).map((value) => value.id);

    if (requestedEngine !== 'auto') {
      const selected = this.inspections.get(requestedEngine);
      if (!selected?.healthy) throw this._unavailableError(requestedEngine, selected);
      this._emit({ phase: 'loading', requestedEngine, activeEngine: requestedEngine, detail: null });
      try {
        await this._ensureEngineStarted(requestedEngine, generation);
      } catch (error) {
        throw this._startFailure(requestedEngine, error);
      }
      this._finishStart(requestedEngine, generation, 'ready', null);
      return this.getStatus();
    }

    if (this.healthyIds.length === 0) throw this._unavailableError('auto');
    if (this.healthyIds.length === 1) {
      const selectedId = this.healthyIds[0];
      this._emit({ phase: 'loading', requestedEngine, activeEngine: selectedId, detail: null });
      try {
        await this._ensureEngineStarted(selectedId, generation);
      } catch (error) {
        throw this._startFailure(selectedId, error);
      }
      this._finishStart(selectedId, generation, 'ready', null);
      return this.getStatus();
    }

    this.cacheKey = buildBenchmarkCacheKey(inspections, { platform: this.platform, arch: this.architecture });
    const cached = await this._loadBenchmarkSafely();
    this._assertGeneration(generation);
    if (this._isValidBenchmark(cached)) {
      const selectedId = cached.winner;
      this._emit({ phase: 'loading', requestedEngine, activeEngine: selectedId, detail: null });
      try {
        await this._ensureEngineStarted(selectedId, generation);
        this._finishStart(selectedId, generation, 'ready', null);
      } catch (error) {
        this.failedEngines.add(selectedId);
        const alternateId = ENGINE_IDS.find((id) => id !== selectedId && this.healthyIds.includes(id));
        const detail = `${engineTitle(selectedId)} failed; continuing locally with ${engineTitle(alternateId)}.`;
        this._emit({ phase: 'fallback', requestedEngine, activeEngine: alternateId, detail });
        try {
          await this._ensureEngineStarted(alternateId, generation);
        } catch (alternateError) {
          throw this._startFailure(alternateId, alternateError);
        }
        this._finishStart(alternateId, generation, 'fallback', detail);
      }
      return this.getStatus();
    }

    this._emit({ phase: 'loading', requestedEngine, activeEngine: null, detail: 'Preparing local engine benchmark.' });
    const starts = await Promise.all(ENGINE_IDS.map(async (id) => {
      try {
        await this._ensureEngineStarted(id, generation);
        return { id, ok: true };
      } catch (error) {
        this.failedEngines.add(id);
        return { id, ok: false, error };
      }
    }));
    this._assertGeneration(generation);
    const readyIds = starts.filter((value) => value.ok).map((value) => value.id);
    if (readyIds.length === 0) throw this._startFailure(starts[0].id, starts[0].error);
    if (readyIds.length === 1) {
      const failedId = starts.find((value) => !value.ok)?.id;
      const detail = `${engineTitle(failedId)} failed; continuing locally with ${engineTitle(readyIds[0])}.`;
      this._finishStart(readyIds[0], generation, 'fallback', detail);
      return this.getStatus();
    }
    this.running = true;
    this.needsBenchmark = true;
    this.activeEngineId = null;
    this._emit({ phase: 'ready', requestedEngine, activeEngine: null, detail: 'Waiting for the first utterance benchmark.' });
    return this.getStatus();
  }

  transcribe(segment) {
    if (!this.running || this.stopPromise) return Promise.reject(stoppedError());
    let copy;
    try {
      copy = this._copyAndValidateSegment(segment);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.jobs.size >= this.maxQueuedTranscriptions) return Promise.reject(queueFullError());

    const generation = this.generation;
    const completion = deferred();
    const job = { generation, completion, settled: false, segment: copy };
    this.jobs.add(job);
    const previous = this.channelTails.get(copy.channel);
    const operation = previous.catch(() => {}).then(() => this._runJob(job));
    const tail = operation.catch(() => {}).finally(() => {
      this.jobs.delete(job);
      if (this.channelTails.get(copy.channel) === tail) this.channelTails.set(copy.channel, Promise.resolve());
    });
    this.channelTails.set(copy.channel, tail);
    return completion.promise;
  }

  async _runJob(job) {
    if (job.settled) return;
    try {
      this._assertGeneration(job.generation);
      this._emit({ phase: 'transcribing' });
      const result = this.needsBenchmark
        ? await this._raceFirstUtterance(job.segment, job.generation)
        : await this._transcribeWithFallback(job.segment, job.generation);
      this._assertGeneration(job.generation);
      this._settleJob(job, 'resolve', deepFreeze({ ...result }));
      this._emit({
        phase: this.fallbackDetail ? 'fallback' : 'ready',
        activeEngine: this.activeEngineId,
        detail: this.fallbackDetail
      });
    } catch (error) {
      this._settleJob(job, 'reject', error);
      if (job.generation === this.generation && this.running && error?.code !== 'stt_stopped') {
        this._emit({ phase: 'error', detail: error?.message || 'Local transcription failed.' });
      }
    }
  }

  async _transcribeWithFallback(segment, generation) {
    const firstId = this.activeEngineId;
    if (!firstId) throw new LocalSttError('not_started', 'No local engine is active.', 'Restart local speech recognition.');
    try {
      const result = normalizeResult(await this.engines.get(firstId).transcribe(segment), firstId);
      if (!this._validResult(result)) throw new Error(`${engineTitle(firstId)} returned no valid transcript.`);
      return result;
    } catch (error) {
      this._assertGeneration(generation);
      if (this.requestedEngine !== 'auto' || segment.committed === true) throw error;
      const alternateId = ENGINE_IDS.find((id) => id !== firstId && this.healthyIds.includes(id) && !this.failedEngines.has(id));
      if (!alternateId) throw error;
      this.failedEngines.add(firstId);
      const detail = `${engineTitle(firstId)} failed; continuing locally with ${engineTitle(alternateId)}.`;
      this._emit({ phase: 'fallback', activeEngine: alternateId, detail });
      await this._ensureEngineStarted(alternateId, generation);
      this.activeEngineId = alternateId;
      this.fallbackDetail = detail;
      const result = normalizeResult(await this.engines.get(alternateId).transcribe(segment), alternateId);
      this._assertGeneration(generation);
      if (!this._validResult(result)) throw new Error(`${engineTitle(alternateId)} returned no valid transcript.`);
      return result;
    }
  }

  async _raceFirstUtterance(segment, generation) {
    this.needsBenchmark = false;
    const benchmarkSegment = this._copyBenchmarkSegment(segment);
    const outcomes = new Map();
    const winner = deferred();
    let winnerId = null;
    let remaining = ENGINE_IDS.length;

    const tasks = ENGINE_IDS.map((id) => Promise.resolve()
      .then(() => this.engines.get(id).transcribe(benchmarkSegment))
      .then((raw) => {
        const result = normalizeResult(raw, id);
        outcomes.set(id, result);
        if (!winnerId && this._validResult(result) && generation === this.generation && this.running) {
          winnerId = id;
          this.activeEngineId = id;
          winner.resolve(result);
        }
      }, (error) => {
        outcomes.set(id, { error, elapsedMs: null });
      })
      .finally(() => {
        remaining -= 1;
        if (remaining === 0 && !winnerId) {
          this.needsBenchmark = generation === this.generation && this.running;
          winner.reject(new LocalSttError(
            'transcription_failed',
            'Both local engines failed to produce a valid transcript.',
            'Check local engine diagnostics and try again.'
          ));
        }
      }));

    const selected = await Promise.race([
      winner.promise,
      this.generationStop.promise.then(() => { throw stoppedError(); })
    ]);
    this.benchmarkPending = this._settleBenchmark({ tasks, outcomes, winnerId, generation });
    return selected;
  }

  async _settleBenchmark({ tasks, outcomes, winnerId, generation }) {
    await this._waitForBenchmarkLoser(tasks, generation);
    if (generation !== this.generation || !this.running || !winnerId) return;
    const record = {
      cacheKey: this.cacheKey,
      winner: winnerId,
      elapsedMs: Object.fromEntries(ENGINE_IDS.map((id) => [
        id,
        Number.isFinite(outcomes.get(id)?.elapsedMs) ? outcomes.get(id).elapsedMs : null
      ])),
      recordedAt: this.now()
    };
    try {
      await this.saveBenchmark(record);
    } catch (error) {
      this._reportObserverError(error, 'benchmark-save');
    }
  }

  async _waitForBenchmarkLoser(tasks, generation) {
    let timer = null;
    try {
      await Promise.race([
        Promise.all(tasks),
        new Promise((resolve) => { timer = this.setTimer(resolve, this.benchmarkLoserTimeoutMs); }),
        this.generationStop.promise
      ]);
    } finally {
      if (timer !== null) this.clearTimer(timer);
    }
    return generation === this.generation;
  }

  whenBenchmarkSettled() {
    return this.benchmarkPending;
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.running = false;
    this.generation += 1;
    this.generationStop.resolve();
    for (const job of this.jobs) this._settleJob(job, 'reject', stoppedError());
    const operation = Promise.resolve().then(async () => {
      const engines = Array.from(this.startedEngines, (id) => this.engines.get(id));
      this.startedEngines.clear();
      await this._boundedStop(engines);
      this.activeEngineId = null;
      this.healthyIds = [];
      this.inspections.clear();
      this.failedEngines.clear();
      this.fallbackDetail = null;
      this.needsBenchmark = false;
      this._emit({ phase: 'off', requestedEngine: null, activeEngine: null, detail: null });
      return this.getStatus();
    });
    const exposed = operation.finally(() => {
      if (this.stopPromise === exposed) this.stopPromise = null;
    });
    this.stopPromise = exposed;
    return exposed;
  }

  async _boundedStop(engines) {
    if (engines.length === 0) return;
    let timer = null;
    try {
      await Promise.race([
        Promise.allSettled(engines.map((engine) => Promise.resolve().then(() => engine.stop()))),
        new Promise((resolve) => { timer = this.setTimer(resolve, this.stopTimeoutMs); })
      ]);
    } finally {
      if (timer !== null) this.clearTimer(timer);
    }
  }

  async _inspectEngineIds(ids, settings) {
    return Promise.all(ids.map(async (id) => {
      try {
        const value = normalizeEngineInspection(await this.engines.get(id).inspect(settings));
        if (value.id !== id) throw new TypeError(`${engineTitle(id)} inspection returned the wrong id.`);
        return value;
      } catch (error) {
        return normalizeEngineInspection({
          id,
          healthy: false,
          runtime: null,
          model: null,
          errors: [{
            code: 'inspection_failed',
            message: `${engineTitle(id)} inspection failed: ${error?.message || 'Unknown inspection error.'}`,
            action: `Repair the ${engineTitle(id)} runtime and model configuration.`
          }]
        });
      }
    }));
  }

  async _ensureEngineStarted(id, generation) {
    if (this.startedEngines.has(id)) return;
    await this.engines.get(id).start({ inspection: this.inspections.get(id) });
    if (generation !== this.generation) {
      await Promise.resolve(this.engines.get(id).stop()).catch(() => {});
      throw stoppedError();
    }
    this.startedEngines.add(id);
  }

  _finishStart(activeEngineId, generation, phase, detail) {
    this._assertGeneration(generation);
    this.running = true;
    this.activeEngineId = activeEngineId;
    this.fallbackDetail = detail;
    this._emit({ phase, activeEngine: activeEngineId, detail });
  }

  _assertGeneration(generation) {
    if (generation !== this.generation) throw stoppedError();
  }

  _copyAndValidateSegment(segment) {
    if (!segment || typeof segment !== 'object' || !CHANNELS.includes(segment.channel)) {
      throw new LocalSttError('invalid_segment', 'A local segment requires channel "you" or "them".', 'Retry with valid local audio metadata.');
    }
    if (!Number.isInteger(segment.sampleRate) || segment.sampleRate < 8000 || segment.sampleRate > 192000) {
      throw new LocalSttError('invalid_segment', 'A local segment requires a supported integer sample rate.', 'Retry with valid local audio metadata.');
    }
    if (!Buffer.isBuffer(segment.pcm16) && !ArrayBuffer.isView(segment.pcm16)) {
      throw new LocalSttError('invalid_segment', 'A local segment requires PCM16 bytes.', 'Retry with valid local audio data.');
    }
    const source = Buffer.from(segment.pcm16.buffer, segment.pcm16.byteOffset, segment.pcm16.byteLength);
    const regularMaximumBytes = segment.sampleRate * 2 * MAX_SEGMENT_SECONDS;
    if (source.length === 0 || source.length % 2 !== 0 || (!this.needsBenchmark && source.length > regularMaximumBytes)) {
      throw new LocalSttError('invalid_segment', `Local PCM must contain complete samples and no more than ${MAX_SEGMENT_SECONDS} seconds.`, 'Retry with bounded PCM16 audio.');
    }
    const copiedSource = this.needsBenchmark
      ? source.subarray(0, segment.sampleRate * 2 * 15)
      : source;
    return {
      channel: segment.channel,
      pcm16: Buffer.from(copiedSource),
      sampleRate: segment.sampleRate,
      committed: segment.committed === true
    };
  }

  _copyBenchmarkSegment(segment) {
    const maximumBytes = segment.sampleRate * 2 * 15;
    return { ...segment, pcm16: Buffer.from(segment.pcm16.subarray(0, maximumBytes)) };
  }

  _validResult(result) {
    try {
      return typeof result.text === 'string' && result.text.trim().length > 0 && Boolean(this.isValidTranscript(result.text));
    } catch {
      return false;
    }
  }

  async _loadBenchmarkSafely() {
    try {
      return await this.loadBenchmark();
    } catch (error) {
      this._reportObserverError(error, 'benchmark-load');
      return null;
    }
  }

  _isValidBenchmark(value) {
    if (!ENGINE_IDS.every((id) => {
      const inspection = this.inspections.get(id);
      return typeof inspection?.runtime?.version === 'string' && inspection.runtime.version.length > 0 &&
        typeof inspection?.model?.fingerprint === 'string' && inspection.model.fingerprint.length > 0;
    })) return false;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    if (Object.keys(value).sort().join(',') !== 'cacheKey,elapsedMs,recordedAt,winner') return false;
    if (value.cacheKey !== this.cacheKey || !ENGINE_IDS.includes(value.winner)) return false;
    if (!Number.isFinite(value.recordedAt) || value.recordedAt > this.now() || this.now() - value.recordedAt > this.benchmarkMaxAgeMs) return false;
    const elapsed = value.elapsedMs;
    if (!elapsed || typeof elapsed !== 'object' || Array.isArray(elapsed)) return false;
    if (Object.keys(elapsed).sort().join(',') !== 'parakeet,whisper') return false;
    return ENGINE_IDS.every((id) => Number.isFinite(elapsed[id]) && elapsed[id] >= 0);
  }

  _unavailableError(requestedEngine, inspection = null) {
    const reason = inspection?.errors?.[0];
    const label = requestedEngine === 'auto' ? 'Local speech recognition' : engineTitle(requestedEngine);
    const error = new LocalSttError(
      requestedEngine === 'auto' ? 'local_stt_unavailable' : 'engine_unavailable',
      `${label} is unavailable${reason ? `: ${reason.message}` : '.'}`,
      reason?.action || 'Install or repair a supported local runtime and model.'
    );
    this._emit({ phase: 'error', requestedEngine, activeEngine: null, detail: error.message });
    return error;
  }

  _startFailure(id, cause) {
    const error = new LocalSttError(
      'engine_start_failed',
      `${engineTitle(id)} failed to start: ${cause?.message || 'Unknown local engine error.'}`,
      `Repair or restart the ${engineTitle(id)} local engine.`
    );
    this._emit({ phase: 'error', activeEngine: null, detail: error.message });
    return error;
  }

  _settleJob(job, method, value) {
    if (job.settled) return;
    job.settled = true;
    job.completion[method](value);
  }

  _emit(patch) {
    this.status = cloneStatus({ ...this.status, ...patch });
    const dispatchStatus = cloneStatus(this.status);
    try {
      const result = this.dispatch({ type: 'STT_UPDATED', patch: dispatchStatus });
      this._consumeObserverResult(result, 'dispatch');
    } catch (error) {
      this._reportObserverError(error, 'dispatch');
    }
    for (const listener of this.listeners) {
      try {
        const result = listener(cloneStatus(this.status));
        this._consumeObserverResult(result, 'status');
      } catch (error) {
        this._reportObserverError(error, 'status');
      }
    }
  }

  _consumeObserverResult(result, kind) {
    if (!result || (typeof result !== 'object' && typeof result !== 'function')) return;
    Promise.resolve(result).catch((error) => this._reportObserverError(error, kind));
  }

  _reportObserverError(error, kind) {
    try {
      const result = this.onObserverError(error, { kind });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Diagnostics must never break local transcription.
    }
  }
}

module.exports = {
  BENCHMARK_LOSER_TIMEOUT_MS,
  BENCHMARK_MAX_AGE_MS,
  DEFAULT_MAX_QUEUED_TRANSCRIPTIONS,
  ENGINE_IDS,
  LocalSttManager,
  buildBenchmarkCacheKey
};
