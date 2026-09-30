import { z } from 'zod';
import { foldUntrusted } from './characters';
import { epochMs, githubLogin, id, webUrl } from './primitives';

// Follow-ups (spec section 7, steps 2 and 7): what a reviewer wrote on a
// donor's open PR, which the PR job reads from GitHub and the donor's next
// start_session and my_work bring back. A reviewer's text is untrusted repo
// text. It is folded to one line and cut before it is stored, and the tools
// quote it as the reviewer's words.

/** The longest a reviewer's words are kept and shown, in graphemes, what a reader counts as characters. */
export const MAX_FOLLOW_UP_TEXT = 1000;

/** The longest file path a follow-up keeps, in graphemes. */
export const MAX_FOLLOW_UP_PATH = 4096;

/** The most follow-ups start_session and my_work list at once, oldest first. */
export const MAX_FOLLOW_UPS = 20;

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
 * A reviewer's review or comment on a claim's open PR, as the PR job read
 * it. It waits for the donor until a submit to the claim lands after a tool
 * showed it to their agent.
 */
export const followUpRecordSchema = z.object({
  claimId: id,
  /** GitHub's node ID of the review or the review comment, which says whether it was read before. */
  commentId: z.string().min(1).max(100),
  reviewer: githubLogin,
  body: followUpText,
  /** The file an inline comment is on, folded to one line too, or null for a review's own text. */
  path: followUpPath.nullable(),
  /** The review or comment on GitHub. */
  url: webUrl,
  /** When the reviewer wrote it, as GitHub gives it. */
  writtenAt: epochMs,
  /** When the PR job read it. */
  readAt: epochMs,
  /** When start_session or my_work first showed it, or null before that. */
  shownAt: epochMs.nullable(),
  /** When a submit to the claim after it was shown answered it, or null. */
  answeredAt: epochMs.nullable(),
});
export type FollowUpRecord = z.infer<typeof followUpRecordSchema>;
