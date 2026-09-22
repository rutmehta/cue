const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { LocalSttError } = require('./local-stt-engine');

const MODEL_FILES = ['Preprocessor.mlmodelc', 'Encoder.mlmodelc', 'Decoder.mlmodelc', 'JointDecision.mlmodelc', 'parakeet_vocab.json'];

class CoreMLTranscriber {
  constructor({ appPath = path.resolve(__dirname, '..'), homeDirectory = os.homedir(), spawnProcess = spawn } = {}) {
    this.binary = path.join(appPath, 'native', 'bin', 'cue-local-speech');
    this.modelPath = path.join(homeDirectory, 'Library', 'Application Support', 'FluidAudio', 'Models', 'parakeet-tdt-0.6b-v2');
    this.spawn = spawnProcess;
    this.child = null;
    this.requests = new Map();
    this.sequence = 0;
    this.ready = false;
  }

  async inspect() {
    const errors = [];
    try { await fs.promises.access(this.binary, fs.constants.X_OK); }
    catch { errors.push(new LocalSttError('runtime_missing', 'The native speech helper is not installed.', 'Build or install Cue with local speech support.')); }
    for (const file of MODEL_FILES) {
      try { await fs.promises.access(path.join(this.modelPath, file)); }
      catch { errors.push(new LocalSttError('model_missing', `SpeakType model asset is missing: ${file}`, 'Download Parakeet v2 in SpeakType.')); }
    }
    return {
      id: 'parakeet', healthy: errors.length === 0,
      runtime: { path: this.binary, source: 'bundle', version: 'fluidaudio-0.15.6' },
      model: { path: this.modelPath, source: 'speaktype', fingerprint: 'parakeet-coreml-v2' }, errors
    };
  }

  async start(inspection) {
    if (this.ready) return;
    if (this.child) throw new Error('Local speech is already starting.');
    const selected = inspection || await this.inspect();
    if (!selected.healthy) throw selected.errors[0];
    const child = this.spawn(this.binary, [selected.model.path], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stderr.on('data', () => {});
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Local model loading timed out.'));
        this.stop();
      }, 90000);
      const fail = error => {
        clearTimeout(timer);
        reject(error);
        for (const request of this.requests.values()) request.reject(error);
        this.requests.clear();
        this.ready = false;
      };
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.once('exit', () => {
        if (this.child === child) this.child = null;
        fail(new Error('Local speech engine stopped.'));
      });
      createInterface({ input: child.stdout }).on('line', line => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.ready) {
          clearTimeout(timer);
          this.ready = true;
          resolve();
        } else if (message.id !== undefined) {
          const request = this.requests.get(message.id);
          if (!request) return;
          this.requests.delete(message.id);
          if (message.error) request.reject(new Error(message.error));
          else request.resolve({ text: message.text || '', elapsedMs: Date.now() - request.startedAt });
        } else if (message.error) fail(new Error(message.error));
      });
    });
  }

  transcribe({ pcm16, sampleRate }) {
    if (!this.ready || !this.child) return Promise.reject(new Error('Local model is not ready.'));
    if (sampleRate !== 16000 || !Buffer.isBuffer(pcm16) || !pcm16.length || pcm16.length % 2 || pcm16.length > 960000) {
      return Promise.reject(new Error('Expected at most 30 seconds of mono 16 kHz PCM16.'));
    }
    if (this.requests.size >= 8) return Promise.reject(new Error('Local transcription is catching up.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error('Local transcription timed out.'));
      }, 45000);
      this.requests.set(id, {
        startedAt: Date.now(),
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      this.child.stdin.write(JSON.stringify({ id, pcm: pcm16.toString('base64') }) + '\n');
    });
  }

  async stop() {
    this.ready = false;
    for (const request of this.requests.values()) request.reject(new Error('Local speech stopped.'));
    this.requests.clear();
    const child = this.child;
    if (!child) return;
    this.child = null;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
      child.kill('SIGTERM');
    });
  }
}

module.exports = { CoreMLTranscriber, MODEL_FILES };
