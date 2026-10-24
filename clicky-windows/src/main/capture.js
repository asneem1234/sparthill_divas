'use strict';

const { desktopCapturer, screen } = require('electron');

const MAX_DIMENSION = 1280;

/**
 * Captures every display as a JPEG, cursor screen first.
 * Coordinates Claude returns are in screenshot pixels, so each capture keeps
 * the screenshot size and the display bounds (in DIPs) needed to map back.
 *
 * Our own overlay windows use content protection, so they are not captured.
 */
async function captureAllScreens() {
  const displays = screen.getAllDisplays();
  if (displays.length === 0) throw new Error('No display available for capture.');

  const cursorPoint = screen.getCursorScreenPoint();
  const cursorDisplay = screen.getDisplayNearestPoint(cursorPoint);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: MAX_DIMENSION, height: MAX_DIMENSION },
  });

  // Cursor display first, then the rest in system order.
  const orderedDisplays = [
    cursorDisplay,
    ...displays.filter((display) => display.id !== cursorDisplay.id),
  ];

  const captures = [];
  for (const display of orderedDisplays) {
    const source =
      sources.find((candidate) => candidate.display_id === String(display.id)) ||
      // Some drivers leave display_id empty; fall back to system order.
      sources[displays.findIndex((candidate) => candidate.id === display.id)];
    if (!source || source.thumbnail.isEmpty()) continue;

    const size = source.thumbnail.getSize();
    captures.push({
      jpeg: source.thumbnail.toJPEG(80),
      isCursorScreen: display.id === cursorDisplay.id,
      displayBounds: display.bounds,
      screenshotWidth: size.width,
      screenshotHeight: size.height,
    });
  }

  if (captures.length === 0) throw new Error('Failed to capture any screen.');

  return captures.map((capture, index) => {
    let label;
    if (captures.length === 1) {
      label = "user's screen (cursor is here)";
    } else if (capture.isCursorScreen) {
      label = `screen ${index + 1} of ${captures.length} — cursor is on this screen (primary focus)`;
    } else {
      label = `screen ${index + 1} of ${captures.length} — secondary screen`;
    }
    label += ` (image dimensions: ${capture.screenshotWidth}x${capture.screenshotHeight} pixels)`;
    return { ...capture, label };
  });
}

/**
 * Maps a point in screenshot pixels to global screen coordinates (DIPs).
 */
function screenshotPointToGlobal(capture, point) {
  const x = Math.max(0, Math.min(point.x, capture.screenshotWidth));
  const y = Math.max(0, Math.min(point.y, capture.screenshotHeight));
  return {
    x: capture.displayBounds.x + x * (capture.displayBounds.width / capture.screenshotWidth),
    y: capture.displayBounds.y + y * (capture.displayBounds.height / capture.screenshotHeight),
  };
}

module.exports = { captureAllScreens, screenshotPointToGlobal };
