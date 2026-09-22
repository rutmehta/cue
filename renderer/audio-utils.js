(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CueAudioUtils = api;
})(typeof window === 'object' ? window : null, function () {
  function validateRate(rate, label) {
    if (!Number.isFinite(rate) || rate <= 0) throw new TypeError(`${label} must be a positive sample rate.`);
  }

  function asFloat32(samples) {
    if (samples instanceof Float32Array) return samples;
    if (samples instanceof ArrayBuffer) return new Float32Array(samples);
    if (ArrayBuffer.isView(samples)) {
      return new Float32Array(samples.buffer, samples.byteOffset, Math.floor(samples.byteLength / 4));
    }
    throw new TypeError('Audio samples must be Float32 data.');
  }

  function levelFor(samples) {
    if (!samples.length) return 0;
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return Math.sqrt(sum / samples.length);
  }

  function floatToPcm16(samples) {
    const output = new Int16Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      output[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    }
    return output;
  }

  function createAudioConverter(targetSampleRate = 16000) {
    validateRate(targetSampleRate, 'Target sample rate');
    let sourceSampleRate = null;
    let previousSample = null;
    let position = 0;

    function reset() {
      sourceSampleRate = null;
      previousSample = null;
      position = 0;
    }

    function convert(rawSamples, measuredSampleRate) {
      validateRate(measuredSampleRate, 'Source sample rate');
      const samples = asFloat32(rawSamples);
      if (sourceSampleRate !== measuredSampleRate) reset();
      sourceSampleRate = measuredSampleRate;
      const level = levelFor(samples);
      if (!samples.length) {
        return { pcm16: new Int16Array(0), sampleRate: targetSampleRate, sourceSampleRate, level };
      }

      const data = previousSample === null
        ? samples
        : Float32Array.from([previousSample, ...samples]);
      const ratio = sourceSampleRate / targetSampleRate;
      const output = [];
      while (position < data.length - 1) {
        const left = Math.floor(position);
        const fraction = position - left;
        output.push(data[left] + (data[left + 1] - data[left]) * fraction);
        position += ratio;
      }
      position -= data.length - 1;
      previousSample = data[data.length - 1];
      return {
        pcm16: floatToPcm16(output),
        sampleRate: targetSampleRate,
        sourceSampleRate,
        level
      };
    }

    return { convert, reset };
  }

  function convertAudioBlock(samples, sourceSampleRate, targetSampleRate = 16000) {
    return createAudioConverter(targetSampleRate).convert(samples, sourceSampleRate);
  }

  return { convertAudioBlock, createAudioConverter, floatToPcm16 };
});

