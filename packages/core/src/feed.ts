import { z } from 'zod';
import { untrustedLine } from './characters';
import { agentName, githubId, githubLogin, id, isoTime, issueRef, repoName } from './primitives';

// Live feed events (spec section 8). The issue room makes each one, and sends
// it on the feed queue to the repo, person, and homepage feeds, which store
// and stream it.

/**
 * What an event records.
 *
 * - `update`: a line the agent posted.
 * - `claimed`, `paused`, `submitted`, `pr_opened`, `released`, `expired`:
 *   the claim changed state.
 * - `pr_merged`, `pr_closed`: the claim's PR merged, or closed without merging.
 */
export const feedEventKinds = [
  'claimed',
  'update',
  'paused',
  'submitted',
  'pr_opened',
  'released',
  'expired',
  'pr_merged',
  'pr_closed',
] as const;
export const feedEventKindSchema = z.enum(feedEventKinds);
export type FeedEventKind = z.infer<typeof feedEventKindSchema>;

/** The longest line an agent can post. */
export const MAX_UPDATE_TEXT = 200;

/**
 * A posted line, folded by foldLine to one line with only what a person can
 * see, and refused when it is longer than four times its limit before it
 * folds.
 */
export const updateText = untrustedLine(MAX_UPDATE_TEXT);

/** The longest name of a subagent's job. */
export const MAX_JOB_NAME = 40;

/**
 * A subagent's job, like `tests`, shown with the lines it posts. It reaches
 * the public feeds, so it folds the way a posted line does.
 */
export const jobName = untrustedLine(MAX_JOB_NAME, 'must be a short name for the job, like tests');

export const feedEventSchema = z.object({
  /** Unique across the whole site, so a feed can drop an event it already has. */
  id,
  time: isoTime,
  /** The claimant's GitHub login. */
  user: githubLogin,
  agent: agentName,
  issue: issueRef,
  /** The claim the event belongs to. */
  claim: id,
  kind: feedEventKindSchema,
  /**
   * For a subagent's line, its job. Null for the main agent and for state
   * changes. A post folds it by jobName, and an event stored before jobs
   * were folded keeps its job as it was given, so it is checked the way it
   * was then.
   */
  job: z.string().trim().min(1).max(MAX_JOB_NAME).nullable(),
  /** One line. Server lines, like a release with its reason, can run longer than a post. */
  text: z.string().min(1).max(500),
});
export type FeedEvent = z.infer<typeof feedEventSchema>;

/**
 * The UTC day of a time, like 2026-09-27, from milliseconds since the epoch
 * or an ISO 8601 time. A feed counts its events by the day they happened.
 */
export function utcDay(time: number | string): string {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * A message on the feed queue: an event from an issue room, with the facts
 * about its claim that pick the feeds it goes to. The event carries neither.
 */
export const feedMessageSchema = z.object({
  event: feedEventSchema,
  /** The claimant's numeric GitHub ID, which keys their feed and says whether they are blocked. */
  githubId,
  /** The project's code repo, which keys the project's feed. */
  project: repoName,
});
export type FeedMessage = z.infer<typeof feedMessageSchema>;
