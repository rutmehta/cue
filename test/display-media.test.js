const assert = require('node:assert/strict');
const test = require('node:test');

const { createDisplayMediaRequestHandler } = require('../src/display-media');

test('Windows display-media grants use Electron loopback audio instead of a boolean', async () => {
  const source = { id: 'screen:1', name: 'Primary screen' };
  const handler = createDisplayMediaRequestHandler({
    platform: 'win32',
    desktopCapturer: {
      getSources: async (options) => {
        assert.deepEqual(options, { types: ['screen'] });
        return [source];
      }
    }
  });

  const streams = await new Promise((resolve) => handler({}, resolve));

  assert.deepEqual(streams, { video: source, audio: 'loopback' });
});
