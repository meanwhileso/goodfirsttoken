import {
  MAX_ROUNDS,
  ROUNDS_PER_DAY,
  type FollowUpRecord,
  type PrFollowMode,
  type PrFollowState,
  type WakeHarness,
  type WakeLevel,
} from '@goodfirsttoken/core';
import type { FollowedPr } from './follow';

// The words /me and /me.md use for follow-through, so the page, its forms,
// and its Markdown say the same. It imports no server code, so the page can
// use it.

/** A time in UTC, to the minute, as /me shows times. */
export function when(time: number): string {
  return `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Each mode as the page names it. */
export const MODE_NAMES: Record<PrFollowMode, string> = {
  go_ahead: 'go ahead',
  ask_first: 'ask first',
  off: 'not followed',
};

/** Where a PR stands, as docs/specs/follow-through.md names each state under Status. */
export const STATE_NAMES: Record<PrFollowState, string> = {
  waiting_reviewer: 'waiting for a reviewer',
  agent_on_it: 'your agent is on it',
  waiting_donor: 'waiting for you',
  stalled: 'stalled',
  off: 'not followed',
};

/** Each harness a wake can be in, by its product's name. */
export const HARNESS_NAMES: Record<WakeHarness, string> = {
  'claude-code-desktop': 'Claude Code desktop app',
  'claude-code-terminal': 'Claude Code in a terminal',
  'claude-code-cloud': 'Claude Code cloud scheduled tasks',
  'codex-desktop': 'Codex in the ChatGPT desktop app',
  'grok-bot': 'Grok Bot',
  'cursor-automations': 'Cursor Automations',
  'codex-cli': 'Codex CLI',
  'cursor-editor': "Cursor's editor and CLI",
  opencode: 'OpenCode',
  'grok-build': 'Grok Build',
  chatgpt: 'ChatGPT',
  'grok-automations': "Grok's Automations",
};

/** What a run at each level does, for the donor. */
export const LEVEL_WORDS: Record<WakeLevel, string> = {
  full: 'Its runs can push fixes and reply on GitHub as you.',
  notify: 'Its runs tell you what came in, and change nothing.',
  session: 'Your agent follows your PRs only while a session runs.',
};

/** How often a wake runs, like `every 15 minutes`. */
export function everyText(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? 'every hour' : hours === 24 ? 'every day' : `every ${String(hours)} hours`;
  }
  return minutes === 1 ? 'every minute' : `every ${String(minutes)} minutes`;
}

/** What the person can do for a PR, or null when nothing waits for them. */
export function stepFor(pr: FollowedPr): string | null {
  if (pr.state === 'stalled') {
    return 'A follow-up has waited a day with no run to sort it. Start a session with your agent, or check that your wake still runs.';
  }
  if (pr.roundLimit === 'day') {
    return `Your agent took ${String(ROUNDS_PER_DAY)} rounds on this PR today, the most in a day. It checks the PR again tomorrow. Choose Go on to let it go on today.`;
  }
  if (pr.roundLimit === 'total') {
    return `Your agent took ${String(MAX_ROUNDS)} rounds on this PR, the most in all. Choose Go on to let it take more.`;
  }
  if (pr.state === 'waiting_donor') return 'Your agent asked you about a follow-up. Answer it in a session with your agent.';
  if (pr.state === 'off') return 'You stopped following this PR. Your agent leaves it.';
  return null;
}

/** When the PR is checked next, in the page's words, or null when that says nothing. */
export function nextCheckText(pr: FollowedPr, now: number): string | null {
  if (pr.followMode === 'off') return null;
  if (pr.roundLimit === 'total') return 'checked again once you choose Go on';
  if (pr.open === 0 && pr.waitingDonor > 0) return 'checked again once you answer';
  if (pr.due) return "due at your agent's next run";
  if (pr.nextCheckAt === null) {
    return pr.schedule === 'stopped' ? 'no reviewer activity for 30 days, so no checks on a schedule' : null;
  }
  return pr.nextCheckAt <= now ? "due at your agent's next run" : `checked next ${when(pr.nextCheckAt)}`;
}

/** What a follow-up is, like `review` or `comment on src/a.ts`. */
export function kindText(followUp: FollowUpRecord): string {
  switch (followUp.kind) {
    case 'review':
      return 'review';
    case 'line':
      return `comment on ${followUp.path ?? 'a line'}`;
    case 'conversation':
      return 'comment';
    case 'checks':
      return 'failed checks';
    case 'conflict':
      return 'merge conflict';
  }
}

const OUTCOME_WORDS = {
  fixed: 'fixed',
  replied: 'replied',
  no_change: 'no change needed',
  resolved: 'resolved by the reviewer',
  superseded: 'replaced by a newer read',
} as const;

/** Where a follow-up stands, like `fixed` or `waiting for the reviewer`. */
export function standText(followUp: FollowUpRecord): string {
  if (followUp.state === 'settled') return followUp.outcome === null ? 'settled' : OUTCOME_WORDS[followUp.outcome];
  if (followUp.state === 'waiting_reviewer') return 'waiting for the reviewer';
  if (followUp.state === 'waiting_donor') return 'waiting for you';
  return 'not sorted yet';
}


/** What a stopped wake's notice says to check, by where the harness runs. */
export function stoppedCheck(harness: WakeHarness): string {
  return LOCAL_HARNESSES.has(harness)
    ? `Check that ${HARNESS_NAMES[harness]} is open and its schedule is on.`
    : `Check that its schedule is still on in ${HARNESS_NAMES[harness]}.`;
}

/** The harnesses whose wakes run only while an app on the donor's machine is open. */
const LOCAL_HARNESSES: ReadonlySet<WakeHarness> = new Set(['claude-code-desktop', 'codex-desktop']);
