import type { PrRecord, PrState } from '@goodfirsttoken/core';
import { getClaim, listOpenPrs, setPrState } from '../db';
import { GitHubError } from '../github';
import { issueRoom, type IssueRoom } from '../rooms/issue-room';
import { SyncStopped, type ServiceGitHub, type StopReason } from './github';

// The PR job (spec section 7). It follows each PR opened for a claim until
// it merges or closes, reading GitHub with the read-only service token. When
// one has, it tells the claim's issue room, which takes claims again once
// no PR is open on the issue, then records the outcome in the prs table. The
// rules are in docs/how-it-works.md, under PRs.

export interface PrJobDeps {
  db: D1Database;
  rooms: DurableObjectNamespace<IssueRoom>;
  github: ServiceGitHub;
  now: () => number;
}

/** What one run did, for its log line. */
export interface PrRun {
  checked: number;
  merged: number;
  closed: number;
  calls: number;
  stopped: StopReason | null;
}

/** PRs one GraphQL query reads. */
const BATCH = 50;

// https://docs.github.com/en/graphql/reference/pulls#object-pullrequest
interface PullState {
  state: string;
  mergedAt: string | null;
  closedAt: string | null;
}

type Pulls = Record<string, { pullRequest: PullState | null } | null>;

async function readStates(github: ServiceGitHub, prs: readonly PrRecord[]): Promise<Pulls> {
  const variables: Record<string, unknown> = {};
  const declared: string[] = [];
  const fields = prs.map((record, i) => {
    const n = String(i);
    const [owner = '', name = ''] = record.pr.repo.split('/');
    variables[`o${n}`] = owner;
    variables[`r${n}`] = name;
    variables[`n${n}`] = record.pr.number;
    declared.push(`$o${n}: String!`, `$r${n}: String!`, `$n${n}: Int!`);
    return `p${n}: repository(owner: $o${n}, name: $r${n}) { pullRequest(number: $n${n}) { state mergedAt closedAt } }`;
  });
  const { data, errors } = await github.query<Pulls>(`query (${declared.join(', ')}) { ${fields.join('\n')} }`, variables);
  if (data === null) throw new SyncStopped('github_error', `GitHub answered no PR: ${errors[0]?.message ?? 'no data'}`);
  // A repo or PR GitHub no longer shows comes back null, with an error, and
  // is read again next time.
  return data;
}

/** When GitHub says the PR merged or closed, or now when it gives no time. */
function outcomeOf(pull: PullState, now: number): { state: PrState; at: number } | null {
  if (pull.state !== 'MERGED' && pull.state !== 'CLOSED') return null;
  const at = Date.parse((pull.state === 'MERGED' ? pull.mergedAt : pull.closedAt) ?? '');
  return { state: pull.state === 'MERGED' ? 'merged' : 'closed', at: Number.isNaN(at) ? now : at };
}

/**
 * Reads every open PR in the prs table, oldest first, until they are done
 * or the run has to stop. It first asks GitHub what is left of the budget.
 * A PR whose room didn't hear it closed stays open in the table, so the
 * next run tries again. A refusal from GitHub stops the run, which ends
 * without an error.
 */
export async function followPrs(deps: PrJobDeps): Promise<PrRun> {
  const run: PrRun = { checked: 0, merged: 0, closed: 0, calls: 0, stopped: null };
  const open = await listOpenPrs(deps.db);
  try {
    if (open.length > 0) await deps.github.checkGitHub();
    for (let start = 0; start < open.length; start += BATCH) {
      const batch = open.slice(start, start + BATCH);
      const pulls = await readStates(deps.github, batch);
      for (const [i, record] of batch.entries()) {
        const pull = pulls[`p${String(i)}`]?.pullRequest;
        if (pull == null) continue;
        run.checked += 1;
        const outcome = outcomeOf(pull, deps.now());
        if (outcome === null) continue;
        const claim = await getClaim(deps.db, record.claimId);
        if (claim === null) continue;
        try {
          const told = await issueRoom(deps.rooms, claim.issue).prClosed(record.pr);
          if (!told.ok) continue;
        } catch (error) {
          console.warn(`The room for ${claim.issue} didn't hear that its PR closed. The next run tries again.`, error);
          continue;
        }
        await setPrState(deps.db, record.claimId, outcome.state, outcome.at);
        if (outcome.state === 'merged') run.merged += 1;
        else run.closed += 1;
      }
    }
  } catch (error) {
    if (error instanceof SyncStopped) {
      run.stopped = error.reason;
      console.warn(`The PR job stopped. ${error.message}`);
    } else if (error instanceof GitHubError) {
      run.stopped = 'github_error';
      console.warn(`The PR job stopped. GitHub answered ${String(error.status)}: ${error.message}`);
    } else {
      throw error;
    }
  }
  run.calls = deps.github.calls;
  console.log(
    `The PR job read open PRs: ${String(run.checked)} of ${String(open.length)}, merged: ${String(run.merged)}, closed: ${String(run.closed)}, calls to GitHub: ${String(run.calls)}. Left: ${JSON.stringify(deps.github.left())}.${run.stopped === null ? '' : ` Stopped: ${run.stopped}.`}`,
  );
  return run;
}
