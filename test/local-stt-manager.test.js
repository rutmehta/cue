const assert = require('node:assert/strict');
const test = require('node:test');
const { LocalSttError } = require('../src/local-stt-engine');
const { LocalSttManager, buildBenchmarkCacheKey } = require('../src/local-stt-manager');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function inspection(id, overrides = {}) {
  return {
    id,
    healthy: true,
    runtime: { path: `/runtime/${id}`, source: 'fixture', version: `${id}-1` },
    model: { path: `/model/${id}`, source: 'fixture', fingerprint: `${id}-model-1` },
    errors: [],
    ...overrides
  };
}

function fakeEngine(id, { healthy = true, text = `${id} result`, elapsedMs = 10 } = {}) {
  const calls = { inspect: 0, start: 0, transcribe: 0, stop: 0 };
  return {
    id,
    calls,
    async inspect() {
      calls.inspect += 1;
      return healthy
        ? inspection(id)
        : inspection(id, {
          healthy: false,
          runtime: null,
          model: null,
          errors: [{ code: 'runtime_missing', message: `${id} runtime missing`, action: 'Install it.' }]
        });
    },
    async start() { calls.start += 1; },
    async transcribe() {
      calls.transcribe += 1;
      return { text, elapsedMs };
    },
    async stop() { calls.stop += 1; }
  };
}

function segment() {
  return { channel: 'you', pcm16: Buffer.alloc(3200, 1), sampleRate: 16000 };
}

function validCacheFor(engines, overrides = {}) {
  const values = engines.map((engine) => inspection(engine.id));
  return {
    cacheKey: buildBenchmarkCacheKey(values, { platform: 'testos', arch: 'testarch' }),
    winner: 'parakeet',
    elapsedMs: {
      parakeet: { status: 'valid', value: 10 },
      whisper: { status: 'valid', value: 20 }
    },
    recordedAt: 4000,
    ...overrides
  };
}

test('Auto selects the only healthy local engine', async () => {
  const parakeet = fakeEngine('parakeet', { text: 'local result', elapsedMs: 80 });
  const whisper = fakeEngine('whisper', { healthy: false });
  let benchmarkLoads = 0;
  let benchmarkSaves = 0;
  const manager = new LocalSttManager({
    engines: [parakeet, whisper],
    loadBenchmark: () => { benchmarkLoads += 1; return null; },
    saveBenchmark: async () => { benchmarkSaves += 1; }
  });

  await manager.start({ requestedEngine: 'auto' });
  const result = await manager.transcribe(segment());

  assert.deepEqual(result, { text: 'local result', elapsedMs: 80, engine: 'parakeet' });
  assert.equal(manager.getStatus().activeEngine, 'parakeet');
  assert.deepEqual(parakeet.calls, { inspect: 1, start: 1, transcribe: 1, stop: 0 });
  assert.deepEqual(whisper.calls, { inspect: 1, start: 0, transcribe: 0, stop: 0 });
  assert.equal(benchmarkLoads, 0);
  assert.equal(benchmarkSaves, 0);
});

test('Auto preserves an empty no-speech result from its only healthy engine', async () => {
  const parakeet = fakeEngine('parakeet', { text: '', elapsedMs: 7 });
  const whisper = fakeEngine('whisper', { healthy: false });
  const manager = new LocalSttManager({ engines: [parakeet, whisper] });

  await manager.start({ requestedEngine: 'auto' });

  assert.deepEqual(await manager.transcribe(segment()), {
    text: '',
    elapsedMs: 7,
    engine: 'parakeet'
  });
  assert.equal(manager.getStatus().activeEngine, 'parakeet');
  assert.equal(whisper.calls.transcribe, 0);
});

test('a transient failure does not deactivate Auto\'s only healthy engine', async () => {
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper', { healthy: false });
  const timeout = Object.assign(new Error('transcription timed out'), { code: 'transcription_timeout' });
  const results = [timeout, { text: 'recovered locally', elapsedMs: 12 }];
  parakeet.transcribe = async () => {
    parakeet.calls.transcribe += 1;
    const next = results.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const manager = new LocalSttManager({ engines: [parakeet, whisper] });

  await manager.start({ requestedEngine: 'auto' });
  await assert.rejects(manager.transcribe(segment()), (error) => error === timeout);

  assert.equal(manager.getStatus().activeEngine, 'parakeet');
  assert.deepEqual(await manager.transcribe(segment()), {
    text: 'recovered locally',
    elapsedMs: 12,
    engine: 'parakeet'
  });
  assert.equal(manager.getStatus().activeEngine, 'parakeet');
  assert.equal(whisper.calls.transcribe, 0);
});

test('an explicit engine inspects and starts only that engine', async () => {
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper', { text: 'chosen' });
  const manager = new LocalSttManager({ engines: [whisper, parakeet] });

  await manager.start({ requestedEngine: 'whisper' });
  assert.equal((await manager.transcribe(segment())).text, 'chosen');
  assert.deepEqual(parakeet.calls, { inspect: 0, start: 0, transcribe: 0, stop: 0 });
  assert.deepEqual(whisper.calls, { inspect: 1, start: 1, transcribe: 1, stop: 0 });
});

test('explicit unavailable errors are stable and actionable', async () => {
  const manager = new LocalSttManager({
    engines: [fakeEngine('parakeet'), fakeEngine('whisper', { healthy: false })]
  });

  await assert.rejects(
    manager.start({ requestedEngine: 'whisper' }),
    (error) => error instanceof LocalSttError
      && error.code === 'engine_unavailable'
      && /Whisper/.test(error.message)
      && /Install it/.test(error.action)
  );
  assert.equal(manager.getStatus().phase, 'error');
});

test('requires exactly the two documented local engines', () => {
  assert.throws(
    () => new LocalSttManager({ engines: [fakeEngine('parakeet')] }),
    /exactly parakeet and whisper/i
  );
  assert.throws(
    () => new LocalSttManager({ engines: [fakeEngine('parakeet'), fakeEngine('cloud')] }),
    /exactly parakeet and whisper/i
  );
});

test('builds the benchmark key from platform, arch, runtimes, and models in engine order', () => {
  const values = [inspection('whisper'), inspection('parakeet')];
  assert.equal(buildBenchmarkCacheKey(values, { platform: 'darwin', arch: 'arm64' }), JSON.stringify({
    platform: 'darwin',
    arch: 'arm64',
    engines: [
      { id: 'parakeet', runtimeVersion: 'parakeet-1', modelFingerprint: 'parakeet-model-1' },
      { id: 'whisper', runtimeVersion: 'whisper-1', modelFingerprint: 'whisper-model-1' }
    ]
  }));
});

test('a valid cache starts its winner without benchmarking', async () => {
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper', { text: 'cached whisper' });
  const inspections = [inspection('parakeet'), inspection('whisper')];
  const cacheKey = buildBenchmarkCacheKey(inspections, { platform: 'testos', arch: 'testarch' });
  const manager = new LocalSttManager({
    engines: [parakeet, whisper],
    platform: 'testos',
    architecture: 'testarch',
    now: () => 5000,
    loadBenchmark: () => ({
      cacheKey,
      winner: 'whisper',
      elapsedMs: {
        parakeet: { status: 'valid', value: 20 },
        whisper: { status: 'valid', value: 10 }
      },
      recordedAt: 4000
    })
  });

  await manager.start({ requestedEngine: 'auto' });
  assert.equal((await manager.transcribe(segment())).engine, 'whisper');
  assert.equal(parakeet.calls.start, 0);
  assert.equal(whisper.calls.start, 1);
});

test('an uncached Auto race resolves the first valid result then records both timings once', async () => {
  const parakeetResult = deferred();
  const whisperResult = deferred();
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper');
  parakeet.transcribe = async () => { parakeet.calls.transcribe += 1; return parakeetResult.promise; };
  whisper.transcribe = async () => { whisper.calls.transcribe += 1; return whisperResult.promise; };
  const saved = [];
  const manager = new LocalSttManager({
    engines: [parakeet, whisper],
    platform: 'testos',
    architecture: 'testarch',
    now: () => 9000,
    loadBenchmark: () => null,
    saveBenchmark: async (record) => { saved.push(record); },
    isValidTranscript: (text) => text.trim() !== '' && text !== '[hallucination]'
  });

  await manager.start({ requestedEngine: 'auto' });
  const pending = manager.transcribe(segment());
  whisperResult.resolve({ text: '[hallucination]', elapsedMs: 30 });
  await Promise.resolve();
  parakeetResult.resolve({ text: 'hello', elapsedMs: 70 });
  assert.deepEqual(await pending, { text: 'hello', elapsedMs: 70, engine: 'parakeet' });
  assert.equal(manager.getStatus().activeEngine, 'parakeet');
  await manager.whenBenchmarkSettled();
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].elapsedMs, {
    parakeet: { status: 'valid', value: 70 },
    whisper: { status: 'invalid', value: 30 }
  });
  assert.equal(saved[0].winner, 'parakeet');
});

test('the first valid benchmark response serves the user while the faster elapsed result is cached', async () => {
  const parakeetResult = deferred();
  const whisperResult = deferred();
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper');
  parakeet.transcribe = async () => parakeetResult.promise;
  whisper.transcribe = async () => whisperResult.promise;
  const saved = [];
  const manager = new LocalSttManager({
    engines: [parakeet, whisper],
    platform: 'testos', architecture: 'testarch', now: () => 5000,
    loadBenchmark: () => null,
    saveBenchmark: async (record) => { saved.push(record); }
  });
  await manager.start({ requestedEngine: 'auto' });

  const pending = manager.transcribe(segment());
  parakeetResult.resolve({ text: 'first response', elapsedMs: 90 });
  assert.equal((await pending).engine, 'parakeet');
  assert.equal(manager.getStatus().activeEngine, 'parakeet');
  whisperResult.resolve({ text: 'faster inference', elapsedMs: 15 });
  await manager.whenBenchmarkSettled();

  assert.equal(saved.length, 1);
  assert.equal(saved[0].winner, 'whisper');
  assert.deepEqual(saved[0].elapsedMs, {
    parakeet: { status: 'valid', value: 90 },
    whisper: { status: 'valid', value: 15 }
  });
  assert.equal(manager.getStatus().activeEngine, 'parakeet');
});

test('equal valid benchmark timings choose Parakeet deterministically for the cache', async () => {
  const saved = [];
  const manager = new LocalSttManager({
    engines: [fakeEngine('parakeet', { text: 'one', elapsedMs: 20 }), fakeEngine('whisper', { text: 'two', elapsedMs: 20 })],
    loadBenchmark: () => null,
    saveBenchmark: async (record) => { saved.push(record); }
  });

  await manager.start({ requestedEngine: 'auto' });
  await manager.transcribe(segment());
  await manager.whenBenchmarkSettled();

  assert.equal(saved[0].winner, 'parakeet');
});

test('both invalid or failed benchmark results reject coherently without writing a cache', async () => {
  const parakeet = fakeEngine('parakeet', { text: 'Thank you for watching.', elapsedMs: 3 });
  const whisper = fakeEngine('whisper');
  whisper.transcribe = async () => { throw new Error('inference failed'); };
  const saved = [];
  const manager = new LocalSttManager({
    engines: [parakeet, whisper], loadBenchmark: () => null,
    saveBenchmark: async (record) => { saved.push(record); }
  });
  await manager.start({ requestedEngine: 'auto' });

  await assert.rejects(
    manager.transcribe(segment()),
    (error) => error.code === 'transcription_failed'
  );
  await new Promise(setImmediate);

  assert.deepEqual(saved, []);
  assert.equal(manager.getStatus().activeEngine, null);
});

test('simultaneous channels share the initial Auto benchmark before transcribing later work', async () => {
  const parakeetBenchmark = deferred();
  const whisperBenchmark = deferred();
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper');
  parakeet.transcribe = async () => {
    parakeet.calls.transcribe += 1;
    return parakeet.calls.transcribe === 1
      ? parakeetBenchmark.promise
      : { text: 'system follows winner', elapsedMs: 11 };
  };
  whisper.transcribe = async () => {
    whisper.calls.transcribe += 1;
    return whisperBenchmark.promise;
  };
  const manager = new LocalSttManager({ engines: [parakeet, whisper], loadBenchmark: () => null });
  await manager.start({ requestedEngine: 'auto' });

  const mic = manager.transcribe(segment());
  const system = manager.transcribe({ ...segment(), channel: 'them' }).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await new Promise(setImmediate);
  assert.equal(parakeet.calls.transcribe, 1);
  assert.equal(whisper.calls.transcribe, 1);

  parakeetBenchmark.resolve({ text: 'mic benchmark', elapsedMs: 20 });
  const micResult = await mic;
  const systemResult = await system;
  whisperBenchmark.resolve({ text: 'slow whisper', elapsedMs: 40 });
  await manager.whenBenchmarkSettled();

  assert.equal(micResult.text, 'mic benchmark');
  assert.equal(systemResult.error, undefined);
  assert.equal(systemResult.value.text, 'system follows winner');
  assert.equal(parakeet.calls.transcribe, 2);
});

test('the first benchmark copies and caps PCM to fifteen seconds without mutating the segment', async () => {
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper');
  const received = [];
  for (const engine of [parakeet, whisper]) {
    engine.transcribe = async (value) => {
      received.push({ engine: engine.id, value });
      return { text: engine.id, elapsedMs: engine.id === 'parakeet' ? 1 : 2 };
    };
  }
  const originalPcm = Buffer.alloc(16_000 * 2 * 40, 7);
  const original = { channel: 'them', pcm16: originalPcm, sampleRate: 16000, committed: false };
  const manager = new LocalSttManager({ engines: [parakeet, whisper], loadBenchmark: () => null });

  await manager.start({ requestedEngine: 'auto' });
  await manager.transcribe(original);
  await manager.whenBenchmarkSettled();

  assert.equal(original.pcm16, originalPcm);
  assert.equal(original.pcm16.length, 1280000);
  for (const item of received) {
    assert.notEqual(item.value, original);
    assert.notEqual(item.value.pcm16, originalPcm);
    assert.equal(item.value.pcm16.length, 480000);
    assert.equal(item.value.channel, 'them');
  }
});

test('Auto retries one uncommitted segment on the other healthy local engine', async () => {
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper', { text: 'recovered', elapsedMs: 22 });
  parakeet.transcribe = async () => {
    parakeet.calls.transcribe += 1;
    throw Object.assign(new Error('sidecar exited'), { code: 'engine_exit' });
  };
  const manager = new LocalSttManager({
    engines: [parakeet, whisper],
    platform: 'testos',
    architecture: 'testarch',
    now: () => 5000,
    loadBenchmark: () => validCacheFor([parakeet, whisper])
  });

  await manager.start({ requestedEngine: 'auto' });
  const result = await manager.transcribe(segment());

  assert.deepEqual(result, { text: 'recovered', elapsedMs: 22, engine: 'whisper' });
  assert.equal(parakeet.calls.transcribe, 1);
  assert.equal(whisper.calls.start, 1);
  assert.equal(whisper.calls.transcribe, 1);
  assert.equal(manager.getStatus().activeEngine, 'whisper');
  assert.match(manager.getStatus().detail, /Parakeet failed.*Whisper/i);
});

test('a failed runtime fallback never publishes an alternate as active before it starts', async () => {
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper');
  parakeet.transcribe = async () => { throw new Error('primary exited'); };
  whisper.start = async () => { whisper.calls.start += 1; throw new Error('alternate failed to load'); };
  const statuses = [];
  const manager = new LocalSttManager({
    engines: [parakeet, whisper],
    platform: 'testos', architecture: 'testarch', now: () => 5000,
    loadBenchmark: () => validCacheFor([parakeet, whisper])
  });
  manager.onStatus((status) => statuses.push(status));
  await manager.start({ requestedEngine: 'auto' });

  await assert.rejects(manager.transcribe(segment()), /alternate failed to load/);

  assert.deepEqual(statuses.slice(-3).map(({ phase, activeEngine }) => ({ phase, activeEngine })), [
    { phase: 'transcribing', activeEngine: 'parakeet' },
    { phase: 'fallback', activeEngine: null },
    { phase: 'error', activeEngine: null }
  ]);
  assert.equal(manager.getStatus().activeEngine, null);
});

test('an alternate transcription failure clears the active engine in the final error snapshot', async () => {
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper');
  parakeet.transcribe = async () => { throw new Error('primary exited'); };
  whisper.transcribe = async () => { throw new Error('alternate inference failed'); };
  const manager = new LocalSttManager({
    engines: [parakeet, whisper],
    platform: 'testos', architecture: 'testarch', now: () => 5000,
    loadBenchmark: () => validCacheFor([parakeet, whisper])
  });
  await manager.start({ requestedEngine: 'auto' });

  await assert.rejects(manager.transcribe(segment()), /alternate inference failed/);

  assert.equal(manager.getStatus().phase, 'error');
  assert.equal(manager.getStatus().activeEngine, null);
});

test('explicit selection never retries on the other engine', async () => {
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper');
  parakeet.transcribe = async () => { throw new Error('failed'); };
  const manager = new LocalSttManager({ engines: [parakeet, whisper] });

  await manager.start({ requestedEngine: 'parakeet' });
  await assert.rejects(manager.transcribe(segment()), /failed/);
  assert.equal(whisper.calls.inspect, 0);
  assert.equal(whisper.calls.start, 0);
  assert.equal(whisper.calls.transcribe, 0);
});

test('zero healthy engines reports one actionable local-only error', async () => {
  const manager = new LocalSttManager({
    engines: [fakeEngine('parakeet', { healthy: false }), fakeEngine('whisper', { healthy: false })]
  });
  await assert.rejects(
    manager.start({ requestedEngine: 'auto' }),
    (error) => error.code === 'local_stt_unavailable' && /local/i.test(error.message) && Boolean(error.action)
  );
  assert.deepEqual(manager.getStatus(), {
    phase: 'error', requestedEngine: 'auto', activeEngine: null,
    detail: 'Local speech recognition is unavailable.'
  });
});

test('stale, malformed, and unknown-engine cache records are ignored', async () => {
  for (const cached of [
    { cacheKey: 'wrong', winner: 'parakeet', elapsedMs: {}, recordedAt: 5000 },
    { cacheKey: validCacheFor([fakeEngine('parakeet'), fakeEngine('whisper')]).cacheKey, winner: 'cloud', elapsedMs: {}, recordedAt: 5000 },
    { ...validCacheFor([fakeEngine('parakeet'), fakeEngine('whisper')]), recordedAt: -10000000000 },
    { ...validCacheFor([fakeEngine('parakeet'), fakeEngine('whisper')]), unexpected: true }
  ]) {
    const parakeet = fakeEngine('parakeet');
    const whisper = fakeEngine('whisper');
    const manager = new LocalSttManager({
      engines: [parakeet, whisper],
      platform: 'testos', architecture: 'testarch', now: () => 5000,
      loadBenchmark: () => cached
    });
    await manager.start({ requestedEngine: 'auto' });
    assert.equal(manager.getStatus().activeEngine, null);
    assert.equal(parakeet.calls.start, 1);
    assert.equal(whisper.calls.start, 1);
    await manager.stop();
  }
});

test('a cache is ignored when current runtime or model identity metadata is incomplete', async () => {
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper');
  const incomplete = inspection('parakeet');
  incomplete.runtime.version = null;
  parakeet.inspect = async () => incomplete;
  const values = [incomplete, inspection('whisper')];
  const manager = new LocalSttManager({
    engines: [parakeet, whisper], platform: 'testos', architecture: 'testarch', now: () => 5000,
    loadBenchmark: () => ({
      cacheKey: buildBenchmarkCacheKey(values, { platform: 'testos', arch: 'testarch' }),
      winner: 'parakeet',
      elapsedMs: {
        parakeet: { status: 'valid', value: 1 },
        whisper: { status: 'valid', value: 2 }
      },
      recordedAt: 4000
    })
  });

  await manager.start({ requestedEngine: 'auto' });
  assert.equal(manager.getStatus().activeEngine, null);
  assert.equal(parakeet.calls.start, 1);
  assert.equal(whisper.calls.start, 1);
});

test('cached winner startup failure falls back by starting the healthy alternate', async () => {
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper');
  parakeet.start = async () => { parakeet.calls.start += 1; throw new Error('load failed'); };
  const manager = new LocalSttManager({
    engines: [parakeet, whisper], platform: 'testos', architecture: 'testarch', now: () => 5000,
    loadBenchmark: () => validCacheFor([parakeet, whisper])
  });

  await manager.start({ requestedEngine: 'auto' });
  assert.equal(manager.getStatus().phase, 'fallback');
  assert.equal(manager.getStatus().activeEngine, 'whisper');
  assert.match(manager.getStatus().detail, /Parakeet failed.*Whisper/i);
  assert.equal(whisper.calls.start, 1);
});

test('cached winner and alternate startup failures end with no falsely active engine', async () => {
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper');
  parakeet.start = async () => { parakeet.calls.start += 1; throw new Error('winner load failed'); };
  whisper.start = async () => { whisper.calls.start += 1; throw new Error('alternate load failed'); };
  const statuses = [];
  const manager = new LocalSttManager({
    engines: [parakeet, whisper], platform: 'testos', architecture: 'testarch', now: () => 5000,
    loadBenchmark: () => validCacheFor([parakeet, whisper])
  });
  manager.onStatus((status) => statuses.push(status));

  await assert.rejects(manager.start({ requestedEngine: 'auto' }), /alternate load failed/);

  assert.deepEqual(statuses.map(({ phase, activeEngine }) => ({ phase, activeEngine })), [
    { phase: 'probing', activeEngine: null },
    { phase: 'loading', activeEngine: 'parakeet' },
    { phase: 'fallback', activeEngine: null },
    { phase: 'error', activeEngine: null }
  ]);
  assert.deepEqual(manager.getStatus(), {
    phase: 'error', requestedEngine: 'auto', activeEngine: null,
    detail: 'Whisper failed to start: alternate load failed'
  });
});

test('bounds a benchmark loser to fifteen seconds after the winner', async () => {
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper');
  const loser = deferred();
  parakeet.transcribe = async () => ({ text: 'winner', elapsedMs: 10 });
  whisper.transcribe = async () => loser.promise;
  let timer = null;
  const cleared = [];
  const saved = [];
  const manager = new LocalSttManager({
    engines: [parakeet, whisper], platform: 'testos', architecture: 'testarch', now: () => 5000,
    loadBenchmark: () => null,
    setTimer: (callback, milliseconds) => { timer = { callback, milliseconds }; return timer; },
    clearTimer: (handle) => { cleared.push(handle); },
    saveBenchmark: async (record) => { saved.push(record); }
  });

  await manager.start({ requestedEngine: 'auto' });
  assert.equal((await manager.transcribe(segment())).engine, 'parakeet');
  await Promise.resolve();
  assert.equal(timer.milliseconds, 15000);
  timer.callback();
  await manager.whenBenchmarkSettled();
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].elapsedMs, {
    parakeet: { status: 'valid', value: 10 },
    whisper: { status: 'timeout', value: null }
  });
  assert.equal(cleared.length, 1);

  const nextParakeet = fakeEngine('parakeet');
  const nextWhisper = fakeEngine('whisper');
  const next = new LocalSttManager({
    engines: [nextParakeet, nextWhisper], platform: 'testos', architecture: 'testarch', now: () => 5001,
    loadBenchmark: () => saved[0]
  });
  await next.start({ requestedEngine: 'auto' });
  assert.equal(next.getStatus().activeEngine, 'parakeet');
  assert.equal(nextParakeet.calls.start, 1);
  assert.equal(nextWhisper.calls.start, 0);
});

test('a valid winner with an errored loser writes and reloads a strict tagged cache record', async () => {
  const parakeet = fakeEngine('parakeet', { text: 'usable', elapsedMs: 25 });
  const whisper = fakeEngine('whisper');
  whisper.transcribe = async () => { throw new Error('decoder exited'); };
  const saved = [];
  const manager = new LocalSttManager({
    engines: [parakeet, whisper], platform: 'testos', architecture: 'testarch', now: () => 5000,
    loadBenchmark: () => null, saveBenchmark: async (record) => { saved.push(record); }
  });
  await manager.start({ requestedEngine: 'auto' });
  assert.equal((await manager.transcribe(segment())).engine, 'parakeet');
  await manager.whenBenchmarkSettled();

  assert.deepEqual(saved[0].elapsedMs, {
    parakeet: { status: 'valid', value: 25 },
    whisper: { status: 'error', value: 0 }
  });
  const nextParakeet = fakeEngine('parakeet');
  const nextWhisper = fakeEngine('whisper');
  const next = new LocalSttManager({
    engines: [nextParakeet, nextWhisper], platform: 'testos', architecture: 'testarch', now: () => 5001,
    loadBenchmark: () => saved[0]
  });
  await next.start({ requestedEngine: 'auto' });
  assert.equal(next.getStatus().activeEngine, 'parakeet');
});

test('publishes immutable serializable lifecycle snapshots despite observer failures', async () => {
  const phases = [];
  const dispatched = [];
  const reported = [];
  const manager = new LocalSttManager({
    engines: [fakeEngine('parakeet'), fakeEngine('whisper', { healthy: false })],
    dispatch: (event) => { dispatched.push(event); if (event.patch.phase === 'loading') throw new Error('dispatch failed'); },
    onObserverError: (error) => { reported.push(error.message); }
  });
  manager.onStatus((status) => {
    phases.push(status.phase);
    assert.equal(Object.isFrozen(status), true);
    assert.equal(JSON.parse(JSON.stringify(status)).phase, status.phase);
    if (status.phase === 'probing') throw new Error('listener failed');
  });

  await manager.start({ requestedEngine: 'auto' });
  await manager.transcribe(segment());

  assert.deepEqual(phases, ['probing', 'loading', 'ready', 'transcribing', 'ready']);
  assert.deepEqual(dispatched.map((event) => event.patch.phase), phases);
  assert.deepEqual(reported.sort(), ['dispatch failed', 'listener failed']);
  assert.equal(Object.isFrozen(manager.getStatus()), true);
});

test('coalesces concurrent start and stop commands and remains restartable', async () => {
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper', { healthy: false });
  const inspectionGate = deferred();
  parakeet.inspect = async () => { parakeet.calls.inspect += 1; await inspectionGate.promise; return inspection('parakeet'); };
  const manager = new LocalSttManager({ engines: [parakeet, whisper] });

  const firstStart = manager.start({ requestedEngine: 'auto' });
  const secondStart = manager.start({ requestedEngine: 'auto' });
  assert.equal(firstStart, secondStart);
  inspectionGate.resolve();
  await firstStart;
  assert.equal(parakeet.calls.start, 1);

  const firstStop = manager.stop();
  const secondStop = manager.stop();
  assert.equal(firstStop, secondStop);
  await firstStop;
  await manager.start({ requestedEngine: 'parakeet' });
  assert.equal(parakeet.calls.start, 2);
});

test('serializes work per channel and rejects beyond the configured queue bound', async () => {
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper', { healthy: false });
  const first = deferred();
  parakeet.transcribe = async () => {
    parakeet.calls.transcribe += 1;
    return parakeet.calls.transcribe === 1 ? first.promise : { text: 'second', elapsedMs: 2 };
  };
  const manager = new LocalSttManager({ engines: [parakeet, whisper], maxQueuedTranscriptions: 2 });
  await manager.start({ requestedEngine: 'auto' });

  const one = manager.transcribe(segment());
  const two = manager.transcribe(segment());
  await new Promise(setImmediate);
  assert.equal(parakeet.calls.transcribe, 1);
  await assert.rejects(manager.transcribe(segment()), (error) => error.code === 'queue_full');
  first.resolve({ text: 'first', elapsedMs: 1 });
  assert.equal((await one).text, 'first');
  assert.equal((await two).text, 'second');
  assert.equal(parakeet.calls.transcribe, 2);
});

test('stop rejects active work once and invalidates late benchmark results and cache writes', async () => {
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper');
  const parakeetResult = deferred();
  const whisperResult = deferred();
  parakeet.transcribe = async () => parakeetResult.promise;
  whisper.transcribe = async () => whisperResult.promise;
  const saved = [];
  const manager = new LocalSttManager({
    engines: [parakeet, whisper], loadBenchmark: () => null,
    saveBenchmark: async (record) => { saved.push(record); }
  });
  await manager.start({ requestedEngine: 'auto' });
  const pending = manager.transcribe(segment());
  await Promise.resolve();

  await manager.stop();
  await assert.rejects(pending, (error) => error.code === 'stt_stopped');
  parakeetResult.resolve({ text: 'late', elapsedMs: 1 });
  whisperResult.resolve({ text: 'later', elapsedMs: 2 });
  await new Promise(setImmediate);

  assert.equal(saved.length, 0);
  assert.equal(manager.getStatus().phase, 'off');
  assert.equal(parakeet.calls.stop, 1);
  assert.equal(whisper.calls.stop, 1);
});

test('an abandoned old-generation transcription cannot block fresh same-channel work', async () => {
  const stale = deferred();
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper', { healthy: false });
  parakeet.transcribe = async () => {
    parakeet.calls.transcribe += 1;
    return parakeet.calls.transcribe === 1
      ? stale.promise
      : { text: 'fresh same channel', elapsedMs: 2 };
  };
  const manager = new LocalSttManager({ engines: [parakeet, whisper] });
  await manager.start({ requestedEngine: 'parakeet' });
  const oldWork = manager.transcribe(segment());
  const oldRejected = assert.rejects(oldWork, (error) => error.code === 'stt_stopped');
  await new Promise(setImmediate);
  await manager.stop();
  await oldRejected;
  await manager.start({ requestedEngine: 'parakeet' });

  const freshOutcome = await Promise.race([
    manager.transcribe(segment()).then((value) => value.text),
    new Promise((resolve) => setImmediate(() => resolve('blocked')))
  ]);

  assert.equal(freshOutcome, 'fresh same channel');
  assert.equal(parakeet.calls.transcribe, 2);
});

test('stop does not wait for an inspection that ignores cancellation', async () => {
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper', { healthy: false });
  const inspectionGate = deferred();
  parakeet.inspect = async () => { await inspectionGate.promise; return inspection('parakeet'); };
  const manager = new LocalSttManager({ engines: [parakeet, whisper] });
  const starting = manager.start({ requestedEngine: 'auto' });
  await Promise.resolve();

  const stopping = manager.stop();
  const outcome = await Promise.race([
    stopping.then(() => 'completed'),
    new Promise((resolve) => setImmediate(() => resolve('blocked')))
  ]);
  assert.equal(outcome, 'completed');
  inspectionGate.resolve();
  await assert.rejects(starting, (error) => error.code === 'stt_stopped');
});

test('stop during inspection stays off and a restart does not join the stale start promise', async () => {
  const staleInspection = deferred();
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper', { healthy: false });
  parakeet.inspect = async () => {
    parakeet.calls.inspect += 1;
    return parakeet.calls.inspect === 1 ? staleInspection.promise : inspection('parakeet');
  };
  const phases = [];
  const manager = new LocalSttManager({ engines: [parakeet, whisper] });
  manager.onStatus((status) => phases.push(status.phase));
  const staleStart = manager.start({ requestedEngine: 'parakeet' });
  const staleRejected = assert.rejects(staleStart, (error) => error.code === 'stt_stopped');
  await new Promise(setImmediate);
  await manager.stop();
  const offIndex = phases.lastIndexOf('off');

  const freshStart = manager.start({ requestedEngine: 'parakeet' });
  assert.notEqual(freshStart, staleStart);
  await freshStart;
  staleInspection.resolve(inspection('parakeet'));
  await staleRejected;
  await new Promise(setImmediate);

  assert.equal(manager.getStatus().phase, 'ready');
  assert.deepEqual(phases.slice(offIndex), ['off', 'probing', 'loading', 'ready']);
});

test('stop owns a cancellation-ignoring engine start and bounds its late cleanup', async () => {
  const startGate = deferred();
  const timers = [];
  const cleared = [];
  const parakeet = fakeEngine('parakeet');
  const whisper = fakeEngine('whisper', { healthy: false });
  parakeet.start = async () => { parakeet.calls.start += 1; await startGate.promise; };
  parakeet.stop = async () => { parakeet.calls.stop += 1; return new Promise(() => {}); };
  const manager = new LocalSttManager({
    engines: [parakeet, whisper], stopTimeoutMs: 123,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { cleared.push(timer); }
  });
  const starting = manager.start({ requestedEngine: 'parakeet' });
  const startRejected = assert.rejects(starting, (error) => error.code === 'stt_stopped');
  await new Promise(setImmediate);
  const stopping = manager.stop();
  await new Promise(setImmediate);

  assert.equal(parakeet.calls.stop, 1);
  assert.equal(timers[0].milliseconds, 123);
  timers[0].callback();
  await stopping;
  assert.equal(manager.getStatus().phase, 'off');

  startGate.resolve();
  await startRejected;
  await new Promise(setImmediate);
  assert.equal(parakeet.calls.stop, 2);
  assert.equal(timers[1].milliseconds, 123);
  timers[1].callback();
  await new Promise(setImmediate);
  assert.deepEqual(cleared, timers);
  assert.equal(manager.getStatus().phase, 'off');
});

test('the default transcript validator rejects known hallucinations but accepts speech', async () => {
  const invalid = new LocalSttManager({
    engines: [
      fakeEngine('parakeet', { text: 'Thank you for watching.', elapsedMs: 1 }),
      fakeEngine('whisper', { text: 'Okay.', elapsedMs: 2 })
    ],
    loadBenchmark: () => null
  });
  await invalid.start({ requestedEngine: 'auto' });
  await assert.rejects(invalid.transcribe(segment()), (error) => error.code === 'transcription_failed');

  const valid = new LocalSttManager({
    engines: [
      fakeEngine('parakeet', { text: 'Deploy the service now.', elapsedMs: 1 }),
      fakeEngine('whisper', { text: 'Ship the release.', elapsedMs: 2 })
    ],
    loadBenchmark: () => null
  });
  await valid.start({ requestedEngine: 'auto' });
  assert.equal((await valid.transcribe(segment())).text, 'Deploy the service now.');
  await valid.whenBenchmarkSettled();
});
