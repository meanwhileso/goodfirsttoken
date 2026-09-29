import { z } from 'zod';

// The small values every other schema is built from. GitHub's own rules set
// the shapes of logins, repos, and labels. Each one gives the same message
// for a wrong type and a wrong shape, so a problem always reads the same way.

const LOGIN = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?';
// A repo name can't be `.` or `..`, whatever follows it, like `#1` in an issue.
const REPO = `${LOGIN}/(?!\\.\\.?(?![A-Za-z0-9._-]))[A-Za-z0-9._-]{1,100}`;

function pattern(regex: RegExp, message: string) {
  return z.string({ error: message }).regex(regex, message);
}

/** A GitHub login: letters, digits, and hyphens, at most 39 characters. */
export const githubLogin = pattern(new RegExp(`^${LOGIN}$`), 'must be a GitHub login, like octocat');

/**
 * A GitHub account's numeric ID. A login can change, and a freed login can go
 * to someone else, so the ID is who a person is.
 */
export const githubId = z
  .int({ error: 'must be a numeric GitHub account ID' })
  .min(1, 'must be a numeric GitHub account ID');

/**
 * A repo's numeric GitHub ID. A repo keeps it through a rename or a
 * transfer, and a new repo made under an old name gets a new one.
 */
export const githubRepoId = z
  .int({ error: 'must be a numeric GitHub repo ID' })
  .min(1, 'must be a numeric GitHub repo ID');

/** A repository as `owner/name`. */
export const repoName = pattern(new RegExp(`^${REPO}$`), 'must be a repository as owner/name');

/** An issue or pull request as `owner/name#number`. */
export const issueRef = pattern(
  new RegExp(`^${REPO}#[1-9][0-9]{0,9}$`),
  'must be an issue as owner/name#number',
);

/** The harness an agent runs in, as a short lowercase name like `claude-code`. */
export const agentName = pattern(
  /^[a-z0-9][a-z0-9._-]{0,39}$/,
  'must be a short lowercase name, like claude-code',
);

/** An ID the server made up: a session, a claim, a queue item, or a feed event. */
export const id = pattern(/^[A-Za-z0-9_-]{1,64}$/, 'must be an ID the server gave out');

/** A full git commit SHA. */
export const commitSha = pattern(/^[0-9a-f]{40}$/, 'must be a full 40-character commit SHA');

/** A GitHub label name. GitHub allows at most 50 characters. */
export const labelName = z
  .string({ error: 'must be a label name' })
  .trim()
  .min(1, 'must not be empty')
  .max(50, 'must be at most 50 characters, the GitHub limit');

/** Text of at most `max` characters, trimmed, and not empty. */
export function trimmedText(max: number) {
  return z
    .string({ error: 'must be text' })
    .trim()
    .min(1, 'must not be empty')
    .max(max, `must be at most ${max.toLocaleString('en-US')} characters`);
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * `text` in at most `max` graphemes, what a reader counts as characters:
 * as it is when it fits, and otherwise cut to `max - 3` of them and ended
 * with `...`. A cut never splits a grapheme, like an emoji made of several
 * code points, or a letter and its accent.
 */
export function cutGraphemes(text: string, max: number): string {
  const parts = Array.from(graphemes.segment(text), ({ segment }) => segment);
  return parts.length > max ? `${parts.slice(0, max - 3).join('')}...` : text;
}

/**
 * Text as one line: each run of whitespace that holds a tab or a line break
 * becomes one space, and the ends are trimmed, in one pass over the text.
 */
export function foldLines(text: string): string {
  return text
    .split(/[\t\r\n]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ');
}

/**
 * One line of text, at most `max` characters once its line breaks fold.
 * Longer text than four times that is refused before it folds.
 */
export function oneLine(max: number, limit = `must be at most ${String(max)} characters`) {
  const raw = 4 * max;
  return z
    .string({ error: 'must be text' })
    .max(raw, { error: `must be at most ${String(raw)} characters before its line breaks fold`, abort: true })
    .overwrite(foldLines)
    .min(1, 'must not be empty')
    .max(max, limit);
}

/**
 * The model an agent used, like `claude-opus-5-5`. It goes into a commit
 * trailer, so tabs and line breaks fold into single spaces.
 */
export const modelName = oneLine(100);

/** A time in UTC, as ISO 8601, like `2026-09-26T13:02:00.000Z`. */
export const isoTime = z.iso.datetime({ error: 'must be an ISO 8601 time in UTC' });

/** A link a person gave us, which must use https. */
export const httpsUrl = z.url({ protocol: /^https$/, error: 'must be an https link' });

/** A link the server gives out. Local development serves plain http. */
export const webUrl = z.url({ protocol: /^https?$/, error: 'must be an http or https link' });

/** A whole number from `min` to `max`. */
export function wholeNumber(min: number, max: number) {
  const message = `must be a whole number from ${String(min)} to ${String(max)}`;
  return z.int({ error: message }).min(min, message).max(max, message);
}

/** A count of things, zero or more. */
export const count = z.int().min(0);

/** A time as whole milliseconds since the epoch, the way a Durable Object alarm takes it. */
export const epochMs = z
  .int({ error: 'must be a time in whole milliseconds since the epoch' })
  .min(0, 'must be a time in whole milliseconds since the epoch');

/** A pull request on GitHub. */
export const prRefSchema = z.object({
  repo: repoName,
  number: z.int({ error: 'must be a PR number' }).min(1, 'must be a PR number'),
  url: webUrl,
});
export type PrRef = z.infer<typeof prRefSchema>;
