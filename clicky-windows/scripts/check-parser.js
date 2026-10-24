'use strict';

// Quick sanity check for the POINT tag parser. Run with: npm run check
const assert = require('assert');
const { parsePointingCoordinates } = require('../src/main/pointTag');

let r = parsePointingCoordinates('click that. [POINT:1100,42:color inspector]');
assert.strictEqual(r.spokenText, 'click that.');
assert.deepStrictEqual(r.coordinate, { x: 1100, y: 42 });
assert.strictEqual(r.label, 'color inspector');
assert.strictEqual(r.screenNumber, null);

r = parsePointingCoordinates('over there [POINT:400,300:terminal:screen2]');
assert.deepStrictEqual(r.coordinate, { x: 400, y: 300 });
assert.strictEqual(r.label, 'terminal');
assert.strictEqual(r.screenNumber, 2);

r = parsePointingCoordinates('html is a markup language. [POINT:none]');
assert.strictEqual(r.spokenText, 'html is a markup language.');
assert.strictEqual(r.coordinate, null);

r = parsePointingCoordinates('no tag at all');
assert.strictEqual(r.spokenText, 'no tag at all');
assert.strictEqual(r.coordinate, null);

r = parsePointingCoordinates('coords only [POINT:10, 20]  ');
assert.deepStrictEqual(r.coordinate, { x: 10, y: 20 });
assert.strictEqual(r.label, null);

console.log('point tag parser: all checks passed');
