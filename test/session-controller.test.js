const assert = require('node:assert/strict');
const test = require('node:test');

const { SessionController } = require('../src/session-controller');

test('serializes commands and publishes full snapshots', async () => {
  const published = [];
  const calls = [];
  const controller = new SessionController({
    now: (() => { let value = 1_000; return () => value += 100; })(),
    startCapture: async () => calls.push('start'),
    stopCapture: async () => calls.push('stop'),
    publish: (snapshot) => published.push(snapshot)
  });
  await Promise.all([controller.start(), controller.start()]);
  await controller.pause();
  await controller.resume();
  await Promise.all([controller.stop(), controller.stop()]);
  assert.deepEqual(calls, ['start', 'stop', 'start', 'stop']);
  assert.ok(published.every((snapshot, index) => index === 0 || snapshot.revision >= published[index - 1].revision));
  assert.equal(controller.getSnapshot().session.phase, 'idle');
});

test('publishes an error and remains restartable when capture hooks reject', async () => {
  let startFailures = 1;
  let stopFailures = 0;
  const published = [];
  const controller = new SessionController({
    now: (() => { let value = 0; return () => ++value; })(),
    startCapture: async () => {
      if (startFailures-- > 0) throw new Error('start failed');
    },
    stopCapture: async () => {
      if (stopFailures-- > 0) throw new Error('stop failed');
    },
    publish: (snapshot) => published.push(snapshot)
  });

  await controller.start();
  assert.equal(controller.getSnapshot().session.phase, 'error');
  assert.equal(controller.getSnapshot().session.degradedReason, 'start failed');

  await controller.start();
  await controller.pause();
  startFailures = 1;
  await controller.resume();
  assert.equal(controller.getSnapshot().session.phase, 'error');
  assert.equal(controller.getSnapshot().session.degradedReason, 'start failed');

  startFailures = 0;
  await controller.start();
  stopFailures = 1;
  await controller.pause();
  assert.equal(controller.getSnapshot().session.phase, 'error');
  assert.equal(controller.getSnapshot().session.degradedReason, 'stop failed');

  await controller.start();
  stopFailures = 1;
  await controller.stop();
  assert.equal(controller.getSnapshot().session.phase, 'error');
  assert.equal(controller.getSnapshot().session.degradedReason, 'stop failed');
  assert.ok(published.some((snapshot) => snapshot.session.phase === 'error'));
});

test('stops sources and STT in the terminal published snapshot', async () => {
  const published = [];
  const controller = new SessionController({
    now: (() => { let value = 0; return () => ++value; })(),
    publish: (snapshot) => published.push(snapshot)
  });

  await controller.start();
  controller.dispatch({ type: 'SOURCE_UPDATED', source: 'mic', patch: { phase: 'live' } });
  controller.dispatch({ type: 'STT_UPDATED', patch: { phase: 'transcribing', activeEngine: 'whisper' } });
  await controller.stop();

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.session.phase, 'idle');
  assert.equal(snapshot.sources.mic.phase, 'off');
  assert.equal(snapshot.sources.system.phase, 'off');
  assert.equal(snapshot.stt.phase, 'off');
  assert.equal(published.at(-1).sources.mic.phase, 'off');
});
