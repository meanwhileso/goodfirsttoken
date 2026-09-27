import { utcDay, type FeedEvent, type PrMode } from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { siteOrigin } from '../auth/settings';
import type { Rank } from '../components/Ranks';
import type { TokenSquare } from '../components/TokenField';
import { listProjectsAskingForHelp, startOfWeek, topMergers } from '../db';
import { homeFeed } from '../rooms/feed';
import { fieldOf, WALL_LINES } from './live';

// What the homepage shows when it loads. It runs on the server only: the
// route calls it through the server function in ./data.ts. Each part is
// read on its own, and a part that can't be read is null, so the page still
// shows the prompt when the database or the feed is down.

const DAY = 24 * 60 * 60 * 1000;

/** How many of the home feed's newest events light the token field when the page loads. */
const FIELD_EVENTS = 100;
/** How many people merged this week shows. */
const MERGED_SHOWN = 5;
/** How many projects asking for help shows. */
const HELP_SHOWN = 5;

export interface HelpProject {
  repo: string;
  /** The labels that mark its issues ready for outside help. */
  tags: string[];
  prMode: PrMode;
  /** Its tagged issues waiting for an agent. */
  waiting: number;
}

export interface HomeData {
  /**
   * How the prompt names the site: its host when it is served over https,
   * like goodfirsttoken.org, and its whole origin otherwise, like
   * http://localhost:5173.
   */
  site: string;
  /** The UTC day the token field counts events for, like 2026-09-27. */
  day: string;
  /** The home feed, or null when it couldn't be read. */
  live: {
    /** The newest events, newest first. */
    lines: FeedEvent[];
    squares: TokenSquare[];
    /** How many events happened on `day`. */
    today: number;
  } | null;
  /** The people with the most PRs merged this week, or null when they couldn't be read. */
  merged: Rank[] | null;
  /** The projects asking for help, or null when they couldn't be read. */
  help: { total: number; projects: HelpProject[] } | null;
}

/** How the prompt names the site. */
export function siteAddress(request: Request): string {
  const origin = siteOrigin(request);
  const url = new URL(origin);
  return url.protocol === 'https:' ? url.host : origin;
}

async function readLive(day: string): Promise<HomeData['live']> {
  try {
    const glance = await homeFeed(env.FEED).glance({ count: FIELD_EVENTS, day });
    if (glance === null) return null;
    return {
      lines: glance.events.slice(-WALL_LINES).reverse(),
      squares: fieldOf(glance.events.filter((event) => utcDay(event.time) === day)),
      today: glance.dayCount,
    };
  } catch (error) {
    console.warn('The homepage could not read the home feed.', error);
    return null;
  }
}

async function readMerged(now: number): Promise<HomeData['merged']> {
  try {
    const from = startOfWeek(now);
    const ranks = await topMergers(env.DB, { from, until: from + 7 * DAY, limit: MERGED_SHOWN });
    return ranks.map(({ login, agent, merged }) => ({ login, agent, score: merged }));
  } catch (error) {
    console.warn('The homepage could not read the PRs merged this week.', error);
    return null;
  }
}

async function readHelp(): Promise<HomeData['help']> {
  try {
    const { total, projects } = await listProjectsAskingForHelp(env.DB, HELP_SHOWN);
    return {
      total,
      projects: projects.map(({ project, waiting }) => ({
        repo: project.repo,
        tags: project.settings.tags,
        prMode: project.settings.prMode,
        waiting,
      })),
    };
  } catch (error) {
    console.warn('The homepage could not read the projects asking for help.', error);
    return null;
  }
}

/** Everything the homepage shows when it loads, as of `now`. */
export async function loadHome(request: Request, now = Date.now()): Promise<HomeData> {
  const day = utcDay(now);
  const [live, merged, help] = await Promise.all([readLive(day), readMerged(now), readHelp()]);
  return { site: siteAddress(request), day, live, merged, help };
}
