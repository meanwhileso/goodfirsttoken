import { githubLogin, nextClaimState, utcDay, validate, type FeedEvent } from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import type { TokenSquare } from '../components/TokenField';
import {
  dailyActivity,
  findPersonByLogin,
  getBlock,
  listPersonWork,
  listRegisteredBy,
  startOfWeek,
  tally,
  type PersonClaim,
  type Tally,
} from '../db';
import { WALL_LINES } from '../home/live';
import { siteAddress } from '../home/load';
import type { PrLink } from '../issue/view';
import { personFeed } from '../rooms/feed';
import { activitySquares, activityStart, ACTIVITY_WEEKS } from './activity';

// What a person's page shows when it loads, at /@<login>. It runs on the
// server only: the route calls it through the server function in ./data.ts.
// It reads the person by their login now, their totals and the projects
// they helped with the leaderboard's tally, their claims and activity from
// D1, and their feed's newest lines, which the page then follows over the
// feed's live socket.

const DAY = 24 * 60 * 60 * 1000;

/** How many claims working now the page lists at most. */
export const WORKING_SHOWN = 20;
/** How many earlier claims the page lists at most, newest first. */
export const HISTORY_SHOWN = 50;
/** How many projects helped the page lists at most. */
export const HELPED_SHOWN = 10;
/** How many projects the person maintains the page lists at most. */
export const MAINTAINS_SHOWN = 20;

/** Where a claim stands, as the page says it. */
export type WorkStatus =
  | 'working'
  | 'paused'
  | 'submitted'
  | 'pr_open'
  | 'merged'
  | 'pr_closed'
  | 'released'
  | 'expired';

/** One of the person's claims, as their page lists it. */
export interface WorkRow {
  /** Like `owner/name#12`. */
  issue: string;
  repo: string;
  number: number;
  /** The issue's title while its project has a page and the site caches the issue, or null. */
  title: string | null;
  agent: string;
  status: WorkStatus;
  pr: PrLink | null;
  /** Work on a project the person was an admin or maintainer of when they claimed. */
  ownProject: boolean;
  /** When the claim was made, in ISO 8601. */
  claimedAt: string;
}

/** A person's totals of all time, counted as the leaderboard counts them. */
export type PersonTotals = Omit<Tally, 'key' | 'login' | 'agent' | 'people'>;

export interface PersonPage {
  state: 'ready';
  /** Their login now. */
  login: string;
  /** When they first signed in, in ISO 8601. */
  joinedAt: string;
  /** How the site names itself, as on the homepage. */
  site: string;
  /** The agents of the claims the page lists, newest first, each once. */
  agents: string[];
  totals: PersonTotals;
  /** The activity graph: 7 rows of 52 weeks, Mondays first. */
  activity: { weeks: number; squares: TokenSquare[] };
  working: WorkRow[];
  history: WorkRow[];
  /** The projects they helped, most PRs merged first. */
  helped: { repo: string; merged: number }[];
  /** The code repos of the projects they registered that have a page. */
  maintains: string[];
  /** The person feed's newest events, newest first, or null when the feed couldn't be read. */
  live: FeedEvent[] | null;
}

export type PersonPageResult =
  | PersonPage
  /** No page: a login no one signed in with, a blocked donor, or a path no login fits. */
  | { state: 'not_found' }
  /** The database couldn't answer. */
  | { state: 'unavailable'; login: string };

const NO_TOTALS: PersonTotals = {
  merged: 0,
  closed: 0,
  opened: 0,
  mergeRate: null,
  issues: 0,
  projects: 0,
  tokens: null,
  ownMerged: 0,
};

/** Where a claim stands at `now`, from its state and its PR's. */
function statusOf({ claim, prState }: PersonClaim, now: number): WorkStatus {
  const ticked = nextClaimState(claim, { kind: 'tick' }, Math.max(now, claim.claimedAt));
  switch (ticked.claim.state) {
    case 'active':
      return 'working';
    case 'paused':
      return 'paused';
    case 'awaiting_review':
      return 'submitted';
    case 'pr_opened':
      return prState === 'merged' ? 'merged' : prState === 'closed' ? 'pr_closed' : 'pr_open';
    case 'released':
      return 'released';
    case 'expired':
      return 'expired';
  }
}

function toRow(work: PersonClaim, now: number): WorkRow {
  const { claim } = work;
  const hash = claim.issue.lastIndexOf('#');
  return {
    issue: claim.issue,
    repo: claim.issue.slice(0, hash),
    number: Number(claim.issue.slice(hash + 1)),
    title: work.title,
    agent: claim.agent,
    status: statusOf(work, now),
    pr: claim.pr && { repo: claim.pr.repo, number: claim.pr.number },
    ownProject: claim.ownProject,
    claimedAt: new Date(claim.claimedAt).toISOString(),
  };
}

/** Everything the page at /@<login> shows when it loads, as of `now`. */
export async function loadPerson(request: Request, login: string, now = Date.now()): Promise<PersonPageResult> {
  if (!validate(githubLogin, login).ok) return { state: 'not_found' };
  try {
    return await read(request, login, now);
  } catch (error) {
    console.warn(`The page of @${login} could not be read.`, error);
    return { state: 'unavailable', login };
  }
}

async function read(request: Request, login: string, now: number): Promise<PersonPageResult> {
  const person = await findPersonByLogin(env.DB, login);
  // A blocked donor's work shows nowhere, so their page is gone too, and
  // reads the same as a login no one signed in with.
  if (person === null || (await getBlock(env.DB, person.githubId)) !== null) return { state: 'not_found' };
  const id = person.githubId;
  const start = activityStart(startOfWeek(now));

  const [working, history, totals, helped, maintains, days, live] = await Promise.all([
    listPersonWork(env.DB, id, { now, holding: true, limit: WORKING_SHOWN }),
    listPersonWork(env.DB, id, { now, holding: false, limit: HISTORY_SHOWN }),
    tally(env.DB, 'person', { person: id }, { limit: 1 }),
    tally(env.DB, 'project', { person: id }, { limit: HELPED_SHOWN, onlyMerged: true }),
    listRegisteredBy(env.DB, id, MAINTAINS_SHOWN),
    dailyActivity(env.DB, id, { from: start, until: start + ACTIVITY_WEEKS * 7 * DAY }),
    readLive(id, now),
  ]);

  const rows = { working: working.map((w) => toRow(w, now)), history: history.map((w) => toRow(w, now)) };
  const [total] = totals.rows;
  return {
    state: 'ready',
    login: person.login,
    joinedAt: new Date(person.joinedAt).toISOString(),
    site: siteAddress(request),
    agents: [...new Set([...rows.working, ...rows.history].map((row) => row.agent))],
    totals: total
      ? {
          merged: total.merged,
          closed: total.closed,
          opened: total.opened,
          mergeRate: total.mergeRate,
          issues: total.issues,
          projects: total.projects,
          tokens: total.tokens,
          ownMerged: total.ownMerged,
        }
      : NO_TOTALS,
    activity: { weeks: ACTIVITY_WEEKS, squares: activitySquares(days, start) },
    ...rows,
    helped: helped.rows.map((row) => ({ repo: row.key, merged: row.merged })),
    maintains,
    live,
  };
}

/** The person feed's newest events, newest first, or null when it can't say who is blocked, or can't be reached. */
async function readLive(id: number, now: number): Promise<FeedEvent[] | null> {
  try {
    const glance = await personFeed(env.FEED, id).glance({ count: WALL_LINES, day: utcDay(now) });
    return glance === null ? null : glance.events.reverse();
  } catch (error) {
    console.warn(`A person's page could not read the feed of ${String(id)}.`, error);
    return null;
  }
}
