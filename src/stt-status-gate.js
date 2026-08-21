function createGenerationGate() {
  let generation = 0;
  return {
    next() { generation += 1; return generation; },
    invalidate() { generation += 1; },
    isCurrent(candidate) { return candidate === generation; }
  };
}

module.exports = { createGenerationGate };
