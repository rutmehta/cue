const DEFAULT_BOUNDS = Object.freeze({ width: 720, height: 600 });
const MINIMUM_BOUNDS = Object.freeze({ width: 420, height: 80 });
const HORIZONTAL_REACHABLE_PIXELS = 96;
const RAIL_REACHABLE_PIXELS = 40;
const DEFAULT_TOP_OFFSET = 6;

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

function requireWorkArea(display) {
  const workArea = display && display.workArea;
  if (!workArea || !Number.isFinite(workArea.x) || !Number.isFinite(workArea.y)
    || !Number.isFinite(workArea.width) || !Number.isFinite(workArea.height)
    || workArea.width <= 0 || workArea.height <= 0) {
    throw new TypeError('Each display must provide a positive workArea.');
  }
  return workArea;
}

function findDisplay(displays, displayId) {
  return displays.find((display) => String(display.id) === String(displayId));
}

function selectDisplay(displays, primaryDisplayId, savedByDisplay) {
  const primary = findDisplay(displays, primaryDisplayId) || displays[0];
  const savedDisplay = displays.find((display) => Object.prototype.hasOwnProperty.call(savedByDisplay, display.id));
  return savedDisplay || primary;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function resolveOverlayBounds({ displays, primaryDisplayId, savedByDisplay = {} } = {}) {
  if (!Array.isArray(displays) || displays.length === 0) {
    throw new TypeError('At least one display is required to resolve overlay bounds.');
  }

  const safeSaved = savedByDisplay && typeof savedByDisplay === 'object' ? savedByDisplay : {};
  const display = selectDisplay(displays, primaryDisplayId, safeSaved);
  const workArea = requireWorkArea(display);
  const saved = safeSaved[display.id];
  const hasSavedBounds = saved && typeof saved === 'object';

  const width = Math.max(MINIMUM_BOUNDS.width, finiteNumber(saved?.width, DEFAULT_BOUNDS.width));
  const height = Math.min(
    Math.max(MINIMUM_BOUNDS.height, finiteNumber(saved?.height, DEFAULT_BOUNDS.height)),
    workArea.height
  );
  const defaultX = workArea.x + Math.round((workArea.width - width) / 2);
  const defaultY = workArea.y + DEFAULT_TOP_OFFSET;
  const x = clamp(
    finiteNumber(hasSavedBounds ? saved.x : undefined, defaultX),
    workArea.x,
    workArea.x + Math.max(0, workArea.width - HORIZONTAL_REACHABLE_PIXELS)
  );
  const y = clamp(
    finiteNumber(hasSavedBounds ? saved.y : undefined, defaultY),
    workArea.y,
    workArea.y + Math.max(0, workArea.height - RAIL_REACHABLE_PIXELS)
  );

  return { x, y, width, height, displayId: display.id };
}

function storeBoundsForDisplay(saved, displayId, bounds) {
  const stored = saved && typeof saved === 'object' ? saved : {};
  if (!bounds || typeof bounds !== 'object') {
    throw new TypeError('Bounds must be an object.');
  }

  return Object.fromEntries([
    ...Object.entries(stored).map(([id, value]) => [id, value && typeof value === 'object' ? { ...value } : value]),
    [displayId, { ...bounds }]
  ]);
}

module.exports = {
  DEFAULT_BOUNDS,
  MINIMUM_BOUNDS,
  resolveOverlayBounds,
  storeBoundsForDisplay
};
