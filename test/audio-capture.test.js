const assert = require('node:assert/strict');
const test = require('node:test');

const { createAudioCapture } = require('../renderer/audio-capture');

function stream(kind = 'audio') {
  const track = { kind, stopped: 0, stop() { this.stopped += 1; } };
  return {
    track,
    getTracks: () => [track],
    getAudioTracks: () => kind === 'audio' ? [track] : [],
    getVideoTracks: () => kind === 'video' ? [track] : []
  };
}

function harness({ noDisplayMedia = false } = {}) {
  const updates = [];
  const pcm = [];
  const graphs = [];
  const mic = stream();
  const systemAudio = stream();
  const displayVideo = { kind: 'video', stopped: 0, stop() { this.stopped += 1; } };
  const display = {
    getTracks: () => [displayVideo, systemAudio.track],
    getAudioTracks: () => [systemAudio.track],
    getVideoTracks: () => [displayVideo]
  };
  const mediaDevices = {
    getUserMediaCalls: 0,
    getDisplayMediaCalls: 0,
    async getUserMedia() { this.getUserMediaCalls += 1; return mic; },
    ...(noDisplayMedia ? {} : { async getDisplayMedia() { this.getDisplayMediaCalls += 1; return display; } }),
    addEventListener() {},
    removeEventListener() {}
  };
  const contexts = [];
  const dependencies = {
    mediaDevices,
    MediaStream: class MediaStream {
      constructor(tracks) { this.tracks = tracks; }
      getTracks() { return this.tracks; }
      getAudioTracks() { return this.tracks; }
    },
    createAudioContext() {
      const context = { sampleRate: 48000, destination: {}, closeCalls: 0, async close() { this.closeCalls += 1; } };
      contexts.push(context);
      return context;
    },
    async createGraph(options) {
      const graph = { onPcm: options.onPcm, disconnected: 0 };
      graphs.push(graph);
      return graph;
    },
    disconnectGraph(graph) { graph.disconnected += 1; },
    sourceUpdate(source, patch) { updates.push({ source, patch }); },
    sourcePcm(source, payload) { pcm.push({ source, payload }); }
  };
  return { dependencies, mediaDevices, updates, pcm, graphs, contexts, mic, displayVideo };
}

test('joins duplicate mic starts, reports actual rate, and cleans up on stop', async () => {
  const fixture = harness();
  const capture = createAudioCapture(fixture.dependencies);
  await Promise.all([capture.startMic(), capture.startMic()]);
  assert.equal(fixture.mediaDevices.getUserMediaCalls, 1);
  assert.deepEqual(fixture.updates.slice(0, 2).map((event) => event.patch.phase), ['starting', 'live']);

  fixture.graphs[0].onPcm({ samples: Float32Array.from({ length: 480 }, () => 0.5), sampleRate: 48000, level: 0.5 });
  assert.equal(fixture.pcm[0].source, 'mic');
  assert.equal(fixture.pcm[0].payload.sampleRate, 16000);
  assert.equal(fixture.pcm[0].payload.sourceSampleRate, 48000);
  assert.equal(fixture.pcm[0].payload.pcm.byteLength, 320);
  assert.deepEqual(Object.keys(fixture.pcm[0].payload).sort(), ['level', 'pcm', 'sampleRate', 'sourceSampleRate']);

  capture.stop();
  assert.equal(fixture.mic.track.stopped, 1);
  assert.equal(fixture.graphs[0].disconnected, 1);
  assert.equal(fixture.contexts[0].closeCalls, 1);
});

test('clears the system starting guard when display capture is unsupported', async () => {
  const fixture = harness({ noDisplayMedia: true });
  const capture = createAudioCapture(fixture.dependencies);
  await assert.rejects(capture.startSystem(), (error) => error.code === 'unsupported');
  await assert.rejects(capture.startSystem(), (error) => error.code === 'unsupported');
  assert.equal(capture.getState().system.starting, false);
  assert.equal(capture.getState().system.phase, 'unsupported');
});

test('pause drops late PCM and resume restarts previously active sources', async () => {
  const fixture = harness();
  const capture = createAudioCapture(fixture.dependencies);
  await capture.startMic();
  const oldPcm = fixture.graphs[0].onPcm;
  capture.pause();
  oldPcm({ samples: Float32Array.from([0.5, 0.5, 0.5]), sampleRate: 48000, level: 0.5 });
  assert.equal(fixture.pcm.length, 0);
  await capture.resume();
  assert.equal(fixture.mediaDevices.getUserMediaCalls, 2);
});
