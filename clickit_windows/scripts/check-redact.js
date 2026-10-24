// Checks that secret-looking values are masked in Privacy Guard answers.
// Run with: npm run check

const assert = require('assert');
const { redactSensitiveValues } = require('../src/main/redact');
const { describeWorkerError } = require('../src/main/worker');

const modelAnswer = [
  '- API Key ID: AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE -> blur it',
  '- Secret: AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY -> rotate it',
  '- Password: DB_PASSWORD=hunter2-Tr0ub4dor -> remove it',
  '- Card: 4111 1111 1111 1111 -> blur it',
  '- Token: ghp_abcdefghijklmnopqrstuvwxyz0123456789 -> revoke it',
  '- Google key: AIzaSyA1234567890abcdefghijklmnopqrstuv -> rotate it',
].join('\n');

const redacted = redactSensitiveValues(modelAnswer);
for (const secret of [
  'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'hunter2-Tr0ub4dor',
  '4111 1111 1111 1111', '4111111111111111', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'AIzaSyA1234567890abcdefghijklmnopqrstuv',
]) {
  assert(!redacted.includes(secret), `secret still visible: ${secret}\n${redacted}`);
}

// Already-masked output, plain prose and ordinary numbers are left alone.
const alreadySafe = '- Password: DB_PASSWORD=hu...or -> remove it\nThe form was submitted on 09/29 at 3pm, line 12.';
assert.strictEqual(redactSensitiveValues(alreadySafe), alreadySafe);
assert.strictEqual(redactSensitiveValues('This screen looks fine to share.'), 'This screen looks fine to share.');

// Error messages are readable.
const rateLimit = describeWorkerError(
  new Error('API Error (429): {"error":{"message":"You exceeded your current quota. Please retry in 50.4s."}}'),
  'http://localhost:8787'
);
assert(/limit was reached/.test(rateLimit) && /51 seconds/.test(rateLimit), rateLimit);
const rejectedKeyMessage = describeWorkerError(new Error('API Error (400): {"error":{"message":"API key not valid. Please pass a valid API key."}}'), 'x');
assert(/rejected the request/.test(rejectedKeyMessage), rejectedKeyMessage);
// Messages shown to the user never name the key, the secrets file, or contain a key.
assert(!/GEMINI_API_KEY|\.dev\.vars/.test(rejectedKeyMessage), rejectedKeyMessage);
const leakyMessage = describeWorkerError(
  new Error('API Error (418): {"error":{"message":"bad call to https://x/v1?key=AQ.Ab8RN6FakeFakeFakeFakeFakeFake1234 and AIzaSyFakeFakeFakeFakeFakeFakeFake12345"}}'),
  'x'
);
assert(!/AQ\.Ab8|AIzaSy|key=AQ/.test(leakyMessage), leakyMessage);
assert(/Couldn't reach the worker/.test(describeWorkerError(new TypeError('fetch failed'), 'http://localhost:8787')));
assert(/rate|limit/i.test(describeWorkerError(new Error('Transcription failed (429): {"error":{"message":"quota"}}'), 'x')));

console.log('redaction and error message checks passed');
