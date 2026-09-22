const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnswerFitController } = require('../renderer/answer-fit');
const { createAnswerRenderGate } = require('../renderer/answer-fit');
const { selectionIntersects } = require('../renderer/answer-fit');
function harness() {
  let work = null; const sent = [];
  const c = createAnswerFitController({ measure: node => node, apply: value => sent.push(value),
    schedule: cb => { work = cb; return 1; }, cancel: () => { work = null; } });
  return { c, sent, flush: () => { const cb = work; work = null; cb?.(); } };
}
test('stream fits are coalesced and use the latest measured content', () => {
  const h = harness(); h.c.start(5); h.c.update({ width: 600, height: 400 }); h.c.update({ width: 800, height: 650 });
  assert.equal(h.sent.length, 0); h.flush(); assert.deepEqual(h.sent, [{ width: 800, height: 650, token: 5 }]);
});
test('reading locks pending and future movement for this answer', () => {
  const h = harness(); h.c.start(1); h.c.update({ width: 800, height: 600 }); h.c.freeze(); h.flush();
  h.c.update({ width: 900, height: 700 }); h.flush(); assert.equal(h.sent.length, 0);
  h.c.start(2); h.c.update({ width: 600, height: 320 }); h.flush(); assert.equal(h.sent.length, 1);
});
test('clearing chat drops queued measurements', () => {
  const h = harness(); h.c.start(1); h.c.update({ width: 800, height: 600 }); h.c.reset(); h.flush();
  assert.equal(h.sent.length, 0);
});

test('stream render preserves selected text and resumes with latest content', () => {
  let selected = true; const rendered = [];
  const gate = createAnswerRenderGate({ hasSelection: () => selected, render: node => rendered.push(node.raw) });
  const node = { raw: 'partial' }; gate.update(node);
  node.raw = 'completed'; gate.update(node); assert.deepEqual(rendered, []);
  selected = false; gate.resume(); assert.deepEqual(rendered, ['completed']);
});
test('clearing a chat drops deferred render while selection is active', () => {
  let selected = true; const rendered = [];
  const gate = createAnswerRenderGate({ hasSelection: () => selected, render: node => rendered.push(node) });
  gate.update({ raw: 'old answer' }); gate.reset(); selected = false; gate.resume();
  assert.deepEqual(rendered, []);
});
test('a new answer does not discard an older selected answer waiting to render', () => {
  const old = { raw: 'old complete' }; const next = { raw: 'next answer' }; const rendered = [];
  let selected = true;
  const gate = createAnswerRenderGate({ hasSelection: node => node === old && selected, render: node => rendered.push(node.raw) });
  gate.update(old); gate.update(next); selected = false; gate.resume();
  assert.deepEqual(rendered, ['next answer', 'old complete']);
});
test('selection enclosing an answer blocks render even when endpoints are outside it', () => {
  const node = {};
  const selection = { isCollapsed: false, rangeCount: 2, getRangeAt: i => ({ intersectsNode: n => i === 1 && n === node }) };
  assert.equal(selectionIntersects(node, selection), true);
  assert.equal(selectionIntersects(node, { ...selection, isCollapsed: true }), false);
});
