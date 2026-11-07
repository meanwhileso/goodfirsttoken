import type { Allowance } from './github';

// What the jobs that read GitHub with the read-only service token may spend,
// and the token itself. The jobs are the crons in src/sync/scheduled.ts, the
// crawl queue's consumer, PrChecker, and the reads of one project that run
// outside the schedule, in src/sync/read-now.ts.

/**
 * What each job may spend of the token's hourly budget, how many calls one
 * run makes, how many of the sync's go to its checks of the repos of the
 * projects it reads no issues for, and how long a read on approval reads.
 * docs/how-it-works.md gives the rule, under Tagged issues, and
 * docs/architecture.md, under The sync and The policy crawler, why these
 * numbers. The crawler's cron job queues its repos with no call, and each
 * run of its queue's consumer spends from the token's budget. The finds the
 * cron approves on their own (src/crawl/auto-approve.ts) make a read or two
 * each, at most 50 finds a run, outside these allowances.
 */
export const ALLOWANCES = {
  sync: { leave: 0.2, maxCalls: 1000, checkCalls: 100 },
  prs: { leave: 0.1, maxCalls: 100 },
  cleared: { leave: 0.1, maxCalls: 100 },
  refresh: { leave: 0.5, maxCalls: 60 },
  approval: { leave: 0.2, maxCalls: 200, maxMs: 20_000 },
  crawlRead: { leave: 0.6, maxCalls: 60 },
} satisfies Record<string, Allowance>;

/** The read-only service token, or null when the deployment has none. */
export function serviceToken(env: Partial<Pick<Env, 'GH_SERVICE_TOKEN'>>): string | null {
  const token = env.GH_SERVICE_TOKEN;
  return token ? token : null;
}
