import { z } from 'zod';
import { epochMs, githubId, id } from './primitives';

// Follow-through (docs/specs/follow-through.md): how the donor's agent
// follows each PR to its end. The donor chooses a mode, and the follow
// skill saves a wake for each harness that starts runs for them.

/**
 * How the donor's agent follows their PRs. `go_ahead`: it answers
 * follow-ups, pushes fixes, and replies on GitHub, then tells the donor.
 * `ask_first`: it tells the donor what came in and decides with them.
 */
export const followModeSchema = z.enum(['go_ahead', 'ask_first']);
export type FollowMode = z.infer<typeof followModeSchema>;

/** A donor who never chose follows this. */
export const DEFAULT_FOLLOW_MODE: FollowMode = 'go_ahead';

/** How one PR is followed: a mode, or `off`, once the donor stopped following it. */
export const prFollowModeSchema = z.enum(['go_ahead', 'ask_first', 'off']);
export type PrFollowMode = z.infer<typeof prFollowModeSchema>;

/**
 * What a run has. `full`: a wake, Good First Token's tools, and git and
 * GitHub as the donor. `notify`: a wake and the tools, and it only reports.
 * `session`: nothing runs until the donor starts a session, where a CLI
 * session that stays open keeps a loop.
 */
export const wakeLevelSchema = z.enum(['full', 'notify', 'session']);
export type WakeLevel = z.infer<typeof wakeLevelSchema>;

/**
 * The harnesses a wake can be in, from the spec's table under Harnesses,
 * each with the highest level a run there can have.
 */
export const WAKE_HARNESSES = {
  /** Claude Code's desktop app, with a scheduled task. */
  'claude-code-desktop': 'full',
  /** Claude Code in a terminal, with a loop while the session runs. */
  'claude-code-terminal': 'session',
  /** Claude Code's cloud scheduled tasks. */
  'claude-code-cloud': 'notify',
  /** Codex in the ChatGPT desktop app, with a scheduled task. */
  'codex-desktop': 'full',
  /** Grok Bot, with a routine. */
  'grok-bot': 'full',
  /** Cursor Automations. */
  'cursor-automations': 'full',
  /** The Codex CLI. No wake is built in. */
  'codex-cli': 'session',
  /** Cursor's editor and CLI. No wake is built in. */
  'cursor-editor': 'session',
  /** OpenCode. No wake is built in. */
  opencode: 'session',
  /** Grok Build. No wake is built in. */
  'grok-build': 'session',
  /** ChatGPT on the web and phone, with a scheduled task. It has no git. */
  chatgpt: 'notify',
  /** Grok's Automations in the Grok app. It has no git. */
  'grok-automations': 'notify',
} as const satisfies Record<string, WakeLevel>;

export const wakeHarnessSchema = z.enum(Object.keys(WAKE_HARNESSES) as [keyof typeof WAKE_HARNESSES]);
export type WakeHarness = z.infer<typeof wakeHarnessSchema>;

const LEVEL_RANK: Record<WakeLevel, number> = { session: 0, notify: 1, full: 2 };

/** Whether a run in the harness can have the level. */
export function levelFits(harness: WakeHarness, level: WakeLevel): boolean {
  return LEVEL_RANK[level] <= LEVEL_RANK[WAKE_HARNESSES[harness]];
}

/** The longest a wake waits between runs, in minutes: a day. */
export const MAX_WAKE_INTERVAL = 1440;

/** The most wakes one donor keeps. */
export const MAX_WAKES = 10;

/**
 * A wake that hasn't run for this long past its interval, while one of
 * the donor's PRs is open, stopped.
 */
export const WAKE_STOPPED_AFTER_MS = 24 * 60 * 60 * 1000;

/** How often a wake starts a run, in whole minutes. */
export const wakeInterval = z
  .int({ error: 'must be a whole number of minutes' })
  .min(1, 'must be at least 1 minute')
  .max(MAX_WAKE_INTERVAL, `must be at most ${String(MAX_WAKE_INTERVAL)} minutes, a day`);

/** A wake as the wakes table keeps it. */
export const wakeRecordSchema = z.object({
  id,
  githubId,
  harness: wakeHarnessSchema,
  level: wakeLevelSchema,
  intervalMinutes: wakeInterval,
  createdAt: epochMs,
  /** When a run last called my_work with the wake's ID, or null before the first. */
  lastRunAt: epochMs.nullable(),
});
export type WakeRecord = z.infer<typeof wakeRecordSchema>;

// When a PR is due (docs/specs/follow-through.md, under Waking up, Limits,
// and Two agents at once). Pure, so tests run it on a fake clock.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long a run's lease on a PR lasts from its last renewal. */
export const LEASE_MS = 30 * MINUTE;

/** The most rounds on one PR in a UTC day. */
export const ROUNDS_PER_DAY = 3;

/** The most rounds on one PR in all. */
export const MAX_ROUNDS = 10;

/** The most rounds on one PR that answer review bots. After them, bot follow-ups settle no_change. */
export const MAX_BOT_ROUNDS = 3;

/** An open follow-up no run sorted for this long makes its PR stalled. */
export const STALLED_AFTER_MS = DAY;

/** A PR with no reviewer activity for this long is checked on no schedule. */
export const QUIET_AFTER_MS = 30 * DAY;

/** The ID a run makes up when it starts, which keys its leases. */
export const runIdSchema = z
  .string({ error: 'must be an ID you make up for this run, like run-2026-11-08T12-00' })
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be an ID you make up for this run, like run-2026-11-08T12-00');

/**
 * Where a followed PR stands, for the donor: `waiting_reviewer`,
 * `agent_on_it` while a run holds it or it has an open follow-up,
 * `waiting_donor` while its follow-ups wait for the donor or it reached a
 * round limit, `stalled` with an open follow-up no run sorted for 24
 * hours, or `off` once the donor stopped following it.
 */
export const prFollowStateSchema = z.enum(['waiting_reviewer', 'agent_on_it', 'waiting_donor', 'stalled', 'off']);
export type PrFollowState = z.infer<typeof prFollowStateSchema>;

/** How often a PR's checks come now, or `stopped` after 30 days with no reviewer activity. */
export const checkScheduleSchema = z.enum(['every_15_minutes', 'hourly', 'every_4_hours', 'daily', 'stopped']);
export type CheckSchedule = z.infer<typeof checkScheduleSchema>;

/** The UTC day a time falls on, as whole days since the epoch, which rounds count by. */
export function roundDay(time: number): number {
  return Math.floor(time / DAY);
}

/** The schedule's steps: until `end` after the PR's anchor, a check every `every`. */
const STEPS: readonly { end: number; every: number; schedule: CheckSchedule }[] = [
  { end: 2 * HOUR, every: 15 * MINUTE, schedule: 'every_15_minutes' },
  { end: DAY, every: HOUR, schedule: 'hourly' },
  { end: 7 * DAY, every: 4 * HOUR, schedule: 'every_4_hours' },
  { end: Infinity, every: DAY, schedule: 'daily' },
];

/** What a PR's schedule reads. Times are epoch milliseconds. */
export interface CheckFacts {
  openedAt: number;
  /** When the agent's last submit landed, or null. */
  lastPushAt: number | null;
  /** When the PR job read the PR's newest follow-up, or null. */
  newestFollowUpAt: number | null;
  /** When a maintainer or a review bot last wrote a follow-up, as GitHub gives it, or null. */
  lastReviewerAt: number | null;
  /** When a run last checked the PR: took or renewed its lease with follow_pr, or renewed it with check_pr. */
  checkedAt: number | null;
}

/**
 * A PR's next check: the first check on its schedule after the last run
 * checked it. The schedule counts from the agent's last push, the PR job's
 * read of a new follow-up, or the PR's opening, whichever is last: every
 * 15 minutes for 2 hours, then every hour until 24 hours, then every 4
 * hours until 7 days, then once a day. It ends 30 days after the last
 * reviewer activity, or after the PR opened when no reviewer wrote on it,
 * and then `at` is null.
 */
export function nextCheck(facts: CheckFacts): { at: number | null; schedule: CheckSchedule } {
  const anchor = Math.max(facts.openedAt, facts.lastPushAt ?? -Infinity, facts.newestFollowUpAt ?? -Infinity);
  // A push, and checks and conflicts, which GitHub reports, are no reviewer's activity.
  const quietAt = Math.max(facts.openedAt, facts.lastReviewerAt ?? -Infinity) + QUIET_AFTER_MS;
  const since = Math.max(0, (facts.checkedAt ?? anchor) - anchor);
  let start = 0;
  for (const step of STEPS) {
    if (since < step.end) {
      const at = anchor + start + (Math.floor((since - start) / step.every) + 1) * step.every;
      return at > quietAt ? { at: null, schedule: 'stopped' } : { at, schedule: step.schedule };
    }
    start = step.end;
  }
  return { at: null, schedule: 'stopped' };
}

/** What followThroughOf reads of one of the donor's open PRs. */
export interface PrFacts extends CheckFacts {
  claimId: string;
  mode: PrFollowMode;
  /** Its open follow-ups, which no run sorted. */
  open: number;
  /** Its follow-ups that wait for the donor. */
  waitingDonor: number;
  /** When the PR job read its oldest open follow-up, or null with none. */
  oldestOpenAt: number | null;
  /** The run that last took its lease and until when, or null. A lease whose time passed holds nothing. */
  lease: { runId: string; until: number } | null;
  /** Its rounds in all, the UTC day of its last round, the rounds on that day, and those that answered bots. */
  rounds: { total: number; day: number | null; onDay: number; bots: number };
}

/** The run asking: its wake's level, or null in a session the donor is in, its run ID, and the claims with follow-ups new for its wake. */
export interface RunContext {
  level: WakeLevel | null;
  runId?: string | undefined;
  newForWake: ReadonlySet<string>;
}

/** Where one PR stands for the run asking. */
export interface PrFollowThrough {
  claimId: string;
  state: PrFollowState;
  /** Whether this run has work on it now. */
  due: boolean;
  /** True when this run only reports on it: a notify wake's, or any wake's run for an ask_first PR. */
  reportOnly: boolean;
  /** A lease a run holds now, or null. */
  lease: { runId: string; until: number } | null;
  rounds: { today: number; total: number; bots: number };
  /** The round limit the PR reached, which holds it for the donor, or null. */
  roundLimit: 'day' | 'total' | null;
  /** True once 3 rounds answered bots, so its bot follow-ups settle no_change. */
  botLimit: boolean;
  /** When its next check comes, or null when it is checked on no schedule now. */
  nextCheckAt: number | null;
  schedule: CheckSchedule;
  /** When it became stalled, or null when it isn't. */
  stalledSince: number | null;
}

export interface FollowThrough {
  /** Whether any PR is due for this run. */
  dueNow: boolean;
  /** The earliest check to come, after now, on a PR this run follows in full, or null. */
  nextCheckAt: number | null;
  /** Each PR, the stalled ones first, the rest in the order given. */
  prs: PrFollowThrough[];
}

function onePr(facts: PrFacts, run: RunContext, now: number): PrFollowThrough {
  const lease = facts.lease !== null && facts.lease.until > now ? facts.lease : null;
  const today = facts.rounds.day === roundDay(now) ? facts.rounds.onDay : 0;
  const roundLimit = facts.rounds.total >= MAX_ROUNDS ? 'total' : today >= ROUNDS_PER_DAY ? 'day' : null;
  const check = nextCheck(facts);
  const heldElsewhere = lease !== null && lease.runId !== run.runId;
  const waitsForDonor = facts.open === 0 && facts.waitingDonor > 0;
  let nextCheckAt = check.at;
  if (facts.mode === 'off' || waitsForDonor || roundLimit === 'total') nextCheckAt = null;
  if (nextCheckAt !== null && roundLimit === 'day') nextCheckAt = Math.max(nextCheckAt, (roundDay(now) + 1) * DAY);
  if (nextCheckAt !== null && heldElsewhere) nextCheckAt = Math.max(nextCheckAt, lease.until);
  const reportOnly = run.level === 'notify' || (run.level !== null && facts.mode === 'ask_first');
  let due: boolean;
  if (facts.mode === 'off') due = false;
  else if (reportOnly) due = run.newForWake.has(facts.claimId);
  else if (heldElsewhere || roundLimit !== null) due = false;
  else due = facts.open > 0 || (nextCheckAt !== null && nextCheckAt <= now);
  const stalledAt = facts.open > 0 && facts.oldestOpenAt !== null ? facts.oldestOpenAt + STALLED_AFTER_MS : null;
  const state: PrFollowState =
    facts.mode === 'off'
      ? 'off'
      : lease !== null
        ? 'agent_on_it'
        : roundLimit !== null
          ? 'waiting_donor'
          : stalledAt !== null && stalledAt <= now
            ? 'stalled'
            : facts.open > 0
              ? 'agent_on_it'
              : facts.waitingDonor > 0
                ? 'waiting_donor'
                : 'waiting_reviewer';
  return {
    claimId: facts.claimId,
    state,
    due,
    reportOnly,
    lease,
    rounds: { today, total: facts.rounds.total, bots: facts.rounds.bots },
    roundLimit,
    botLimit: facts.rounds.bots >= MAX_BOT_ROUNDS,
    nextCheckAt,
    schedule: check.schedule,
    stalledSince: state === 'stalled' ? stalledAt : null,
  };
}

/**
 * Where each of the donor's open PRs stands for the run asking at `now`.
 * A PR is due when it has an open follow-up or its next check comes,
 * unless the donor stopped following it, another run holds its lease, or
 * it reached a round limit. A PR whose follow-ups all wait for the donor
 * is checked on no schedule. A run that only reports is due for a PR when
 * its wake has follow-ups there it wasn't given.
 */
export function followThroughOf(prs: readonly PrFacts[], run: RunContext, now: number): FollowThrough {
  const each = prs.map((facts) => onePr(facts, run, now));
  const coming = each
    .filter((pr) => !pr.reportOnly && pr.nextCheckAt !== null && pr.nextCheckAt > now)
    .map((pr) => pr.nextCheckAt as number);
  return {
    dueNow: each.some((pr) => pr.due),
    nextCheckAt: coming.length === 0 ? null : Math.min(...coming),
    prs: [...each.filter((pr) => pr.state === 'stalled'), ...each.filter((pr) => pr.state !== 'stalled')],
  };
}
