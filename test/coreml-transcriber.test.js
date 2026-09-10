const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { CoreMLTranscriber } = require('../src/coreml-transcriber');

function fakeProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true; };
  return child;
}
const inspection = { healthy: true, model: { path: '/fixture/models' } };

test('native transcription waits for model readiness and matches out-of-order results', async () => {
  const child = fakeProcess();
  const engine = new CoreMLTranscriber({ spawnProcess: () => child });
  const start = engine.start(inspection);
  await assert.rejects(engine.transcribe({ pcm16: Buffer.alloc(3200), sampleRate: 16000 }), /not ready/);
  child.stdout.write('model diagnostic line\n{"ready":true}\n');
  await start;
  const jobs = [];
  child.stdin.on('data', data => jobs.push(JSON.parse(data)));
  const first = engine.transcribe({ pcm16: Buffer.alloc(3200), sampleRate: 16000 });
  const second = engine.transcribe({ pcm16: Buffer.alloc(3200), sampleRate: 16000 });
  child.stdout.write(JSON.stringify({ id: jobs[1].id, text: 'Second speaker' }) + '\n');
  child.stdout.write(JSON.stringify({ id: jobs[0].id, text: 'First speaker' }) + '\n');
  assert.equal((await first).text, 'First speaker');
  assert.equal((await second).text, 'Second speaker');
  await engine.stop();
  assert.equal(engine.ready, false);
});

test('native engine failure rejects outstanding requests instead of hanging', async () => {
  const child = fakeProcess();
  const engine = new CoreMLTranscriber({ spawnProcess: () => child });
  const start = engine.start(inspection);
  child.stdout.write('{"ready":true}\n');
  await start;
  const pending = engine.transcribe({ pcm16: Buffer.alloc(3200), sampleRate: 16000 });
  const rejected = assert.rejects(pending, /stopped/);
  child.emit('exit', 1);
  await rejected;
  assert.equal(engine.requests.size, 0);
  assert.equal(engine.child, null);
});
