const assert = require('node:assert/strict');
const test = require('node:test');

const { convertAudioBlock, createAudioConverter } = require('../renderer/audio-utils');

test('resamples measured 48 kHz float audio to 16 kHz PCM with metadata', () => {
  const input = Float32Array.from({ length: 480 }, (_, index) => Math.sin(index / 12));
  const result = convertAudioBlock(input, 48000, 16000);
  assert.equal(result.sampleRate, 16000);
  assert.equal(result.sourceSampleRate, 48000);
  assert.equal(result.pcm16.byteLength, 160 * 2);
  assert.ok(result.level > 0);
});

test('stateful resampling preserves fractional position across block boundaries', () => {
  const input = Float32Array.from({ length: 1000 }, (_, index) => Math.sin(index / 17));
  const oneShot = convertAudioBlock(input, 44100, 16000).pcm16;
  const converter = createAudioConverter(16000);
  const first = converter.convert(input.subarray(0, 333), 44100).pcm16;
  const second = converter.convert(input.subarray(333), 44100).pcm16;
  const combined = Buffer.concat([
    Buffer.from(first.buffer, first.byteOffset, first.byteLength),
    Buffer.from(second.buffer, second.byteOffset, second.byteLength)
  ]);
  const joined = new Int16Array(combined.buffer, combined.byteOffset, combined.byteLength / 2);
  assert.deepEqual(Array.from(joined), Array.from(oneShot));
});
