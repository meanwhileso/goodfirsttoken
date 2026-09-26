import { z } from 'zod';
import { agentName, count, epochMs, githubId, id, wholeNumber } from './primitives';

// A donor's session (spec section 7): one run of spending tokens, from
// start_session until the budget runs out or the harness stops.

/** How much the donor wants to spend this session. */
export const budgetSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('issues'), count: wholeNumber(1, 100) }),
    z.object({ kind: z.literal('time'), minutes: wholeNumber(1, 24 * 60) }),
    z.object({ kind: z.literal('until_limit') }),
  ],
  { error: 'must be a number of issues, a number of minutes, or until_limit' },
);
export type Budget = z.infer<typeof budgetSchema>;

/** A stored session. Time spent is counted from `startedAt`. */
export const sessionRecordSchema = z.object({
  id,
  /** The donor. */
  githubId,
  agent: agentName,
  budget: budgetSchema,
  startedAt: epochMs,
  /** Issues claimed in this session, counted against a budget of issues. */
  issuesClaimed: count,
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
