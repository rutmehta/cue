const path = require('node:path');

function createUpdater({ app, dialog, platform = process.platform, load = require, logger = console }) {
  let native = null;
  let failure = null;
  const supported = platform === 'darwin' && app.isPackaged;
  return {
    supported,
    start() {
      if (!supported || native) return;
      try {
        native = load(path.join(app.getAppPath(), 'native/bin/cue-sparkle.node'));
        native.start();
        logger.log('[cue] Sparkle ready:', native.status().feedURL);
      } catch (error) {
        native = null;
        failure = error;
        logger.error('[cue] Sparkle failed to start:', error.message);
      }
    },
    async check() {
      if (native) return native.check();
      await dialog.showMessageBox({ type: 'error', title: 'Cue Updates', message: 'The updater could not start.', detail: failure?.message || 'Automatic updates are available in the installed macOS app.' });
      return false;
    },
    probe() {
      if (!native) throw failure || new Error('Sparkle is unavailable.');
      return native.probe();
    },
    status() {
      return native ? native.status() : { state: 'error', error: failure?.message || 'Sparkle is unavailable.' };
    }
  };
}
module.exports = { createUpdater };
