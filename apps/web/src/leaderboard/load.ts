import { env } from 'cloudflare:workers';
import { startOfWeek, tally, type Tally } from '../db';

// What the leaderboard shows when it loads. It runs on the server only: the
// route calls it through the server function in ./data.ts. Each view is one
// call to the leaderboard's tally in src/db/leaderboard.ts, so every view,
// the homepage's merged this week, a project's top helpers, and a person's
// totals count the same way.

const DAY = 24 * 60 * 60 * 1000;

/** How many rows each view shows at most. */
export const BOARD_ROWS = 50;

/**
 * The agents the view by agent always shows, side by side, even before
 * they have a PR: Claude Code, Codex, OpenCode, Grok Bot, and Cursor, by the
 * names their sessions report.
 */
export const NAMED_AGENTS = ['claude-code', 'codex', 'opencode', 'grok', 'cursor'] as const;

/** One view: its first rows, and how many rows it has in all. */
export interface Board {
  total: number;
  rows: Tally[];
}

export interface LeaderboardPage {
  state: 'ready';
  /** When this week started, Monday at 00:00 UTC, in ISO 8601. */
  weekStart: string;
  week: Board;
  allTime: Board;
  agents: Board;
  projects: Board;
}

export type LeaderboardResult = LeaderboardPage | { state: 'unavailable' };

function noWork(agent: string): Tally {
  return {
    key: agent,
    login: null,
    agent: null,
    merged: 0,
    closed: 0,
    opened: 0,
    mergeRate: null,
    issues: 0,
    projects: 0,
    people: 0,
    tokens: null,
    ownMerged: 0,
  };
}

/**
 * The view by agent: every agent with work, and each of the named agents
 * with none yet after them, in the order NAMED_AGENTS gives.
 */
export function withNamedAgents(board: Board): Board {
  const missing = NAMED_AGENTS.filter((agent) => !board.rows.some((row) => row.key === agent));
  return { total: board.total + missing.length, rows: [...board.rows, ...missing.map(noWork)] };
}

/** Every view of the leaderboard, as of `now`. */
export async function loadLeaderboard(now = Date.now()): Promise<LeaderboardResult> {
  const from = startOfWeek(now);
  const limit = { limit: BOARD_ROWS };
  try {
    const [week, allTime, agents, projects] = await Promise.all([
      tally(env.DB, 'person', { range: { from, until: from + 7 * DAY } }, limit),
      tally(env.DB, 'person', {}, limit),
      tally(env.DB, 'agent', {}, limit),
      tally(env.DB, 'project', {}, limit),
    ]);
    return {
      state: 'ready',
      weekStart: new Date(from).toISOString(),
      week,
      allTime,
      agents: withNamedAgents(agents),
      projects,
    };
  } catch (error) {
    console.warn('The leaderboard could not be read.', error);
    return { state: 'unavailable' };
  }
}
