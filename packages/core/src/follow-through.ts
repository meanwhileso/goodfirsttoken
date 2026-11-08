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
