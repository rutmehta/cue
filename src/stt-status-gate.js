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

function createBatchAttemptGate({ initialAttempt = 0n } = {}) {
  if (typeof initialAttempt !== 'bigint' || initialAttempt < 0n) {
    throw new TypeError('initialAttempt must be a non-negative bigint.');
  }
  let epoch = null;
  let sequence = initialAttempt;
  let latestEffectAttempt = initialAttempt;
  let latestTranscriptAttempt = new Map();

  return {
    beginCapture() {
      epoch = Symbol('batch-capture');
      sequence = initialAttempt;
      latestEffectAttempt = initialAttempt;
      latestTranscriptAttempt = new Map();
    },
    invalidate() {
      epoch = null;
      latestTranscriptAttempt = new Map();
    },
    beginAttempt(channel) {
      if (!epoch || (channel !== 'you' && channel !== 'them')) return null;
      sequence += 1n;
      return { epoch, attempt: sequence, channel };
    },
    commit(token) {
      if (!epoch || !token || token.epoch !== epoch || (token.channel !== 'you' && token.channel !== 'them')) {
        return { effects: false, transcript: false };
      }
      const effects = token.attempt > latestEffectAttempt;
      if (effects) latestEffectAttempt = token.attempt;
      const channelAttempt = latestTranscriptAttempt.get(token.channel) || initialAttempt;
      const transcript = token.attempt > channelAttempt;
      if (transcript) latestTranscriptAttempt.set(token.channel, token.attempt);
      return { effects, transcript };
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

function createStreamingCallbackGate() {
  let activeToken = null;

  return {
    begin() {
      activeToken = Symbol('streaming-capture');
      return activeToken;
    },
    invalidate(token) {
      if (arguments.length === 0 || token === activeToken) activeToken = null;
    },
    guard(token, callback) {
      if (typeof callback !== 'function') throw new TypeError('Streaming callback must be a function.');
      return (...args) => {
        if (activeToken !== token) return undefined;
        return callback(...args);
      };
    }
  };
}

module.exports = {
  MAX_STT_DETAIL_CHARS,
  batchStatusForResult,
  createBatchAttemptGate,
  createGenerationGate,
  createLocalSttCallbackGate,
  createStreamingCallbackGate
};
