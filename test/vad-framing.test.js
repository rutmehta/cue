const test = require('node:test');
const assert = require('node:assert/strict');
const { AdaptiveVAD } = require('../src/vad');

test('VAD retains partial frames across small audio-worklet chunks', () => {
  let starts = 0;
  const vad = new AdaptiveVAD({ onSpeechStart: () => starts++ });
  const chunk = Buffer.alloc(256);
  for (let i = 0; i < chunk.length; i += 2) chunk.writeInt16LE(2000, i);
  for (let i = 0; i < 4; i++) vad.processChunk(chunk);
  assert.equal(starts, 1);
  assert.equal(vad.pendingFrame.length, 64);
  vad.reset();
  assert.equal(vad.pendingFrame.length, 0);
});
