// Safety net for Privacy Guard answers. The model is told never to repeat secrets,
// but a privacy tool must not depend on that alone, so any secret-looking value in
// the answer is masked here before it is shown or copied.

/** Keeps the first two and last two characters, e.g. "wJalrXUt...EY" -> "wJ...EY". */
function maskMiddle(value) {
  if (value.length <= 6) return '***';
  return `${value.slice(0, 2)}...${value.slice(-2)}`;
}

const SECRET_NAME_KEYWORDS = 'password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential';

// 1. NAME=value or NAME: value where the name looks secret (DB_PASSWORD=..., token: ...).
const NAMED_SECRET_PATTERN = new RegExp(
  `(\\b[\\w.-]*(?:${SECRET_NAME_KEYWORDS})[\\w.-]*\\s*[=:]\\s*)(["']?)([^\\s"',;]{4,})`,
  'gi'
);

// 2. Well-known key formats (AWS, Google, GitHub, OpenAI-style, Slack).
const KNOWN_KEY_FORMAT_PATTERN = /\b(?:AKIA|ASIA|AIza|ghp_|gho_|ghs_|github_pat_|sk-|xox[abprs]-)[A-Za-z0-9_-]{8,}/g;

// 3. Payment-card-like digit runs (13-19 digits, optionally spaced or dashed).
const CARD_NUMBER_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

// 4. Any other long token that mixes letters and digits (api keys, hashes, jwt parts).
const LONG_MIXED_TOKEN_PATTERN = /\b(?=[A-Za-z0-9_\-/+=]*\d)(?=[A-Za-z0-9_\-/+=]*[A-Za-z])[A-Za-z0-9_\-/+=]{20,}\b/g;

function redactSensitiveValues(answerText) {
  return answerText
    .replace(NAMED_SECRET_PATTERN, (match, namePrefix, openingQuote, secretValue) => {
      // Already masked values contain "...": leave them.
      if (secretValue.includes('...')) return match;
      return `${namePrefix}${openingQuote}${maskMiddle(secretValue)}`;
    })
    .replace(KNOWN_KEY_FORMAT_PATTERN, (keyValue) => maskMiddle(keyValue))
    .replace(CARD_NUMBER_PATTERN, (digitRun) => maskMiddle(digitRun.replace(/[ -]/g, '')))
    .replace(LONG_MIXED_TOKEN_PATTERN, (token) => maskMiddle(token));
}

module.exports = { redactSensitiveValues, maskMiddle };
