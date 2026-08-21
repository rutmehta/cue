const SOURCE_PHASES = new Set(['off', 'starting', 'live', 'recovering', 'error', 'unsupported']);
const SESSION_PHASES = new Set(['idle', 'starting', 'listening', 'paused', 'stopping', 'error']);
const STT_PHASES = new Set(['off', 'probing', 'loading', 'ready', 'transcribing', 'fallback', 'error']);
const SOURCES = new Set(['mic', 'system']);
const SOURCE_LABELS = { mic: 'Microphone', system: 'System audio' };
const { validateSourcePatch } = require('./source-update');
const LIFECYCLE_TRANSITIONS = {
  SESSION_START_REQUESTED: { idle: 'start', error: 'start', starting: 'noop', listening: 'noop' },
  SESSION_PAUSED: { starting: 'pause', listening: 'pause', paused: 'noop' },
  SESSION_RESUMED: { paused: 'resume', starting: 'noop', listening: 'noop' },
  SESSION_STOP_REQUESTED: { idle: 'noop', starting: 'stop', listening: 'stop', paused: 'stop', stopping: 'noop', error: 'stop' },
  SESSION_STOPPED: { idle: 'noop', stopping: 'stopped' },
  SESSION_CAPTURE_FAILED: { starting: 'failed', listening: 'failed', paused: 'failed', stopping: 'failed', error: 'noop' }
};

function createInitialSnapshot({ now = Date.now(), settings = {} } = {}) {
  const provider = settings.provider || 'openai';
  const tier = settings.smart ? 'smart' : 'fast';
  return {
    revision: 0,
    session: { phase: 'idle', startedAt: null, elapsedMs: 0, resumedAt: null, degradedReason: null },
    sources: {
      mic: { phase: 'off', level: 0, error: null },
      system: { phase: 'off', level: 0, error: null }
    },
    stt: { route: settings.sttProvider === 'local' ? 'local' : 'cloud', requestedEngine: requestedSttEngine(settings), activeEngine: null, model: null, phase: 'off', detail: null },
    llm: { provider, requestedModel: settings.models?.[provider]?.[tier] || null, activeModel: null, phase: 'idle', error: null },
    transcript: { mic: { interim: '', final: '' }, system: { interim: '', final: '' } },
    request: { id: null, phase: 'idle', contextUsed: { screen: false, mic: false, system: false }, error: null },
    createdAt: now
  };
}

function requestedSttEngine(settings) {
  if (settings.localStt?.engine) return settings.localStt.engine;
  return settings.sttProvider === 'local' ? 'whisper' : 'auto';
}

function deriveSessionPhase(snapshot) {
  const currentPhase = snapshot.session.phase;
  if (currentPhase === 'idle' || currentPhase === 'paused' || currentPhase === 'stopping') {
    return currentPhase;
  }

  const sourceStates = Object.values(snapshot.sources);
  if (sourceStates.some((source) => source.phase === 'live')) {
    return 'listening';
  }

  if (sourceStates.every((source) => source.phase === 'error' || source.phase === 'unsupported')) {
    return 'error';
  }

  return 'starting';
}

function reduceSession(snapshot, event) {
  if (!event || typeof event.type !== 'string') {
    throw new TypeError('Session event must include a string type');
  }

  switch (event.type) {
    case 'SESSION_START_REQUESTED':
    case 'SESSION_PAUSED':
    case 'SESSION_RESUMED':
    case 'SESSION_STOP_REQUESTED':
    case 'SESSION_STOPPED':
    case 'SESSION_CAPTURE_FAILED':
      return reduceLifecycle(snapshot, event);
    case 'SOURCE_UPDATED':
      return reduceSourceUpdated(snapshot, event);
    case 'STT_UPDATED':
      return reduceSttUpdated(snapshot, event);
    case 'TRANSCRIPT_INTERIM':
      return reduceTranscript(snapshot, event, 'interim');
    case 'TRANSCRIPT_FINAL':
      return reduceTranscript(snapshot, event, 'final');
    case 'TRANSCRIPT_CLEARED':
      return revise(snapshot, {
        transcript: {
          mic: { interim: '', final: '' },
          system: { interim: '', final: '' }
        }
      });
    case 'SETTINGS_UPDATED':
      return reduceSettingsUpdated(snapshot, event.settings);
    case 'LLM_REQUEST_STARTED':
      return revise(snapshot, {
        llm: {
          ...snapshot.llm,
          provider: event.provider,
          activeModel: event.model,
          phase: 'idle',
          error: null
        },
        request: {
          id: event.id,
          phase: 'capturing-context',
          contextUsed: { ...event.contextUsed },
          error: null
        }
      });
    case 'LLM_TOKEN_STARTED':
      return revise(snapshot, {
        llm: { ...snapshot.llm, phase: 'streaming', error: null },
        request: { ...snapshot.request, id: event.id || snapshot.request.id, phase: 'streaming', error: null }
      });
    case 'LLM_REQUEST_FINISHED':
      return revise(snapshot, {
        llm: { ...snapshot.llm, phase: 'idle', error: null },
        request: { ...snapshot.request, id: event.id || snapshot.request.id, phase: 'complete', error: null }
      });
    case 'LLM_REQUEST_FAILED':
      return revise(snapshot, {
        llm: { ...snapshot.llm, phase: 'error', error: event.error },
        request: { ...snapshot.request, id: event.id || snapshot.request.id, phase: 'error', error: event.error }
      });
    default:
      throw new TypeError(`Unknown session event: ${event.type}`);
  }
}

function reduceSettingsUpdated(snapshot, settings = {}) {
  const provider = settings.provider || 'openai';
  const tier = settings.smart ? 'smart' : 'fast';
  const requestActive = snapshot.request.phase === 'capturing-context' || snapshot.request.phase === 'streaming';
  return revise(snapshot, {
    stt: {
      ...snapshot.stt,
      route: settings.sttProvider === 'local' ? 'local' : 'cloud',
      requestedEngine: requestedSttEngine(settings)
    },
    llm: {
      ...snapshot.llm,
      provider: requestActive ? snapshot.llm.provider : provider,
      requestedModel: settings.models?.[provider]?.[tier] || null
    }
  });
}

function reduceLifecycle(snapshot, event) {
  const action = LIFECYCLE_TRANSITIONS[event.type][snapshot.session.phase];
  if (!action) {
    throw new TypeError(`Cannot ${event.type} while session is ${snapshot.session.phase}`);
  }
  if (action === 'noop') {
    return snapshot;
  }

  switch (action) {
    case 'start':
      return revise(snapshot, {
        session: {
          phase: 'starting',
          startedAt: event.now,
          elapsedMs: 0,
          resumedAt: event.now,
          degradedReason: null
        }
      });
    case 'pause':
      return revise(snapshot, { session: pauseSession(snapshot.session, event.now) });
    case 'resume':
      return revise(snapshot, {
        session: {
          ...snapshot.session,
          phase: resumePhase(snapshot),
          resumedAt: event.now
        }
      });
    case 'stop':
      return revise(snapshot, {
        session: {
          ...pauseSession(snapshot.session, event.now),
          phase: 'stopping',
          degradedReason: null
        }
      });
    case 'stopped':
      return revise(snapshot, {
        session: {
          ...snapshot.session,
          phase: 'idle',
          startedAt: null,
          resumedAt: null,
          degradedReason: null
        },
        sources: stopSources(snapshot.sources),
        stt: stopStt(snapshot.stt)
      });
    case 'failed':
      return revise(snapshot, {
        session: {
          ...snapshot.session,
          phase: 'error',
          resumedAt: null,
          degradedReason: captureFailureMessage(event.error)
        },
        stt: { ...snapshot.stt, phase: 'error', detail: captureFailureMessage(event.error) }
      });
    default:
      throw new TypeError(`Unknown lifecycle action: ${action}`);
  }
}

function reduceSttUpdated(snapshot, event) {
  const patch = event.patch || {};
  if (patch.phase !== undefined && !STT_PHASES.has(patch.phase)) {
    throw new TypeError(`Invalid STT phase: ${patch.phase}`);
  }
  return revise(snapshot, { stt: { ...snapshot.stt, ...patch } });
}

function reduceSourceUpdated(snapshot, event) {
  assertSource(event.source);
  const patch = validateSourcePatch(event.patch);

  const sources = {
    ...snapshot.sources,
    [event.source]: { ...snapshot.sources[event.source], ...patch }
  };
  const phase = deriveSessionPhase({ ...snapshot, sources });
  const session = sessionForSourceUpdate(snapshot.session, sources, phase);
  return revise(snapshot, { sources, session });
}

function reduceTranscript(snapshot, event, field) {
  assertSource(event.source);
  const currentTranscript = snapshot.transcript[event.source];
  const nextTranscript = field === 'final'
    ? { ...currentTranscript, final: event.text, interim: '' }
    : { ...currentTranscript, interim: event.text };
  return revise(snapshot, {
    transcript: { ...snapshot.transcript, [event.source]: nextTranscript }
  });
}

function sessionForSourceUpdate(session, sources, phase) {
  if (session.phase === 'idle' || session.phase === 'paused' || session.phase === 'stopping') {
    return session;
  }

  const degradedReason = phase === 'listening' ? firstSourceErrorMessage(sources) : null;
  if (session.phase === phase && session.degradedReason === degradedReason) {
    return session;
  }
  return { ...session, phase, degradedReason };
}

function firstSourceErrorMessage(sources) {
  for (const [sourceName, source] of Object.entries(sources)) {
    if (source.phase === 'error') {
      return source.error?.message || `${SOURCE_LABELS[sourceName]} failed`;
    }
    if (source.phase === 'unsupported') {
      return `${SOURCE_LABELS[sourceName]} is unsupported`;
    }
  }
  return null;
}

function stopSources(sources) {
  const mic = stopSource(sources.mic);
  const system = stopSource(sources.system);
  if (mic === sources.mic && system === sources.system) {
    return sources;
  }
  return { mic, system };
}

function stopSource(source) {
  if (source.phase === 'off' && source.level === 0 && source.error === null) {
    return source;
  }
  return { ...source, phase: 'off', level: 0, error: null };
}

function stopStt(stt) {
  if (stt.phase === 'off' && stt.activeEngine === null && stt.detail === null) {
    return stt;
  }
  return { ...stt, phase: 'off', activeEngine: null, detail: null };
}

function captureFailureMessage(error) {
  return error?.message || 'Capture operation failed';
}

function pauseSession(session, now) {
  const elapsedMs = session.resumedAt === null
    ? session.elapsedMs
    : session.elapsedMs + Math.max(0, now - session.resumedAt);
  return { ...session, phase: 'paused', elapsedMs, resumedAt: null };
}

function resumePhase(snapshot) {
  return deriveSessionPhase({ ...snapshot, session: { ...snapshot.session, phase: 'starting' } });
}

function assertSource(source) {
  if (!SOURCES.has(source)) {
    throw new TypeError(`Unknown source: ${source}`);
  }
}

function revise(snapshot, changes) {
  return { ...snapshot, ...changes, revision: snapshot.revision + 1 };
}

module.exports = {
  SOURCE_PHASES,
  SESSION_PHASES,
  STT_PHASES,
  createInitialSnapshot,
  reduceSession,
  deriveSessionPhase
};
