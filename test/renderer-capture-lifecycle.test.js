const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  createAudioCaptureGraph,
  connectAudioWorklet,
  connectScriptProcessor,
  createCaptureLifecycle,
  createSessionCaptureReconciler,
  describeSystemCaptureError,
  disconnectAudioGraph
} = require('../renderer/capture-lifecycle');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('coalesces duplicate starts into one media acquisition', async () => {
  const acquisition = deferred();
  const phases = [];
  let acquireCount = 0;
  const lifecycle = createCaptureLifecycle({
    acquire: () => { acquireCount += 1; return acquisition.promise; },
    activate: async (resource) => ({ resource }),
    disposeAcquired() {},
    disposeActive() {},
    onPhase: (phase) => phases.push(phase)
  });

  const first = lifecycle.start();
  const second = lifecycle.start();
  assert.strictEqual(first, second);
  acquisition.resolve('mic-stream');
  assert.deepEqual(await first, { resource: 'mic-stream' });
  assert.equal(acquireCount, 1);
  assert.deepEqual(phases, ['starting', 'live']);
});

test('stopping during acquisition disposes the late stream without activating it', async () => {
  const acquisition = deferred();
  const disposed = [];
  let activated = false;
  const lifecycle = createCaptureLifecycle({
    acquire: () => acquisition.promise,
    activate: async () => { activated = true; },
    disposeAcquired: (resource) => disposed.push(resource),
    disposeActive() {}
  });

  const starting = lifecycle.start();
  lifecycle.stop();
  acquisition.resolve('late-stream');

  assert.equal(await starting, null);
  assert.equal(activated, false);
  assert.deepEqual(disposed, ['late-stream']);
});

test('stop followed immediately by start owns a fresh acquisition generation', async () => {
  const acquisitions = [deferred(), deferred()];
  const disposed = [];
  let acquireCount = 0;
  const lifecycle = createCaptureLifecycle({
    acquire: () => acquisitions[acquireCount++].promise,
    activate: async (resource) => ({ resource }),
    disposeAcquired: (resource) => disposed.push(resource),
    disposeActive() {}
  });

  const stale = lifecycle.start();
  lifecycle.stop();
  const fresh = lifecycle.start();
  assert.notStrictEqual(fresh, stale);
  assert.equal(acquireCount, 0);
  await Promise.resolve();
  assert.equal(acquireCount, 2);

  acquisitions[0].resolve('stale-stream');
  acquisitions[1].resolve('fresh-stream');
  assert.equal(await stale, null);
  assert.deepEqual(await fresh, { resource: 'fresh-stream' });
  assert.deepEqual(disposed, ['stale-stream']);
});

test('stopping during activation disposes the late graph', async () => {
  const activation = deferred();
  const disposed = [];
  const lifecycle = createCaptureLifecycle({
    acquire: async () => 'stream',
    activate: () => activation.promise,
    disposeAcquired() {},
    disposeActive: (graph) => disposed.push(graph)
  });

  const starting = lifecycle.start();
  await new Promise(setImmediate);
  lifecycle.stop();
  activation.resolve('late-graph');

  assert.equal(await starting, null);
  assert.deepEqual(disposed, ['late-graph']);
});

test('activation failure disposes the acquired stream before reporting the error', async () => {
  const disposed = [];
  const phases = [];
  const lifecycle = createCaptureLifecycle({
    acquire: async () => 'stream',
    activate: async () => { throw new Error('worklet failed'); },
    disposeAcquired: (resource) => disposed.push(resource),
    disposeActive() {},
    onPhase: (phase) => phases.push(phase)
  });

  await assert.rejects(lifecycle.start(), /worklet failed/);
  assert.deepEqual(disposed, ['stream']);
  assert.deepEqual(phases, ['starting', 'error']);
});

test('AudioWorklet graph retains a zero-gain destination sink and disconnects every node', () => {
  const connections = [];
  const disconnections = [];
  const source = { connect: (node) => connections.push(['source', node]), disconnect: () => disconnections.push('source') };
  const worklet = {
    port: {},
    connect: (node) => connections.push(['worklet', node]),
    disconnect: () => disconnections.push('worklet')
  };
  const sink = {
    gain: { value: 1 },
    connect: (node) => connections.push(['sink', node]),
    disconnect: () => disconnections.push('sink')
  };
  const context = {
    destination: 'destination',
    createMediaStreamSource: () => source,
    createGain: () => sink
  };
  const graph = connectAudioWorklet({
    audioContext: context,
    mediaStream: 'stream',
    WorkletNode: function WorkletNode() { return worklet; },
    onPcm() {}
  });

  assert.equal(sink.gain.value, 0);
  assert.deepEqual(connections, [
    ['source', worklet],
    ['worklet', sink],
    ['sink', 'destination']
  ]);
  disconnectAudioGraph(graph);
  assert.deepEqual(disconnections, ['worklet', 'source', 'sink']);
});

test('AudioWorklet graph construction rolls back every node and handler when connect throws', () => {
  const disconnected = [];
  const source = { connect() {}, disconnect: () => disconnected.push('source') };
  const worklet = {
    port: {},
    connect() { throw new Error('worklet connect failed'); },
    disconnect: () => disconnected.push('worklet')
  };
  const sink = { gain: {}, connect() {}, disconnect: () => disconnected.push('sink') };
  const context = {
    destination: {},
    createMediaStreamSource: () => source,
    createGain: () => sink
  };

  assert.throws(() => connectAudioWorklet({
    audioContext: context,
    mediaStream: {},
    WorkletNode: function WorkletNode() { return worklet; },
    onPcm() {}
  }), /worklet connect failed/);
  assert.equal(worklet.port.onmessage, null);
  assert.deepEqual(disconnected.sort(), ['sink', 'source', 'worklet']);
});

test('ScriptProcessor graph construction is transactional', () => {
  const disconnected = [];
  const source = { connect() {}, disconnect: () => disconnected.push('source') };
  const processor = {
    connect() { throw new Error('processor connect failed'); },
    disconnect: () => disconnected.push('processor')
  };
  const sink = { gain: {}, connect() {}, disconnect: () => disconnected.push('sink') };
  const context = {
    destination: {},
    createMediaStreamSource: () => source,
    createScriptProcessor: () => processor,
    createGain: () => sink
  };

  assert.throws(() => connectScriptProcessor({ audioContext: context, mediaStream: {}, onPcm() {} }), /processor connect failed/);
  assert.equal(processor.onaudioprocess, null);
  assert.deepEqual(disconnected.sort(), ['processor', 'sink', 'source']);
});

test('terminal graph activation failure closes its AudioContext', async () => {
  let closed = 0;
  const context = {
    audioWorklet: { addModule: async () => {} },
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createGain: () => ({ gain: {}, connect() {}, disconnect() {} }),
    createScriptProcessor: () => { throw new Error('legacy graph failed'); },
    close: async () => { closed += 1; }
  };
  function BrokenWorklet() {
    return { port: {}, connect() { throw new Error('worklet graph failed'); }, disconnect() {} };
  }

  await assert.rejects(createAudioCaptureGraph({
    audioContext: context,
    mediaStream: {},
    WorkletNode: BrokenWorklet,
    onPcm() {}
  }), /legacy graph failed/);
  assert.equal(closed, 1);
});

test('a throwing fallback observer cannot abort legacy graph recovery', async () => {
  let closed = 0;
  const processor = { connect() {}, disconnect() {} };
  const context = {
    audioWorklet: { addModule: async () => { throw new Error('worklet unavailable'); } },
    destination: {},
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createScriptProcessor: () => processor,
    createGain: () => ({ gain: {}, connect() {}, disconnect() {} }),
    close: async () => { closed += 1; }
  };

  const graph = await createAudioCaptureGraph({
    audioContext: context,
    mediaStream: {},
    WorkletNode: function WorkletNode() {},
    onPcm() {},
    onWorkletFallback() { throw new Error('diagnostic observer failed'); }
  });

  assert.equal(graph._legacy, true);
  assert.strictEqual(graph.proc, processor);
  assert.equal(closed, 0);
});

test('an asynchronously rejecting fallback observer is consumed without aborting recovery', async () => {
  let rejectionObserved = false;
  const context = {
    audioWorklet: { addModule: async () => { throw new Error('worklet unavailable'); } },
    destination: {},
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createScriptProcessor: () => ({ connect() {}, disconnect() {} }),
    createGain: () => ({ gain: {}, connect() {}, disconnect() {} }),
    async close() {}
  };
  const rejectingThenable = {
    then(_resolve, reject) {
      rejectionObserved = true;
      reject(new Error('async diagnostic observer failed'));
    }
  };

  const graph = await createAudioCaptureGraph({
    audioContext: context,
    mediaStream: {},
    WorkletNode: function WorkletNode() {},
    onPcm() {},
    onWorkletFallback: () => rejectingThenable
  });
  await new Promise(setImmediate);

  assert.equal(graph._legacy, true);
  assert.equal(rejectionObserved, true, 'observer thenable must be adopted so rejection is consumed');
});

test('observer rejection handling never reads a result-controlled catch accessor', async () => {
  let catchAccesses = 0;
  const rejectedObserver = Promise.reject(new Error('diagnostic rejection'));
  Promise.prototype.then.call(rejectedObserver, undefined, () => {});
  Object.defineProperty(rejectedObserver, 'catch', {
    configurable: true,
    get() {
      catchAccesses += 1;
      throw new Error('hostile catch accessor');
    }
  });
  const context = {
    audioWorklet: { addModule: async () => { throw new Error('worklet unavailable'); } },
    destination: {},
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createScriptProcessor: () => ({ connect() {}, disconnect() {} }),
    createGain: () => ({ gain: {}, connect() {}, disconnect() {} }),
    async close() {}
  };

  const graph = await createAudioCaptureGraph({
    audioContext: context,
    mediaStream: {},
    WorkletNode: function WorkletNode() {},
    onPcm() {},
    onWorkletFallback: () => rejectedObserver
  });
  await new Promise(setImmediate);

  assert.equal(graph._legacy, true);
  assert.equal(catchAccesses, 0);
});

test('strict unhandled-rejection mode consumes a hostile native observer promise before assimilation', () => {
  const modulePath = require.resolve('../renderer/capture-lifecycle');
  const script = `
    const { createAudioCaptureGraph } = require(${JSON.stringify(modulePath)});
    let thenAccesses = 0;
    let catchAccesses = 0;
    const rejectedObserver = Promise.reject(new Error('diagnostic rejection'));
    Object.defineProperties(rejectedObserver, {
      then: {
        configurable: true,
        get() {
          thenAccesses += 1;
          throw new Error('hostile then accessor');
        }
      },
      catch: {
        configurable: true,
        get() {
          catchAccesses += 1;
          throw new Error('hostile catch accessor');
        }
      }
    });
    const context = {
      audioWorklet: { addModule: async () => { throw new Error('worklet unavailable'); } },
      destination: {},
      createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
      createScriptProcessor: () => ({ connect() {}, disconnect() {} }),
      createGain: () => ({ gain: {}, connect() {}, disconnect() {} }),
      async close() {}
    };
    (async () => {
      const graph = await createAudioCaptureGraph({
        audioContext: context,
        mediaStream: {},
        WorkletNode: function WorkletNode() {},
        onPcm() {},
        onWorkletFallback: () => rejectedObserver
      });
      await new Promise(setImmediate);
      process.stdout.write(JSON.stringify({ legacy: graph._legacy, thenAccesses, catchAccesses }));
    })().catch((error) => {
      process.stderr.write(error.stack || String(error));
      process.exitCode = 1;
    });
  `;

  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', script], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '{"legacy":true,"thenAccesses":0,"catchAccesses":0}');
});

test('a recreated renderer reconciles both sources once from an already-active snapshot', async () => {
  const calls = [];
  const reconciler = createSessionCaptureReconciler({
    startMic: async () => calls.push('start-mic'),
    startSystem: async () => calls.push('start-system'),
    stopMic: () => calls.push('stop-mic'),
    stopSystem: () => calls.push('stop-system')
  });
  const activeSnapshot = {
    revision: 42,
    session: { phase: 'listening' },
    sources: { mic: { phase: 'live' }, system: { phase: 'live' } }
  };

  reconciler.reconcile(activeSnapshot);
  reconciler.reconcile({ ...activeSnapshot, revision: 43 });
  await Promise.resolve();
  reconciler.reconcile({ revision: 44, session: { phase: 'paused' } });

  assert.deepEqual(calls, ['start-mic', 'start-system', 'stop-mic', 'stop-system']);
});

test('a rejected start command stops the gesture-bootstrapped system capture generation', async () => {
  const calls = [];
  const reconciler = createSessionCaptureReconciler({
    startMic: async () => calls.push('start-mic'),
    startSystem: async () => calls.push('start-system'),
    stopMic: () => calls.push('stop-mic'),
    stopSystem: () => calls.push('stop-system')
  });

  await assert.rejects(reconciler.command('start', async (command) => {
    calls.push(`command-${command}`);
    throw new Error('main rejected start');
  }, { bootstrapSystem: true }), /main rejected start/);

  assert.deepEqual(calls, ['start-system', 'command-start', 'stop-system']);
});

test('non-gesture display denial reports an actionable source error', () => {
  const error = new Error('Not allowed without transient activation');
  error.name = 'InvalidStateError';

  assert.deepEqual(describeSystemCaptureError(error, { userGesture: false }), {
    code: 'gesture_required',
    message: 'Meeting audio needs a click in Cue. End this session, then choose Start listening in the overlay to grant screen and audio access.'
  });
});
