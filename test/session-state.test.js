const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createInitialSnapshot,
  reduceSession,
  deriveSessionPhase
} = require('../src/session-state');

test('session model follows the explicit Codex selection on startup and changes', () => {
  const settings = { provider: 'codex', codexSelection: { model: 'selected' }, models: { codex: { fast: 'legacy' } } };
  const initial = createInitialSnapshot({ settings });
  assert.equal(initial.llm.requestedModel, 'selected');
  const next = reduceSession(initial, { type: 'SETTINGS_UPDATED', settings: { ...settings, codexSelection: { model: 'next' } } });
  assert.equal(next.llm.requestedModel, 'next');
});

test('moves through start, degraded listening, pause, resume, and stop with revisions', () => {
  let state = createInitialSnapshot({ now: 1_000, settings: { sttProvider: 'local', localStt: { engine: 'auto' } } });
  state = reduceSession(state, { type: 'SESSION_START_REQUESTED', now: 2_000 });
  state = reduceSession(state, { type: 'SOURCE_UPDATED', source: 'mic', patch: { phase: 'live', level: 0.4 } });
  state = reduceSession(state, { type: 'SOURCE_UPDATED', source: 'system', patch: { phase: 'error', error: { code: 'permission_denied', message: 'Meeting audio permission denied' } } });
  assert.equal(state.session.phase, 'listening');
  assert.equal(state.session.degradedReason, 'Meeting audio permission denied');
  state = reduceSession(state, { type: 'SESSION_PAUSED', now: 5_000 });
  state = reduceSession(state, { type: 'SESSION_RESUMED', now: 8_000 });
  state = reduceSession(state, { type: 'SESSION_STOP_REQUESTED', now: 9_000 });
  state = reduceSession(state, { type: 'SESSION_STOPPED', now: 9_100 });
  assert.equal(state.session.phase, 'idle');
  assert.equal(state.session.elapsedMs, 4_000);
  assert.equal(state.revision, 7);
});

test('records interim/final source text and exact request model attribution', () => {
  let state = createInitialSnapshot({ now: 0, settings: {} });
  state = reduceSession(state, { type: 'TRANSCRIPT_INTERIM', source: 'mic', text: 'hel' });
  state = reduceSession(state, { type: 'TRANSCRIPT_FINAL', source: 'mic', text: 'hello' });
  state = reduceSession(state, { type: 'LLM_REQUEST_STARTED', id: 'r1', provider: 'openai', model: 'gpt-4o-mini', contextUsed: { screen: true, mic: true, system: false } });
  assert.equal(state.transcript.mic.interim, '');
  assert.equal(state.transcript.mic.final, 'hello');
  assert.equal(state.llm.activeModel, 'gpt-4o-mini');
  assert.deepEqual(state.request.contextUsed, { screen: true, mic: true, system: false });
});

test('updates STT and request lifecycle metadata without mutating previous snapshots', () => {
  const initial = createInitialSnapshot({ now: 0 });
  let state = reduceSession(initial, {
    type: 'STT_UPDATED',
    patch: { activeEngine: 'whisper', model: 'large-v3', phase: 'transcribing', detail: 'ready' }
  });
  state = reduceSession(state, {
    type: 'LLM_REQUEST_STARTED',
    id: 'r1',
    provider: 'openai',
    model: 'gpt-4o-mini',
    contextUsed: { screen: false, mic: true, system: false }
  });
  assert.equal(state.llm.phase, 'idle');
  assert.equal(state.request.phase, 'capturing-context');
  state = reduceSession(state, { type: 'LLM_TOKEN_STARTED', id: 'r1' });
  assert.equal(state.llm.phase, 'streaming');
  assert.equal(state.request.phase, 'streaming');
  state = reduceSession(state, { type: 'LLM_REQUEST_FINISHED', id: 'r1' });

  assert.equal(initial.stt.phase, 'off');
  assert.equal(state.stt.activeEngine, 'whisper');
  assert.equal(state.request.phase, 'complete');
  assert.equal(state.llm.phase, 'idle');
  assert.throws(
    () => reduceSession(state, { type: 'STT_UPDATED', patch: { phase: 'live' } }),
    /Invalid STT phase: live/
  );
});

test('records request failures and rejects invalid source updates', () => {
  let state = createInitialSnapshot({ now: 0 });
  state = reduceSession(state, {
    type: 'LLM_REQUEST_FAILED',
    id: 'r1',
    error: { code: 'rate_limited', message: 'Too many requests' }
  });

  assert.equal(state.request.phase, 'error');
  assert.equal(state.llm.error.message, 'Too many requests');
  assert.throws(
    () => reduceSession(state, { type: 'SOURCE_UPDATED', source: 'screen', patch: { phase: 'live' } }),
    /Unknown source: screen/
  );
  assert.throws(
    () => reduceSession(state, { type: 'SOURCE_UPDATED', source: 'mic', patch: { phase: 'ready' } }),
    /Invalid source phase: ready/
  );
});

test('settings changes update requested routes/models and transcript clear resets both sources', () => {
  let state = createInitialSnapshot({
    now: 0,
    settings: { provider: 'openai', models: { openai: { fast: 'gpt-fast' } } }
  });
  state = reduceSession(state, { type: 'TRANSCRIPT_INTERIM', source: 'system', text: 'partial' });
  state = reduceSession(state, { type: 'TRANSCRIPT_FINAL', source: 'mic', text: 'final' });
  state = reduceSession(state, {
    type: 'SETTINGS_UPDATED',
    settings: {
      provider: 'anthropic',
      smart: true,
      models: { anthropic: { smart: 'claude-deep' } },
      sttProvider: 'local',
      localStt: { engine: 'whisper' }
    }
  });

  assert.equal(state.stt.route, 'local');
  assert.equal(state.stt.requestedEngine, 'whisper');
  assert.equal(state.llm.provider, 'anthropic');
  assert.equal(state.llm.requestedModel, 'claude-deep');

  const cleared = reduceSession(state, { type: 'TRANSCRIPT_CLEARED' });
  assert.deepEqual(cleared.transcript, {
    mic: { interim: '', final: '' },
    system: { interim: '', final: '' }
  });
  assert.equal(cleared.revision, state.revision + 1);
});

test('local provider requests Whisper even with the existing localWhisper settings schema', () => {
  const state = createInitialSnapshot({
    now: 0,
    settings: { sttProvider: 'local', localWhisper: { modelId: 'base.en' } }
  });

  assert.equal(state.stt.route, 'local');
  assert.equal(state.stt.requestedEngine, 'whisper');
});

test('derives error only when neither requested source can run', () => {
  let state = createInitialSnapshot({ now: 0 });
  state = reduceSession(state, { type: 'SESSION_START_REQUESTED', now: 1 });
  state = reduceSession(state, { type: 'SOURCE_UPDATED', source: 'mic', patch: { phase: 'error', error: { message: 'Mic blocked' } } });
  assert.equal(deriveSessionPhase(state), 'starting');
  state = reduceSession(state, { type: 'SOURCE_UPDATED', source: 'system', patch: { phase: 'error', error: { message: 'System blocked' } } });
  assert.equal(deriveSessionPhase(state), 'error');
});

test('uses a source-labelled degraded reason when a requested source is unsupported', () => {
  let state = createInitialSnapshot({ now: 0 });
  state = reduceSession(state, { type: 'SESSION_START_REQUESTED', now: 1 });
  state = reduceSession(state, { type: 'SOURCE_UPDATED', source: 'mic', patch: { phase: 'live' } });
  state = reduceSession(state, { type: 'SOURCE_UPDATED', source: 'system', patch: { phase: 'unsupported' } });

  assert.equal(state.session.phase, 'listening');
  assert.equal(state.session.degradedReason, 'System audio is unsupported');
});

test('enforces legal lifecycle transitions and leaves duplicate commands unchanged', () => {
  const validTransitions = [
    ['idle', 'SESSION_START_REQUESTED', false],
    ['error', 'SESSION_START_REQUESTED', false],
    ['starting', 'SESSION_START_REQUESTED', true],
    ['listening', 'SESSION_START_REQUESTED', true],
    ['starting', 'SESSION_PAUSED', false],
    ['listening', 'SESSION_PAUSED', false],
    ['paused', 'SESSION_PAUSED', true],
    ['paused', 'SESSION_RESUMED', false],
    ['starting', 'SESSION_RESUMED', true],
    ['listening', 'SESSION_RESUMED', true],
    ['starting', 'SESSION_STOP_REQUESTED', false],
    ['listening', 'SESSION_STOP_REQUESTED', false],
    ['paused', 'SESSION_STOP_REQUESTED', false],
    ['error', 'SESSION_STOP_REQUESTED', false],
    ['stopping', 'SESSION_STOP_REQUESTED', true],
    ['idle', 'SESSION_STOP_REQUESTED', true],
    ['stopping', 'SESSION_STOPPED', false],
    ['idle', 'SESSION_STOPPED', true]
  ];

  for (const [phase, type, isNoop] of validTransitions) {
    const state = snapshotInPhase(phase);
    const next = reduceSession(state, { type, now: 100 });
    if (isNoop) {
      assert.strictEqual(next, state, `${type} should be idempotent from ${phase}`);
    } else {
      assert.equal(next.revision, state.revision + 1, `${type} should revise from ${phase}`);
    }
  }

  const illegalTransitions = [
    ['paused', 'SESSION_START_REQUESTED'],
    ['stopping', 'SESSION_START_REQUESTED'],
    ['idle', 'SESSION_PAUSED'],
    ['stopping', 'SESSION_PAUSED'],
    ['error', 'SESSION_PAUSED'],
    ['idle', 'SESSION_RESUMED'],
    ['stopping', 'SESSION_RESUMED'],
    ['error', 'SESSION_RESUMED'],
    ['starting', 'SESSION_STOPPED'],
    ['listening', 'SESSION_STOPPED'],
    ['paused', 'SESSION_STOPPED'],
    ['error', 'SESSION_STOPPED']
  ];

  for (const [phase, type] of illegalTransitions) {
    assert.throws(
      () => reduceSession(snapshotInPhase(phase), { type, now: 100 }),
      new RegExp(`Cannot ${type} while session is ${phase}`)
    );
  }
});

function snapshotInPhase(phase) {
  const state = createInitialSnapshot({ now: 0 });
  return {
    ...state,
    session: {
      ...state.session,
      phase,
      startedAt: phase === 'idle' ? null : 0,
      resumedAt: phase === 'paused' || phase === 'stopping' || phase === 'error' || phase === 'idle' ? null : 0
    }
  };
}
