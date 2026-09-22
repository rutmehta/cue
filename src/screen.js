// Full-resolution screenshot via desktopCapturer (main process).
// The first call can trigger the system permission prompt for the app.
const { desktopCapturer, screen } = require('electron');

async function captureScreenContext({ displayId } = {}) {
  const display = displayId == null ? screen.getPrimaryDisplay()
    : screen.getAllDisplays().find(d => String(d.id) === String(displayId));
  if (!display) throw new Error('The selected screen is no longer connected.');
  const { width, height } = display.size;
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.floor(width * scale), height: Math.floor(height * scale) }
  });
  if (!sources.length) throw new Error('Screen capture returned no sources.');
  const src = sources.find((s) => String(s.display_id) === String(display.id));
  if (!src) throw new Error(`Display ${display.id} was not available for capture; available display IDs: ${sources.map(s => s.display_id || '(empty)').join(', ')}.`);
  const img = src?.thumbnail;
  if (!img || img.isEmpty()) throw new Error(`Display ${display.id} returned an empty screen image.`);
  const sample = img.resize({ width: 320 });
  return { imageDataUrl: img.toDataURL(), display, analysis: { ...sample.getSize(), bitmap: sample.toBitmap() } };
}

async function captureScreenshot(options) { return (await captureScreenContext(options))?.imageDataUrl || null; }

module.exports = { captureScreenshot, captureScreenContext };
