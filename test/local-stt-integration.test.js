const assert = require('node:assert/strict');
const test = require('node:test');

const { createLocalSttRuntime } = require('../src/local-stt-runtime');

test('starts fastest local selection, segments both sources, and publishes exact engine results', async () => {
  const calls = { start: [], transcribe: [], stop: 0 };
  const transcripts = [];
  const speech = [];
  const manager = {
    async start(settings) { calls.start.push(settings); return { activeEngine: 'parakeet' }; },
    async transcribe(segment) { calls.transcribe.push(segment); return { text: segment.channel + ' words', engine: 'parakeet', elapsedMs: 10 }; },
    async stop() { calls.stop += 1; }
  };
  const runtime = createLocalSttRuntime({
    manager,
    segmenterFactory: (options) => ({
      push(pcm) {
        options.onSpeechState(options.channel, true);
        options.onUtterance(options.channel, Buffer.from(pcm));
        options.onSpeechState(options.channel, false, 300);
      },
      stop() {}
    }),
    publishTranscript: (channel, text, result) => transcripts.push({ channel, text, result }),
    publishSpeechState: (...args) => speech.push(args)
  });

  await runtime.start({ localStt: { engine: 'auto' } });
  runtime.push('you', { pcm: Uint8Array.from([1, 0, 2, 0]).buffer, sampleRate: 16000, sourceSampleRate: 48000, level: 0.2 });
  runtime.push('them', { pcm: Uint8Array.from([3, 0, 4, 0]).buffer, sampleRate: 16000, sourceSampleRate: 48000, level: 0.3 });
  await runtime.whenIdle();

  assert.deepEqual(calls.start, [{ requestedEngine: 'auto', localWhisper: undefined }]);
  assert.deepEqual(calls.transcribe.map((segment) => segment.channel), ['you', 'them']);
  assert.deepEqual(transcripts.map((turn) => [turn.channel, turn.text, turn.result.engine]), [
    ['you', 'you words', 'parakeet'], ['them', 'them words', 'parakeet']
  ]);
  assert.deepEqual(speech.map((entry) => entry.slice(0, 2)), [['you', true], ['you', false], ['them', true], ['them', false]]);
  await runtime.stop();
  assert.equal(calls.stop, 1);
});

test('rejects malformed PCM and ignores audio outside a running local session', async () => {
  let transcriptions = 0;
  const runtime = createLocalSttRuntime({
    manager: { async start() {}, async transcribe() { transcriptions += 1; }, async stop() {} },
    segmenterFactory: () => ({ push() { transcriptions += 1; }, stop() {} })
  });
  assert.equal(runtime.push('you', { pcm: new ArrayBuffer(2), sampleRate: 16000 }), false);
  await runtime.start({ localStt: { engine: 'parakeet' } });
  assert.throws(() => runtime.push('you', { pcm: new ArrayBuffer(3), sampleRate: 16000 }), /PCM16/);
  assert.throws(() => runtime.push('mic', { pcm: new ArrayBuffer(2), sampleRate: 16000 }), /channel/);
  assert.equal(transcriptions, 0);
});

