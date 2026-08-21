const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createAudioCaptureGraph,
  connectAudioWorklet,
  connectScriptProcessor,
  createCaptureLifecycle,
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
