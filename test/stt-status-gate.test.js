const assert = require('node:assert/strict');
const test = require('node:test');

const {
  batchStatusForResult,
  createGenerationGate,
  createLocalSttCallbackGate
} = require('../src/stt-status-gate');

test('invalidates local STT callbacks from an engine that is stopping', () => {
  const gate = createGenerationGate();
  const first = gate.next();
  assert.equal(gate.isCurrent(first), true);
  gate.invalidate();
  assert.equal(gate.isCurrent(first), false);
  const second = gate.next();
  assert.equal(gate.isCurrent(second), true);
  assert.equal(gate.isCurrent(first), false);
});

test('batch provider failure produces an authoritative terminal STT update', () => {
  assert.equal(typeof batchStatusForResult, 'function');
  assert.deepEqual(batchStatusForResult({
    error: { provider: 'groq', model: 'whisper-large-v3-turbo', message: 'All providers failed.' }
  }), {
    status: 'error',
    details: {
      detail: 'All providers failed.',
      patch: { activeEngine: null, model: null }
    }
  });
});

test('graceful local stop drains transcripts while suppressing terminal statuses', () => {
  assert.equal(typeof createLocalSttCallbackGate, 'function');
  const gate = createLocalSttCallbackGate();
  const token = gate.begin();

  gate.beginGracefulStop(token);
  assert.equal(gate.allowsTranscript(token), true);
  assert.equal(gate.allowsStatus(token), false);

  gate.finishGracefulStop(token);
  assert.equal(gate.allowsTranscript(token), false);

  const forced = gate.begin();
  gate.forceStop(forced);
  assert.equal(gate.allowsTranscript(forced), false);
  assert.equal(gate.allowsStatus(forced), false);
});
