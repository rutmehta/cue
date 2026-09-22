const { UtteranceSegmenter } = require('./utterance-segmenter');

const CHANNELS = Object.freeze(['you', 'them']);

function createLocalSttRuntime({
  manager,
  segmenterFactory = (options) => new UtteranceSegmenter(options),
  publishTranscript = () => {},
  publishInterim = () => {},
  publishSpeechState = () => {},
  publishError = () => {}
} = {}) {
  if (!manager || typeof manager.start !== 'function' || typeof manager.transcribe !== 'function' || typeof manager.stop !== 'function') {
    throw new TypeError('Local STT runtime requires a manager.');
  }
  let running = false;
  let generation = 0;
  let stopping = false;
  let stopPromise = null;
  const previews = new Set();
  const revisions = { you: 0, them: 0 };
  const pending = new Set();

  function transcribe(channel, pcm) {
    if (!running) return;
    revisions[channel] += 1;
    const ownGeneration = generation;
    const operation = Promise.resolve(manager.transcribe({
      channel,
      pcm16: Buffer.from(pcm),
      sampleRate: 16000,
      committed: false
    })).then((result) => {
      if (running && generation === ownGeneration && result?.text?.trim()) {
        publishTranscript(channel, result.text.trim(), result);
      }
    }).catch((error) => {
      if (running && generation === ownGeneration && error?.code !== 'stt_stopped') publishError(error, channel);
    }).finally(() => pending.delete(operation));
    pending.add(operation);
  }

  const segmenters = new Map(CHANNELS.map((channel) => [channel, segmenterFactory({
    channel,
    onSpeechState: (...args) => publishSpeechState(...args),
    onUtterance: transcribe,
    onPreview: (channel, pcm) => {
      if (!running || stopping || previews.has(channel)) return;
      previews.add(channel);
      const revision = revisions[channel];
      const ownGeneration = generation;
      const operation = Promise.resolve(manager.transcribe({ channel, pcm16: Buffer.from(pcm), sampleRate: 16000 }))
        .then(result => {
          if (running && generation === ownGeneration && revisions[channel] === revision && result?.text?.trim()) {
            publishInterim(channel, result.text.trim());
          }
        }).catch(() => {}).finally(() => { previews.delete(channel); pending.delete(operation); });
      pending.add(operation);
    }
  })]));

  async function start(settings = {}) {
    if (stopPromise) await stopPromise;
    stopping = false;
    generation += 1;
    const engine = settings.localStt?.engine || 'auto';
    await manager.start({ requestedEngine: engine, localWhisper: settings.localWhisper });
    running = true;
  }

  function push(channel, payload) {
    if (!CHANNELS.includes(channel)) throw new TypeError('Local STT requires channel "you" or "them".');
    if (!running || stopping) return false;
    if (!payload || payload.sampleRate !== 16000) throw new TypeError('Local STT requires 16 kHz PCM16 audio.');
    const value = payload.pcm;
    if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw new TypeError('Local STT requires PCM16 bytes.');
    const pcm = value instanceof ArrayBuffer
      ? Buffer.from(value)
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (!pcm.length || pcm.length % 2 !== 0) throw new TypeError('Local STT requires complete PCM16 samples.');
    segmenters.get(channel).push(Buffer.from(pcm));
    return true;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      for (const segmenter of segmenters.values()) segmenter.stop();
      let timer;
      await Promise.race([whenIdle(), new Promise(resolve => { timer = setTimeout(resolve, 4000); })]);
      clearTimeout(timer);
      running = false;
      generation += 1;
      await manager.stop();
      previews.clear();
    })().finally(() => { stopPromise = null; stopping = false; });
    return stopPromise;
  }

  async function whenIdle() {
    while (pending.size) await Promise.allSettled([...pending]);
  }

  return { start, push, stop, whenIdle, isRunning: () => running };
}

module.exports = { CHANNELS, createLocalSttRuntime };
