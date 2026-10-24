// Checks the on-device sensitive-content detector. Run with: npm run check
// Some inputs are copied from real Windows OCR output (including its mistakes).

const assert = require('assert');
const { scanText, assessWindowIdentity, passesLuhnCheck } = require('../src/main/sensitiveContent');

function verdictOf(text) {
  return scanText(text).verdict;
}
function kindsOf(text) {
  return scanText(text).findings.map((finding) => finding.kind);
}

// --- must be BLOCKED ---
const mustBlock = {
  'real OCR: .env secrets': 'settings\nAWS ACCESS KEY ID=AKIAIOSFODNN7EXAMPLE\nDB PASSWORD=hunter2-Treub4dor',
  'real OCR: private key header with dropped dashes': 'BEGIN RSA PRIVATE KEY',
  'real OCR: private key header': '---BEGIN RSA PRIVATE KEY-----',
  'real OCR: visa': 'Card: 4012 8888 8888 1881 exp 09/29',
  'real OCR: mastercard': 'Card number 5555 5555 5555 4444',
  'real OCR: amex': 'Amex 3782 822463 10005',
  'real OCR: hyphenated visa': '4532-0151-1283-0366',
  'real OCR: unspaced visa': 'Visa 4539148803436467',
  'real OCR: username and password on one line': 'Username: jane Password: hunter2',
  'real OCR: SSN': 'SSN 123-45-6789   Aadhaar 2345 6789 0123',
  'aadhaar with context': 'Aadhaar number 2345 6789 0123',
  'github token': 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'google key': 'key AIzaSyA1234567890abcdefghijklmnopqrstuv',
  'jwt': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  'cvv': 'cvv 123',
  'quoted password in config': 'password = "correcthorse"',
  'PAN card': 'Permanent Account Number ABCDE1234F',
};
for (const [name, text] of Object.entries(mustBlock)) {
  assert.strictEqual(verdictOf(text), 'blocked', `should be blocked: ${name} -> ${JSON.stringify(scanText(text))}`);
}

// --- must NOT be blocked ---
const mustNotBlock = {
  'weather note': 'Weather today: sunny, 24 degrees.\nRemember to water the plants.',
  'phone number': 'Phone: +1 415 555 0137',
  'email address': 'Contact: jane.doe.private@gmail.com',
  'python input prompt': 'password = input("Password: ")',
  'type hint': 'def check_password(password: str) -> bool:',
  'env access': 'const apiKey = process.env.API_KEY',
  'token count variable': 'token_count = 12\nmax_tokens: 4096',
  'tokenizer call': 'tokenizer = AutoTokenizer.from_pretrained(model_name)',
  'timestamp-like number': 'created at 1699999999999',
  'random 16 digit order id': 'Order 1234 5678 9012 3456',
  'dollar amounts': 'Total: $1,234.56 on 09/29/2026',
  'masked password': 'Password: ************',
  'placeholder secret': 'api_key = your_api_key_here',
};
for (const [name, text] of Object.entries(mustNotBlock)) {
  assert.notStrictEqual(verdictOf(text), 'blocked', `should NOT be blocked: ${name} -> ${JSON.stringify(scanText(text))}`);
}

// --- must ask for CONFIRMATION (soft signals) ---
assert.strictEqual(verdictOf('Sign in\nUsername:\nPassword:'), 'confirm');
assert.strictEqual(verdictOf('P a SSWOrd:'), 'confirm', 'spaced OCR letters still detected');
assert.strictEqual(verdictOf('Enter the verification code we sent you'), 'confirm');
assert.strictEqual(verdictOf('Weather today is sunny'), 'ok');

// --- findings never contain the full secret ---
const secretText = 'DB_PASSWORD=hunter2-Tr0ub4dor\nCard: 4012 8888 8888 1881\nAWS_KEY=AKIAIOSFODNN7EXAMPLE';
const serialized = JSON.stringify(scanText(secretText));
for (const secret of ['hunter2-Tr0ub4dor', '4012888888881881', '4012 8888 8888 1881', 'AKIAIOSFODNN7EXAMPLE']) {
  assert(!serialized.includes(secret), `finding leaks ${secret}: ${serialized}`);
}

// --- Luhn ---
assert(passesLuhnCheck('4012888888881881'));
assert(!passesLuhnCheck('4012888888881882'));

// --- window identity ---
assert(assessWindowIdentity({ title: 'Bitwarden', processName: 'Bitwarden' }).isBlocked);
assert(assessWindowIdentity({ title: 'My Vault', processName: '1Password' }).isBlocked);
assert(assessWindowIdentity({ title: 'Passwords - Google Chrome', processName: 'chrome' }).isBlocked);
assert(assessWindowIdentity({ title: '.env - clicky - Kiro', processName: 'Kiro' }).isBlocked);
assert(assessWindowIdentity({ title: 'Reset your password - Gmail', processName: 'chrome' }).isBlocked);
assert(!assessWindowIdentity({ title: 'Inbox (3) - Gmail - Google Chrome', processName: 'chrome' }).isBlocked);
assert(!assessWindowIdentity({ title: 'Untitled - Notepad', processName: 'notepad' }).isBlocked);
assert(!assessWindowIdentity({ title: 'Visual Studio Code', processName: 'Code' }).isBlocked);

console.log('sensitive content checks passed');
