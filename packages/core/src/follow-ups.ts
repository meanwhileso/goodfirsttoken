import { z } from 'zod';
import { foldUntrusted, untrustedLine } from './characters';
import { epochMs, id, webUrl } from './primitives';

// Follow-ups (spec section 7, steps 2 and 7, and docs/specs/follow-through.md):
// what a maintainer or a review bot wrote on a donor's open PR, and what
// GitHub shows of its checks and whether it can merge, which the PR job
// reads from GitHub and the donor's next start_session and my_work bring
// back. A reviewer's text is untrusted repo text. It is folded to one line
// and cut before it is stored, and the tools quote it as the reviewer's
// words.

/** The longest a reviewer's words are kept and shown, in graphemes, what a reader counts as characters. */
export const MAX_FOLLOW_UP_TEXT = 1000;

/** The longest file path a follow-up keeps, in graphemes. */
export const MAX_FOLLOW_UP_PATH = 4096;

/** The most follow-ups start_session and my_work list at once, oldest first. */
export const MAX_FOLLOW_UPS = 20;

/** The newest comments in a PR's conversation the PR job reads. */
export const CONVERSATION_READ = 30;

/** The most failing checks a checks follow-up names. */
export const MAX_FAILING_CHECKS = 10;

/**
 * What a follow-up is: a review that comments or asks for changes, a
 * comment on a line, a comment in the PR's conversation, checks on the PR's
 * head that failed, or a conflict with the PR's base.
 */
export const followUpKindSchema = z.enum(['review', 'line', 'conversation', 'checks', 'conflict']);
export type FollowUpKind = z.infer<typeof followUpKindSchema>;

/** Who wrote a follow-up: a maintainer, or a review bot, a GitHub App's account. Checks and conflicts have no author. */
export const followUpAuthorKindSchema = z.enum(['maintainer', 'bot']);
export type FollowUpAuthorKind = z.infer<typeof followUpAuthorKindSchema>;

/**
 * Who wrote a follow-up: a person's GitHub login, or a GitHub App's, as
 * GraphQL gives it, with no `[bot]` on the end. An app's login is its
 * slug, letters, digits, and hyphens, which can run longer than a
 * person's.
 */
export const followUpAuthor = z
  .string({ error: 'must be a GitHub login, like octocat' })
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/, 'must be a GitHub login, like octocat');

/**
 * Where a follow-up stands: `open` until an agent sorts it,
 * `waiting_reviewer` once the agent replied or pushed and waits for the
 * reviewer, `waiting_donor` once the agent asked the donor, who hasn't
 * answered, and `settled` once nothing more is needed.
 */
export const followUpStateSchema = z.enum(['open', 'waiting_reviewer', 'waiting_donor', 'settled']);
export type FollowUpState = z.infer<typeof followUpStateSchema>;

/**
 * Why a follow-up settled: a submit `fixed` it, the agent `replied` and
 * needs nothing more, it needed `no_change`, its reviewer `resolved` the
 * thread, or a new read `superseded` checks or a conflict.
 */
export const followUpOutcomeSchema = z.enum(['fixed', 'replied', 'no_change', 'resolved', 'superseded']);
export type FollowUpOutcome = z.infer<typeof followUpOutcomeSchema>;

/** The outcomes an agent sets with sort_follow_ups. A submit sets `fixed`, and a read sets `superseded`. */
export const sortedOutcomeSchema = z.enum(['replied', 'no_change', 'resolved']);

/** The states an agent sets with sort_follow_ups. Only a read makes a follow-up `open`. */
export const sortedStateSchema = z.enum(['waiting_reviewer', 'waiting_donor', 'settled']);

/** The longest question for the donor a follow-up keeps, in characters. */
export const MAX_FOLLOW_UP_QUESTION = 2000;

/**
 * The agent's question for the donor about a follow-up, folded to one line.
 * It quotes repo text, so it folds the way a posted line does.
 */
export const followUpQuestion = untrustedLine(MAX_FOLLOW_UP_QUESTION);

/**
 * What names a follow-up to the tools, as its record's `commentId`:
 * GitHub's node ID of the review or comment, the head's SHA for checks, or
 * `head:base` for a conflict. It is unique on its claim.
 */
export const followUpId = z
  .string({ error: 'must be a follow-up ID, as start_session and my_work list it' })
  .min(1, 'must be a follow-up ID, as start_session and my_work list it')
  .max(200, 'must be a follow-up ID, as start_session and my_work list it');

/** A reviewer's text, as the follow-ups keep it. */
export const followUpText = z
  .string({ error: 'must be text' })
  .min(1, 'must not be empty')
  .refine(
    (text) => foldUntrusted(text, MAX_FOLLOW_UP_TEXT) === text,
    `must be one folded line of at most ${String(MAX_FOLLOW_UP_TEXT)} graphemes`,
  );

/** The file a comment on a line is on, as the follow-ups keep it. It is repo text too. */
export const followUpPath = z
  .string({ error: 'must be text' })
  .min(1, 'must not be empty')
  .refine(
    (path) => foldUntrusted(path, MAX_FOLLOW_UP_PATH) === path,
    `must be one folded line of at most ${String(MAX_FOLLOW_UP_PATH)} graphemes`,
  );

/**
 * A maintainer's or a review bot's review or comment on a claim's open PR,
 * or its failed checks or conflict, as the PR job read it, and where it
 * stands. It is open until the donor's agent sorts it or a submit settles
 * it.
 */
export const followUpRecordSchema = z.object({
  claimId: id,
  /**
   * What says whether it was read before: GitHub's node ID of the review or
   * comment, the head's SHA for checks, and the head's and the base's SHAs,
   * as `head:base`, for a conflict.
   */
  commentId: followUpId,
  kind: followUpKindSchema,
  /** Who wrote it, or null for checks and a conflict, which GitHub reports. */
  reviewer: followUpAuthor.nullable(),
  /** A maintainer or a bot, or null with no author. */
  authorKind: followUpAuthorKindSchema.nullable(),
  /**
   * The reviewer's text. For checks, GitHub's combined state of the head's
   * checks and the names of the failing ones, which are repo text, like
   * `FAILURE: test, lint`. For a conflict, GitHub's mergeable state and the
   * base branch, like `CONFLICTING with main`.
   */
  body: followUpText,
  /** The file an inline comment is on, folded to one line too, or null for a review's own text. */
  path: followUpPath.nullable(),
  /** The review or comment on GitHub, the PR's checks on its head, or the PR for a conflict. */
  url: webUrl,
  /** When the reviewer wrote it, as GitHub gives it, or for checks and a conflict when the PR job first saw it. */
  writtenAt: epochMs,
  /** When the PR job read it. */
  readAt: epochMs,
  /** When start_session or my_work first showed it, or null before that. */
  shownAt: epochMs.nullable(),
  /** When it settled, by a submit, an agent's sort, or a read that superseded it, or null while it is not settled. */
  answeredAt: epochMs.nullable(),
  state: followUpStateSchema,
  /** Why it settled, or null while it is not settled. */
  outcome: followUpOutcomeSchema.nullable(),
  /** The agent's question for the donor while it waits for them, or null. */
  question: followUpQuestion.nullable(),
  /** The agent's reply on GitHub, as it recorded it, or null. A follow-up settled as `replied` has one. */
  replyUrl: webUrl.nullable(),
});
export type FollowUpRecord = z.infer<typeof followUpRecordSchema>;
