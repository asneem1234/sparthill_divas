// Parses the [POINT:x,y:label:screenN] / [POINT:none] tag the model appends to
// its reply. Port of CompanionManager.parsePointingCoordinates.

// Matches [POINT:none], [POINT:123,456:label] and [POINT:123,456:label:screen2]
// at the very end of the response.
const POINT_TAG_PATTERN = /\[POINT:(?:none|(\d+)\s*,\s*(\d+)(?::([^\]:\s][^\]:]*?))?(?::screen(\d+))?)\]\s*$/;

/**
 * @returns {{spokenText: string, coordinate: ({x: number, y: number}|null),
 *            elementLabel: (string|null), screenNumber: (number|null)}}
 */
function parsePointingCoordinates(responseText) {
  const tagMatch = POINT_TAG_PATTERN.exec(responseText);

  if (!tagMatch) {
    // No tag found at all.
    return { spokenText: responseText, coordinate: null, elementLabel: null, screenNumber: null };
  }

  // Remove the tag from the spoken text.
  const spokenText = responseText.slice(0, tagMatch.index).trim();

  const [, xText, yText, labelText, screenNumberText] = tagMatch;

  // [POINT:none] has no coordinate groups.
  if (xText === undefined || yText === undefined) {
    return { spokenText, coordinate: null, elementLabel: 'none', screenNumber: null };
  }

  return {
    spokenText,
    coordinate: { x: Number(xText), y: Number(yText) },
    elementLabel: labelText !== undefined ? labelText.trim() : null,
    screenNumber: screenNumberText !== undefined ? Number(screenNumberText) : null,
  };
}

/**
 * Converts a coordinate in the screenshot's pixel space (top-left origin) into
 * global desktop coordinates. Electron reports display bounds and the cursor in
 * DIPs with a top-left origin, so unlike AppKit there is no Y flip.
 */
function convertScreenshotPointToGlobalLocation(pointInScreenshotPixels, screenCapture) {
  const screenshotWidth = screenCapture.screenshotWidthInPixels;
  const screenshotHeight = screenCapture.screenshotHeightInPixels;
  const displayWidth = screenCapture.displayWidthInPoints;
  const displayHeight = screenCapture.displayHeightInPoints;
  const displayFrame = screenCapture.displayFrame;

  // Clamp to the screenshot coordinate space.
  const clampedX = Math.max(0, Math.min(pointInScreenshotPixels.x, screenshotWidth));
  const clampedY = Math.max(0, Math.min(pointInScreenshotPixels.y, screenshotHeight));

  // Scale from screenshot pixels to display points.
  const displayLocalX = clampedX * (displayWidth / screenshotWidth);
  const displayLocalY = clampedY * (displayHeight / screenshotHeight);

  return {
    x: displayLocalX + displayFrame.x,
    y: displayLocalY + displayFrame.y,
  };
}

module.exports = { parsePointingCoordinates, convertScreenshotPointToGlobalLocation };
