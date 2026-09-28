import { ISSUE_REFRESH_INTERVAL_MS, type ProjectRecord, type ToolOutput } from '@goodfirsttoken/core';
import { getDoNotListEntry, releaseProject, takeRefresh } from '../db';
import { ServiceGitHub, SyncStopped, type Allowance } from './github';
import { HOLD_MS, newSyncRun, syncProject, syncTaggedIssues } from './issues';
import { followPrs } from './prs';

// The jobs that read GitHub with the read-only service token: the Worker's
// cron triggers, and the refresh a maintainer asks for with project_status.
// Each cron in apps/web/wrangler.jsonc names one job here.

/** Every 15 minutes: the tagged-issue sync (src/sync/issues.ts). */
export const ISSUE_SYNC_CRON = '*/15 * * * *';
/** Twice an hour, apart from the sync: the PR job (src/sync/prs.ts). */
export const PR_JOB_CRON = '7,37 * * * *';

/**
 * What each job may spend of the token's hourly budget, how many calls one
 * run makes, and how many of the sync's go to its checks of the repos of
 * the projects it reads no issues for. docs/how-it-works.md gives the rule,
 * under Tagged issues, and docs/architecture.md, under The sync, why these
 * numbers.
 */
export const ALLOWANCES = {
  sync: { leave: 0.2, maxCalls: 1000, checkCalls: 100 },
  prs: { leave: 0.1, maxCalls: 100 },
  refresh: { leave: 0.5, maxCalls: 60 },
} satisfies Record<string, Allowance>;

/** The read-only service token, or null when the deployment has none. */
function serviceToken(env: Env): string | null {
  const token = (env as Partial<Pick<Env, 'GH_SERVICE_TOKEN'>>).GH_SERVICE_TOKEN;
  return token ? token : null;
}

/** Runs the job for a cron trigger. */
export async function runScheduled(cron: string, env: Env): Promise<void> {
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
