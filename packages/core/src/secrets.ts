// Lines agents post are public (spec section 8). Before the server stores or
// shows one, it replaces anything that looks like a key or a token with
// `[redacted]`. The patterns follow the published formats of common keys and
// tokens, or need a name that says a value is secret, so ordinary text,
// paths, and commit SHAs pass through. The list is in docs/how-it-works.md,
// and a new pattern goes there too.
//
// No pattern has two unbounded repeats in a row that can match the same
// characters. The scan for named values reads a value again when its name
// isn't secret, so a line like `a=b=c=...` takes time that grows with the
// square of its length. The room strips lines of 200 characters or fewer.

/** What a key or token is replaced with. */
export const REDACTED = '[redacted]';

// Patterns whose whole match is the secret.
const WHOLE: readonly RegExp[] = [
  // GitHub: classic personal access tokens (ghp_), OAuth tokens (gho_),
  // user-to-server tokens (ghu_), server-to-server tokens (ghs_), and refresh
  // tokens (ghr_).
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  // GitHub fine-grained personal access tokens.
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // GitLab personal access tokens.
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  // OpenAI and Anthropic API keys, like sk-proj-... and sk-ant-....
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // Stripe secret and restricted keys, and webhook signing secrets.
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bwhsec_[A-Za-z0-9+/=]{20,}/g,
  // AWS access key IDs, long-lived and temporary.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // Google API keys, OAuth client secrets, and OAuth access tokens.
  /\bAIza[A-Za-z0-9_-]{35}/g,
  /\bGOCSPX-[A-Za-z0-9_-]{20,}/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  // Slack tokens, and Slack app-level tokens.
  /\bx(?:ox[abeoprs]|app)-[A-Za-z0-9-]{10,}/g,
  // Hugging Face tokens.
  /\bhf_[A-Za-z0-9]{30,}/g,
  // npm access tokens.
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  // SendGrid API keys: SG., an ID, a dot, and the secret.
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  // JSON Web Tokens: three base64url parts, the first two JSON objects.
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // A private key in PEM or PGP form: its BEGIN line and everything after
  // it. A posted line is too short to hold a whole key, so no END line is
  // needed.
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*/g,
];

// Patterns that keep their first group, like the scheme of an Authorization
// header or the host of a link, and replace the rest.
const AFTER_FIRST_GROUP: readonly RegExp[] = [
  // The credentials in an Authorization header, after Bearer, Basic, or
  // token. The word Bearer alone is not enough, since it is ordinary text.
  /\b(Authorization["']?[ \t]*[:=][ \t]*["']?(?:Bearer|Basic|token)[ \t]+)[A-Za-z0-9._~+/-]{16,}=*/gi,
  // The password in a link, like https://user:password@host.
  /(\/\/[^\s:/@]+:)[^\s/@]+(?=@)/g,
  // The secret path of a Slack or Discord webhook link.
  /(hooks\.slack\.com\/(?:services|workflows|triggers)\/)[A-Za-z0-9_/-]+/g,
  /((?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/)[0-9]+\/[A-Za-z0-9_-]+/g,
];

// A value given to a name with = or :, like GITHUB_TOKEN=..., "password":
// "...", or ?token=... in a link. The name starts where a run of name
// characters starts.
const ASSIGNMENT = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)(["']?[ \t]*[:=][ \t]*["']?)([^\s"',;&]+)/g;
// A value after a flag and a space, like --password hunter2. A value that
// starts with - is the next flag.
const FLAG = /(?<![A-Za-z0-9_-])(--[A-Za-z][A-Za-z0-9-]*)([ \t]+)(?!-)([^\s"',;&]+)/g;

// Names whose value is a password or a secret: 6 or more characters.
const PASSWORD_NAME = /(?:passw(?:or)?d|secret)$/i;
const MIN_PASSWORD = 6;
// Names whose value is a token or one of these keys. These names also label
// ordinary values, like `expected token: STRING_LITERAL` from a parser, so
// the value needs 8 or more characters with a letter and a digit.
const TOKEN_NAME = /(?:token|(?:api|access|secret|private|signing|encryption)[_-]?key)$/i;
const MIN_TOKEN = 8;
// Any other key: a name that ends in _key or -key, or in Key after a
// lowercase letter or digit, like RAILS_MASTER_KEY or masterKey. Many such
// names hold ordinary values, like `sort_key: created_at_desc`, so the value
// needs 16 or more characters with a letter and a digit.
const KEY_NAME = /[_-]key$/i;
const CAMEL_KEY_NAME = /[a-z0-9]Key$/;
const MIN_KEY = 16;

// Words that say what a field is or whether it is set, and don't give its
// value, like `password: required` or `the --secret parameter`.
const FIELD_WORDS = new Set([
  'argument',
  'boolean',
  'changed',
  'default',
  'disabled',
  'enabled',
  'hidden',
  'masked',
  'missing',
  'needed',
  'option',
  'optional',
  'parameter',
  'placeholder',
  'provided',
  'redacted',
  'removed',
  'required',
  'rotated',
  'setting',
  'string',
  'support',
  'switch',
  'updated',
]);
// A reference in code, which names a value and doesn't hold it: a dotted
// path like config.apiKeyV2, or a constant in capitals with an underscore,
// like T_STRING2.
const CODE_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const CONSTANT = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
// Closing punctuation after a value belongs to the text around it.
const CLOSING = new Set([')', ']', '}', '>', '.', '!']);

function looksRandom(value: string, min: number): boolean {
  return value.length >= min && /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

function isSecret(name: string, value: string): boolean {
  if (FIELD_WORDS.has(value.toLowerCase()) || CODE_PATH.test(value) || CONSTANT.test(value)) return false;
  if (PASSWORD_NAME.test(name)) return value.length >= MIN_PASSWORD;
  if (TOKEN_NAME.test(name)) return looksRandom(value, MIN_TOKEN);
  if (KEY_NAME.test(name) || CAMEL_KEY_NAME.test(name)) return looksRandom(value, MIN_KEY);
  return false;
}

/**
 * Replaces each secret value that `pattern` finds after a name. When the
 * name or value isn't secret, the scan goes on from the start of the value,
 * so a secret inside it is found too, like `?api_key=...` in a link or
 * `GITHUB_TOKEN=...` after `env:`.
 */
function replaceNamed(text: string, pattern: RegExp): string {
  let out = '';
  let copied = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const [whole, name = '', separator = '', found = ''] = match;
    let value = found;
    while (value.length > 0 && CLOSING.has(value.slice(-1))) value = value.slice(0, -1);
    const valueAt = match.index + name.length + separator.length;
    if (isSecret(name, value)) {
      out += text.slice(copied, valueAt) + REDACTED;
      copied = valueAt + value.length;
      pattern.lastIndex = match.index + whole.length;
    } else {
      pattern.lastIndex = valueAt;
    }
  }
  return out + text.slice(copied);
}

/**
 * `text` with every key or token in it replaced with `[redacted]`. Text that
 * holds none comes back as it was.
 */
export function stripSecrets(text: string): string {
  let out = text;
  for (const pattern of WHOLE) out = out.replace(pattern, REDACTED);
  for (const pattern of AFTER_FIRST_GROUP) out = out.replace(pattern, `$1${REDACTED}`);
  return replaceNamed(replaceNamed(out, ASSIGNMENT), FLAG);
}
