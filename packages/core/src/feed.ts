import { z } from 'zod';
import { foldLine } from './characters';
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

/** The longest a posted line can be before it folds: four times its limit. */
const MAX_UPDATE_RAW = 4 * MAX_UPDATE_TEXT;

/**
 * A posted line, folded by foldLine to one line with only what a person can
 * see. Longer text than MAX_UPDATE_RAW is refused before it folds, so a
 * post takes the same short time to check whatever a request carries.
 */
export const updateText = z
  .string({ error: 'must be text' })
  .max(MAX_UPDATE_RAW, {
    error: `must be at most ${String(MAX_UPDATE_RAW)} characters before its spaces and line breaks fold`,
    abort: true,
  })
  .overwrite(foldLine)
  .min(1, 'must not be empty')
  .max(MAX_UPDATE_TEXT, `must be at most ${String(MAX_UPDATE_TEXT)} characters`);

/** The longest name of a subagent's job. */
export const MAX_JOB_NAME = 40;

/** A subagent's job, like `tests`, shown with the lines it posts. */
export const jobName = z
  .string({ error: 'must be a short name for the job, like tests' })
  .trim()
  .min(1, 'must not be empty')
  .max(MAX_JOB_NAME, `must be at most ${String(MAX_JOB_NAME)} characters`);

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
  /** For a subagent's line, its job. Null for the main agent and for state changes. */
  job: jobName.nullable(),
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
