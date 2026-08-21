const assert = require('node:assert/strict');
const test = require('node:test');
const { LocalWhisperTranscriber } = require('../src/local-whisper-transcriber');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function segmenterFactory(options) {
  return {
    push(pcm) { options.onUtterance(options.channel, Buffer.from(pcm)); },
    stop() {}
  };
}

test('serializes both channels through one persistent session', async () => {
  let activeInferences = 0;
  let maximumConcurrency = 0;
  const transcribedChannels = [];
  const transcripts = [];
  const fakeSession = {
    startCalls: 0,
    stopCalls: 0,
    async start() { this.startCalls += 1; },
    async transcribe(pcm) {
      activeInferences += 1;
      maximumConcurrency = Math.max(maximumConcurrency, activeInferences);
      await new Promise((resolve) => setImmediate(resolve));
      activeInferences -= 1;
      return pcm.toString();
    },
    abortInferences() {},
    async stop() { this.stopCalls += 1; }
  };

  const transcriber = new LocalWhisperTranscriber({
    sessionOptions: {},
    sessionFactory: () => fakeSession,
    segmenterFactory: (options) => ({
      push(pcm) {
        transcribedChannels.push(options.channel);
        options.onUtterance(options.channel, Buffer.from(pcm));
      },
      stop() {}
    }),
    onTranscript: (channel, text) => transcripts.push({ channel, text })
  });

  await transcriber.start();
  transcriber.push('you', Buffer.from('first'));
  transcriber.push('them', Buffer.from('second'));
  await transcriber.queueTail;
  await transcriber.stop();

  assert.equal(fakeSession.startCalls, 1);
  assert.equal(fakeSession.stopCalls, 1);
  assert.equal(maximumConcurrency, 1);
  assert.deepEqual(transcribedChannels, ['you', 'them']);
  assert.deepEqual(transcripts, [
    { channel: 'you', text: 'first' },
    { channel: 'them', text: 'second' }
  ]);
});

test('bounds shutdown drain time before aborting an in-flight inference', async () => {
  let rejectInference;
  const stopOptions = [];
  const reportedErrors = [];
  let abortCalls = 0;
  let transcribeCalls = 0;
  const fakeSession = {
    async start() {},
    async transcribe() {
      transcribeCalls += 1;
      return new Promise((_resolve, reject) => { rejectInference = reject; });
    },
    abortInferences() {
      abortCalls += 1;
      rejectInference(new Error('inference aborted'));
    },
    async stop(options) { stopOptions.push(options); }
  };
  const transcriber = new LocalWhisperTranscriber({
    sessionOptions: {},
    sessionFactory: () => fakeSession,
    segmenterFactory: (options) => ({
      push(pcm) { options.onUtterance(options.channel, Buffer.from(pcm)); },
      stop() {}
    }),
    drainTimeoutMs: 0,
    onError: (error) => reportedErrors.push(error)
  });

  await transcriber.start();
  transcriber.push('you', Buffer.from('pending'));
  transcriber.push('them', Buffer.from('discard me'));
  await transcriber.stop();
  await transcriber.queueTail;

  assert.equal(abortCalls, 1);
  assert.equal(transcribeCalls, 1);
  assert.deepEqual(reportedErrors, []);
  assert.deepEqual(stopOptions, [{ force: true }]);
});

test('drops a delayed success after drain timeout even when the transcriber restarts', async () => {
  const inference = deferred();
  const transcripts = [];
  let calls = 0;
  const fakeSession = {
    async start() {},
    async transcribe() {
      calls += 1;
      return calls === 1 ? inference.promise : 'fresh transcript';
    },
    abortInferences() {},
    async stop() {}
  };
  const transcriber = new LocalWhisperTranscriber({
    sessionOptions: {},
    sessionFactory: () => fakeSession,
    segmenterFactory,
    drainTimeoutMs: 0,
    onTranscript: (channel, text) => transcripts.push({ channel, text })
  });

  await transcriber.start();
  transcriber.push('you', Buffer.from('stale'));
  await Promise.resolve();
  await transcriber.stop();
  await transcriber.start();
  inference.resolve('stale transcript');
  await transcriber.queueTail;
  transcriber.push('them', Buffer.from('fresh'));
  await transcriber.queueTail;

  assert.deepEqual(transcripts, [{ channel: 'them', text: 'fresh transcript' }]);
});

test('drops a delayed failure after drain timeout even when the transcriber restarts', async () => {
  const inference = deferred();
  const errors = [];
  const fakeSession = {
    async start() {},
    async transcribe() { return inference.promise; },
    abortInferences() {},
    async stop() {}
  };
  const transcriber = new LocalWhisperTranscriber({
    sessionOptions: {},
    sessionFactory: () => fakeSession,
    segmenterFactory,
    drainTimeoutMs: 0,
    onError: (error) => errors.push(error)
  });

  await transcriber.start();
  transcriber.push('you', Buffer.from('stale'));
  await Promise.resolve();
  await transcriber.stop();
  await transcriber.start();
  inference.reject(new Error('late failure'));
  await transcriber.queueTail;

  assert.deepEqual(errors, []);
});

test('restart detaches fresh work from an abort-ignoring abandoned queue', async () => {
  const staleInference = deferred();
  const transcripts = [];
  const statuses = [];
  const fakeSession = {
    async start() {},
    async transcribe(pcm) {
      return pcm.toString() === 'stale' ? staleInference.promise : 'fresh transcript';
    },
    abortInferences() {},
    async stop() {}
  };
  const transcriber = new LocalWhisperTranscriber({
    sessionOptions: {},
    sessionFactory: () => fakeSession,
    segmenterFactory,
    drainTimeoutMs: 0,
    onTranscript: (channel, text) => transcripts.push({ channel, text }),
    onStatus: (status) => statuses.push(status.status)
  });

  await transcriber.start();
  transcriber.push('you', Buffer.from('stale'));
  await Promise.resolve();
  await transcriber.stop();
  await transcriber.start();
  transcriber.push('them', Buffer.from('fresh'));
  const freshOutcome = await Promise.race([
    transcriber.queueTail.then(() => 'completed'),
    new Promise((resolve) => setImmediate(() => resolve('blocked')))
  ]);
  staleInference.resolve('stale transcript');
  await new Promise(setImmediate);

  assert.equal(freshOutcome, 'completed');
  assert.deepEqual(transcripts, [{ channel: 'them', text: 'fresh transcript' }]);
  assert.equal(statuses.filter((status) => status === 'ready').length, 1);
});

test('a direct engine request preserves its id through transcript callbacks', async () => {
  const transcripts = [];
  let segmenterPushes = 0;
  const transcriber = new LocalWhisperTranscriber({
    sessionOptions: {},
    sessionFactory: () => ({
      async start() {},
      async transcribe(pcm) { return pcm.toString(); },
      abortInferences() {},
      async stop() {}
    }),
    segmenterFactory: () => ({ push() { segmenterPushes += 1; }, stop() {} }),
    onTranscript: (channel, text, requestId) => transcripts.push({ channel, text, requestId })
  });

  await transcriber.start();
  transcriber.push('you', Buffer.from('direct'), 'request-1');
  await transcriber.queueTail;

  assert.equal(segmenterPushes, 0);
  assert.deepEqual(transcripts, [{ channel: 'you', text: 'direct', requestId: 'request-1' }]);
});

test('a direct engine request reports an empty result so its caller can fall back promptly', async () => {
  const transcripts = [];
  const transcriber = new LocalWhisperTranscriber({
    sessionOptions: {},
    sessionFactory: () => ({
      async start() {},
      async transcribe() { return ''; },
      abortInferences() {},
      async stop() {}
    }),
    segmenterFactory,
    onTranscript: (channel, text, requestId) => transcripts.push({ channel, text, requestId })
  });

  await transcriber.start();
  transcriber.push('you', Buffer.from('direct'), 'request-empty');
  await transcriber.queueTail;

  assert.deepEqual(transcripts, [{ channel: 'you', text: '', requestId: 'request-empty' }]);
});

test('a direct engine failure preserves its channel and request id', async () => {
  const errors = [];
  const transcriber = new LocalWhisperTranscriber({
    sessionOptions: {},
    sessionFactory: () => ({
      async start() {},
      async transcribe() { throw new Error('inference failed'); },
      abortInferences() {},
      async stop() {}
    }),
    segmenterFactory,
    onError: (error, channel, requestId) => errors.push({ message: error.message, channel, requestId })
  });

  await transcriber.start();
  transcriber.push('them', Buffer.from('direct'), 'request-2');
  await transcriber.queueTail;

  assert.deepEqual(errors, [{ message: 'inference failed', channel: 'them', requestId: 'request-2' }]);
});
