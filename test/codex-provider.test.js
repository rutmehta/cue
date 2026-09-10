const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createLLM } = require('../src/llm');

test('Codex answers do not require a platform API key', () => {
  assert.equal(createLLM({ provider: 'codex', apiKeys: {}, models: {} }).ready, true);
});

function fakeProcess(onRequest) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  child.stdin = new Writable({ write(bytes, enc, done) {
    const req = JSON.parse(bytes.toString());
    const send = (message) => child.stdout.write(JSON.stringify(message) + '\n');
    queueMicrotask(() => onRequest(req, send)); done();
  } });
  return child;
}

test('subscription stream preserves context, disables environments, emits deltas and closes child', async () => {
  const { CodexProvider } = require('../src/codex-provider');
  const requests = []; const chunks = [];
  const child = fakeProcess((r, send) => {
    requests.push(r);
    if (!r.id) return;
    const results = {
      initialize: {}, 'account/read': { account: { type: 'chatgpt', planType: 'pro' } },
      'config/read': { config: { mcp_servers: { privateServer: { command: 'do-not-run' } } } },
      'model/list': { data: [{ model: 'available-model', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null },
      'thread/start': { thread: { id: 't1' } }, 'turn/start': { turn: { id: 'u1' } }
    };
    send({ id: r.id, result: results[r.method] });
    if (r.method === 'turn/start') {
      send({ method: 'item/agentMessage/delta', params: { threadId: 't1', delta: 'Hello ' } });
      send({ method: 'item/agentMessage/delta', params: { threadId: 't1', delta: 'there.' } });
      send({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'u1', status: 'completed', items: [] } } });
    }
  });
  const p = new CodexProvider({ spawn: () => child, executable: '/codex', timeoutMs: 1000 });
  const answer = await p.stream({ system: 'Be concise', turns: [{ role: 'user', text: 'Hi' }], onToken: x => chunks.push(x), smart: false });
  assert.equal(answer, 'Hello there.'); assert.deepEqual(chunks, ['Hello ', 'there.']);
  const start = requests.find(r => r.method === 'thread/start').params;
  assert.deepEqual(start.environments, []); assert.equal(start.sandbox, 'read-only');
  assert.equal(start.ephemeral, true); assert.equal(start.config.web_search, 'disabled');
  assert.equal(start.config.features.shell_tool, false);
  assert.equal(start.config.mcp_servers.privateServer.enabled, false);
  assert.equal(start.model, 'available-model');
  const turn = requests.find(r => r.method === 'turn/start').params;
  assert.match(turn.input[0].text, /Hi/); assert.equal(turn.effort, 'low');
  assert.equal(child.killed, true);
});

test('API-key auth is rejected rather than charging API billing', async () => {
  const { CodexProvider } = require('../src/codex-provider');
  const child = fakeProcess((r, send) => {
    if (r.id) send({ id: r.id, result: r.method === 'account/read' ? { account: { type: 'apiKey' } } : {} });
  });
  const p = new CodexProvider({ spawn: () => child, executable: '/codex', timeoutMs: 1000 });
  await assert.rejects(p.stream({ turns: [], onToken() {} }), /ChatGPT/);
  assert.equal(child.killed, true);
});

test('an unresponsive server times out and is terminated', async () => {
  const { CodexProvider } = require('../src/codex-provider');
  const child = fakeProcess(() => {});
  const p = new CodexProvider({ spawn: () => child, executable: '/codex', timeoutMs: 20 });
  await assert.rejects(p.status(), /timed out/i);
  assert.equal(child.killed, true);
});

test('server exit rejects an in-flight request without waiting for timeout', async () => {
  const { CodexProvider } = require('../src/codex-provider');
  const child = fakeProcess(() => child.emit('exit', 1));
  const p = new CodexProvider({ spawn: () => child, executable: '/codex', timeoutMs: 1000 });
  await assert.rejects(p.status(), /stopped/);
});

test('closing a provider rejects pending work even when child exit is asynchronous', async () => {
  const { CodexProvider } = require('../src/codex-provider');
  const child = fakeProcess(() => {});
  child.kill = () => {};
  const p = new CodexProvider({ spawn: () => child, executable: '/codex', timeoutMs: 1000 });
  const request = p.status();
  p.close();
  await assert.rejects(request, /closed/);
});

test('active thread progress keeps a response alive beyond one idle interval', async () => {
  const { CodexProvider } = require('../src/codex-provider');
  const p = new CodexProvider({ timeoutMs: 60 });
  const result = p.waitFor(m => m.method === 'complete' ? { text: 'done' } : null, { isActivity: m => m.threadId === 't1' });
  const interval = setInterval(() => p.events.emit('notification', { threadId: 't1', method: 'reasoning' }), 15);
  setTimeout(() => p.events.emit('notification', { threadId: 't1', method: 'complete' }), 130);
  try { assert.deepEqual(await result, { text: 'done' }); }
  finally { clearInterval(interval); p.close(); }
});
