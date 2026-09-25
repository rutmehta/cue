const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatHistory } = require('../src/chat-history');

test('follow-ups include prior questions and answers in order', () => {
  const history = createChatHistory();
  const first = history.begin('Write a Python solution');
  history.complete(first, 'def solve(): pass');
  assert.deepEqual(history.begin('Explain that').turns, [
    { role: 'user', text: 'Write a Python solution' },
    { role: 'assistant', text: 'def solve(): pass' },
    { role: 'user', text: 'Explain that' }
  ]);
});

test('uncompleted requests and empty answers do not become conversation history', () => {
  const history = createChatHistory();
  history.begin('failed request');
  history.complete(history.begin('empty request'), '  ');
  assert.deepEqual(history.begin('retry').turns, [{ role: 'user', text: 'retry' }]);
});

test('clearing history rejects a late completion from the old chat', () => {
  const history = createChatHistory();
  history.complete(history.begin('old question'), 'old answer');
  const pending = history.begin('pending');
  history.clear();
  history.complete(pending, 'late answer');
  assert.deepEqual(history.begin('new chat').turns, [{ role: 'user', text: 'new chat' }]);
});

test('history evicts whole oldest exchanges and bounds oversized answers', () => {
  const history = createChatHistory({ maxExchanges: 2, maxChars: 100 });
  history.complete(history.begin('one'), 'first');
  history.complete(history.begin('two'), 'second');
  history.complete(history.begin('three'), 'third');
  assert.deepEqual(history.begin('next').turns.map(t => t.text), ['two', 'second', 'three', 'third', 'next']);
  history.complete(history.begin('large'), 'x'.repeat(200));
  const turns = history.begin('next').turns;
  assert.ok(turns.slice(0, -1).reduce((n, t) => n + t.text.length, 0) <= 100);
  assert.equal(turns[0].role, 'user');
  assert.equal(turns[1].role, 'assistant');
  assert.match(turns.at(-2).text, /truncated/);
});

// Exercise the actual Electron feature runner with only the UI/provider boundary
// replaced, so dropping history at the call site breaks this regression test.
function featureHarness() {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../main.js'), 'utf8');
  const requests = [];
  const errors = [];
  const ctx = vm.createContext({
    ...require('../src/prompts'),
    state: { busy: false }, chatEpoch: 0, answerLayoutEpoch: 0,
    answerLayoutSize: null, llmRequestSequence: 0,
    chatHistory: createChatHistory(), transcript: [],
    store: { getSettings: () => ({ screenContextEnabled: false }) },
    createLLM: () => ({ ready: true, stream: async params => {
      requests.push(params);
      return ctx.reply(params);
    } }),
    reply: () => 'def solve(): pass',
    dispatchSession() {}, send(event, payload) { if (event === 'llm:error') errors.push(payload); },
    recordEvent() {}, sessionController: null,
    STREAM_INACTIVITY_MS: 1000, setTimeout, clearTimeout
  });
  const runner = source.slice(source.indexOf('async function runFeature('), source.indexOf('\n//', source.indexOf('async function runFeature(')));
  const clear = source.slice(source.indexOf('function clearSessionContext('), source.indexOf('\nfunction collapseOverlay('));
  vm.runInContext(runner + '\n' + clear, ctx);
  return { ctx, requests, errors };
}

test('feature runner sends completed history across modes and clears it on New Chat', async () => {
  const { ctx, requests, errors } = featureHarness();
  await ctx.runFeature('leetcode', '');
  await ctx.runFeature('ask', 'Explain your solution');
  assert.deepEqual(requests[1].turns.map(t => t.role), ['user', 'assistant', 'user']);
  assert.equal(requests[1].turns[1].text, 'def solve(): pass');
  assert.match(requests[1].turns[2].text, /Explain your solution/);
  ctx.clearSessionContext('new-chat');
  await ctx.runFeature('ask', 'fresh question');
  assert.equal(requests[2].turns.length, 1);
  assert.deepEqual(errors, []);
});

test('feature runner excludes failed requests and late replies after reset', async () => {
  const { ctx, requests, errors } = featureHarness();
  ctx.reply = () => { throw new Error('provider failure'); };
  await ctx.runFeature('ask', 'failed');
  assert.equal(errors.length, 1);
  let resolve;
  ctx.reply = () => new Promise(r => { resolve = r; });
  const pending = ctx.runFeature('ask', 'old chat');
  ctx.clearSessionContext('new-chat');
  resolve('late answer');
  await pending;
  ctx.reply = () => 'new answer';
  await ctx.runFeature('ask', 'new chat');
  assert.equal(requests.at(-1).turns.length, 1);
});
