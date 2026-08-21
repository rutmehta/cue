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
