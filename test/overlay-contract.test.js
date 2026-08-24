const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');

test('overlay exposes explicit session, source, engine, end, and quit controls', () => {
  for (const id of ['session-status-label', 'mic-signal', 'system-signal', 'engine-signal', 'end-btn', 'quit-btn', 'local-engine-seg']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test('primary transport pauses live capture while end remains explicit', () => {
  assert.match(renderer, /turningOn \? 'start' : 'pause'/);
  assert.match(renderer, /captureReconciler\.command\('end-session'/);
});

test('local engine selector offers fastest Auto plus both supported engines', () => {
  assert.match(html, /data-local-engine="auto"[^>]*>Auto · fastest/);
  assert.match(html, /data-local-engine="parakeet"/);
  assert.match(html, /data-local-engine="whisper"/);
});
