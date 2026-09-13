const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

// Execute the real startup prefix; stop before window/provider initialization.
function startup(platform) {
  const switches = new Map();
  const stop = new Error('startup prefix complete');
  try {
    vm.runInNewContext(fs.readFileSync(require.resolve('../main'), 'utf8'), {
      process: { platform },
      require(name) {
        if (name === 'electron') return { app: { commandLine: {
          appendSwitch: (name, value) => switches.set(name, value)
        } } };
        if (name === './src/whisper-model-manager') throw stop;
        return {};
      }
    });
  } catch (error) { if (error !== stop) throw error; }
  return switches;
}

test('macOS startup enables all-system playback reference for microphone echo cancellation', () => {
  const features = startup('darwin').get('enable-features').split(',');
  assert.ok(features.includes('SystemLoopbackAsAecReference:forced_on/true'));
});

test('speaker fix does not force macOS audio features onto other platforms', () => {
  for (const platform of ['win32', 'linux']) {
    assert.equal(startup(platform).has('enable-features'), false);
  }
});
