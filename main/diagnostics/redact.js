// Removes secrets from text written to the IDE log and from the diagnostic data archive: passwords, tokens, API
// keys and safeStorage blobs. Keys whose name says they hold a secret are blanked whatever their value; free text is
// scrubbed of well-known token shapes and of `password=...`-style assignments.
const MASK = '<redacted>';

const SECRET_KEY = /pass(?:word|wd|phrase)?|secret|token|api[-_. ]?key|apikey|authorization|\bauth\b|auth[-_.]?(?:token|key)|credential|private[-_. ]?key|cookie|session[-_. ]?id|bearer|encrypted|safe[-_. ]?storage|cipher/i;

const TEXT_PATTERNS = [
  // Anthropic, OpenAI, GitHub, GitLab, Slack, AWS, Google, Hugging Face, Stripe, npm.
  /\bsk-(ant-)?[A-Za-z0-9_-]{16,}/g,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];
// Bearer/Basic auth headers, key=value or "key": "value" assignments, and URL credentials (scheme://user:pass@host).
const AUTH_HEADER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const ASSIGNMENT = new RegExp(`(["']?[\\w.-]*(?:${SECRET_KEY.source})[\\w.-]*["']?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&}]+)`, 'gi');
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;

// Values known to be secret whatever their shape, such as the values loaded from .env files (main/dotenv.js).
// Booleans and short numbers are left alone: masking every "true" in the log would hide nothing worth hiding.
let knownSecrets = [];
function addSecretValues(values) {
  const fresh = values.filter((v) => typeof v === 'string' && v.length >= 4 && !/^(true|false|yes|no|on|off|null|none|\d{1,5})$/i.test(v) && !knownSecrets.includes(v));
  if (fresh.length) knownSecrets = [...knownSecrets, ...fresh].sort((a, b) => b.length - a.length);
}

function scrubText(text) {
  let s = String(text);
  for (const v of knownSecrets) if (s.includes(v)) s = s.split(v).join(MASK);
  for (const re of TEXT_PATTERNS) s = s.replace(re, MASK);
  return s
    .replace(AUTH_HEADER, (_m, kind) => `${kind} ${MASK}`)
    .replace(URL_CREDENTIALS, `$1${MASK}@`)
    .replace(ASSIGNMENT, (m, head, value) => (/^["']?(<redacted>|\d*)["']?$/.test(value) ? m : `${head}${MASK}`));
}

// A long unbroken run of base64/hex characters mixing letters and digits: an encrypted blob or a key.
const looksLikeBlob = (s) => s.length >= 32 && /^[A-Za-z0-9+/=_-]+$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s);

// A deep copy of a settings-like object with every secret replaced by "<redacted>".
function redactObject(value, key = '') {
  if (key && SECRET_KEY.test(key)) return value === '' || value == null ? value : MASK;
  if (Array.isArray(value)) return value.map((v) => redactObject(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactObject(v, k)]));
  }
  if (typeof value === 'string') return looksLikeBlob(value) ? MASK : scrubText(value);
  return value;
}

module.exports = { MASK, SECRET_KEY, scrubText, redactObject, addSecretValues };
