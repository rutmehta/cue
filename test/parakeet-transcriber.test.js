const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');

const {
  ParakeetTranscriber,
  buildOfflineMessage,
  pcm16ToFloat32Buffer
} = require('../src/parakeet-transcriber');

function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const timer = { id: nextId++, at: now + delay, callback };
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timers.delete(timer.id);
    },
    async advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const due = [...timers.values()]
          .filter((timer) => timer.at <= target)
          .sort((left, right) => left.at - right.at || left.id - right.id)[0];
        if (!due) break;
        timers.delete(due.id);
        now = due.at;
        due.callback();
        await tick();
      }
      now = target;
      await tick();
    },
    delays() {
      return [...timers.values()].map((timer) => timer.at - now).sort((a, b) => a - b);
    },
    get size() { return timers.size; }
  };
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4321;
    this.exitCode = null;
    this.signalCode = null;
    this.stderr = new EventEmitter();
    this.stdout = new EventEmitter();
  }

  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

class FakeSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.closeCalls = 0;
    this.readyState = 0;
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 2;
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  finish(code = 1000) {
    this.readyState = 3;
    this.emit('close', code);
  }
}

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

function createHarness(overrides = {}) {
  const clock = createClock();
  const child = new FakeChild();
  const spawnCalls = [];
  const portCalls = [];
  const stopCalls = [];
  const sockets = [];
  const inspection = {
    id: 'parakeet', healthy: true,
    runtime: { path: '/Applications/OpenWhispr.app/Contents/Resources/bin/sherpa' },
    model: { path: '/Users/test/.cache/openwhispr/parakeet-models/parakeet-tdt-0.6b-v3' },
    errors: []
  };
  class WebSocket extends FakeSocket {
    static OPEN = 1;
    constructor(url) {
      super(url);
      sockets.push(this);
    }
  }
  const dependencies = {
    inspect: async () => inspection,
    findPort: async (options) => {
      portCalls.push(options);
      return 6006;
    },
    spawn: (...args) => {
      spawnCalls.push(args);
      return child;
    },
    WebSocket,
    cpuCount: () => 8,
    platform: 'darwin',
    tempDirectory: '/private/tmp',
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    stopProcess: async (target, signal, options) => {
      stopCalls.push({ target, signal, options });
      if (overrides.autoExitOnStop !== false && signal === 'SIGTERM') target.exit(0, signal);
    },
    ...overrides.dependencies
  };
  return { child, clock, dependencies, inspection, portCalls, sockets, spawnCalls, stopCalls };
}

async function startReady(engine, harness, chunks = ['Listening on: 127.0.0.1:6006\n']) {
  const started = engine.start(harness.inspection);
  await tick();
  for (const chunk of chunks) harness.child.stderr.emit('data', Buffer.from(chunk));
  await started;
}

function expectCode(promise, code) {
  return assert.rejects(promise, (error) => error && error.name === 'LocalSttError' && error.code === code);
}

test('builds sherpa offline frame with little-endian header and float32 audio', () => {
  const pcm16 = Buffer.alloc(4);
  pcm16.writeInt16LE(-32768, 0);
  pcm16.writeInt16LE(16384, 2);
  const float32 = pcm16ToFloat32Buffer(pcm16);
  const frame = buildOfflineMessage(float32, 16000);
  assert.equal(frame.readInt32LE(0), 16000);
  assert.equal(frame.readInt32LE(4), 8);
  assert.equal(frame.readFloatLE(8), -1);
  assert.ok(Math.abs(frame.readFloatLE(12) - 0.5) < 0.0001);
});

test('accepts byte-oriented typed PCM views without reading outside the view', () => {
  const backing = new Uint8Array([99, 0x00, 0x80, 0x00, 0x40, 99]);
  const float32 = pcm16ToFloat32Buffer(backing.subarray(1, 5));
  assert.equal(float32.byteLength, 8);
  assert.equal(float32.readFloatLE(0), -1);
  assert.ok(Math.abs(float32.readFloatLE(4) - 0.5) < 0.0001);
});

test('rejects incomplete, empty, oversized PCM and unsupported sample metadata', () => {
  assert.throws(() => pcm16ToFloat32Buffer(Buffer.alloc(3)), /complete 16-bit samples/);
  assert.throws(() => pcm16ToFloat32Buffer(Buffer.alloc(0)), /audio samples/);
  assert.throws(() => pcm16ToFloat32Buffer('audio'), /Buffer or typed array/);
  assert.throws(() => pcm16ToFloat32Buffer({ byteLength: 2 }), /Buffer or typed array/);
  assert.throws(() => pcm16ToFloat32Buffer({ byteLength: 300 * 1024 * 1024 }), /Buffer or typed array|too large/);
  for (const sampleRate of [0, 7999, 192001, 16000.5, Infinity, '16000']) {
    assert.throws(() => buildOfflineMessage(Buffer.alloc(8), sampleRate), /sample rate/i);
  }
  assert.throws(() => buildOfflineMessage(Buffer.alloc(6), 16000), /float32 samples/i);
});

test('inspect normalizes a fresh inspection and does not retain caller objects', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  const result = await engine.inspect();
  assert.notStrictEqual(result, harness.inspection);
  assert.deepEqual(result.runtime, {
    path: harness.inspection.runtime.path, source: 'unknown', version: null
  });
  assert.deepEqual(result.model, {
    path: harness.inspection.model.path, source: 'unknown', fingerprint: null
  });
});

test('rejects unhealthy or wrong-engine inspection and invalid dependencies before port lookup or spawn', async () => {
  for (const inspection of [
    { id: 'parakeet', healthy: false, runtime: null, model: null, errors: [] },
    { id: 'whisper', runtime: { path: '/bin/w' }, model: { path: '/model/w' } },
    { id: 'parakeet', healthy: true }
  ]) {
    const harness = createHarness();
    const engine = new ParakeetTranscriber(harness.dependencies);
    await assert.rejects(engine.start(inspection), /healthy Parakeet inspection|runtime and model/i);
    assert.equal(harness.portCalls.length, 0);
    assert.equal(harness.spawnCalls.length, 0);
  }
  const harness = createHarness({ dependencies: { WebSocket: null } });
  const engine = new ParakeetTranscriber(harness.dependencies);
  await assert.rejects(engine.start(harness.inspection), /WebSocket/);
  assert.equal(harness.portCalls.length, 0);
  assert.equal(harness.spawnCalls.length, 0);
});

test('finds a bounded loopback port and spawns once with exact Task 1 arguments', async () => {
  const harness = createHarness({ dependencies: { findPort: async (options) => {
    harness.portCalls.push(options);
    return 6007;
  } } });
  const engine = new ParakeetTranscriber(harness.dependencies);
  const starts = Promise.all([engine.start(harness.inspection), engine.start(harness.inspection)]);
  await tick();
  harness.child.stderr.emit('data', Buffer.from('noise\nListen'));
  harness.child.stderr.emit('data', Buffer.from('ing on: 127.0.0.1:6007\n'));
  await starts;

  assert.deepEqual(harness.portCalls, [{ host: '127.0.0.1', start: 6006, end: 6029 }]);
  assert.equal(harness.spawnCalls.length, 1);
  const [command, args, options] = harness.spawnCalls[0];
  assert.equal(command, harness.inspection.runtime.path);
  assert.deepEqual(args, [
    `--tokens=${path.join(harness.inspection.model.path, 'tokens.txt')}`,
    `--encoder=${path.join(harness.inspection.model.path, 'encoder.int8.onnx')}`,
    `--decoder=${path.join(harness.inspection.model.path, 'decoder.int8.onnx')}`,
    `--joiner=${path.join(harness.inspection.model.path, 'joiner.int8.onnx')}`,
    '--port=6007', '--num-threads=4'
  ]);
  assert.deepEqual(options, {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    cwd: '/private/tmp', detached: true
  });
  assert.equal(harness.clock.size, 0);
  await engine.stop();
});

test('detects readiness even when a long stderr chunk follows the marker', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  const started = engine.start(harness.inspection);
  await tick();
  harness.child.stderr.emit('data', Buffer.from(`Listening on: 127.0.0.1:6006\n${'x'.repeat(1024)}`));
  await started;
  await engine.stop();
});

test('uses at least one and at most four threads', async () => {
  for (const [cpuCount, expected] of [[0, 1], [1, 1], [2, 1], [5, 3], [64, 4]]) {
    const harness = createHarness({ dependencies: { cpuCount: () => cpuCount } });
    const engine = new ParakeetTranscriber(harness.dependencies);
    await startReady(engine, harness);
    assert.equal(harness.spawnCalls[0][1].at(-1), `--num-threads=${expected}`);
    await engine.stop();
  }
});

test('accepts a numeric CPU count and uses non-detached child semantics on Windows', async () => {
  const harness = createHarness({ dependencies: { cpuCount: 6, platform: 'win32' } });
  const engine = new ParakeetTranscriber(harness.dependencies);
  await startReady(engine, harness);
  assert.equal(harness.spawnCalls[0][1].at(-1), '--num-threads=4');
  assert.equal(harness.spawnCalls[0][2].detached, false);
  await engine.stop();
  assert.equal(harness.stopCalls[0].options.detached, false);
});

test('status observer failures do not break start, exit handling, or stop', async () => {
  const harness = createHarness();
  const statuses = [];
  const engine = new ParakeetTranscriber(harness.dependencies);
  engine.onStatus(() => { throw new Error('observer failed'); });
  const unsubscribe = engine.onStatus((status) => statuses.push(status.status));
  await startReady(engine, harness);
  harness.child.exit(3, null);
  await tick();
  await engine.stop();
  unsubscribe();
  assert.deepEqual(statuses.slice(0, 3), ['starting', 'ready', 'error']);
});

test('consumes rejected thenables returned by status observers', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  let rejectionsConsumed = 0;
  engine.onStatus(() => ({
    then(_resolve, reject) {
      rejectionsConsumed += 1;
      reject(new Error('async observer failed'));
    }
  }));
  await startReady(engine, harness);
  await engine.stop();
  assert.equal(rejectionsConsumed, 3);
});

test('spawn error rejects once, cleans readiness resources, and permits restart', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  const first = engine.start(harness.inspection);
  await tick();
  harness.child.emit('error', new Error('ENOEXEC'));
  harness.child.exit(1, null);
  await expectCode(first, 'runtime_spawn_failed');
  assert.equal(harness.clock.size, 0);

  const second = engine.start(harness.inspection);
  await tick();
  harness.child.stderr.emit('data', Buffer.from('Listening on: 6006'));
  await second;
  assert.equal(harness.spawnCalls.length, 2);
  await engine.stop();
});

test('port lookup failure publishes a stable error and remains restartable', async () => {
  const harness = createHarness();
  const statuses = [];
  let attempts = 0;
  harness.dependencies.findPort = async (options) => {
    harness.portCalls.push(options);
    attempts += 1;
    if (attempts === 1) throw new Error('all ports busy');
    return 6006;
  };
  const engine = new ParakeetTranscriber(harness.dependencies);
  engine.onStatus((status) => statuses.push(status));
  await expectCode(engine.start(harness.inspection), 'port_unavailable');
  assert.equal(statuses.at(-1).status, 'error');
  assert.equal(statuses.at(-1).error.code, 'port_unavailable');
  await startReady(engine, harness);
  await engine.stop();
});

test('exit before readiness rejects once and permits restart', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  const first = engine.start(harness.inspection);
  await tick();
  harness.child.exit(12, null);
  harness.child.emit('exit', 13, null);
  await expectCode(first, 'engine_exit');
  assert.equal(harness.clock.size, 0);

  harness.child.exitCode = null;
  const second = engine.start(harness.inspection);
  await tick();
  harness.child.stderr.emit('data', Buffer.from('Listening on:'));
  await second;
  await engine.stop();
});

test('readiness timeout fires at exactly 15 seconds and cleans the child', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  const statuses = [];
  engine.onStatus((status) => statuses.push(status));
  const started = engine.start(harness.inspection);
  await tick();
  let settled = false;
  started.catch(() => { settled = true; });
  await harness.clock.advance(14999);
  assert.equal(settled, false);
  await harness.clock.advance(1);
  await expectCode(started, 'readiness_timeout');
  assert.equal(harness.stopCalls[0].signal, 'SIGTERM');
  assert.equal(harness.clock.size, 0);
  assert.equal(harness.child.stderr.listenerCount('data'), 0);
  assert.equal(harness.child.listenerCount('error'), 0);
  assert.equal(harness.child.listenerCount('exit'), 0);
  assert.equal(statuses.at(-1).status, 'error');
  assert.equal(statuses.at(-1).error.code, 'readiness_timeout');
});

test('stop during startup rejects that generation once and a later start succeeds', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  const first = engine.start(harness.inspection);
  await tick();
  await engine.stop();
  await expectCode(first, 'engine_stopped');
  harness.child.exitCode = null;
  const second = engine.start(harness.inspection);
  await tick();
  harness.child.stderr.emit('data', Buffer.from('Listening on:'));
  await second;
  await engine.stop();
});

test('sends one binary frame, accumulates JSON results, sends literal Done, and resolves on close', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  await startReady(engine, harness);
  const request = engine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(3200), sampleRate: 16000 });
  await tick();
  const socket = harness.sockets[0];
  socket.open();
  assert.equal(socket.url, 'ws://127.0.0.1:6006');
  assert.equal(socket.sent.length, 1);
  assert.ok(Buffer.isBuffer(socket.sent[0]));
  assert.equal(socket.sent[0].readInt32LE(0), 16000);
  assert.equal(socket.sent[0].readInt32LE(4), 6400);
  socket.emit('message', Buffer.from('{"text":"hello"}'));
  socket.emit('message', '{"text":"world"}');
  assert.deepEqual(socket.sent.slice(1), ['Done']);
  let settled = false;
  request.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  socket.finish(1000);
  assert.deepEqual(await request, { text: 'hello world', elapsedMs: 0 });
  assert.equal(harness.clock.size, 0);
  await engine.stop();
});

test('uses trimmed text as the fallback for every malformed JSON shape', async () => {
  for (const [message, expected] of [['  fallback text \n', 'fallback text'], ['{not-json}', '{not-json}']]) {
    const harness = createHarness();
    const engine = new ParakeetTranscriber(harness.dependencies);
    await startReady(engine, harness);
    const request = engine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(2), sampleRate: 16000 });
    await tick();
    harness.sockets[0].open();
    harness.sockets[0].emit('message', Buffer.from(message));
    harness.sockets[0].finish();
    assert.equal((await request).text, expected);
    await engine.stop();
  }
});

test('close before a usable result rejects with a stable protocol error', async () => {
  for (const message of [null, '', '   ', '{"partial":"missing text"}', '{"text":""}']) {
    const harness = createHarness();
    const engine = new ParakeetTranscriber(harness.dependencies);
    await startReady(engine, harness);
    const request = engine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(2), sampleRate: 16000 });
    await tick();
    harness.sockets[0].open();
    if (message !== null) harness.sockets[0].emit('message', message);
    harness.sockets[0].finish();
    await expectCode(request, 'protocol_failure');
    await engine.stop();
  }
});

test('WebSocket constructor and emitted errors reject with stable protocol errors', async () => {
  const constructorHarness = createHarness({ dependencies: {
    WebSocket: class { constructor() { throw new Error('constructor failure'); } }
  } });
  const constructorEngine = new ParakeetTranscriber(constructorHarness.dependencies);
  await startReady(constructorEngine, constructorHarness);
  await expectCode(constructorEngine.transcribe({
    channel: 'mic', pcm16: Buffer.alloc(2), sampleRate: 16000
  }), 'protocol_failure');
  await constructorEngine.stop();

  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  await startReady(engine, harness);
  const request = engine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(2), sampleRate: 16000 });
  await tick();
  harness.sockets[0].emit('error', new Error('socket failed'));
  await expectCode(request, 'protocol_failure');
  assert.equal(harness.sockets[0].closeCalls, 1);
  await engine.stop();
});

test('transcription timeout is duration-based with 10-second floor and 120-second ceiling', async () => {
  const shortHarness = createHarness();
  const shortEngine = new ParakeetTranscriber(shortHarness.dependencies);
  await startReady(shortEngine, shortHarness);
  const shortRequest = shortEngine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(3200), sampleRate: 16000 });
  await tick();
  assert.deepEqual(shortHarness.clock.delays(), [10000]);
  await shortHarness.clock.advance(10000);
  await expectCode(shortRequest, 'transcription_timeout');
  assert.equal(shortHarness.sockets[0].closeCalls, 1);
  await shortEngine.stop();

  const longHarness = createHarness();
  const longEngine = new ParakeetTranscriber(longHarness.dependencies);
  await startReady(longEngine, longHarness);
  const longRequest = longEngine.transcribe({
    channel: 'system', pcm16: Buffer.alloc(16000 * 2 * 40), sampleRate: 16000
  });
  await tick();
  assert.deepEqual(longHarness.clock.delays(), [120000]);
  await longHarness.clock.advance(120000);
  await expectCode(longRequest, 'transcription_timeout');
  await longEngine.stop();
});

test('serializes requests within a channel while mic and system run concurrently', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  await startReady(engine, harness);
  const mic1 = engine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(2), sampleRate: 16000 });
  const mic2 = engine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(2), sampleRate: 16000 });
  const system = engine.transcribe({ channel: 'system', pcm16: Buffer.alloc(2), sampleRate: 16000 });
  await tick();
  assert.equal(harness.sockets.length, 2);
  for (const [socket, text] of [[harness.sockets[0], 'mic one'], [harness.sockets[1], 'system one']]) {
    socket.open();
    socket.emit('message', JSON.stringify({ text }));
    socket.finish();
  }
  assert.equal((await mic1).text, 'mic one');
  assert.equal((await system).text, 'system one');
  await tick();
  assert.equal(harness.sockets.length, 3);
  harness.sockets[2].open();
  harness.sockets[2].emit('message', '{"text":"mic two"}');
  harness.sockets[2].finish();
  assert.equal((await mic2).text, 'mic two');
  await engine.stop();
});

test('validates every transcription input before creating or queueing a socket', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  await startReady(engine, harness);
  for (const request of [
    { channel: '', pcm16: Buffer.alloc(2), sampleRate: 16000 },
    { channel: 'mic', pcm16: Buffer.alloc(0), sampleRate: 16000 },
    { channel: 'mic', pcm16: Buffer.alloc(3), sampleRate: 16000 },
    { channel: 'mic', pcm16: Buffer.alloc(2), sampleRate: NaN }
  ]) await assert.rejects(engine.transcribe(request), /channel|audio samples|16-bit|sample rate/i);
  assert.equal(harness.sockets.length, 0);
  await engine.stop();
});

test('child exit after readiness reports error and rejects active and queued requests once', async () => {
  const harness = createHarness();
  const statuses = [];
  const engine = new ParakeetTranscriber(harness.dependencies);
  engine.onStatus((status) => statuses.push(status));
  await startReady(engine, harness);
  const active = engine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(2), sampleRate: 16000 });
  const queued = engine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(2), sampleRate: 16000 });
  await tick();
  harness.child.exit(9, null);
  harness.child.emit('exit', 10, null);
  await expectCode(active, 'engine_exit');
  await expectCode(queued, 'engine_exit');
  assert.equal(harness.sockets[0].closeCalls, 1);
  assert.equal(statuses.at(-1).status, 'error');
  assert.equal(statuses.at(-1).error.code, 'engine_exit');
  await engine.stop();
});

test('child error after readiness retains and terminates the owned process during stop', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  await startReady(engine, harness);
  harness.child.emit('error', new Error('runtime pipe failure'));
  await tick();
  await engine.stop();
  assert.deepEqual(harness.stopCalls.map((call) => call.signal), ['SIGTERM']);
  assert.equal(harness.stopCalls[0].target, harness.child);
});

test('concurrent stop closes sockets, rejects all work, TERM-kills only its child, then returns on exit', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  await startReady(engine, harness);
  const activeMic = engine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(2), sampleRate: 16000 });
  const queuedMic = engine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(2), sampleRate: 16000 });
  const activeSystem = engine.transcribe({ channel: 'system', pcm16: Buffer.alloc(2), sampleRate: 16000 });
  await tick();
  const stopped = Promise.all([engine.stop(), engine.stop()]);
  await stopped;
  await Promise.all([
    expectCode(activeMic, 'engine_stopped'),
    expectCode(queuedMic, 'engine_stopped'),
    expectCode(activeSystem, 'engine_stopped')
  ]);
  assert.equal(harness.sockets.every((socket) => socket.closeCalls === 1), true);
  assert.deepEqual(harness.stopCalls, [{
    target: harness.child, signal: 'SIGTERM', options: { detached: true }
  }]);
  assert.equal(harness.clock.size, 0);
  assert.equal(harness.child.stderr.listenerCount('data'), 0);
  assert.equal(harness.child.listenerCount('error'), 0);
  assert.equal(harness.child.listenerCount('exit'), 0);
});

test('stop escalates to SIGKILL at exactly two seconds when the owned child remains alive', async () => {
  const harness = createHarness({ autoExitOnStop: false });
  const engine = new ParakeetTranscriber(harness.dependencies);
  await startReady(engine, harness);
  const stopped = engine.stop();
  await tick();
  assert.deepEqual(harness.stopCalls.map((call) => call.signal), ['SIGTERM']);
  await harness.clock.advance(1999);
  assert.deepEqual(harness.stopCalls.map((call) => call.signal), ['SIGTERM']);
  await harness.clock.advance(1);
  await stopped;
  assert.deepEqual(harness.stopCalls.map((call) => call.signal), ['SIGTERM', 'SIGKILL']);
  assert.equal(harness.stopCalls.every((call) => call.target === harness.child), true);
  assert.equal(harness.clock.size, 0);
});

test('stop remains bounded when the injected process stopper returns a never-settling promise', async () => {
  const calls = [];
  const harness = createHarness({ autoExitOnStop: false, dependencies: {
    stopProcess(target, signal, options) {
      calls.push({ target, signal, options });
      return new Promise(() => {});
    }
  } });
  const engine = new ParakeetTranscriber(harness.dependencies);
  await startReady(engine, harness);
  const stopped = engine.stop();
  await harness.clock.advance(2000);
  await stopped;
  assert.deepEqual(calls.map((call) => call.signal), ['SIGTERM', 'SIGKILL']);
});

test('can restart after a completed stop with a new lifecycle generation', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  await startReady(engine, harness);
  await engine.stop();
  harness.child.exitCode = null;
  await startReady(engine, harness);
  assert.equal(harness.spawnCalls.length, 2);
  await engine.stop();
});
