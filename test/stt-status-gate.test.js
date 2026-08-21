const assert = require('node:assert/strict');
const test = require('node:test');

const { createGenerationGate } = require('../src/stt-status-gate');

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
