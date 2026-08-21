const assert = require('node:assert/strict');
const test = require('node:test');

const {
  connectAudioWorklet,
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
