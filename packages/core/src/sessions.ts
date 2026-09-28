import { z } from 'zod';
import { agentName, count, epochMs, githubId, id, issueRef, wholeNumber } from './primitives';

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

/** The most picks a session's queue holds. */
export const MAX_QUEUE = 20;

/** The donor's picks waiting in a session, in order. Each is claimed only when the agent reaches it. */
export const queueSchema = z.array(issueRef).max(MAX_QUEUE, `must list at most ${String(MAX_QUEUE)} issues`);

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
  /** The donor's picks not claimed yet, in order. */
  queue: queueSchema,
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

/** What is left of a session's budget at a moment. */
export interface BudgetLeft {
  /** True once the budget allows no new claim. */
  spent: boolean;
  /** Issues the session can still claim, or null unless its budget is a number of issues. */
  issuesLeft: number | null;
  /** When a budget of time runs out, or null for any other budget. */
  endsAt: number | null;
}

/**
 * What is left of the session's budget at `now`. A budget of issues is spent
 * once that many were claimed in the session. A budget of time is spent once
 * that many minutes have passed since the session started. Until the limit
 * is never spent: the session runs until the harness stops.
 */
export function budgetLeft(
  session: Pick<SessionRecord, 'budget' | 'startedAt' | 'issuesClaimed'>,
  now: number,
): BudgetLeft {
  const { budget } = session;
  switch (budget.kind) {
    case 'issues': {
      const issuesLeft = Math.max(0, budget.count - session.issuesClaimed);
      return { spent: issuesLeft === 0, issuesLeft, endsAt: null };
    }
    case 'time': {
      const endsAt = session.startedAt + budget.minutes * 60_000;
      return { spent: now >= endsAt, issuesLeft: null, endsAt };
    }
    case 'until_limit':
      return { spent: false, issuesLeft: null, endsAt: null };
  }
}
