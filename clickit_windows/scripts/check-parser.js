// Quick sanity check for the POINT tag parser and coordinate mapping.
// Run with: npm run check

const assert = require('assert');
const { parsePointingCoordinates, convertScreenshotPointToGlobalLocation } = require('../src/main/pointTag');

// Tag with label.
let parsedResult = parsePointingCoordinates('see that menu up top? [POINT:285,11:source control]');
assert.strictEqual(parsedResult.spokenText, 'see that menu up top?');
assert.deepStrictEqual(parsedResult.coordinate, { x: 285, y: 11 });
assert.strictEqual(parsedResult.elementLabel, 'source control');
assert.strictEqual(parsedResult.screenNumber, null);

// Tag with a screen number.
parsedResult = parsePointingCoordinates('over on your other monitor. [POINT:400,300:terminal:screen2]');
assert.deepStrictEqual(parsedResult.coordinate, { x: 400, y: 300 });
assert.strictEqual(parsedResult.elementLabel, 'terminal');
assert.strictEqual(parsedResult.screenNumber, 2);

// Tag without a label, with whitespace around the comma.
parsedResult = parsePointingCoordinates('here. [POINT:10 , 20]  ');
assert.deepStrictEqual(parsedResult.coordinate, { x: 10, y: 20 });
assert.strictEqual(parsedResult.elementLabel, null);

// Explicit none.
parsedResult = parsePointingCoordinates('html is the skeleton of every page. [POINT:none]');
assert.strictEqual(parsedResult.spokenText, 'html is the skeleton of every page.');
assert.strictEqual(parsedResult.coordinate, null);
assert.strictEqual(parsedResult.elementLabel, 'none');

// No tag at all.
parsedResult = parsePointingCoordinates('just an answer');
assert.strictEqual(parsedResult.spokenText, 'just an answer');
assert.strictEqual(parsedResult.coordinate, null);
assert.strictEqual(parsedResult.elementLabel, null);

// A tag in the middle of the text is not a pointing tag.
parsedResult = parsePointingCoordinates('use [POINT:1,2:x] syntax for pointing.');
assert.strictEqual(parsedResult.coordinate, null);

// Coordinate mapping: a 1280x720 screenshot of a 1920x1080 display that sits at x=1920.
const screenCapture = {
  screenshotWidthInPixels: 1280,
  screenshotHeightInPixels: 720,
  displayWidthInPoints: 1920,
  displayHeightInPoints: 1080,
  displayFrame: { x: 1920, y: 0, width: 1920, height: 1080 },
};
assert.deepStrictEqual(convertScreenshotPointToGlobalLocation({ x: 640, y: 360 }, screenCapture), { x: 2880, y: 540 });
// Out-of-range values clamp to the screenshot edge.
assert.deepStrictEqual(convertScreenshotPointToGlobalLocation({ x: 5000, y: -4 }, screenCapture), { x: 3840, y: 0 });

console.log('point tag parser checks passed');
