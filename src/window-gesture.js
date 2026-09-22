function gestureBounds(start, kind, dx, dy, minWidth = 520) {
  if (kind === 'move') return { ...start, x: start.x + dx, y: start.y + dy };
  const width = Math.max(minWidth, start.width + (kind === 'left' ? -dx : dx));
  return { ...start, width, x: kind === 'left' ? start.x + start.width - width : start.x };
}
module.exports = { gestureBounds };
