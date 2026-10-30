import { getClaim, getProject, getSubmission, listClearedWithoutPr } from '../db';
import { pullMismatch } from '../donor/work';
import { pullFacts } from '../donor/writes';
import { GitHubError } from '../github';
import { clearedPrOf, recordPull } from '../mcp/submit';
import { SyncStopped, type ServiceGitHub, type StopReason } from './github';

// The job that records cleared PRs nobody recorded
// (docs/specs/agent-submits.md). A donor may open the PR for work open_pr
// cleared on GitHub's own form, or their agent may stop before record_pr.
// So on the PR job's schedule, with the read-only service token, it lists
// each cleared claim's PRs by the claim's branch, and records the first one
// that is the cleared one, by record_pr's checks. The rules are in
// docs/how-it-works.md, under Recording the PR.

export interface ClearedJobDeps {
  db: D1Database;
  github: ServiceGitHub;
  now: () => number;
}

/** What one run did, for its log line. */
export interface ClearedRun {
  /** Cleared claims whose branch the run looked up. */
  checked: number;
  recorded: number;
  calls: number;
  stopped: StopReason | null;
}

/**
 * How long after a claim's 7 days ran out the job still looks, for a PR
 * made before they did. The job runs twice an hour, so a day leaves room
 * for runs that didn't happen.
 */
export const AFTER_EXPIRY_MS = 24 * 60 * 60 * 1000;

export async function recordClearedPrs(deps: ClearedJobDeps): Promise<ClearedRun> {
  const run: ClearedRun = { checked: 0, recorded: 0, calls: 0, stopped: null };
  const claimIds = await listClearedWithoutPr(deps.db, deps.now() - AFTER_EXPIRY_MS);
  try {
    if (claimIds.length > 0) await deps.github.checkGitHub();
    for (const claimId of claimIds) {
      const [claim, submission] = await Promise.all([getClaim(deps.db, claimId), getSubmission(deps.db, claimId)]);
      if (claim === null || submission?.clearance == null) continue;
      const project = await getProject(deps.db, claim.project);
      if (project === null) continue;
      const owner = submission.repo.slice(0, submission.repo.indexOf('/'));
      const head = encodeURIComponent(`${owner}:${submission.branch}`);
      // https://docs.github.com/en/rest/pulls/pulls#list-pull-requests
      const { data } = await deps.github.read<unknown[]>(`/repos/${project.repo}/pulls?state=all&head=${head}&per_page=100`);
      run.checked += 1;
      for (const listed of Array.isArray(data) ? data : []) {
        const pull = pullFacts(listed);
        if (pull?.baseDefault == null) continue;
        const cleared = clearedPrOf(claim, project, submission, submission.clearance, project.repo, pull.baseDefault);
        if (pullMismatch(pull, cleared) !== null) continue;
        const recorded = await recordPull(claim, pull);
        if ('pr' in recorded) {
          run.recorded += 1;
          break;
        }
      }
    }
  } catch (error) {
    if (error instanceof SyncStopped) {
      run.stopped = error.reason;
      console.warn(`The cleared PR job stopped. ${error.message}`);
    } else if (error instanceof GitHubError) {
      run.stopped = 'github_error';
      console.warn(`The cleared PR job stopped. GitHub answered ${String(error.status)}: ${error.message}`);
    } else {
      throw error;
    }
  }
  run.calls = deps.github.calls;
  console.log(
    `The cleared PR job looked up branches: ${String(run.checked)} of ${String(claimIds.length)}, PRs recorded: ${String(run.recorded)}, calls to GitHub: ${String(run.calls)}.${run.stopped === null ? '' : ` Stopped: ${run.stopped}.`}`,
  );
  return run;
}
