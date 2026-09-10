const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenAIRealtimeSTT } = require('../src/stt-streaming');

test('partial words accumulate independently for overlapping items and reset on completion', () => {
  const partials = [], finals = [];
  const session = new OpenAIRealtimeSTT('unused', {
    onInterim: text => partials.push(text), onTranscript: text => finals.push(text)
  });
  const delta = (item_id, text) => session._handleEvent({
    type: 'conversation.item.input_audio_transcription.delta', item_id, delta: text
  });
  delta('a', 'Hello');
  delta('b', 'Another');
  delta('a', ' world');
  assert.deepEqual(partials, ['Hello', 'Another', 'Hello world']);
  session._handleEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Hello world.' });
  assert.deepEqual(finals, ['Hello world.']);
  assert.equal(session._interimByItem.has('a:0'), false);
  session.disconnect();
  assert.equal(session._interimByItem.size, 0);
});

test('transport creation does not mark configured transcription ready', () => {
  const statuses = [];
  const session = new OpenAIRealtimeSTT('unused', { onStatusChange: status => statuses.push(status) });
  session._handleEvent({ type: 'session.created' });
  assert.equal(session._sessionReady, false);
  assert.deepEqual(statuses, []);
  session._handleEvent({ type: 'session.updated' });
  assert.equal(session._sessionReady, true);
  assert.deepEqual(statuses, ['connected']);
});
