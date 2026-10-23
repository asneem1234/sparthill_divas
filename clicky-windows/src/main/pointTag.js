'use strict';

// Matches [POINT:none], [POINT:123,456:label] and [POINT:123,456:label:screen2]
// at the very end of the response. Same pattern as the macOS app.
const POINT_TAG_PATTERN =
  /\[POINT:(?:none|(\d+)\s*,\s*(\d+)(?::([^\]:\s][^\]:]*?))?(?::screen(\d+))?)\]\s*$/;

/**
 * Parses the trailing POINT tag from Claude's response.
 * @param {string} responseText
 * @returns {{spokenText: string, coordinate: {x:number,y:number}|null, label: string|null, screenNumber: number|null}}
 */
function parsePointingCoordinates(responseText) {
  const match = POINT_TAG_PATTERN.exec(responseText);
  if (!match) {
    return { spokenText: responseText.trim(), coordinate: null, label: null, screenNumber: null };
  }

  const spokenText = responseText.slice(0, match.index).trim();

  // [POINT:none] has no capture groups filled in.
  if (match[1] === undefined || match[2] === undefined) {
    return { spokenText, coordinate: null, label: 'none', screenNumber: null };
  }

  return {
    spokenText,
    coordinate: { x: parseInt(match[1], 10), y: parseInt(match[2], 10) },
    label: match[3] ? match[3].trim() : null,
    screenNumber: match[4] ? parseInt(match[4], 10) : null,
  };
}

module.exports = { parsePointingCoordinates };
