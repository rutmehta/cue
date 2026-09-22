function createDisplayMediaRequestHandler({ desktopCapturer } = {}) {
  if (!desktopCapturer || typeof desktopCapturer.getSources !== 'function') {
    throw new TypeError('A desktopCapturer adapter with getSources() is required.');
  }

  return (_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (!sources.length) {
        callback();
        return;
      }
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => callback());
  };
}

module.exports = { createDisplayMediaRequestHandler };
