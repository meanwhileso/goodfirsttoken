import {
  utcDay,
  type FeedEvent,
  type Policy,
  type ProjectSettings,
  type ProjectSource,
  type ProjectStatus,
} from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { siteOrigin } from '../auth/settings';
import type { Rank } from '../components/Ranks';
import {
  countWorkingClaims,
  getDoNotListEntry,
  getPerson,
  getProject,
  getSettingsSave,
  listMergedPrs,
  listProjectIssues,
  listProjectsAskingForHelp,
  topHelpers,
} from '../db';
import { WALL_LINES } from '../home/live';
import { siteAddress } from '../home/load';
import { repoFromPath } from '../issue/path';
import type { PrLink } from '../issue/view';
import { repoFeed } from '../rooms/feed';
import type { ProjectRowData } from './ProjectRow';

// What the projects list and a project's page show when they load. It runs
// on the server only: the routes call it through the server functions in
// ./data.ts.
//
// The list is the homepage's projects asking for help, all of them, with
// how each got in. A project's page reads its project, its tagged issues
// from the sync's cache with their slots from the claims mirror, the merged
// PRs from its claims, and its top helpers from D1, and its newest lines
// from the project's feed, which the page then follows over the feed's
// live socket.

/** How many projects the list shows at most. */
const PROJECTS_SHOWN = 1000;
/** How many tagged issues a project's page shows at most. */
const ISSUES_SHOWN = 100;
/** How many merged PRs a project's page shows. */
const MERGED_SHOWN = 10;
/** How many top helpers a project's page shows. */
const HELPERS_SHOWN = 5;

/** A project on the list: its row, with how it got in. */
export type ListedProject = ProjectRowData & { source: ProjectSource };

export type ProjectsListResult =
  | { state: 'ready'; total: number; projects: ListedProject[] }
  /** The database couldn't answer. */
  | { state: 'unavailable' };

/**
 * Every project asking for help at `now`, by the homepage's rule and in its
 * order: approved, not paused, and off the do-not-list, the ones with the
 * most issues waiting first.
 */
export async function loadProjectsList(now = Date.now()): Promise<ProjectsListResult> {
  try {
    const { total, projects } = await listProjectsAskingForHelp(env.DB, PROJECTS_SHOWN, now);
    return {
      state: 'ready',
      total,
      projects: projects.map(({ project, waiting }) => ({
        repo: project.repo,
        tags: project.settings.tags,
        prMode: project.settings.prMode,
        waiting,
        source: project.source,
      })),
    };
  } catch (error) {
    console.warn('The projects list could not be read.', error);
    return { state: 'unavailable' };
  }
}

/** One of the project's tagged issues, as its page lists it. */
export interface ProjectIssueRow {
  /** Like `owner/name#12`, in the repo where the project keeps its issues. */
  issue: string;
  repo: string;
  number: number;
  title: string;
  labels: string[];
  /** Claims holding a slot, blocked donors' included. */
  taken: number;
  /** An open PR on it, from the last sync or a claim, which closes it to claims. */
  openPr: PrLink | null;
  /** Whether a new agent could claim it now. */
  takesClaims: boolean;
}

/** A PR merged from a claim on the project. */
export interface MergedRow {
  pr: PrLink;
  issue: string;
  /** The claimant's login now. */
  login: string;
  agent: string;
  /** ISO 8601, in UTC. */
  mergedAt: string;
}

export interface ProjectPage {
  state: 'ready';
  /** The project's code repo, spelled as it was saved. */
  repo: string;
  status: Extract<ProjectStatus, 'approved' | 'paused'>;
  /** How the site names itself, as on the homepage, and its origin. */
  site: string;
  origin: string;
  source: ProjectSource;
  /** The policy it was listed from, or null for a registered project. */
  policy: Policy | null;
  /** The login now of who added it: the maintainer who registered it, or the admin who listed it. */
  addedBy: string | null;
  settings: ProjectSettings;
  /** Who saved its current settings, by their login now, and when, in ISO 8601. */
  rulesSet: { login: string | null; at: string } | null;
  /** Claims in the project holding a slot now. */
  working: number;
  issues: { total: number; rows: ProjectIssueRow[] };
  merged: { total: number; rows: MergedRow[] };
  helpers: Rank[];
  /** The project feed's newest events, newest first, or null when the feed couldn't be read. */
  live: FeedEvent[] | null;
}

export type ProjectPageResult =
  | ProjectPage
  | { state: 'not_found' }
  /** The database couldn't answer. */
  | { state: 'unavailable'; repo: string };

/** The statuses whose projects have a page. */
const SHOWN = new Set<ProjectStatus>(['approved', 'paused']);

/** Everything a project's page shows when it loads, as of `now`. */
export async function loadProject(
  request: Request,
  owner: string,
  name: string,
  now = Date.now(),
): Promise<ProjectPageResult> {
  const asked = repoFromPath(owner, name);
  if (asked === null) return { state: 'not_found' };
  try {
    return await read(request, asked, now);
  } catch (error) {
    console.warn(`The project page for ${asked} could not be read.`, error);
    return { state: 'unavailable', repo: asked };
  }
}

async function read(request: Request, asked: string, now: number): Promise<ProjectPageResult> {
  const project = await getProject(env.DB, asked);
  if (project === null || !SHOWN.has(project.status)) return { state: 'not_found' };
  const status = project.status === 'paused' ? 'paused' : 'approved';

  // Nothing on the do-not-list shows, by its repo or the repo where its
  // issues live.
  const repos = new Set([project.repo, project.settings.issueRepo ?? project.repo].map((repo) => repo.toLowerCase()));
  const listed = await Promise.all([...repos].map((repo) => getDoNotListEntry(env.DB, repo)));
  if (listed.some((entry) => entry !== null)) return { state: 'not_found' };

  const [issues, working, merged, helpers, save, live] = await Promise.all([
    listProjectIssues(env.DB, project.repo, ISSUES_SHOWN, now),
    countWorkingClaims(env.DB, project.repo, now),
    listMergedPrs(env.DB, project.repo, MERGED_SHOWN),
    topHelpers(env.DB, project.repo, HELPERS_SHOWN),
    getSettingsSave(env.DB, project.repo, project.settingsVersion),
    readLive(project.repo, now),
  ]);

  // People by their login now, since a login can change hands.
  const ids = [...new Set([project.addedBy, ...(save ? [save.changedBy] : [])])];
  const logins = new Map(await Promise.all(ids.map(async (id) => [id, (await getPerson(env.DB, id))?.login ?? null] as const)));

  return {
    state: 'ready',
    repo: project.repo,
    status,
    site: siteAddress(request),
    origin: siteOrigin(request),
    source: project.source,
    policy: project.policy,
    addedBy: logins.get(project.addedBy) ?? null,
    settings: project.settings,
    rulesSet: save && { login: logins.get(save.changedBy) ?? null, at: new Date(save.changedAt).toISOString() },
    working,
    issues: {
      total: issues.total,
      rows: issues.issues.map(({ copy, taken, claimPr, waiting }) => {
        const hash = copy.issue.lastIndexOf('#');
        const linked = copy.linkedPr && { repo: copy.linkedPr.repo, number: copy.linkedPr.number };
        return {
          issue: copy.issue,
          repo: copy.issue.slice(0, hash),
          number: Number(copy.issue.slice(hash + 1)),
          title: copy.title,
          labels: copy.labels,
          taken,
          openPr: linked ?? claimPr,
          takesClaims: status === 'approved' && waiting,
        };
      }),
    },
    merged: {
      total: merged.total,
      rows: merged.prs.map((pr) => ({
        pr: pr.pr,
        issue: pr.issue,
        login: pr.login,
        agent: pr.agent,
        mergedAt: new Date(pr.mergedAt).toISOString(),
      })),
    },
    helpers: helpers.map(({ login, agent, merged: score }) => ({ login, agent, score })),
    live,
  };
}

/** The project feed's newest events, newest first, or null when it can't say who is blocked, or can't be reached. */
async function readLive(repo: string, now: number): Promise<FeedEvent[] | null> {
  try {
    const glance = await repoFeed(env.FEED, repo).glance({ count: WALL_LINES, day: utcDay(now) });
    return glance === null ? null : glance.events.reverse();
  } catch (error) {
    console.warn(`The project page could not read the feed of ${repo}.`, error);
    return null;
  }
}
