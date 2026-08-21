const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');

const {
  ParakeetTranscriber,
  buildOfflineMessage,
  pcm16ToFloat32Buffer
} = require('../src/parakeet-transcriber');
const { LocalSttError } = require('../src/local-stt-engine');

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
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
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

  terminate() {
    this.terminateCalls = (this.terminateCalls || 0) + 1;
    this.readyState = 3;
    this.emit('close', 1006);
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settleResolve, settleReject) => {
    resolve = settleResolve;
    reject = settleReject;
  });
  return { promise, resolve, reject };
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
    constructor(url, options) {
      super(url, options);
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

function useDistinctChildren(harness, children, stopBehavior = 'exit') {
  const order = [];
  harness.dependencies.spawn = (...args) => {
    harness.spawnCalls.push(args);
    const child = children[harness.spawnCalls.length - 1];
    order.push(`spawn:${child.pid}`);
    return child;
  };
  harness.dependencies.stopProcess = (target, signal, options) => {
    harness.stopCalls.push({ target, signal, options });
    order.push(`${signal}:${target.pid}`);
    if (stopBehavior === 'throw') throw new Error('stopper failed');
    if (stopBehavior === 'hang') return new Promise(() => {});
    if (signal === 'SIGTERM') target.exit(0, signal);
  };
  return order;
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

function runStrictWebSocketAbortScenario(mode) {
  const modulePath = require.resolve('../src/parakeet-transcriber');
  const script = String.raw`
    const assert = require('node:assert/strict');
    const crypto = require('node:crypto');
    const { EventEmitter } = require('node:events');
    const net = require('node:net');
    const { ParakeetTranscriber } = require(${JSON.stringify(modulePath)});
    const WebSocket = require('ws');

    class Child extends EventEmitter {
      constructor() {
        super(); this.pid = 9001; this.exitCode = null;
        this.stderr = new EventEmitter(); this.stdout = new EventEmitter();
      }
      exit() { this.exitCode = 0; this.emit('exit', 0, 'SIGTERM'); }
    }

    async function listenInRange(connection) {
      for (let port = 6006; port <= 6029; port += 1) {
        const server = net.createServer(connection);
        const listening = await new Promise((resolve) => {
          server.once('error', () => resolve(false));
          server.listen(port, '127.0.0.1', () => resolve(true));
        });
        if (listening) return { server, port };
      }
      throw new Error('No test port available.');
    }

    (async () => {
      const sockets = new Set();
      let upgradedResolve;
      const upgraded = new Promise((resolve) => { upgradedResolve = resolve; });
      let frameResolve;
      const frameReceived = new Promise((resolve) => { frameResolve = resolve; });
      const connection = (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        if (${JSON.stringify(mode)} === 'connecting') {
          socket.resume();
          return;
        }
        let request = '';
        socket.on('data', (chunk) => {
          if (socket.handshakeSent) {
            frameResolve();
            return;
          }
          request += chunk.toString('latin1');
          if (!request.includes('\r\n\r\n') || socket.handshakeSent) return;
          socket.handshakeSent = true;
          const key = /Sec-WebSocket-Key:\s*([^\r\n]+)/i.exec(request)[1].trim();
          const accept = crypto.createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
          socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
          upgradedResolve();
        });
      };
      const { server, port } = await listenInRange(connection);
      const child = new Child();
      const inspection = {
        id: 'parakeet', healthy: true,
        runtime: { path: '/fake/parakeet' }, model: { path: '/fake/model' }, errors: []
      };
      const engine = new ParakeetTranscriber({
        inspect: async () => inspection,
        findPort: async () => port,
        spawn: () => child,
        WebSocket,
        cpuCount: 4,
        tempDirectory: '/tmp',
        stopProcess: (target) => target.exit()
      });
      let failure;
      try {
        console.log('stage:start');
        const starting = engine.start(inspection);
        await new Promise((resolve) => setImmediate(resolve));
        child.stderr.emit('data', Buffer.from('Listening on:'));
        await starting;
        console.log('stage:ready');
        const request = engine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(2), sampleRate: 16000 });
        if (${JSON.stringify(mode)} === 'open') await frameReceived;
        else await new Promise((resolve) => setTimeout(resolve, 30));
        console.log('stage:socket-ready');
        await engine.stop();
        console.log('stage:stopped');
        const code = await request.then(() => 'resolved', (error) => error.code);
        assert.equal(code, 'engine_stopped');
        await new Promise((resolve) => setTimeout(resolve, 100));
        console.log('stage:peer-count:' + sockets.size);
        assert.equal(sockets.size, 0, 'aborted WebSocket must release its TCP peer');
      } catch (error) {
        failure = error;
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
        console.log('stage:server-closed');
      }
      if (failure) throw failure;
    })().catch((error) => {
      console.error(error && error.stack || error);
      process.exitCode = 1;
    });
  `;
  return spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', script], {
    encoding: 'utf8', timeout: 4000
  });
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

test('stores an immutable inspection and never returns its retained instance', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  const started = engine.start(harness.inspection);
  await tick();
  harness.child.stderr.emit('data', Buffer.from('Listening on:'));
  const first = await started;
  first.runtime.path = '/mutated/runtime';
  first.model.path = '/mutated/model';
  const second = await engine.start(harness.inspection);
  assert.notStrictEqual(second, first);
  assert.equal(second.runtime.path, harness.inspection.runtime.path);
  assert.equal(second.model.path, harness.inspection.model.path);
  await engine.stop();
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

test('publishes a stable start promise before a reentrant status observer can start again', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  let reentrant;
  let observed = false;
  engine.onStatus((status) => {
    if (status.status === 'starting' && !observed) {
      observed = true;
      reentrant = engine.start(harness.inspection);
    }
  });
  const original = engine.start(harness.inspection);
  assert.strictEqual(reentrant, original);
  await tick();
  assert.equal(harness.spawnCalls.length, 1);
  harness.child.stderr.emit('data', Buffer.from('Listening on:'));
  await Promise.all([original, reentrant]);
  await engine.stop();
});

test('no-argument start publishes one generation before delayed inspection and reentrant observers join it', async () => {
  const harness = createHarness();
  const inspection = deferred();
  let inspectCalls = 0;
  harness.dependencies.inspect = () => {
    inspectCalls += 1;
    return inspection.promise;
  };
  const engine = new ParakeetTranscriber(harness.dependencies);
  let reentrant;
  engine.onStatus((status) => {
    if (status.status === 'starting' && !reentrant) reentrant = engine.start();
  });

  const original = engine.start();
  const concurrent = engine.start();
  assert.strictEqual(reentrant, original);
  assert.strictEqual(concurrent, original);
  await tick();
  assert.equal(inspectCalls, 1);
  assert.equal(harness.spawnCalls.length, 0);

  inspection.resolve(harness.inspection);
  await tick();
  assert.equal(harness.spawnCalls.length, 1);
  harness.child.stderr.emit('data', Buffer.from('Listening on:'));
  await Promise.all([original, concurrent, reentrant]);
  await engine.stop();
});

test('no-argument inspection failure settles every joiner and one later retry creates one generation', async () => {
  const harness = createHarness();
  const firstInspection = deferred();
  const secondInspection = deferred();
  let inspectCalls = 0;
  harness.dependencies.inspect = () => {
    inspectCalls += 1;
    return inspectCalls === 1 ? firstInspection.promise : secondInspection.promise;
  };
  const engine = new ParakeetTranscriber(harness.dependencies);

  const first = engine.start();
  const joined = engine.start();
  assert.strictEqual(joined, first);
  const rejected = assert.rejects(first, /inspection unavailable/);
  await tick();
  firstInspection.reject(new Error('inspection unavailable'));
  await rejected;
  assert.equal(inspectCalls, 1);

  const retry = engine.start();
  const retryJoiner = engine.start();
  assert.notStrictEqual(retry, first);
  assert.strictEqual(retryJoiner, retry);
  await tick();
  assert.equal(inspectCalls, 2);
  secondInspection.resolve(harness.inspection);
  await tick();
  harness.child.stderr.emit('data', Buffer.from('Listening on:'));
  await retry;
  assert.equal(harness.spawnCalls.length, 1);
  await engine.stop();
});

test('no-argument spawn failure settles one generation and a coalesced retry spawns once', async () => {
  const harness = createHarness();
  const replacement = new FakeChild();
  replacement.pid = 5302;
  let spawnAttempts = 0;
  harness.dependencies.spawn = (...args) => {
    harness.spawnCalls.push(args);
    spawnAttempts += 1;
    if (spawnAttempts === 1) throw new Error('spawn unavailable');
    return replacement;
  };
  const engine = new ParakeetTranscriber(harness.dependencies);

  const failed = engine.start();
  assert.strictEqual(engine.start(), failed);
  await expectCode(failed, 'runtime_spawn_failed');
  const retry = engine.start();
  assert.strictEqual(engine.start(), retry);
  assert.notStrictEqual(retry, failed);
  await new Promise((resolve) => setImmediate(resolve));
  replacement.stderr.emit('data', Buffer.from('Listening on:'));
  await retry;
  assert.equal(harness.spawnCalls.length, 2);
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

test('deep-clones and freezes status payloads separately for each observer', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  const seen = [];
  engine.onStatus((status) => {
    if (status.status !== 'error') return;
    seen.push(status);
    status.error.code = 'mutated';
    status.error.details.code = 999;
  });
  engine.onStatus((status) => {
    if (status.status === 'error') seen.push(status);
  });
  await startReady(engine, harness);
  harness.child.exit(7, null);
  await tick();
  assert.equal(seen.length, 2);
  assert.notStrictEqual(seen[0], seen[1]);
  assert.notStrictEqual(seen[0].error, seen[1].error);
  assert.equal(Object.isFrozen(seen[0]), true);
  assert.equal(Object.isFrozen(seen[0].error), true);
  assert.equal(Object.isFrozen(seen[0].error.details), true);
  assert.equal(seen[1].error.code, 'engine_exit');
  assert.equal(seen[1].error.details.code, 7);
  await engine.stop();
});

test('retained inspection cloning bypasses inherited object setters', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'runtime');
  let setterCalls = 0;
  let started;
  try {
    Object.defineProperty(Object.prototype, 'runtime', {
      configurable: true,
      set(value) {
        setterCalls += 1;
        Object.defineProperty(this, 'runtime', {
          value, writable: true, enumerable: true, configurable: true
        });
      }
    });
    started = engine.start(harness.inspection);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'runtime', previous);
    else delete Object.prototype.runtime;
  }
  await tick();
  harness.child.stderr.emit('data', Buffer.from('Listening on:'));
  const inspection = await started;
  assert.equal(setterCalls, 0);
  assert.equal(inspection.runtime.path, harness.inspection.runtime.path);
  await engine.stop();
});

test('an observer-installed object setter cannot intercept another observer snapshot', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'message');
  let setterCalls = 0;
  let secondSnapshot;
  let installed = false;
  const restore = () => {
    if (!installed) return;
    installed = false;
    if (previous) Object.defineProperty(Object.prototype, 'message', previous);
    else delete Object.prototype.message;
  };
  engine.onStatus((status) => {
    if (status.status !== 'starting' || installed) return;
    installed = true;
    Object.defineProperty(Object.prototype, 'message', {
      configurable: true,
      set(value) {
        setterCalls += 1;
        Object.defineProperty(this, 'message', {
          value, writable: true, enumerable: true, configurable: true
        });
      }
    });
  });
  engine.onStatus((status) => {
    if (status.status === 'starting') secondSnapshot = status;
  });
  let started;
  try {
    started = engine.start(harness.inspection);
  } finally {
    restore();
  }
  await tick();
  harness.child.stderr.emit('data', Buffer.from('Listening on:'));
  await started;
  assert.equal(setterCalls, 0);
  assert.equal(Object.hasOwn(secondSnapshot, 'message'), true);
  assert.equal(secondSnapshot.message, 'Starting local Parakeet.');
  await engine.stop();
});

test('observer-installed array setters cannot intercept nested error snapshots', async () => {
  const harness = createHarness();
  const marker = 'array-setter-probe-6006';
  harness.dependencies.findPort = async () => {
    throw new LocalSttError(
      'port_unavailable',
      'No port is available.',
      'Close the conflicting process.',
      { attempts: [marker] }
    );
  };
  const engine = new ParakeetTranscriber(harness.dependencies);
  const previous = Object.getOwnPropertyDescriptor(Array.prototype, '0');
  let setterCalls = 0;
  let errorSnapshot;
  let installed = false;
  const restore = () => {
    if (!installed) return;
    installed = false;
    if (previous) Object.defineProperty(Array.prototype, '0', previous);
    else delete Array.prototype[0];
  };
  engine.onStatus((status) => {
    if (status.status === 'starting' && !installed) {
      installed = true;
      Object.defineProperty(Array.prototype, '0', {
        configurable: true,
        set(value) {
          if (value === marker) setterCalls += 1;
          Object.defineProperty(this, '0', {
            value, writable: true, enumerable: true, configurable: true
          });
        }
      });
    } else if (status.status === 'error') {
      errorSnapshot = status;
      restore();
    }
  });
  try {
    await expectCode(engine.start(harness.inspection), 'port_unavailable');
  } finally {
    restore();
  }
  assert.equal(setterCalls, 0);
  assert.equal(Object.hasOwn(errorSnapshot.error.details.attempts, 0), true);
  assert.equal(errorSnapshot.error.details.attempts[0], marker);
  await engine.stop();
});

test('status cloning preserves standard dense, sparse, and trailing-hole array lengths', async () => {
  const harness = createHarness();
  const sparse = new Array(3);
  const trailing = ['first'];
  trailing.length = 4;
  const dense = ['first', 'second'];
  const extra = ['value'];
  extra.length = 3;
  Object.defineProperty(extra, 'label', {
    value: 'kept', writable: true, enumerable: true, configurable: true
  });
  const details = { sparse, trailing, dense, extra };
  harness.dependencies.findPort = async () => {
    throw new LocalSttError(
      'port_unavailable',
      'No port is available.',
      'Close the conflicting process.',
      details
    );
  };
  const engine = new ParakeetTranscriber(harness.dependencies);
  let cloned;
  engine.onStatus((status) => {
    if (status.status === 'error') cloned = status.error.details;
  });

  await expectCode(engine.start(harness.inspection), 'port_unavailable');
  assert.notStrictEqual(cloned, details);
  assert.notStrictEqual(cloned.sparse, sparse);
  assert.equal(cloned.sparse.length, 3);
  assert.deepEqual(Object.keys(cloned.sparse), []);
  assert.equal(Object.hasOwn(cloned.sparse, 0), false);
  assert.equal(Object.hasOwn(cloned.sparse, 2), false);
  assert.equal(cloned.trailing.length, 4);
  assert.deepEqual(Object.keys(cloned.trailing), ['0']);
  assert.equal(Object.hasOwn(cloned.trailing, 3), false);
  assert.equal(cloned.dense.length, 2);
  assert.deepEqual(cloned.dense, ['first', 'second']);
  assert.equal(cloned.extra.length, 3);
  assert.deepEqual(Object.keys(cloned.extra), ['0', 'label']);
  assert.equal(cloned.extra.label, 'kept');
  assert.equal(JSON.stringify(cloned), JSON.stringify(details));
  assert.equal(Object.isFrozen(cloned.sparse), true);
  assert.equal(Object.isFrozen(cloned.trailing), true);
  assert.equal(Object.isFrozen(cloned.dense), true);
  assert.equal(Object.isFrozen(cloned.extra), true);
  await engine.stop();
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
  const firstChild = new FakeChild();
  const secondChild = new FakeChild();
  firstChild.pid = 4901;
  secondChild.pid = 4902;
  useDistinctChildren(harness, [firstChild, secondChild]);
  const engine = new ParakeetTranscriber(harness.dependencies);
  const first = engine.start(harness.inspection);
  await tick();
  firstChild.emit('error', new Error('ENOEXEC'));
  await expectCode(first, 'runtime_spawn_failed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.clock.size, 0);

  const second = engine.start(harness.inspection);
  await new Promise((resolve) => setImmediate(resolve));
  secondChild.stderr.emit('data', Buffer.from('Listening on: 6006'));
  await second;
  assert.equal(harness.spawnCalls.length, 2);
  await engine.stop();
});

test('a pre-readiness child error disposes that exact child before restart spawns another', async () => {
  const harness = createHarness();
  const first = new FakeChild();
  const second = new FakeChild();
  first.pid = 5001;
  second.pid = 5002;
  const order = useDistinctChildren(harness, [first, second]);
  const engine = new ParakeetTranscriber(harness.dependencies);
  const failed = engine.start(harness.inspection);
  await tick();
  first.emit('error', new Error('spawn pipe failed'));
  await expectCode(failed, 'runtime_spawn_failed');
  const restarted = engine.start(harness.inspection);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order.slice(0, 3), ['spawn:5001', 'SIGTERM:5001', 'spawn:5002']);
  second.stderr.emit('data', Buffer.from('Listening on:'));
  await restarted;
  await engine.stop();
});

test('a live malformed spawned child is owned and disposed before start rejects or restart spawns', async () => {
  const harness = createHarness();
  const malformed = new FakeChild();
  const replacement = new FakeChild();
  malformed.pid = 5101;
  malformed.stderr = null;
  replacement.pid = 5102;
  const order = useDistinctChildren(harness, [malformed, replacement]);
  const engine = new ParakeetTranscriber(harness.dependencies);

  const failed = engine.start(harness.inspection);
  await tick();
  await expectCode(failed, 'runtime_spawn_failed');
  assert.deepEqual(order.slice(0, 2), ['spawn:5101', 'SIGTERM:5101']);
  assert.equal(malformed.listenerCount('error'), 0);
  assert.equal(malformed.listenerCount('exit'), 0);

  const restarted = engine.start(harness.inspection);
  await tick();
  assert.deepEqual(order.slice(0, 3), ['spawn:5101', 'SIGTERM:5101', 'spawn:5102']);
  replacement.stderr.emit('data', Buffer.from('Listening on:'));
  await restarted;
  await engine.stop();
});

test('listener-registration failure still bounds and kills the exact live spawn before restart', async () => {
  const harness = createHarness();
  class RegistrationThrowChild extends FakeChild {
    constructor() {
      super();
      this.registrations = 0;
    }

    on(event, listener) {
      this.registrations += 1;
      if (this.registrations > 2) throw new Error('listener registration failed');
      return super.on(event, listener);
    }
  }
  const malformed = new RegistrationThrowChild();
  malformed.pid = 5201;
  malformed.kill = () => {};
  const replacement = new FakeChild();
  replacement.pid = 5202;
  const signals = [];
  harness.dependencies.spawn = (...args) => {
    harness.spawnCalls.push(args);
    return harness.spawnCalls.length === 1 ? malformed : replacement;
  };
  harness.dependencies.stopProcess = (child, signal) => {
    signals.push(`${signal}:${child.pid}`);
    if (child === malformed && signal === 'SIGKILL') {
      child.exitCode = 137;
      child.signalCode = signal;
    }
    if (child === replacement && signal === 'SIGTERM') child.exit(0, signal);
  };
  const engine = new ParakeetTranscriber(harness.dependencies);

  const failed = engine.start(harness.inspection);
  let settled = false;
  failed.catch(() => { settled = true; });
  await tick();
  assert.deepEqual(signals, ['SIGTERM:5201']);
  assert.equal(settled, false);
  await harness.clock.advance(1999);
  assert.equal(settled, false);
  await harness.clock.advance(1);
  await expectCode(failed, 'runtime_spawn_failed');
  assert.deepEqual(signals, ['SIGTERM:5201', 'SIGKILL:5201']);
  assert.equal(malformed.listenerCount('error'), 0);
  assert.equal(malformed.listenerCount('exit'), 0);

  const restarted = engine.start(harness.inspection);
  await tick();
  replacement.stderr.emit('data', Buffer.from('Listening on:'));
  await restarted;
  assert.equal(harness.spawnCalls.length, 2);
  await engine.stop();
});

test('non-finite, negative, and fractional exit codes remain owned through bounded TERM and KILL disposal', async () => {
  for (const exitCode of [NaN, Infinity, -1, 1.5]) {
    const harness = createHarness();
    const replacement = new FakeChild();
    replacement.pid = 5402;
    harness.child.stderr = null;
    harness.child.exitCode = exitCode;
    harness.child.signalCode = null;
    const signals = [];
    harness.dependencies.spawn = (...args) => {
      harness.spawnCalls.push(args);
      return harness.spawnCalls.length === 1 ? harness.child : replacement;
    };
    harness.dependencies.stopProcess = (child, signal) => {
      signals.push(signal);
      if (child === harness.child && signal === 'SIGKILL') {
        child.exitCode = 137;
        child.signalCode = 'SIGKILL';
      }
      if (child === replacement && signal === 'SIGTERM') child.exit(0, signal);
    };
    const engine = new ParakeetTranscriber(harness.dependencies);

    const failed = engine.start(harness.inspection);
    let settled = false;
    failed.catch(() => { settled = true; });
    await tick();
    assert.deepEqual(signals, ['SIGTERM'], `exitCode ${String(exitCode)} must remain owned`);
    assert.equal(settled, false, `exitCode ${String(exitCode)} must wait for bounded disposal`);
    await harness.clock.advance(1999);
    assert.equal(settled, false);
    await harness.clock.advance(1);
    await expectCode(failed, 'runtime_spawn_failed');
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(harness.child.listenerCount('error'), 0);
    assert.equal(harness.child.listenerCount('exit'), 0);

    const restarted = engine.start(harness.inspection);
    await tick();
    assert.equal(harness.spawnCalls.length, 2);
    replacement.stderr.emit('data', Buffer.from('Listening on:'));
    await restarted;
    await engine.stop();
  }
});

test('zero and nonzero finite integer exit codes are terminal without signaling the process', async () => {
  for (const exitCode of [0, 9]) {
    const harness = createHarness();
    harness.child.stderr = null;
    harness.child.exitCode = exitCode;
    harness.child.signalCode = null;
    const signals = [];
    harness.dependencies.stopProcess = (_child, signal) => signals.push(signal);
    const engine = new ParakeetTranscriber(harness.dependencies);

    await expectCode(engine.start(harness.inspection), 'runtime_spawn_failed');
    assert.deepEqual(signals, []);
    assert.equal(harness.child.listenerCount('error'), 0);
    assert.equal(harness.child.listenerCount('exit'), 0);
    await engine.stop();
  }
});

test('only recognized signal names are terminal evidence for malformed spawned children', async () => {
  for (const signalCode of ['NOT_A_SIGNAL', 'SIGTOTALLYFAKE']) {
    const harness = createHarness();
    harness.child.stderr = null;
    harness.child.exitCode = null;
    harness.child.signalCode = signalCode;
    const signals = [];
    harness.dependencies.stopProcess = (child, signal) => {
      signals.push(signal);
      if (signal === 'SIGKILL') child.signalCode = 'SIGKILL';
    };
    const engine = new ParakeetTranscriber(harness.dependencies);
    const failed = engine.start(harness.inspection);
    failed.catch(() => {});
    await tick();
    assert.deepEqual(signals, ['SIGTERM']);
    await harness.clock.advance(2000);
    await expectCode(failed, 'runtime_spawn_failed');
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    await engine.stop();
  }

  for (const signalCode of ['SIGTERM', 'SIGKILL']) {
    const harness = createHarness();
    harness.child.stderr = null;
    harness.child.exitCode = null;
    harness.child.signalCode = signalCode;
    const signals = [];
    harness.dependencies.stopProcess = (_child, signal) => signals.push(signal);
    const engine = new ParakeetTranscriber(harness.dependencies);
    await expectCode(engine.start(harness.inspection), 'runtime_spawn_failed');
    assert.deepEqual(signals, []);
    await engine.stop();
  }
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
  assert.deepEqual(socket.options, { maxPayload: 1024 * 1024 });
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

test('real ws CONNECTING abort cannot emit an uncaught error or retain its TCP handle', () => {
  const result = runStrictWebSocketAbortScenario('connecting');
  assert.equal(result.signal, null, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});

test('real ws OPEN abort force-closes an uncooperative peer without retained handles', () => {
  const result = runStrictWebSocketAbortScenario('open');
  assert.equal(result.signal, null, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});

test('transcription timeout is exactly four times supported duration with a 10-second floor', async () => {
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
    channel: 'system', pcm16: Buffer.alloc(16000 * 2 * 30), sampleRate: 16000
  });
  await tick();
  assert.deepEqual(longHarness.clock.delays(), [120000]);
  await longHarness.clock.advance(120000);
  await expectCode(longRequest, 'transcription_timeout');
  await longEngine.stop();
});

test('accepts at most 30 seconds of audio and rejects longer input before opening a socket', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  await startReady(engine, harness);
  const tooLong = Buffer.alloc((16000 * 30 + 1) * 2);
  const rejected = expectCode(
    engine.transcribe({ channel: 'mic', pcm16: tooLong, sampleRate: 16000 }),
    'audio_too_large'
  );
  await tick();
  assert.equal(harness.sockets.length, 0);
  await rejected;
  await engine.stop();
});

test('classifies 192 kHz audio beyond 30 seconds before byte conversion without a large allocation', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  await startReady(engine, harness);
  const simulatedView = {
    buffer: new ArrayBuffer(0),
    byteOffset: 0,
    byteLength: (192000 * 30 + 1) * 2
  };
  const descriptor = Object.getOwnPropertyDescriptor(ArrayBuffer, 'isView');
  let request;
  try {
    Object.defineProperty(ArrayBuffer, 'isView', {
      ...descriptor,
      value: (value) => value === simulatedView || descriptor.value(value)
    });
    request = engine.transcribe({ channel: 'mic', pcm16: simulatedView, sampleRate: 192000 });
  } finally {
    Object.defineProperty(ArrayBuffer, 'isView', descriptor);
  }
  await expectCode(request, 'audio_too_large');
  assert.equal(harness.sockets.length, 0);
  await engine.stop();
});

test('maps public PCM conversion and sample metadata failures to stable local errors', async () => {
  const harness = createHarness();
  const engine = new ParakeetTranscriber(harness.dependencies);
  await startReady(engine, harness);
  for (const pcm16 of [Buffer.alloc(0), Buffer.alloc(3), 'not audio']) {
    await expectCode(
      engine.transcribe({ channel: 'mic', pcm16, sampleRate: 16000 }),
      'invalid_audio'
    );
  }
  for (const sampleRate of [7999, 192001, 16000.5]) {
    await expectCode(
      engine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(2), sampleRate }),
      'invalid_sample_rate'
    );
  }
  assert.equal(harness.sockets.length, 0);
  await engine.stop();
});

test('bounds active plus queued requests and retained frame bytes per channel', async () => {
  const requestHarness = createHarness({ dependencies: {
    limits: { maxChannelRequests: 2, maxChannelRetainedBytes: 1024, maxResultBytes: 1024, maxResultMessages: 8 }
  } });
  const requestEngine = new ParakeetTranscriber(requestHarness.dependencies);
  await startReady(requestEngine, requestHarness);
  const first = requestEngine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(2), sampleRate: 16000 });
  const second = requestEngine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(2), sampleRate: 16000 });
  const third = requestEngine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(2), sampleRate: 16000 });
  const requestOutcome = await Promise.race([
    third.then(() => 'resolved', (error) => error.code),
    new Promise((resolve) => setImmediate(() => resolve('pending')))
  ]);
  await requestEngine.stop();
  if (requestOutcome === 'pending') await expectCode(third, 'engine_stopped');
  assert.equal(requestOutcome, 'engine_overloaded');
  await Promise.all([expectCode(first, 'engine_stopped'), expectCode(second, 'engine_stopped')]);

  const byteHarness = createHarness({ dependencies: {
    limits: { maxChannelRequests: 8, maxChannelRetainedBytes: 24, maxResultBytes: 1024, maxResultMessages: 8 }
  } });
  const byteEngine = new ParakeetTranscriber(byteHarness.dependencies);
  await startReady(byteEngine, byteHarness);
  const byteFirst = byteEngine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(2), sampleRate: 16000 });
  const byteSecond = byteEngine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(2), sampleRate: 16000 });
  const byteThird = byteEngine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(2), sampleRate: 16000 });
  const byteOutcome = await Promise.race([
    byteThird.then(() => 'resolved', (error) => error.code),
    new Promise((resolve) => setImmediate(() => resolve('pending')))
  ]);
  await byteEngine.stop();
  if (byteOutcome === 'pending') await expectCode(byteThird, 'engine_stopped');
  assert.equal(byteOutcome, 'engine_overloaded');
  await Promise.all([expectCode(byteFirst, 'engine_stopped'), expectCode(byteSecond, 'engine_stopped')]);
});

test('bounds WebSocket result message count and total bytes', async () => {
  for (const [limits, messages] of [
    [{ maxResultMessages: 2, maxResultBytes: 1024 }, ['one', 'two', 'three']],
    [{ maxResultMessages: 8, maxResultBytes: 10 }, ['12345678901']]
  ]) {
    const harness = createHarness({ dependencies: {
      limits: { maxChannelRequests: 8, maxChannelRetainedBytes: 1024, ...limits }
    } });
    const engine = new ParakeetTranscriber(harness.dependencies);
    await startReady(engine, harness);
    const request = engine.transcribe({ channel: 'mic', pcm16: Buffer.alloc(2), sampleRate: 16000 });
    await tick();
    const socket = harness.sockets[0];
    socket.open();
    for (const message of messages) socket.emit('message', message);
    if (socket.readyState !== 3) socket.finish();
    await expectCode(request, 'protocol_failure');
    assert.equal(socket.terminateCalls, 1);
    await engine.stop();
  }
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

test('a post-readiness child error joins bounded cleanup before replacing its owned child', async () => {
  const harness = createHarness();
  const first = new FakeChild();
  const second = new FakeChild();
  first.pid = 5101;
  second.pid = 5102;
  const order = useDistinctChildren(harness, [first, second]);
  const engine = new ParakeetTranscriber(harness.dependencies);
  const initial = engine.start(harness.inspection);
  await tick();
  first.stderr.emit('data', Buffer.from('Listening on:'));
  await initial;
  first.emit('error', new Error('runtime pipe failed'));
  const restarted = engine.start(harness.inspection);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order.slice(0, 3), ['spawn:5101', 'SIGTERM:5101', 'spawn:5102']);
  second.stderr.emit('data', Buffer.from('Listening on:'));
  await restarted;
  await engine.stop();
});

test('failed-child cleanup stays bounded when the stopper throws or hangs', async () => {
  for (const behavior of ['throw', 'hang']) {
    const harness = createHarness({ autoExitOnStop: false });
    const first = new FakeChild();
    const second = new FakeChild();
    first.pid = behavior === 'throw' ? 5201 : 5301;
    second.pid = first.pid + 1;
    useDistinctChildren(harness, [first, second], behavior);
    const engine = new ParakeetTranscriber(harness.dependencies);
    const initial = engine.start(harness.inspection);
    await tick();
    first.stderr.emit('data', Buffer.from('Listening on:'));
    await initial;
    first.emit('error', new Error(`${behavior} failure`));
    const restarted = engine.start(harness.inspection);
    await tick();
    assert.equal(harness.spawnCalls.length, 1, behavior);
    await harness.clock.advance(1999);
    assert.equal(harness.spawnCalls.length, 1, behavior);
    await harness.clock.advance(1);
    await tick();
    assert.deepEqual(harness.stopCalls.map((call) => call.signal), ['SIGTERM', 'SIGKILL'], behavior);
    assert.equal(harness.stopCalls.every((call) => call.target === first), true, behavior);
    assert.equal(harness.spawnCalls.length, 2, behavior);
    assert.equal(first.stderr.listenerCount('data'), 0, behavior);
    assert.equal(first.listenerCount('error'), 1, behavior);
    assert.equal(first.listenerCount('exit'), 1, behavior);
    second.stderr.emit('data', Buffer.from('Listening on:'));
    await restarted;
    first.exit(0, 'SIGKILL');
    assert.equal(first.listenerCount('error'), 0, behavior);
    assert.equal(first.listenerCount('exit'), 0, behavior);
    second.exit(0, 'SIGTERM');
    await engine.stop();
  }
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
