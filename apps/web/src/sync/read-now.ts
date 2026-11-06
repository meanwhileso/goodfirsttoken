import { ISSUE_REFRESH_INTERVAL_MS, type ProjectRecord, type ToolOutput } from '@goodfirsttoken/core';
import { waitUntil } from 'cloudflare:workers';
import { getDoNotListEntry, getIssueSync, getProject, holdProject, releaseProject, takeRefresh } from '../db';
import { ALLOWANCES, serviceToken } from './allowances';
import { ServiceGitHub, SyncStopped } from './github';
import { HOLD_MS, newSyncRun, syncProject, type SyncRun } from './issues';

// The reads of one project's tagged issues that run now, outside the
// schedule: the refresh a maintainer asks for with project_status, and the
// read an admin's approval starts. Each reads as a pass of the sync does,
// with syncProject, holds the project as a scheduled run does, and spends
// under its own allowance in src/sync/allowances.ts. A read cut short saves
// what it read and leaves its pass in progress, and the next scheduled run
// reads the rest. The rules are in docs/how-it-works.md, under Tagged issues.

export type RefreshOutcome = NonNullable<ToolOutput<'project_status'>['refresh']>;

/** Whether the project's code repo or issue repo is on the do-not-list. */
async function onDoNotList(db: D1Database, project: ProjectRecord): Promise<boolean> {
  for (const repo of new Set([project.repo, project.settings.issueRepo ?? project.repo])) {
    if ((await getDoNotListEntry(db, repo)) !== null) return true;
  }
  return false;
}

/**
 * Reads the project's tagged issues now, outside the schedule, as one pass
 * of the sync or the rest of one, with `github` and its allowance. The
 * caller took the hold that runs out at `until`, and this lets go of it.
 * A read that stops saves what it read, and leaves the pass in progress for
 * the next scheduled run. `what` names the read in the log.
 */
async function readHeld(
  env: Env,
  project: ProjectRecord,
  github: ServiceGitHub,
  until: number,
  what: string,
  now: () => number,
): Promise<{ outcome: 'read' | 'paused' | 'partly_read' | 'not_read'; run: SyncRun }> {
  const run = newSyncRun();
  try {
    await github.checkGitHub();
    const result = await syncProject({ db: env.DB, rooms: env.ISSUE_ROOM, github, now }, project, run);
    if (result.outcome === 'read') return { outcome: 'read', run };
    if (result.outcome === 'paused') return { outcome: 'paused', run };
    console.warn(`${what} was skipped. ${result.problem}`);
  } catch (error) {
    if (!(error instanceof SyncStopped)) throw error;
    run.stopped = error.reason;
    console.warn(`${what} stopped. ${error.message}`);
  } finally {
    run.calls = github.calls;
    await releaseProject(env.DB, project.repo, until);
  }
  return { outcome: run.issues > 0 ? 'partly_read' : 'not_read', run };
}

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
  if (await onDoNotList(env.DB, project)) return 'not_approved';
  const until = now() + HOLD_MS;
  const turn = await takeRefresh(env.DB, project.repo, now(), ISSUE_REFRESH_INTERVAL_MS, until);
  if (turn !== 'taken') return turn;
  const github = new ServiceGitHub(token, ALLOWANCES.refresh, now);
  return (await readHeld(env, project, github, until, `A refresh of ${project.repo}`, now)).outcome;
}

/** What a read on approval did. */
export type ApprovalRead =
  | Exclude<RefreshOutcome, 'too_soon'>
  /** A pass of the project's issues finished before, so the sync keeps it current. */
  | 'read_before'
  /** It waited for other reads on approval until its time was up. */
  | 'out_of_time';

/**
 * How long a read on approval holds its project: its 20 seconds, the 30
 * the runtime gives work after an answer, and a margin. A read the runtime
 * cancels never lets go of its hold, so the hold runs out a minute after
 * it began, and the next scheduled run reads the project.
 */
export const APPROVAL_HOLD_MS = 60_000;

/** How often a read on approval looks again whether its turn has come. */
const TURN_CHECK_MS = 200;

/**
 * Until when the read on approval running in this isolate reads, at most:
 * 20 seconds after its approval. Zero while none runs. A read cancelled
 * before it lets go stops counting once that time has passed.
 */
let readingUntil = 0;

/**
 * Waits until no other read on approval runs in this isolate, then takes
 * the turn. False when the 20 seconds since `approvedAt` ran out first.
 * Each request waits on its own timer, never on another request's work,
 * which the runtime can cancel with that request.
 */
async function takeTurn(approvedAt: number, now: () => number): Promise<boolean> {
  const deadline = approvedAt + ALLOWANCES.approval.maxMs;
  while (now() < readingUntil) {
    if (now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, TURN_CHECK_MS));
  }
  if (now() >= deadline) return false;
  readingUntil = deadline;
  return true;
}

/**
 * Reads the tagged issues of a project an admin just approved, listed, or
 * resumed, so they show without waiting for the next scheduled run. Only an
 * approved project off the do-not-list is read, and only when no pass of
 * its issues ever finished: a project the sync read before stays in its
 * turn. It holds the project as a scheduled run does, for a minute, and
 * reads nothing while another run holds it. It leaves a fifth of the
 * hour's budget, as the sync does, makes at most 200 calls, and stops
 * before a call once 20 seconds have passed since `approvedAt`, so it ends
 * well inside the 30 seconds a Worker runs after it answers. A read cut
 * short leaves its pass in progress, and the next scheduled run, which
 * takes such passes first, reads the rest. The rules are in
 * docs/how-it-works.md, under Tagged issues.
 */
export async function readOnApproval(
  env: Env,
  repo: string,
  approvedAt: number,
  now: () => number = Date.now,
): Promise<ApprovalRead> {
  const project = await getProject(env.DB, repo);
  if (project?.status !== 'approved' || (await onDoNotList(env.DB, project))) return 'not_approved';
  if ((await getIssueSync(env.DB, project.repo))?.readAt != null) return 'read_before';
  const token = serviceToken(env);
  if (token === null) {
    console.error(
      `No read of ${project.repo}'s tagged issues ran on its approval. The GH_SERVICE_TOKEN secret is not set. docs/self-hosting.md lists the Worker's secrets. The sync reads it once the secret is set.`,
    );
    return 'not_set_up';
  }
  if (!(await takeTurn(approvedAt, now))) {
    console.log(
      `No read of ${project.repo}'s tagged issues ran on its approval. It waited for other reads on approval for ${String(ALLOWANCES.approval.maxMs / 1000)} seconds. The next scheduled run reads it.`,
    );
    return 'out_of_time';
  }
  try {
    const until = now() + APPROVAL_HOLD_MS;
    if (!(await holdProject(env.DB, project.repo, now(), until))) {
      console.log(`No read of ${project.repo}'s tagged issues ran on its approval. Another run is reading it now.`);
      return 'busy';
    }
    const left = { ...ALLOWANCES.approval, maxMs: ALLOWANCES.approval.maxMs - (now() - approvedAt) };
    const github = new ServiceGitHub(token, left, now);
    const { outcome, run } = await readHeld(env, project, github, until, `The read of ${project.repo} on its approval`, now);
    console.log(
      `The read of ${project.repo} on its approval read issues: ${String(run.issues)}, calls to GitHub: ${String(run.calls)}. Left: ${JSON.stringify(github.left())}.${run.stopped === null ? '' : ` Stopped: ${run.stopped}. The next scheduled run reads the rest.`}`,
    );
    return outcome;
  } finally {
    readingUntil = 0;
  }
}

/** The reads on approval that haven't ended yet, for readsOnApprovalSettled. */
const approvalReads = new Set<Promise<void>>();

/**
 * Starts the read on approval of the project, and hands it to the runtime,
 * so the request that approved it answers at once and the read goes on
 * after. Reads on approval in one isolate run one at a time, so many
 * approvals in a row don't read GitHub side by side, and each one's 20
 * seconds count from its approval, waiting included. It never throws: a read that fails is
 * logged, and the next scheduled run reads the project.
 */
export function startReadOnApproval(env: Env, repo: string): void {
  const approvedAt = Date.now();
  const read: Promise<void> = readOnApproval(env, repo, approvedAt)
    .then(
      () => undefined,
      (error: unknown) => {
        console.error(`The read of ${repo}'s tagged issues on its approval failed. The next scheduled run reads it.`, error);
      },
    )
    .finally(() => approvalReads.delete(read));
  approvalReads.add(read);
  waitUntil(read);
}

/**
 * Settles once every read on approval started so far has ended. A test
 * waits for one this way, since the runtime doesn't make a request wait.
 */
export async function readsOnApprovalSettled(): Promise<void> {
  while (approvalReads.size > 0) await Promise.all(approvalReads);
}
