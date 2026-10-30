import {
  addPr,
  getBlock,
  getClaim,
  getProject,
  getSubmission,
  listClearedPrsMissing,
  listClearedWithoutPr,
  markClearedChecked,
} from '../db';
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
  /** PRs the rooms recorded and the PRs table missed, added to it. */
  repaired: number;
  /** Claims a read or a record failed for, which later runs try again. */
  failed: number;
  calls: number;
  stopped: StopReason | null;
}

/**
 * How long after a claim's 7 days ran out the job still looks, for a PR
 * made before they did. The job runs twice an hour, so a day leaves room
 * for runs that didn't happen. A PR made in time that no run found in that
 * day is left for record_pr.
 */
export const AFTER_EXPIRY_MS = 24 * 60 * 60 * 1000;

export async function recordClearedPrs(deps: ClearedJobDeps): Promise<ClearedRun> {
  const run: ClearedRun = { checked: 0, recorded: 0, repaired: 0, failed: 0, calls: 0, stopped: null };
  // A PR the room took and the PRs table missed needs no read of GitHub.
  for (const { claimId, pr } of await listClearedPrsMissing(deps.db)) {
    await addPr(deps.db, { claimId, pr, openedAt: deps.now() });
    run.repaired += 1;
  }
  const claimIds = await listClearedWithoutPr(deps.db, deps.now() - AFTER_EXPIRY_MS);
  try {
    if (claimIds.length > 0) await deps.github.checkGitHub();
    for (const claimId of claimIds) {
      const [claim, submission] = await Promise.all([getClaim(deps.db, claimId), getSubmission(deps.db, claimId)]);
      if (claim === null || submission?.clearance == null) continue;
      // A blocked donor's PR isn't recorded, as record_pr refuses it.
      if ((await getBlock(deps.db, claim.githubId)) !== null) continue;
      const project = await getProject(deps.db, claim.project);
      if (project === null) continue;
      const owner = submission.repo.slice(0, submission.repo.indexOf('/'));
      const head = encodeURIComponent(`${owner}:${submission.branch}`);
      let listed: unknown[];
      try {
        // https://docs.github.com/en/rest/pulls/pulls#list-pull-requests
        const { data } = await deps.github.read<unknown[]>(`/repos/${project.repo}/pulls?state=all&head=${head}&per_page=100`);
        listed = Array.isArray(data) ? data : [];
      } catch (error) {
        // A repo GitHub no longer shows stops this claim alone. A spent
        // budget stops the run.
        if (!(error instanceof GitHubError) || error.rateLimited) throw error;
        console.warn(`The cleared PR job couldn't list ${project.repo}'s PRs for claim ${claim.id}. GitHub answered ${String(error.status)}.`);
        run.failed += 1;
        await markClearedChecked(deps.db, claim.id, deps.now());
        continue;
      }
      run.checked += 1;
      await markClearedChecked(deps.db, claim.id, deps.now());
      for (const item of listed) {
        const pull = pullFacts(item);
        if (pull?.baseDefault == null) continue;
        // Each PR listed is in the code repo, by the name GitHub gives it
        // now, since the list follows a rename.
        const cleared = clearedPrOf(claim, project, submission, submission.clearance, pull.baseRepo, pull.baseDefault);
        if (pullMismatch(pull, cleared) !== null) continue;
        try {
          const recorded = await recordPull(claim, pull);
          if ('pr' in recorded) run.recorded += 1;
        } catch (error) {
          console.warn(`The cleared PR job couldn't record ${pull.url} for claim ${claim.id}.`, error);
          run.failed += 1;
        }
        break;
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
    `The cleared PR job looked up branches: ${String(run.checked)} of ${String(claimIds.length)}, PRs recorded: ${String(run.recorded)}, added to the PRs table: ${String(run.repaired)}, failed: ${String(run.failed)}, calls to GitHub: ${String(run.calls)}.${run.stopped === null ? '' : ` Stopped: ${run.stopped}.`}`,
  );
  return run;
}
