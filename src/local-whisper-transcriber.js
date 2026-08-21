const { UtteranceSegmenter } = require('./utterance-segmenter');
const { WhisperServerSession } = require('./whisper-server-session');

const CHANNELS = Object.freeze(['you', 'them']);
const DEFAULT_DRAIN_TIMEOUT_MS = 15000;

class LocalWhisperTranscriber {
  /** Coordinate two audio channels through one sequential, persistent model session. */
  constructor({
    sessionOptions,
    sessionFactory = (options) => new WhisperServerSession(options),
    segmenterFactory = (options) => new UtteranceSegmenter(options),
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    onTranscript = () => {},
    onSpeechState = () => {},
    onStatus = () => {},
    onError = () => {}
  }) {
    this.session = sessionFactory({ ...sessionOptions, onState: onStatus });
    this.segmenterFactory = segmenterFactory;
    this.drainTimeoutMs = drainTimeoutMs;
    this.onTranscript = onTranscript;
    this.onSpeechState = onSpeechState;
    this.onStatus = onStatus;
    this.onError = onError;
    this.segmenters = new Map();
    this.queueState = this._createQueueState(0);
    this.queueTail = this.queueState.tail;
    this.pendingJobs = this.queueState.pendingJobs;
    this.acceptingAudio = false;
    this.jobGeneration = 0;
  }

  async start() {
    this.jobGeneration += 1;
    this.queueState = this._createQueueState(this.jobGeneration);
    this.queueTail = this.queueState.tail;
    this.pendingJobs = this.queueState.pendingJobs;
    await this.session.start();
    for (const channel of CHANNELS) {
      const isRemoteAudio = channel === 'them';
      this.segmenters.set(channel, this.segmenterFactory({
        channel,
        vadOptions: {
          onsetThreshold: isRemoteAudio ? 200 : 220,
          offsetThreshold: isRemoteAudio ? 120 : 130,
          silenceFrames: isRemoteAudio ? 20 : 18
        },
        onSpeechState: (speechChannel, speaking, durationMs) => {
          this.onSpeechState(speechChannel, speaking, durationMs);
        },
        onUtterance: (utteranceChannel, pcm) => this._enqueue(utteranceChannel, pcm)
      }));
    }
    this.acceptingAudio = true;
  }

  push(channel, pcm) {
    if (!this.acceptingAudio) return;
    const segmenter = this.segmenters.get(channel);
    if (!segmenter) throw new Error(`Unknown local Whisper channel: ${channel}`);
    segmenter.push(pcm);
  }

  async stop() {
    this.acceptingAudio = false;
    for (const segmenter of this.segmenters.values()) segmenter.stop();

    const stoppingQueue = this.queueState;
    const drained = await this._drainQueue(stoppingQueue);
    if (!drained) {
      stoppingQueue.abandoned = true;
      this.jobGeneration += 1;
      this.session.abortInferences();
    }
    await this.session.stop({ force: !drained });
    this.segmenters.clear();
    this.onStatus({ status: 'off', message: 'Local Whisper stopped.' });
  }

  forceStop() {
    this.acceptingAudio = false;
    this.queueState.abandoned = true;
    this.jobGeneration += 1;
    this.session.abortInferences();
    return this.session.stop({ force: true });
  }

  _enqueue(channel, pcm) {
    const generation = this.jobGeneration;
    const queue = this.queueState;
    queue.pendingJobs += 1;
    this.pendingJobs = queue.pendingJobs;
    this.onStatus({ status: 'transcribing', channel, pending: queue.pendingJobs });

    const job = queue.tail.then(async () => {
      if (queue.abandoned || generation !== this.jobGeneration) return;
      const text = await this.session.transcribe(pcm);
      if (!queue.abandoned && generation === this.jobGeneration && text) {
        this.onTranscript(channel, text);
      }
    });

    queue.tail = job
      .catch((error) => {
        if (!queue.abandoned && generation === this.jobGeneration) this.onError(error);
      })
      .finally(() => {
        queue.pendingJobs -= 1;
        if (this.queueState === queue) this.pendingJobs = queue.pendingJobs;
        if (this.acceptingAudio && this.queueState === queue && generation === this.jobGeneration && !queue.abandoned && queue.pendingJobs === 0) {
          this.onStatus({ status: 'ready', message: 'Local Whisper is ready.' });
        }
      });
    if (this.queueState === queue) this.queueTail = queue.tail;
    return job;
  }

  _createQueueState(generation) {
    return { generation, tail: Promise.resolve(), pendingJobs: 0, abandoned: false };
  }

  async _drainQueue(queue = this.queueState) {
    let timeout = null;
    try {
      return await Promise.race([
        queue.tail.then(() => true),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(false), this.drainTimeoutMs);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

module.exports = { LocalWhisperTranscriber, CHANNELS, DEFAULT_DRAIN_TIMEOUT_MS };
