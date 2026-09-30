import { HIDDEN_CHARACTER } from './characters';

// Lines agents post are public (spec section 8). Before the server stores or
// shows one, it replaces anything that looks like a key or a token with
// `[redacted]`. The patterns follow the published formats of common keys and
// tokens, or need a name that says a value is secret. The list is in
// docs/how-it-works.md, and a new pattern goes there too.
//
// The rule: when in doubt, redact. A redacted ordinary word costs little,
// and a leaked secret costs a lot. A value is left alone only where it can't
// plausibly be a credential.
//
// No pattern has two unbounded repeats in a row that can match the same
// characters. The scan for named values reads a value again when its name
// isn't secret, so a line like `a=b=c=...` takes time that grows with the
// square of its length. That is why stripSecrets refuses text longer than
// MAX_STRIP_LENGTH.

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
  // Discord bot tokens: the account's numeric ID in base64, which starts
  // with M, N, or O and runs 23 to 28 characters, a dot, 6 characters, a
  // dot, and 27 to 38 characters.
  /(?<![\w-])[MNO][\w-]{22,27}\.[\w-]{6}\.[\w-]{27,38}(?![\w-])/g,
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
// needs 16 or more characters with a letter and a digit. A value that long
// is replaced even under a name that labels no secret, like
// `row_key=20260927T120000Z1`, since it could be one.
const KEY_NAME = /[_-]key$/i;
const CAMEL_KEY_NAME = /[a-z0-9]Key$/;
const MIN_KEY = 16;

// Words that say a password field is set or not, and can't plausibly be the
// password, like `password: required`, or that name the flag itself, like
// `the --secret parameter`. Other names get no such words: a value of the
// right shape under them is replaced, whatever it says.
const NOT_A_PASSWORD = new Set(['argument', 'hidden', 'masked', 'missing', 'option', 'optional', 'parameter', 'required']);
// Closing punctuation after a value belongs to the text around it.
const CLOSING = new Set([')', ']', '}', '>', '.', '!']);

function looksRandom(value: string, min: number): boolean {
  return value.length >= min && /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

function isSecret(name: string, value: string): boolean {
  // An earlier pattern already replaced it.
  if (value.startsWith(REDACTED.slice(0, -1))) return false;
  if (PASSWORD_NAME.test(name)) return value.length >= MIN_PASSWORD && !NOT_A_PASSWORD.has(value.toLowerCase());
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

/** The longest text `stripSecrets` takes. */
export const MAX_STRIP_LENGTH = 1000;

/**
 * `text` with every key or token in it replaced with `[redacted]`. Text that
 * holds none comes back as it was.
 *
 * For lines up to 1,000 characters, like a post, a job, or a release
 * reason. The scan for named values takes time that grows with the square
 * of the length for a line like `a=b=c=...`, so longer text is refused with
 * a RangeError. Cut it first.
 */
export function stripSecrets(text: string): string {
  if (text.length > MAX_STRIP_LENGTH) {
    throw new RangeError(`stripSecrets takes at most ${String(MAX_STRIP_LENGTH)} characters.`);
  }
  let out = text;
  for (const pattern of WHOLE) out = out.replace(pattern, REDACTED);
  for (const pattern of AFTER_FIRST_GROUP) out = out.replace(pattern, `$1${REDACTED}`);
  return replaceNamed(replaceNamed(out, ASSIGNMENT), FLAG);
}

const KEY_BEGINS = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
const KEY_ENDS = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;

// The characters a person reading the text can't see, which foldLine drops.
const HIDDEN = new RegExp(HIDDEN_CHARACTER.source, 'gu');

// How long the end of one piece of a long line, read again with the next
// piece, can be, and so how long a piece is.
const TAIL_MAX = 200;
const PIECE_MAX = MAX_STRIP_LENGTH - TAIL_MAX;
// How many words the end of a piece holds: enough for a name and its value,
// like `password: x`, or `Authorization: Bearer x`, to be read together.
const TAIL_WORDS = 3;

// The last few words of a piece, with the whitespace between them, as its
// parts, alternating words and whitespace, give them.
function tailOf(parts: readonly string[]): string {
  let tail = '';
  let words = 0;
  for (let i = parts.length - 1; i >= 0 && words < TAIL_WORDS; i--) {
    const part = parts[i] ?? '';
    if (tail.length + part.length > TAIL_MAX) break;
    tail = part + tail;
    if (/\S/.test(part)) words += 1;
  }
  return tail;
}

// One line of any length, stripped as stripSecrets strips a short one. A
// longer line is read in pieces cut at whitespace, and each piece is read
// together with the last few words of the one before it, so a name and its
// value, or `Authorization: Bearer` and its token, are read together
// wherever the cut falls. A key or token with no whitespace in it is never
// cut. A run with no whitespace longer than a piece could hide one, and
// can't be read in pieces, so it is replaced whole.
function stripLine(line: string): string {
  if (line.length <= MAX_STRIP_LENGTH) return stripSecrets(line);
  let out = '';
  let piece: string[] = [];
  let length = 0;
  let tail = '';
  const flush = () => {
    if (piece.length === 0) return;
    const text = piece.join('');
    const both = stripSecrets(tail + text);
    // The end of the last piece stays as it was, unless it held a secret,
    // which that piece already replaced. Then this piece is read alone.
    out += both.startsWith(tail) ? both.slice(tail.length) : stripSecrets(text);
    tail = tailOf(piece);
    piece = [];
    length = 0;
  };
  for (const part of line.split(/(\s+)/)) {
    if (part.length > PIECE_MAX) {
      flush();
      out += /^\s/.test(part) ? part : REDACTED;
      tail = '';
      continue;
    }
    if (length + part.length > PIECE_MAX) flush();
    piece.push(part);
    length += part.length;
  }
  flush();
  return out;
}

/**
 * `text` of any length, like a PR description, with every key or token in it
 * replaced with `[redacted]`, as stripSecrets strips one line.
 *
 * - Each line is read without the characters a person can't see, the ones
 *   foldLine drops, like a zero-width space, so none can split a token.
 *   Line breaks, tabs, and spaces stay. A line with no secret keeps them
 *   all, like the joiners inside an emoji.
 * - It reads the text line by line. A line longer than stripSecrets takes
 *   is read in pieces cut at whitespace, each with the last few words of the
 *   piece before it.
 * - A private key is replaced from its BEGIN through its END, on one line
 *   or across lines, or through the end of the text when it has no END, since
 *   its body can hold spaces and span lines.
 *
 * Text that holds no secret comes back as it was.
 */
export function stripSecretsFromText(text: string): string {
  let inKey = false;
  return text
    .split('\n')
    .map((raw) => {
      const seen = raw.replace(HIDDEN, '');
      const wasInKey = inKey;
      let line = seen;
      if (inKey) {
        const end = KEY_ENDS.exec(line);
        if (end === null) return REDACTED;
        inKey = false;
        line = REDACTED + line.slice(end.index + end[0].length);
      }
      // A key begun on this line, with its END here or on a later line.
      for (let begin = KEY_BEGINS.exec(line); begin !== null; begin = KEY_BEGINS.exec(line)) {
        const rest = line.slice(begin.index + begin[0].length);
        const end = KEY_ENDS.exec(rest);
        if (end === null) {
          inKey = true;
          line = line.slice(0, begin.index) + REDACTED;
          break;
        }
        line = line.slice(0, begin.index) + REDACTED + rest.slice(end.index + end[0].length);
      }
      const stripped = stripLine(line);
      // A line with nothing to redact keeps the characters it was written with.
      return !wasInKey && !inKey && stripped === seen ? raw : stripped;
    })
    .join('\n');
}
