// On-device detector for sensitive content. It works on text that was read from a
// window with local OCR (or on copied text), and on window titles / app names.
// Nothing here talks to the network.
//
// Verdicts:
//   blocked  A secret or private identifier is visible. It is NOT sent to the AI.
//   confirm  Something suggests sensitive material (a sign-in form, a one-time code).
//            The user must confirm before anything is sent.
//   ok       Nothing found.

const { maskMiddle } = require('./redact');

const BLOCK = 'block';
const CONFIRM = 'confirm';

// ---------------------------------------------------------------------------
// Window identity (title and app name)
// ---------------------------------------------------------------------------

const PASSWORD_MANAGER_PROCESS_NAMES = [
  '1password', 'bitwarden', 'keepass', 'keepassxc', 'lastpass', 'dashlane', 'enpass', 'nordpass',
  'roboform', 'keeper', 'protonpass', 'proton pass', 'pwsafe', 'passwordsafe', 'authy', 'psono',
];

const SENSITIVE_TITLE_PATTERN =
  /(?:^|[^a-z])(?:passwords?|passcodes?|password manager|credential manager|credentials|vault|keychain|private key|secret key|api keys?|secrets?|seed phrase|recovery phrase|recovery codes?|backup codes?|authenticator|2fa|two-factor|\.env)(?:[^a-z]|$)/i;

/**
 * Cheap check on a window's title and app name, run when listing windows.
 * @returns {{isBlocked: boolean, reason: string|null}}
 */
function assessWindowIdentity({ title = '', processName = '' }) {
  const lowerProcessName = String(processName).toLowerCase();
  const matchedManager = PASSWORD_MANAGER_PROCESS_NAMES.find((managerName) => lowerProcessName.includes(managerName));
  if (matchedManager) {
    return { isBlocked: true, reason: 'This looks like a password manager.' };
  }
  if (SENSITIVE_TITLE_PATTERN.test(String(title))) {
    return { isBlocked: true, reason: 'The window title suggests passwords or secrets.' };
  }
  return { isBlocked: false, reason: null };
}

// ---------------------------------------------------------------------------
// Content patterns
// ---------------------------------------------------------------------------

/** Luhn checksum used by payment card numbers. */
function passesLuhnCheck(digits) {
  let sum = 0;
  let shouldDouble = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

// Issuer ranges, so a random long number that happens to pass Luhn isn't flagged.
const CARD_ISSUER_PATTERNS = [
  /^4\d{12}(?:\d{3}(?:\d{3})?)?$/, // Visa 13/16/19
  /^(?:5[1-5]\d{2}|222[1-9]|22[3-9]\d|2[3-6]\d{2}|27[01]\d|2720)\d{12}$/, // Mastercard
  /^3[47]\d{13}$/, // American Express
  /^(?:6011|65\d{2}|64[4-9]\d)\d{12}$/, // Discover
  /^35(?:2[89]|[3-8]\d)\d{12}$/, // JCB
  /^3(?:0[0-5]|[68]\d)\d{11}$/, // Diners Club
  /^62\d{14,17}$/, // UnionPay
  /^(?:60|65|81|82|508)\d{13,14}$/, // RuPay
];

const CARD_CANDIDATE_PATTERN = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;

const SECRET_NAME_KEYWORDS = 'password|passwd|pwd|passphrase|pass\\s?code|secret|token|api[_ -]?key|access[_ -]?key|private[_ -]?key|credential';
// NAME = value or NAME: value. OCR often turns underscores into spaces, so names may contain spaces.
const NAMED_SECRET_PATTERN = new RegExp(
  `((?:[\\w.-]+ ){0,3}[\\w.-]*(?:${SECRET_NAME_KEYWORDS})[\\w.-]*)\\s*[=:]\\s*(["']?)([^\\s"',;]{4,})`,
  'gi'
);

const PLACEHOLDER_VALUE_PATTERN = /^(?:[*•●·x\-_.]+|null|none|nil|true|false|undefined|string|required|optional|hidden|empty|your[\w-]*|example|changeme|placeholder|<.*>|\{.*\}|\$\{.*\}|%.*%)$/i;

function looksLikeSecretValue(value, wasQuoted) {
  if (PLACEHOLDER_VALUE_PATTERN.test(value)) return false;
  if (/[()[\]{}<>]/.test(value)) return false; // code, not a value
  // A property path such as process.env.API_KEY or config.db.password is a reference, not a secret.
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return false;
  if (wasQuoted) return value.length >= 4;
  // Unquoted values need a digit: real passwords almost always have one, plain words are usually code.
  const hasDigit = /\d/.test(value);
  const hasLetter = /[a-z]/i.test(value);
  return (hasDigit && value.length >= 6) || (hasDigit && hasLetter && value.length >= 5);
}

/** Rules that match one clear pattern and report what it was. */
const SIMPLE_RULES = [
  { kind: 'private-key', label: 'Private key', severity: BLOCK, pattern: /BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|PGP\s+|ENCRYPTED\s+)?PRIVATE\s+KEY/i },
  { kind: 'aws-key', label: 'AWS access key', severity: BLOCK, pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { kind: 'google-key', label: 'Google API key', severity: BLOCK, pattern: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { kind: 'github-token', label: 'GitHub token', severity: BLOCK, pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { kind: 'slack-token', label: 'Slack token', severity: BLOCK, pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'api-key', label: 'API key', severity: BLOCK, pattern: /\b(?:(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{20,})/ },
  { kind: 'jwt', label: 'Login token (JWT)', severity: BLOCK, pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { kind: 'ssn', label: 'Social Security number', severity: BLOCK, pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/ },
  { kind: 'pan', label: 'PAN number', severity: BLOCK, pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/ },
  { kind: 'cvv', label: 'Card security code (CVV)', severity: BLOCK, pattern: /\b(?:cvv2?|cvc2?|security code)\s*[:=]?\s*\d{3,4}\b/i },
];

function addFinding(findings, kind, label, severity, rawExample) {
  const example = rawExample ? maskMiddle(String(rawExample).replace(/\s+/g, ' ').trim()) : '';
  if (!findings.some((finding) => finding.kind === kind && finding.example === example)) {
    findings.push({ kind, label, severity, example });
  }
}

/**
 * Scans text for sensitive content.
 * @param {string} text
 * @returns {{verdict: 'ok'|'confirm'|'blocked', findings: {kind: string, label: string, severity: string, example: string}[]}}
 */
function scanText(text) {
  const findings = [];
  const sourceText = String(text || '');

  for (const rule of SIMPLE_RULES) {
    const match = rule.pattern.exec(sourceText);
    if (match) addFinding(findings, rule.kind, rule.label, rule.severity, match[0]);
  }

  // Passwords and secrets written as NAME=value.
  NAMED_SECRET_PATTERN.lastIndex = 0;
  let namedMatch;
  while ((namedMatch = NAMED_SECRET_PATTERN.exec(sourceText)) !== null) {
    const [, , openingQuote, value] = namedMatch;
    if (looksLikeSecretValue(value, openingQuote !== '')) {
      addFinding(findings, 'secret-value', 'A password or secret value', BLOCK, value);
    }
  }

  // Payment card numbers: right length, a real issuer range, and a valid checksum.
  CARD_CANDIDATE_PATTERN.lastIndex = 0;
  let cardMatch;
  while ((cardMatch = CARD_CANDIDATE_PATTERN.exec(sourceText)) !== null) {
    const digits = cardMatch[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && CARD_ISSUER_PATTERNS.some((issuer) => issuer.test(digits)) && passesLuhnCheck(digits)) {
      addFinding(findings, 'card-number', 'Payment card number', BLOCK, digits);
    }
  }

  // Letter-by-letter OCR ("P a SSWOrd") defeats plain matching, so also look at the text
  // with whitespace removed for labels and phrases.
  const compactLowerText = sourceText.toLowerCase().replace(/\s+/g, '');

  if (/aadhaar|aadhar|uidai/.test(compactLowerText) && /\b[2-9]\d{3}\s\d{4}\s\d{4}\b/.test(sourceText)) {
    const aadhaarMatch = /\b[2-9]\d{3}\s\d{4}\s\d{4}\b/.exec(sourceText);
    addFinding(findings, 'aadhaar', 'Aadhaar number', BLOCK, aadhaarMatch[0]);
  }
  if (/seedphrase|secretrecoveryphrase|recoveryphrase|mnemonic/.test(compactLowerText)) {
    addFinding(findings, 'recovery-phrase', 'A wallet recovery phrase', BLOCK, '');
  }

  // Softer signals: ask the user before anything is sent.
  if (!findings.some((finding) => finding.severity === BLOCK)) {
    if (compactLowerText.includes('password') || compactLowerText.includes('passcode')) {
      addFinding(findings, 'password-field', 'A password or sign-in field is visible', CONFIRM, '');
    }
    if (/onetimepassword|verificationcode|securitycode|recoverycode|backupcode|enterthecode|\botp\b/.test(compactLowerText) || /\botp\b/i.test(sourceText)) {
      addFinding(findings, 'one-time-code', 'A verification or one-time code', CONFIRM, '');
    }
  }

  const verdict = findings.some((finding) => finding.severity === BLOCK)
    ? 'blocked'
    : findings.length > 0
      ? 'confirm'
      : 'ok';
  return { verdict, findings: findings.slice(0, 8) };
}

module.exports = { scanText, assessWindowIdentity, passesLuhnCheck, BLOCK, CONFIRM };
