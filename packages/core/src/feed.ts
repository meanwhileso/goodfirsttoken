import { z } from 'zod';
import { agentName, githubLogin, id, isoTime, issueRef } from './primitives';

// Live feed events (spec section 8). The issue room makes each one, and the
// repo, person, and homepage feeds store and stream it.

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

/** A subagent's job, like `tests`, shown with the lines it posts. */
export const jobName = z
  .string({ error: 'must be a short name for the job, like tests' })
  .trim()
  .min(1, 'must not be empty')
  .max(40, 'must be at most 40 characters');

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
