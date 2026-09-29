import type { PrRef } from '@goodfirsttoken/core';
import { setPrState } from '../db';
import { issueRoom, type IssueRoom } from '../rooms/issue-room';

// A claim's own PR that the PR job recorded closed without merging, found
// open on GitHub again, or merged since. The PR job's read of the PRs it
// recorded closed finds one, and so does a read of an issue's linked PRs,
// by a pass of the tagged-issue sync or the PR job's read of an issue
// again. Both record it here. The rules are in docs/how-it-works.md, under
// Reopened in PRs.

export interface ReopenDeps {
  db: D1Database;
  rooms: DurableObjectNamespace<IssueRoom>;
  now: () => number;
}

/**
 * Records open again a claim's own PR on `issue` that the PR job recorded
 * closed without merging. The claim's issue room hears first, and takes
 * posts and submits for the claim again, with the PR open on the issue,
 * then the prs table, so the PR job follows the PR again, and a session
 * offers how it ends. True once both took it. False when the room didn't
 * open it again, as for a claim it doesn't hold with this PR, and the PR
 * stays closed for the next read to try again.
 */
export async function reopenClaimPr(deps: ReopenDeps, claim: { claimId: string; issue: string; pr: PrRef }): Promise<boolean> {
  try {
    const told = await issueRoom(deps.rooms, claim.issue).claimPrReopened({ claimId: claim.claimId, pr: claim.pr });
    if (!told.ok || !told.reopened) return false;
  } catch (error) {
    console.warn(`The room for ${claim.issue} didn't hear that a claim's PR is open again. The next read tries again.`, error);
    return false;
  }
  await setPrState(deps.db, claim.claimId, 'open', deps.now());
  return true;
}
