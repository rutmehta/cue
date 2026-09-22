const assert = require('node:assert/strict');
const test = require('node:test');

const { applyContentProtection } = require('../src/capture-protection');

for (const [platform, build, mode] of [
  ['darwin', 0, 'macos-best-effort'],
  ['win32', 22631, 'windows-excluded'],
  ['win32', 18363, 'windows-black-fallback']
]) {
  test(`applies protection on ${platform} ${build}`, () => {
    const calls = [];
    const result = applyContentProtection({
      setContentProtection: (value) => calls.push(value)
    }, { platform, windowsBuild: build });

    assert.deepEqual(calls, [true]);
    assert.deepEqual(result, {
      configured: true,
      mode,
      verified: false,
      reason: 'Content protection was requested; capture exclusion has not been verified.'
    });
  });
}

test('reports unsupported Linux without calling Electron', () => {
  let called = false;
  const result = applyContentProtection({
    setContentProtection: () => { called = true; }
  }, { platform: 'linux' });

  assert.equal(called, false);
  assert.deepEqual(result, {
    configured: false,
    mode: 'unsupported',
    reason: 'Content protection is unavailable on Linux.'
  });
});

test('CUE_NO_PROTECT disables protection without calling Electron', () => {
  let called = false;
  const result = applyContentProtection({
    setContentProtection: () => { called = true; }
  }, { platform: 'darwin', environment: { CUE_NO_PROTECT: '1' } });

  assert.equal(called, false);
  assert.equal(result.configured, false);
  assert.equal(result.mode, 'disabled');
});

test('returns a structured error only when Electron rejects the protection request', () => {
  const thrown = applyContentProtection({
    setContentProtection: () => { throw new Error('window is gone'); }
  }, { platform: 'darwin' });

  assert.deepEqual(thrown, {
    configured: false,
    mode: 'error',
    reason: 'window is gone'
  });
});
