(function (root, factory) {
  const audioUtils = typeof module === 'object' && module.exports
    ? require('./audio-utils')
    : root.CueAudioUtils;
  const api = factory(audioUtils);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CueAudioCapture = api;
})(typeof window === 'object' ? window : null, function ({ createAudioConverter }) {
  const TARGET_SAMPLE_RATE = 16000;

  function stableError(error, fallbackCode = 'capture_failed') {
    const code = String(error?.code || error?.name || fallbackCode).trim().slice(0, 64) || fallbackCode;
    const message = String(error?.message || error || 'Audio capture failed.').trim().slice(0, 500) || 'Audio capture failed.';
    const normalized = new Error(message);
    normalized.code = code;
    normalized.name = error?.name || 'Error';
    return normalized;
  }

  function stopTracks(stream) {
    for (const track of stream?.getTracks?.() || []) {
      try { track.stop(); } catch (_) { /* best effort */ }
    }
  }

  function createAudioCapture(dependencies = {}) {
    const mediaDevices = dependencies.mediaDevices;
    const MediaStreamCtor = dependencies.MediaStream;
    const createAudioContext = dependencies.createAudioContext;
    const createGraph = dependencies.createGraph;
    const disconnectGraph = dependencies.disconnectGraph || (() => {});
    const sourceUpdate = dependencies.sourceUpdate || (() => {});
    const sourcePcm = dependencies.sourcePcm || (() => {});
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') throw new TypeError('Audio capture requires mediaDevices.getUserMedia().');
    if (typeof createAudioContext !== 'function' || typeof createGraph !== 'function') throw new TypeError('Audio capture requires context and graph factories.');

    const sources = {
      mic: { phase: 'off', generation: 0, startingPromise: null, active: null, converter: createAudioConverter(TARGET_SAMPLE_RATE) },
      system: { phase: 'off', generation: 0, startingPromise: null, active: null, converter: createAudioConverter(TARGET_SAMPLE_RATE) }
    };
    const resumeWanted = new Set();

    function publish(source, phase, error = null) {
      const record = sources[source];
      record.phase = phase;
      sourceUpdate(source, { phase, error: error ? { code: error.code, message: error.message } : null });
    }

    async function acquire(source) {
      if (source === 'mic') {
        const stream = await mediaDevices.getUserMedia({ audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        } });
        if (!(stream.getAudioTracks?.() || []).length) {
          stopTracks(stream);
          throw Object.assign(new Error('No microphone audio track was available.'), { code: 'no_audio_track' });
        }
        return { ownerStream: stream, graphStream: stream };
      }
      if (typeof mediaDevices.getDisplayMedia !== 'function') {
        throw Object.assign(new Error('Meeting audio capture is not supported by this build.'), { code: 'unsupported' });
      }
      const displayStream = await mediaDevices.getDisplayMedia({ video: true, audio: true });
      for (const track of displayStream.getVideoTracks?.() || []) track.stop();
      const audioTracks = displayStream.getAudioTracks?.() || [];
      if (!audioTracks.length) {
        stopTracks(displayStream);
        throw Object.assign(new Error('No system-audio loopback track was provided.'), { code: 'unsupported' });
      }
      const graphStream = typeof MediaStreamCtor === 'function' ? new MediaStreamCtor(audioTracks) : displayStream;
      return { ownerStream: displayStream, graphStream };
    }

    function dispose(active) {
      if (!active) return;
      try { disconnectGraph(active.graph); } catch (_) { /* best effort */ }
      try { void active.context.close(); } catch (_) { /* best effort */ }
      stopTracks(active.ownerStream);
    }

    function start(source) {
      const record = sources[source];
      if (record.active) return Promise.resolve(record.active);
      if (record.startingPromise) return record.startingPromise;
      const generation = ++record.generation;
      publish(source, 'starting');
      let acquired = null;
      let context = null;
      const operation = Promise.resolve()
        .then(() => acquire(source))
        .then(async (resource) => {
          acquired = resource;
          if (generation !== record.generation) {
            stopTracks(resource.ownerStream);
            return null;
          }
          context = createAudioContext();
          record.converter.reset();
          const graph = await createGraph({
            audioContext: context,
            mediaStream: resource.graphStream,
            onPcm: (message) => {
              if (generation !== record.generation || !record.active) return;
              const samples = message?.samples ?? message;
              const measuredRate = Number(message?.sampleRate) || context.sampleRate;
              const converted = record.converter.convert(samples, measuredRate);
              if (!converted.pcm16.length) return;
              const bytes = converted.pcm16.buffer.slice(
                converted.pcm16.byteOffset,
                converted.pcm16.byteOffset + converted.pcm16.byteLength
              );
              sourcePcm(source, {
                pcm: bytes,
                sampleRate: converted.sampleRate,
                sourceSampleRate: converted.sourceSampleRate,
                level: Number(message?.level) || converted.level
              });
            }
          });
          if (generation !== record.generation) {
            dispose({ graph, context, ownerStream: resource.ownerStream });
            return null;
          }
          record.active = { graph, context, ownerStream: resource.ownerStream };
          acquired = null;
          context = null;
          publish(source, 'live');
          return record.active;
        })
        .catch((rawError) => {
          if (acquired) stopTracks(acquired.ownerStream);
          if (context) { try { void context.close(); } catch (_) {} }
          const error = stableError(rawError, source === 'system' ? 'unsupported' : 'capture_failed');
          if (generation === record.generation) publish(source, error.code === 'unsupported' ? 'unsupported' : 'error', error);
          throw error;
        })
        .finally(() => {
          if (record.startingPromise === operation) record.startingPromise = null;
        });
      record.startingPromise = operation;
      return operation;
    }

    function stopSource(source, phase = 'off') {
      const record = sources[source];
      record.generation += 1;
      const active = record.active;
      record.active = null;
      record.converter.reset();
      dispose(active);
      publish(source, phase);
    }

    function pause() {
      resumeWanted.clear();
      for (const source of ['mic', 'system']) {
        const record = sources[source];
        if (record.active || record.startingPromise) resumeWanted.add(source);
        stopSource(source, 'off');
      }
    }

    async function resume() {
      await Promise.all([...resumeWanted].map((source) => start(source).catch(() => null)));
    }

    function stop() {
      resumeWanted.clear();
      stopSource('mic');
      stopSource('system');
    }

    function getState() {
      return Object.freeze({
        mic: Object.freeze({ phase: sources.mic.phase, starting: Boolean(sources.mic.startingPromise), active: Boolean(sources.mic.active) }),
        system: Object.freeze({ phase: sources.system.phase, starting: Boolean(sources.system.startingPromise), active: Boolean(sources.system.active) })
      });
    }

    return {
      startMic: () => start('mic'),
      startSystem: () => start('system'),
      stopMic: () => stopSource('mic'),
      stopSystem: () => stopSource('system'),
      pause,
      resume,
      stop,
      getState
    };
  }

  return { createAudioCapture, stableError };
});
