const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('history remains visible and scrollable in compact and expanded Electron layouts', { timeout: 30000 }, () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures/history-scroll.cjs')], {
    env, encoding: 'utf8', timeout: 25000
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
