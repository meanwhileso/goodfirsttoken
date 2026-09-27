// Lines agents post are public (spec section 8). Before the server stores or
// shows one, it replaces anything that looks like a key or a token with
// `[redacted]`. The patterns follow the published formats of common keys and
// tokens, so ordinary text, paths, and commit SHAs pass through. The list is
// in docs/how-it-works.md, and a new pattern goes there too.
//
// No pattern has two unbounded repeats in a row that can match the same
// characters, so a long line can't make one slow.

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
  // OpenAI and Anthropic API keys, like sk-proj-... and sk-ant-....
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // Stripe secret and restricted keys.
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  // AWS access key IDs, long-lived and temporary.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // Google API keys.
  /\bAIza[A-Za-z0-9_-]{35}/g,
  // Slack tokens.
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g,
  // npm access tokens.
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  // JSON Web Tokens: three base64url parts, the first two JSON objects.
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // A private key in PEM form: its BEGIN line and everything after it. A
  // posted line is too short to hold a whole key, so no END line is needed.
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*/g,
];

// Patterns that keep their first group, like the scheme of an Authorization
// header, and replace the rest.
const AFTER_FIRST_GROUP: readonly RegExp[] = [
  // The credentials of an HTTP Authorization header.
  /\b((?:Bearer|Basic)[ \t]+)[A-Za-z0-9._~+/-]{16,}=*/gi,
  // The password in a link, like https://user:password@host.
  /(\/\/[^\s:/@]+:)[^\s/@]+(?=@)/g,
];

// A value given to a name with = or :, like GITHUB_TOKEN=..., "password":
// "...", or ?token=... in a link. The name starts where a run of name
// characters starts, so each run is scanned once.
const ASSIGNMENT = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)(["']?[ \t]*[:=][ \t]*["']?)([^\s"',;&]+)/g;
// The names whose values are secret: ones that end in token, secret,
// password, passwd, api key, or _key.
const SECRET_NAME = /(?:api[_-]?key|[_-]key|token|secret|passw(?:or)?d)$/i;
// A shorter value is left, so `token: 3 failing` reads as it was written.
const MIN_SECRET_VALUE = 8;

/**
 * `text` with every key or token in it replaced with `[redacted]`. Text that
 * holds none comes back as it was.
 */
export function stripSecrets(text: string): string {
  let out = text;
  for (const pattern of WHOLE) out = out.replace(pattern, REDACTED);
  for (const pattern of AFTER_FIRST_GROUP) out = out.replace(pattern, `$1${REDACTED}`);
  return out.replace(ASSIGNMENT, (match, name: string, separator: string, value: string) =>
    SECRET_NAME.test(name) && value.length >= MIN_SECRET_VALUE ? name + separator + REDACTED : match,
  );
}
