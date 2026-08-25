const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

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

test('overlay exposes a real New Chat action with a local Command-N shortcut', () => {
  assert.match(html, /id="new-chat-btn"/);
  assert.match(renderer, /cue\.newChat\(\)/);
  assert.match(renderer, /\(e\.metaKey\s*\|\|\s*e\.ctrlKey\)\s*&&\s*e\.key\.toLowerCase\(\)\s*===\s*'n'/);
});

test('resizable overlay preserves a usable viewport and scrolls tall content', () => {
  assert.match(main, /minWidth:\s*520/);
  assert.match(main, /minHeight:\s*320/);
  assert.match(styles, /#panel\s*\{[^}]*max-height:\s*calc\(100vh\s*-\s*\d+px\)[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.transcript-sidebar\s*\{[^}]*max-height:\s*calc\(100vh\s*-\s*\d+px\)/s);
});
