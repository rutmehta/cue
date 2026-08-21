function createGenerationGate() {
  let generation = 0;
  return {
    next() { generation += 1; return generation; },
    invalidate() { generation += 1; },
    isCurrent(candidate) { return candidate === generation; }
  };
}

const MAX_STT_DETAIL_CHARS = 500;
const STT_FAILURE_FALLBACK = 'Speech-to-text providers failed.';

function normalizeSttDetail(value) {
  if (typeof value !== 'string' || !value.trim()) return STT_FAILURE_FALLBACK;
  return value.trim().slice(0, MAX_STT_DETAIL_CHARS);
}

function batchStatusForResult(result) {
  if (result && result.error) {
    return {
      status: 'error',
      details: {
        detail: normalizeSttDetail(result.error.message),
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

function createBatchAttemptGate() {
  let epoch = 0;
  let sequence = 0;
  let latestCommittedAttempt = 0;
  let active = false;

  return {
    beginCapture() {
      epoch += 1;
      latestCommittedAttempt = 0;
      active = true;
    },
    invalidate() {
      epoch += 1;
      latestCommittedAttempt = 0;
      active = false;
    },
    beginAttempt() {
      if (!active) return null;
      sequence += 1;
      return { epoch, attempt: sequence };
    },
    commit(token) {
      if (!active || !token || token.epoch !== epoch || token.attempt <= latestCommittedAttempt) {
        return false;
      }
      latestCommittedAttempt = token.attempt;
      return true;
    }
  };
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

module.exports = {
  MAX_STT_DETAIL_CHARS,
  batchStatusForResult,
  createBatchAttemptGate,
  createGenerationGate,
  createLocalSttCallbackGate
};
