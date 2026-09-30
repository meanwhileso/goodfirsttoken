import { ISSUE_REFRESH_INTERVAL_MS, type ProjectRecord, type ToolOutput } from '@goodfirsttoken/core';
import { authSecret, oauthApp, SignInNotSetUp } from '../auth/settings';
import { fillCrawlQueue } from '../crawl/search';
import { getDoNotListEntry, releaseProject, takeRefresh } from '../db';
import { endEveryLapsedConnection } from '../mcp/connections';
import { ServiceGitHub, SyncStopped, type Allowance } from './github';
import { HOLD_MS, newSyncRun, syncProject, syncTaggedIssues } from './issues';
import { followPrs } from './prs';

// The jobs that read GitHub with the read-only service token: the Worker's
// cron triggers, and the refresh a maintainer asks for with project_status.
// One more cron, once a day, ends the connections whose grants ran out, and
// revokes their tokens as the OAuth app, with no service token. Each cron in
// apps/web/wrangler.jsonc names one job here.

/** Every 15 minutes: the tagged-issue sync (src/sync/issues.ts). */
export const ISSUE_SYNC_CRON = '*/15 * * * *';
/** Twice an hour, apart from the sync: the PR job (src/sync/prs.ts). */
export const PR_JOB_CRON = '7,37 * * * *';
/** Once an hour, apart from both: the policy crawler's search (src/crawl/search.ts). */
export const CRAWL_CRON = '52 * * * *';
/** Once a day, apart from the others: ending lapsed connections (src/mcp/connections.ts). */
export const LAPSED_CONNECTIONS_CRON = '23 4 * * *';

/**
 * What each job may spend of the token's hourly budget, how many calls one
 * run makes, and how many of the sync's go to its checks of the repos of
 * the projects it reads no issues for. docs/how-it-works.md gives the rule,
 * under Tagged issues, and docs/architecture.md, under The sync and The
 * policy crawler, why these numbers. The crawler's search spends the search
 * budget, which only it uses, and each run of its queue's consumer spends
 * from the others.
 */
export const ALLOWANCES = {
  sync: { leave: 0.2, maxCalls: 1000, checkCalls: 100 },
  prs: { leave: 0.1, maxCalls: 100 },
  refresh: { leave: 0.5, maxCalls: 60 },
  crawlSearch: { leave: 0.1, maxCalls: 20 },
  crawlRead: { leave: 0.6, maxCalls: 60 },
} satisfies Record<string, Allowance>;

/**
 * How many lapsed connections one daily run ends, at most. Each is one call
 * to GitHub to revoke its token, as the OAuth app, never with the service
 * token, and about ten calls to D1 and KV. docs/architecture.md, under The
 * sync, says why this number.
 */
export const LAPSED_PER_RUN = 200;

/** The read-only service token, or null when the deployment has none. */
export function serviceToken(env: Partial<Pick<Env, 'GH_SERVICE_TOKEN'>>): string | null {
  const token = env.GH_SERVICE_TOKEN;
  return token ? token : null;
}

// The origin the libraries are made for when ending a connection with no
// request. Ending one makes no URL, so any does, and this is the site's own
// when it has a primary domain.
function jobOrigin(env: Env): string {
  const primary = env.PRIMARY_DOMAIN.trim().toLowerCase();
  return primary ? `https://${primary}` : 'https://scheduled.invalid';
}

/**
 * Ends every lapsed connection, up to the day's cap. With a setting sign-in
 * needs missing, it ends none, since a connection's row would go before its
 * token could be read or revoked.
 */
async function endLapsed(env: Env): Promise<void> {
  try {
    oauthApp();
    authSecret();
  } catch (problem) {
    if (!(problem instanceof SignInNotSetUp)) throw problem;
    console.error(`No lapsed connection was ended. Sign-in is not set up: ${problem.message}`);
    return;
  }
  const ended = await endEveryLapsedConnection(jobOrigin(env), Date.now(), LAPSED_PER_RUN);
  if (ended > 0) console.log(`Ended ${String(ended)} connections whose grants ran out.`);
}

/** Runs the job for a cron trigger. */
export async function runScheduled(cron: string, env: Env): Promise<void> {
  if (cron === LAPSED_CONNECTIONS_CRON) {
    await endLapsed(env);
    return;
  }
  const token = serviceToken(env);
  if (token === null) {
    console.error(`No job ran on the cron ${cron}. The GH_SERVICE_TOKEN secret is not set. docs/self-hosting.md lists the Worker's secrets.`);
    return;
  }
  const now = () => Date.now();
  switch (cron) {
    case ISSUE_SYNC_CRON:
      await syncTaggedIssues({ db: env.DB, rooms: env.ISSUE_ROOM, github: new ServiceGitHub(token, ALLOWANCES.sync), now });
      return;
    case PR_JOB_CRON:
      await followPrs({ db: env.DB, rooms: env.ISSUE_ROOM, github: new ServiceGitHub(token, ALLOWANCES.prs), now });
      return;
    case CRAWL_CRON:
      await fillCrawlQueue({ db: env.DB, queue: env.CRAWL_QUEUE, github: new ServiceGitHub(token, ALLOWANCES.crawlSearch), now });
      return;
    default:
      console.error(`No job runs on the cron ${cron}. Each cron trigger in wrangler.jsonc needs one in src/sync/scheduled.ts.`);
  }
}

export type RefreshOutcome = NonNullable<ToolOutput<'project_status'>['refresh']>;

/**
 * Reads an approved project's tagged issues from GitHub now, for a
 * maintainer who asked with project_status. At most once every 10 minutes
 * for a project, counting only earlier refreshes, never while a scheduled
 * run reads the project, and only while half the token's hourly budget is
 * left. It says it read part of the issues only when it saved some.
 */
export async function refreshIssues(env: Env, project: ProjectRecord, now: () => number = Date.now): Promise<RefreshOutcome> {
  const token = serviceToken(env);
  if (token === null) return 'not_set_up';
  if (project.status !== 'approved') return 'not_approved';
  for (const repo of new Set([project.repo, project.settings.issueRepo ?? project.repo])) {
    if ((await getDoNotListEntry(env.DB, repo)) !== null) return 'not_approved';
  }
  const until = now() + HOLD_MS;
  const turn = await takeRefresh(env.DB, project.repo, now(), ISSUE_REFRESH_INTERVAL_MS, until);
  if (turn !== 'taken') return turn;
  const github = new ServiceGitHub(token, ALLOWANCES.refresh);
  const run = newSyncRun();
  try {
    await github.checkGitHub();
    const result = await syncProject({ db: env.DB, rooms: env.ISSUE_ROOM, github, now }, project, run);
    if (result.outcome === 'read') return 'read';
    if (result.outcome === 'paused') return 'paused';
    console.warn(`A refresh of ${project.repo} was skipped. ${result.problem}`);
  } catch (error) {
    if (!(error instanceof SyncStopped)) throw error;
    console.warn(`A refresh of ${project.repo} stopped. ${error.message}`);
  } finally {
    await releaseProject(env.DB, project.repo, until);
  }
  return run.issues > 0 ? 'partly_read' : 'not_read';
}
