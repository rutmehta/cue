const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_STT_DETAIL_CHARS,
  batchStatusForResult,
  createBatchAttemptGate,
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

test('batch attempts reject stale completion across ordering, stop, and restart boundaries', () => {
  assert.equal(typeof createBatchAttemptGate, 'function');
  const gate = createBatchAttemptGate();
  gate.beginCapture();
  const older = gate.beginAttempt();
  const newer = gate.beginAttempt();

  assert.equal(gate.commit(newer), true);
  assert.equal(gate.commit(older), false, 'older success cannot replace a newer committed error');

  const stopping = gate.beginAttempt();
  gate.invalidate();
  assert.equal(gate.commit(stopping), false, 'a completion after stop cannot publish');

  gate.beginCapture();
  const restarted = gate.beginAttempt();
  assert.equal(gate.commit(restarted), true);
  assert.equal(gate.commit(stopping), false, 'a prior capture epoch cannot publish after restart');
});

test('batch failure detail is normalized to bounded useful text', () => {
  assert.equal(MAX_STT_DETAIL_CHARS, 500);
  const fallback = 'Speech-to-text providers failed.';
  for (const message of [null, undefined, '', '   ', false, { injected: true }]) {
    assert.equal(batchStatusForResult({ error: { message } }).details.detail, fallback);
  }
  const detail = batchStatusForResult({ error: { message: `  ${'x'.repeat(700)}  ` } }).details.detail;
  assert.equal(detail.length, MAX_STT_DETAIL_CHARS);
  assert.equal(detail, 'x'.repeat(MAX_STT_DETAIL_CHARS));
});
