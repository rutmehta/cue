'use strict';

const clamp = (n, a, b) => Math.min(Math.max(n, a), b);

function cameraBounds(area) {
  if (!area || ![area.x, area.y, area.width, area.height].every(Number.isFinite) || area.width <= 0 || area.height <= 0) throw new TypeError('A valid display work area is required.');
  const width = Math.min(600, area.width);
  const height = Math.min(410, Math.max(1, area.height - 8));
  return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + Math.min(8, area.height - height)), width, height };
}

// Edge density is a local visual-clutter heuristic, not semantic importance.
// Analyze only at request start, never while the user is reading streamed text.
function chooseOverlayBounds(display, image) {
  const center = cameraBounds(display.workArea);
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 2 || image.height < 2
    || !image.bitmap || image.bitmap.length !== image.width * image.height * 4) return center;
  const { width, height, bitmap } = image;
  const luminance = (x, y) => { const i = (y * width + x) * 4; return (bitmap[i] * .0722 + bitmap[i + 1] * .7152 + bitmap[i + 2] * .2126) / 255; };
  function density(box) {
    const d = display.bounds;
    const x0 = clamp(Math.floor((box.x - d.x) / d.width * width), 1, width - 1);
    const x1 = clamp(Math.ceil((box.x + box.width - d.x) / d.width * width), x0 + 1, width);
    const y0 = clamp(Math.floor((box.y - d.y) / d.height * height), 1, height - 1);
    const y1 = clamp(Math.ceil((box.y + box.height - d.y) / d.height * height), y0 + 1, height);
    let edges = 0, count = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const l = luminance(x, y);
      edges += Math.max(Math.abs(l - luminance(x - 1, y)), Math.abs(l - luminance(x, y - 1)));
      count++;
    }
    return count ? edges / count : 0;
  }
  const base = density(center);
  let best = center, score = base;
  for (const offset of [-120, 120]) {
    const candidate = { ...center, x: Math.round(clamp(center.x + offset, display.workArea.x, display.workArea.x + display.workArea.width - center.width)) };
    const candidateScore = density(candidate) + .025; // Prefer camera center unless improvement is meaningful.
    if (candidateScore < score) { score = candidateScore; best = candidate; }
  }
  return best;
}

function fitAnswerBounds({ area, current, width, height, previous, manual, token, currentToken }) {
  if (manual || token !== currentToken || !Number.isInteger(token) || ![width, height].every(n => Number.isFinite(n) && n > 0)) return null;
  const maxWidth = Math.min(900, area.width);
  const maxHeight = Math.min(760, Math.floor(area.height * .85));
  const w = Math.round(clamp(Math.max(width, previous?.width || 0), Math.min(600, maxWidth), maxWidth));
  const h = Math.round(clamp(Math.max(height, previous?.height || 0), Math.min(320, maxHeight), maxHeight));
  return {
    x: Math.round(clamp(current.x + current.width / 2 - w / 2, area.x, area.x + area.width - w)),
    y: Math.round(clamp(current.y, area.y, area.y + area.height - h)), width: w, height: h
  };
}

module.exports = { cameraBounds, chooseOverlayBounds, fitAnswerBounds };
