const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function screenModule(sources) {
  const displays = [1, 2].map(id => ({ id, size: { width: 1000, height: 800 }, scaleFactor: 1 }));
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/screen.js'), 'utf8'), {
    module, require: name => { assert.equal(name, 'electron'); return {
      screen: { getPrimaryDisplay: () => displays[0], getAllDisplays: () => displays },
      desktopCapturer: { getSources: async () => sources }
    }; }
  });
  return module.exports;
}
const thumbnail = { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,screen-two', resize: () => ({ getSize: () => ({ width: 2, height: 2 }), toBitmap: () => Buffer.alloc(16) }) };

test('screen context captures the requested display and returns matching image analysis', async () => {
  const s = screenModule([{ display_id: '2', thumbnail }]);
  const result = await s.captureScreenContext({ displayId: 2 });
  assert.equal(result.display.id, 2); assert.equal(result.imageDataUrl, 'data:image/png;base64,screen-two');
  assert.equal(result.analysis.bitmap.length, 16);
});

test('missing requested screen never substitutes another monitor', async () => {
  const s = screenModule([{ display_id: '2', thumbnail }]);
  assert.equal(await s.captureScreenshot({ displayId: 1 }), null);
});

test('disconnected screen reports an explicit error', async () => {
  await assert.rejects(screenModule([]).captureScreenContext({ displayId: 3 }), /no longer connected/);
});
