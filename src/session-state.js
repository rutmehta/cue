const SOURCE_PHASES = new Set(['off', 'starting', 'live', 'recovering', 'error', 'unsupported']);
const SESSION_PHASES = new Set(['idle', 'starting', 'listening', 'paused', 'stopping', 'error']);
const SOURCES = new Set(['mic', 'system']);

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
    stt: { route: settings.sttProvider === 'local' ? 'local' : 'cloud', requestedEngine: settings.localStt?.engine || 'auto', activeEngine: null, model: null, phase: 'off', detail: null },
    llm: { provider, requestedModel: settings.models?.[provider]?.[tier] || null, activeModel: null, phase: 'idle', error: null },
    transcript: { mic: { interim: '', final: '' }, system: { interim: '', final: '' } },
    request: { id: null, phase: 'idle', contextUsed: { screen: false, mic: false, system: false }, error: null },
    createdAt: now
  };
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
      return revise(snapshot, {
        session: {
          phase: 'starting',
          startedAt: event.now,
          elapsedMs: 0,
          resumedAt: event.now,
          degradedReason: null
        }
      });
    case 'SESSION_PAUSED':
      return revise(snapshot, { session: pauseSession(snapshot.session, event.now) });
    case 'SESSION_RESUMED':
      return revise(snapshot, {
        session: {
          ...snapshot.session,
          phase: resumePhase(snapshot),
          resumedAt: event.now
        }
      });
    case 'SESSION_STOP_REQUESTED':
      return revise(snapshot, {
        session: {
          ...pauseSession(snapshot.session, event.now),
          phase: 'stopping',
          degradedReason: null
        }
      });
    case 'SESSION_STOPPED':
      return revise(snapshot, {
        session: {
          ...snapshot.session,
          phase: 'idle',
          startedAt: null,
          resumedAt: null,
          degradedReason: null
        }
      });
    case 'SOURCE_UPDATED':
      return reduceSourceUpdated(snapshot, event);
    case 'STT_UPDATED':
      return revise(snapshot, { stt: { ...snapshot.stt, ...event.patch } });
    case 'TRANSCRIPT_INTERIM':
      return reduceTranscript(snapshot, event, 'interim');
    case 'TRANSCRIPT_FINAL':
      return reduceTranscript(snapshot, event, 'final');
    case 'LLM_REQUEST_STARTED':
      return revise(snapshot, {
        llm: {
          ...snapshot.llm,
          provider: event.provider,
          activeModel: event.model,
          phase: 'requesting',
          error: null
        },
        request: {
          id: event.id,
          phase: 'requesting',
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
        request: { ...snapshot.request, id: event.id || snapshot.request.id, phase: 'finished', error: null }
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

function reduceSourceUpdated(snapshot, event) {
  assertSource(event.source);
  const patch = event.patch || {};
  if (patch.phase !== undefined && !SOURCE_PHASES.has(patch.phase)) {
    throw new TypeError(`Invalid source phase: ${patch.phase}`);
  }

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
  for (const source of Object.values(sources)) {
    if (source.phase === 'error' && source.error?.message) {
      return source.error.message;
    }
  }
  return null;
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
  createInitialSnapshot,
  reduceSession,
  deriveSessionPhase
};
