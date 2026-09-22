// AudioWorklet processor — runs off the main thread for low-latency audio capture.
// Replaces the deprecated ScriptProcessor. It sends measured-rate Float32 blocks
// to the renderer, where one stateful converter performs resampling and PCM16 conversion.

class CueAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bufferSize = 4096; // accumulate before sending (matches old ScriptProcessor)
    this._buffer = new Float32Array(this._bufferSize);
    this._writeIndex = 0;
  }

  process(inputs, _outputs, _parameters) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0]; // mono
    for (let i = 0; i < channelData.length; i++) {
      this._buffer[this._writeIndex++] = channelData[i];
      if (this._writeIndex >= this._bufferSize) {
        this._flush();
      }
    }
    return true;
  }

  _flush() {
    const samples = this._buffer.slice(0, this._writeIndex);
    let sum = 0;
    for (let i = 0; i < this._writeIndex; i++) {
      sum += samples[i] * samples[i];
    }
    this.port.postMessage({
      samples,
      sampleRate,
      level: samples.length ? Math.sqrt(sum / samples.length) : 0
    }, [samples.buffer]);
    this._buffer = new Float32Array(this._bufferSize);
    this._writeIndex = 0;
  }
}

registerProcessor('cue-audio-processor', CueAudioProcessor);
