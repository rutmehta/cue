const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpdater } = require('../src/updater');
const { buildTrayTemplate } = require('../src/tray-menu');
const app = { isPackaged: true, getAppPath: () => '/Cue.app/Contents/Resources/app' };
const logger = { log() {}, error() {} };

test('Sparkle only loads in packaged macOS apps', () => {
  for (const options of [{ platform: 'win32', app }, { platform: 'darwin', app: { ...app, isPackaged: false } }]) {
    const updater = createUpdater({ ...options, load() { throw new Error('must not load'); }, logger });
    updater.start();
    assert.equal(updater.supported, false);
  }
});
test('native updater loads once and routes manual checks and read-only probes', async () => {
  const calls = [];
  const native = { start: () => calls.push('start'), check: () => calls.push('check'), probe: () => calls.push('probe'), status: () => ({ feedURL: 'https://example.test/appcast.xml' }) };
  const updater = createUpdater({ app, platform: 'darwin', logger, load(file) { assert.equal(file, '/Cue.app/Contents/Resources/app/native/bin/cue-sparkle.node'); return native; } });
  updater.start(); updater.start(); await updater.check(); updater.probe();
  assert.deepEqual(calls, ['start', 'check', 'probe']);
});
test('a broken native updater is visible to manual checks without crashing Cue', async () => {
  const messages = [];
  const updater = createUpdater({ app, platform: 'darwin', logger, load() { throw new Error('signature invalid'); }, dialog: { showMessageBox: async message => messages.push(message) } });
  assert.doesNotThrow(() => updater.start());
  assert.equal(await updater.check(), false);
  assert.match(messages[0].detail, /signature invalid/);
  assert.throws(() => updater.probe(), /signature invalid/);
});
test('tray exposes and routes Check for Updates only when supported', () => {
  assert.equal(buildTrayTemplate().some(item => item.label === 'Check for Updates…'), false);
  let checks = 0;
  const menu = buildTrayTemplate({}, { checkForUpdates: () => checks++ });
  menu.find(item => item.label === 'Check for Updates…').click();
  assert.equal(checks, 1);
});
