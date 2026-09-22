const test = require('node:test');
const assert = require('node:assert/strict');

const { createSTT } = require('../src/stt');

test('keeps Custom chat credentials separate from speech-to-text providers', async () => {
  const speechToText = createSTT({
    apiKeys: {
      custom: 'gateway-token'
    }
  });

  assert.equal(speechToText.available, false);
  assert.deepEqual(speechToText.providers, []);
  assert.deepEqual(await speechToText.transcribe(Buffer.alloc(6400)), { text: '' });
});

test('reports the exact successful provider and hardcoded adapter model after fallback', async () => {
  assert.equal(createSTT.length, 2, 'createSTT must accept deterministic adapter injection');
  const attempts = [];
  const speechToText = createSTT({
    sttProvider: 'auto',
    sttModel: 'configured-but-not-used',
    apiKeys: { openai: 'openai-key', groq: 'groq-key' }
  }, {
    transcribeOpenAI: async (_key, _wav, model, baseUrl) => {
      attempts.push({ model, baseUrl: baseUrl || null });
      if (!baseUrl) throw new Error('OpenAI unavailable');
      return 'fallback transcript';
    }
  });

  const result = await speechToText.transcribe(Buffer.alloc(6400, 1));
  assert.deepEqual(attempts, [
    { model: 'configured-but-not-used', baseUrl: null },
    { model: 'whisper-large-v3-turbo', baseUrl: 'https://api.groq.com/openai/v1' }
  ]);
  assert.deepEqual(result, {
    text: 'fallback transcript',
    provider: 'groq',
    model: 'whisper-large-v3-turbo'
  });
});
