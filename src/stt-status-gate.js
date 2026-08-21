function createGenerationGate() {
  let generation = 0;
  return {
    next() { generation += 1; return generation; },
    invalidate() { generation += 1; },
    isCurrent(candidate) { return candidate === generation; }
  };
}

function batchStatusForResult(result) {
  if (result && result.error) {
    return {
      status: 'error',
      details: {
        detail: result.error.message || 'Speech-to-text providers failed.',
        patch: { activeEngine: null, model: null }
      }
    };
  }
  if (result && result.provider && result.model) {
    return {
      status: 'ready',
      details: {
        detail: `${result.provider} batch transcription is ready.`,
        patch: { activeEngine: result.provider, model: result.model }
      }
    };
  }
  return null;
}

function createLocalSttCallbackGate() {
  let generation = 0;
  let statusSuppressed = false;

  function isCurrent(token) {
    return token === generation;
  }

  return {
    begin() {
      generation += 1;
      statusSuppressed = false;
      return generation;
    },
    beginGracefulStop(token) {
      if (isCurrent(token)) statusSuppressed = true;
    },
    finishGracefulStop(token) {
      if (isCurrent(token)) {
        generation += 1;
        statusSuppressed = false;
      }
    },
    forceStop(token) {
      if (isCurrent(token)) {
        generation += 1;
        statusSuppressed = false;
      }
    },
    allowsTranscript: isCurrent,
    allowsStatus(token) {
      return isCurrent(token) && !statusSuppressed;
    }
  };
}

module.exports = { batchStatusForResult, createGenerationGate, createLocalSttCallbackGate };
