'use strict';

// Calls Gemini directly through src/main/gemini.js. Run with: npm run test:gemini
const gemini = require('../src/main/gemini');

// 1x1 red PNG, just to prove image input is accepted.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
);

(async () => {
  if (!gemini.hasApiKey()) {
    console.error('No GEMINI_API_KEY found (env or clicky-windows/.env).');
    process.exit(1);
  }
  const text = await gemini.streamChat({
    model: 'gemini-3.5-flash',
    systemPrompt: 'Reply in one short sentence.',
    history: [],
    images: [{ data: TINY_PNG, label: 'test image' }],
    userPrompt: 'What color is this image?',
  });
  console.log('chat reply:', text || '(EMPTY)');
  if (!text) process.exit(1);
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
