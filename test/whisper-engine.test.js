const assert = require('node:assert/strict');
const test = require('node:test');
const { WhisperEngine } = require('../src/whisper-engine');

const MODEL = Object.freeze({
  id: 'fixture',
  filename: 'ggml-fixture.bin',
  bytes: 123,
  sha256: 'a'.repeat(64),
  englishOnly: true,
  tinydiarize: false
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(overrides = {}) {
  const controls = { transcribers: [], options: [] };
  const options = {
    modelId: MODEL.id,
    requireModel: () => MODEL,
    locateRuntime: () => ({
      available: true,
      version: 'whisper.cpp-v1',
      target: 'testos-testarch',
      runtimeDirectory: '/runtime/whisper',
      executablePath: '/runtime/whisper/server'
    }),
    modelManager: {
      async verifyInstalledModel() { return '/models/ggml-fixture.bin'; }
    },
    setTimer: (callback, milliseconds) => ({ callback, milliseconds }),
    clearTimer: () => {},
    transcriberFactory: (transcriberOptions) => {
      controls.options.push(transcriberOptions);
      const transcriber = {
        startCalls: 0,
        stopCalls: 0,
        pushes: [],
        async start() { this.startCalls += 1; },
        push(channel, pcm, requestId) { this.pushes.push({ channel, pcm: Buffer.from(pcm), requestId }); },
        async stop() { this.stopCalls += 1; },
        async forceStop() { this.stopCalls += 1; }
      };
      controls.transcribers.push(transcriber);
      return transcriber;
    },
    ...overrides
  };
  return { controls, options };
}

function segment(channel = 'you', text = 'pcm') {
  const bytes = Buffer.from(text);
  const pcm16 = bytes.length % 2 === 0 ? bytes : Buffer.concat([bytes, Buffer.alloc(1)]);
  return { channel, pcm16, sampleRate: 16000 };
}

test('inspection reports a checksum-invalid same-size model as corrupt', async () => {
  const fixture = harness({
    modelManager: {
      async verifyInstalledModel() {
        throw Object.assign(new Error('checksum mismatch'), { code: 'MODEL_CHECKSUM_MISMATCH' });
      }
    }
  });
  const engine = new WhisperEngine(fixture.options);

  const value = await engine.inspect();

  assert.equal(value.id, 'whisper');
  assert.equal(value.healthy, false);
  assert.equal(value.errors[0].code, 'model_corrupt');
  assert.match(value.errors[0].action, /download|import/i);
});

test('healthy inspection includes the verified runtime version and model checksum fingerprint', async () => {
  const fixture = harness();
  const engine = new WhisperEngine(fixture.options);

  assert.deepEqual(await engine.inspect(), {
    id: 'whisper',
    healthy: true,
    runtime: { path: '/runtime/whisper/server', source: 'prepared', version: 'whisper.cpp-v1' },
    model: { path: '/models/ggml-fixture.bin', source: 'cue', fingerprint: 'a'.repeat(64) },
    errors: []
  });
});

test('healthy inspection identifies a packaged runtime source', async () => {
  const fixture = harness({ runtimeOptions: { isPackaged: true } });
  const engine = new WhisperEngine(fixture.options);

  assert.equal((await engine.inspect()).runtime.source, 'packaged');
});

test('inspection reports runtime and model failures together with stable remediation', async () => {
  const fixture = harness({
    locateRuntime: () => ({
      available: false,
      version: 'whisper.cpp-v1',
      target: 'testos-testarch',
      runtimeDirectory: '/runtime/whisper',
      executablePath: null,
      message: 'Run npm run prepare:whisper.'
    }),
    modelManager: {
      async verifyInstalledModel() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }
    }
  });
  const engine = new WhisperEngine(fixture.options);

  const value = await engine.inspect();
  assert.equal(value.healthy, false);
  assert.deepEqual(value.errors.map((error) => error.code), ['runtime_missing', 'model_missing']);
  assert.match(value.errors[0].action, /prepare:whisper/);
});

test('inspection identifies an inaccessible runtime without weakening model verification', async () => {
  let modelVerifications = 0;
  const fixture = harness({
    locateRuntime: async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); },
    modelManager: {
      async verifyInstalledModel() { modelVerifications += 1; return '/models/ggml-fixture.bin'; }
    }
  });
  const engine = new WhisperEngine(fixture.options);

  const value = await engine.inspect();
  assert.equal(modelVerifications, 1);
  assert.equal(value.errors[0].code, 'runtime_not_executable');
});

test('concurrent starts create one transcriber and restart creates a fresh generation', async () => {
  const fixture = harness();
  const engine = new WhisperEngine(fixture.options);

  const first = engine.start();
  const second = engine.start();
  assert.equal(first, second);
  await first;
  assert.equal(fixture.controls.transcribers.length, 1);
  assert.equal(fixture.controls.transcribers[0].startCalls, 1);
  await engine.stop();
  await engine.start();
  assert.equal(fixture.controls.transcribers.length, 2);
  assert.equal(fixture.controls.transcribers[1].startCalls, 1);
});

test('pairs unique callback ids without cross-delivery and serializes each channel', async () => {
  let clock = 100;
  const fixture = harness({ now: () => ++clock });
  const engine = new WhisperEngine(fixture.options);
  await engine.start();
  const callbacks = fixture.controls.options[0];
  const transcriber = fixture.controls.transcribers[0];

  const youFirst = engine.transcribe(segment('you', 'one'));
  const youSecond = engine.transcribe(segment('you', 'two'));
  const them = engine.transcribe(segment('them', 'three'));
  await new Promise(setImmediate);

  assert.equal(transcriber.pushes.length, 2);
  const firstPush = transcriber.pushes.find((value) => value.channel === 'you');
  const themPush = transcriber.pushes.find((value) => value.channel === 'them');
  assert.notEqual(firstPush.requestId, themPush.requestId);
  callbacks.onTranscript('you', 'crossed', themPush.requestId);
  callbacks.onTranscript('them', 'remote', themPush.requestId);
  assert.equal((await them).text, 'remote');
  callbacks.onTranscript('you', 'first', firstPush.requestId);
  assert.equal((await youFirst).text, 'first');
  await new Promise(setImmediate);

  assert.equal(transcriber.pushes.length, 3);
  const secondPush = transcriber.pushes[2];
  assert.notEqual(secondPush.requestId, firstPush.requestId);
  callbacks.onTranscript('you', 'second', secondPush.requestId);
  assert.equal((await youSecond).text, 'second');
});

test('a request-specific local error rejects only its matching transcription', async () => {
  const fixture = harness();
  const engine = new WhisperEngine(fixture.options);
  await engine.start();
  const callbacks = fixture.controls.options[0];
  const transcriber = fixture.controls.transcribers[0];
  const first = engine.transcribe(segment('you', 'one'));
  const second = engine.transcribe(segment('them', 'two'));
  await new Promise(setImmediate);
  const firstPush = transcriber.pushes.find((value) => value.channel === 'you');
  const secondPush = transcriber.pushes.find((value) => value.channel === 'them');

  callbacks.onError(Object.assign(new Error('local inference failed'), { code: 'INFERENCE_FAILED' }), 'you', firstPush.requestId);
  callbacks.onTranscript('them', 'still local', secondPush.requestId);

  await assert.rejects(first, /local inference failed/);
  assert.equal((await second).text, 'still local');
});

test('stop rejects active and queued work, ignores late callbacks, and prevents future pushes', async () => {
  const fixture = harness();
  const engine = new WhisperEngine(fixture.options);
  await engine.start();
  const callbacks = fixture.controls.options[0];
  const transcriber = fixture.controls.transcribers[0];
  const active = engine.transcribe(segment('you', 'one'));
  const queued = engine.transcribe(segment('you', 'two'));
  await new Promise(setImmediate);
  const requestId = transcriber.pushes[0].requestId;

  await engine.stop();
  await assert.rejects(active, (error) => error.code === 'stt_stopped');
  await assert.rejects(queued, (error) => error.code === 'stt_stopped');
  callbacks.onTranscript('you', 'late', requestId);
  await assert.rejects(engine.transcribe(segment()), (error) => error.code === 'stt_stopped');
  assert.equal(transcriber.pushes.length, 1);
});

test('bounds each channel queue and segment input before pushing the transcriber', async () => {
  const fixture = harness({ maxQueuePerChannel: 2 });
  const engine = new WhisperEngine(fixture.options);
  await engine.start();
  const first = engine.transcribe(segment('you', 'one'));
  const second = engine.transcribe(segment('you', 'two'));
  await assert.rejects(engine.transcribe(segment('you', 'three')), (error) => error.code === 'queue_full');
  await assert.rejects(
    engine.transcribe({ channel: 'you', pcm16: Buffer.alloc(16000 * 2 * 30 + 2), sampleRate: 16000 }),
    (error) => error.code === 'invalid_segment'
  );
  await new Promise(setImmediate);
  assert.equal(fixture.controls.transcribers[0].pushes.length, 1);
  const firstRejected = assert.rejects(first, (error) => error.code === 'stt_stopped');
  const secondRejected = assert.rejects(second, (error) => error.code === 'stt_stopped');
  await engine.stop();
  await firstRejected;
  await secondRejected;
});

test('times out a request with injected timers and clears its timer exactly once', async () => {
  const timers = [];
  const cleared = [];
  const fixture = harness({
    transcriptionTimeoutMs: 321,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { cleared.push(timer); }
  });
  const engine = new WhisperEngine(fixture.options);
  await engine.start();
  const pending = engine.transcribe(segment());
  await new Promise(setImmediate);

  assert.equal(timers[0].milliseconds, 321);
  timers[0].callback();
  await assert.rejects(pending, (error) => error.code === 'transcription_timeout');
  assert.deepEqual(cleared, [timers[0]]);
});

test('repeated timeouts retain capacity until lower-level callbacks terminate the work', async () => {
  const timers = [];
  const cleared = [];
  const fixture = harness({
    maxQueuePerChannel: 3,
    transcriptionTimeoutMs: 50,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { cleared.push(timer); }
  });
  const engine = new WhisperEngine(fixture.options);
  await engine.start();
  const callbacks = fixture.controls.options[0];
  const transcriber = fixture.controls.transcribers[0];

  const first = engine.transcribe(segment('you', 'one'));
  const firstRejected = assert.rejects(first, (error) => error.code === 'transcription_timeout');
  await new Promise(setImmediate);
  const firstPush = transcriber.pushes[0];
  timers[0].callback();
  await firstRejected;

  const second = engine.transcribe(segment('you', 'two'));
  const third = engine.transcribe(segment('you', 'three'));
  await assert.rejects(engine.transcribe(segment('you', 'four')), (error) => error.code === 'queue_full');
  await new Promise(setImmediate);
  assert.equal(transcriber.pushes.length, 1);
  assert.equal(timers.length, 1);

  callbacks.onTranscript('you', 'late first', firstPush.requestId);
  await new Promise(setImmediate);
  assert.equal(transcriber.pushes.length, 2);
  const secondPush = transcriber.pushes[1];
  const secondRejected = assert.rejects(second, (error) => error.code === 'transcription_timeout');
  timers[1].callback();
  await secondRejected;

  const fourth = engine.transcribe(segment('you', 'four'));
  await assert.rejects(engine.transcribe(segment('you', 'five')), (error) => error.code === 'queue_full');
  await new Promise(setImmediate);
  assert.equal(transcriber.pushes.length, 2);
  assert.equal(timers.length, 2);

  callbacks.onError(new Error('late second'), 'you', secondPush.requestId);
  await new Promise(setImmediate);
  assert.equal(transcriber.pushes.length, 3);
  const thirdRejected = assert.rejects(third, (error) => error.code === 'stt_stopped');
  const fourthRejected = assert.rejects(fourth, (error) => error.code === 'stt_stopped');
  await engine.stop();
  await thirdRejected;
  await fourthRejected;

  assert.equal(cleared.filter((timer) => timers.slice(0, 2).includes(timer)).length, 2);
});

test('isolates status observer failures and returns immutable transcript results', async () => {
  const reported = [];
  const statuses = [];
  const fixture = harness({ onObserverError: (error) => { reported.push(error.message); } });
  const engine = new WhisperEngine(fixture.options);
  engine.onStatus((status) => {
    statuses.push(status.status);
    assert.equal(Object.isFrozen(status), true);
    throw new Error('observer failed');
  });
  await engine.start();
  const callbacks = fixture.controls.options[0];
  const pending = engine.transcribe(segment());
  await new Promise(setImmediate);
  callbacks.onStatus({ status: 'transcribing', nested: { pending: 1 } });
  callbacks.onTranscript('you', 'immutable', fixture.controls.transcribers[0].pushes[0].requestId);
  const result = await pending;

  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(statuses, ['transcribing']);
  assert.deepEqual(reported, ['observer failed']);
});

test('status observers receive independent deeply immutable snapshots', async () => {
  const fixture = harness();
  const engine = new WhisperEngine(fixture.options);
  const seen = [];
  engine.onStatus((status) => { status.nested.pending = 99; });
  engine.onStatus((status) => {
    seen.push(status.nested.pending);
    assert.equal(Object.isFrozen(status.nested), true);
  });
  await engine.start();
  fixture.controls.options[0].onStatus({ status: 'ready', nested: { pending: 1 } });

  assert.deepEqual(seen, [1]);
});

test('forwards loading and ready status emitted during transcriber startup', async () => {
  const fixture = harness({
    transcriberFactory: (options) => {
      fixture.controls.options.push(options);
      const transcriber = {
        async start() {
          options.onStatus({ status: 'loading' });
          options.onStatus({ status: 'ready' });
        },
        push() {},
        async stop() {},
        async forceStop() {}
      };
      fixture.controls.transcribers.push(transcriber);
      return transcriber;
    }
  });
  const engine = new WhisperEngine(fixture.options);
  const statuses = [];
  engine.onStatus((status) => { statuses.push(status.status); });

  await engine.start();
  assert.deepEqual(statuses, ['loading', 'ready']);
});

test('stop force-stops a startup generation without waiting for its start promise', async () => {
  const startGate = deferred();
  const fixture = harness({
    transcriberFactory: (options) => {
      fixture.controls.options.push(options);
      const transcriber = {
        forceStopCalls: 0,
        async start() { await startGate.promise; },
        push() {},
        async stop() {},
        async forceStop() { this.forceStopCalls += 1; }
      };
      fixture.controls.transcribers.push(transcriber);
      return transcriber;
    }
  });
  const engine = new WhisperEngine(fixture.options);
  const starting = engine.start();
  await new Promise(setImmediate);
  const stopping = engine.stop();
  const outcome = await Promise.race([
    stopping.then(() => 'completed'),
    new Promise((resolve) => setImmediate(() => resolve('blocked')))
  ]);

  assert.equal(outcome, 'completed');
  assert.equal(fixture.controls.transcribers[0].forceStopCalls, 1);
  startGate.resolve();
  await assert.rejects(starting, (error) => error.code === 'stt_stopped');
});

test('a fresh start after stopping does not join a cancellation-ignoring stale start', async () => {
  const staleStartGate = deferred();
  const fixture = harness({
    transcriberFactory: (options) => {
      fixture.controls.options.push(options);
      const index = fixture.controls.transcribers.length;
      const transcriber = {
        forceStopCalls: 0,
        async start() { if (index === 0) await staleStartGate.promise; },
        push() {},
        async stop() {},
        async forceStop() { this.forceStopCalls += 1; }
      };
      fixture.controls.transcribers.push(transcriber);
      return transcriber;
    }
  });
  const engine = new WhisperEngine(fixture.options);
  const staleStart = engine.start();
  const staleRejected = assert.rejects(staleStart, (error) => error.code === 'stt_stopped');
  await new Promise(setImmediate);
  await engine.stop();

  const freshStart = engine.start();
  assert.notEqual(freshStart, staleStart);
  await freshStart;
  assert.equal(fixture.controls.transcribers.length, 2);

  staleStartGate.resolve();
  await staleRejected;
  await new Promise(setImmediate);
  assert.equal(engine.running, true);
  assert.equal(fixture.controls.transcribers[0].forceStopCalls, 2);
});

test('stop has an injected bound when the transcriber ignores shutdown', async () => {
  const timers = [];
  const cleared = [];
  const fixture = harness({
    stopTimeoutMs: 456,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { cleared.push(timer); },
    transcriberFactory: (options) => {
      fixture.controls.options.push(options);
      const transcriber = {
        async start() {},
        push() {},
        async stop() { return new Promise(() => {}); },
        async forceStop() {}
      };
      fixture.controls.transcribers.push(transcriber);
      return transcriber;
    }
  });
  const engine = new WhisperEngine(fixture.options);
  await engine.start();
  const stopping = engine.stop();
  await new Promise(setImmediate);

  assert.equal(timers[0].milliseconds, 456);
  timers[0].callback();
  await stopping;
  assert.deepEqual(cleared, [timers[0]]);
});
