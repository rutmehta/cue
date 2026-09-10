const test = require('node:test');
const assert = require('node:assert');
const { DEFAULTS, resolveShortcuts, findConflicts, isValid } = require('../src/shortcuts');

test('defaults cover the core actions', () => {
  assert.strictEqual(DEFAULTS.assist, 'CommandOrControl+Return');
  assert.notStrictEqual(DEFAULTS.toggle, 'CommandOrControl+\\');
  assert.strictEqual(DEFAULTS.moveLeft, 'CommandOrControl+Left');
  assert.strictEqual(DEFAULTS.moveRight, 'CommandOrControl+Right');
  assert.strictEqual(DEFAULTS.clear, 'CommandOrControl+R');
  assert.strictEqual(DEFAULTS.listening, 'CommandOrControl+Shift+L');
  assert.ok(DEFAULTS.leetcode);
  assert.ok(DEFAULTS.quit);
});

test('failed shortcut replacement leaves the previous binding registered', () => {
  const { replaceGlobalShortcut } = require('../src/shortcuts');
  const held = new Set(['Control+Alt+Command+C', 'Command+\\']);
  const registry = { register: key => { if (held.has(key)) return false; held.add(key); return true; }, unregister: key => held.delete(key) };
  assert.throws(() => replaceGlobalShortcut(registry, 'Control+Alt+Command+C', 'Command+\\', () => {}), /unavailable/);
  assert.ok(held.has('Control+Alt+Command+C'));
});

test('successful shortcut replacement releases only Cue previous binding', () => {
  const { replaceGlobalShortcut } = require('../src/shortcuts');
  const held = new Set(['Control+Alt+Command+C', 'Command+\\']);
  const registry = { register: key => { if (held.has(key)) return false; held.add(key); return true; }, unregister: key => held.delete(key) };
  replaceGlobalShortcut(registry, 'Control+Alt+Command+C', 'Control+Alt+Command+J', () => {});
  assert.deepStrictEqual([...held], ['Command+\\', 'Control+Alt+Command+J']);
});

test('resolveShortcuts merges overrides', () => {
  const map = resolveShortcuts({ leetcode: 'CommandOrControl+L' });
  assert.strictEqual(map.leetcode, 'CommandOrControl+L');
  assert.strictEqual(map.assist, DEFAULTS.assist);
});

test('findConflicts detects duplicate accelerators', () => {
  const map = resolveShortcuts({ leetcode: 'CommandOrControl+Return' });
  const conflicts = findConflicts(map);
  assert.ok(conflicts.some(([a, b]) => (a === 'assist' && b === 'leetcode') || (a === 'leetcode' && b === 'assist')));
});

test('no conflicts in the default set', () => {
  assert.strictEqual(findConflicts(resolveShortcuts()).length, 0);
});

test('isValid accepts good accelerators and rejects junk', () => {
  assert.ok(isValid('CommandOrControl+Return'));
  assert.ok(isValid('Shift+Q'));
  assert.ok(isValid('F1'));
  assert.strictEqual(isValid(''), false);
  assert.strictEqual(isValid('++'), false);
  assert.strictEqual(isValid(null), false);
});
