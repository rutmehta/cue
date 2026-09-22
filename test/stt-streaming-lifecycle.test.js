const assert = require('node:assert/strict');
const test = require('node:test');

const { DeepgramStreamingSTT, OpenAIRealtimeSTT } = require('../src/stt-streaming');

for (const [name, StreamingSTT] of [
  ['OpenAI Realtime', OpenAIRealtimeSTT],
  ['Deepgram', DeepgramStreamingSTT]
]) {
  test(`${name} disconnect cancels a scheduled reconnect`, async () => {
    let reconnects = 0;
    const stt = new StreamingSTT('key');
    stt._reconnectDelay = 0;
    stt.connect = async () => { reconnects += 1; };

    stt._attemptReconnect();
    stt.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(reconnects, 0);
  });
}
