// What the public pages show of a person's work, as SQL, in one place for
// every query that counts or lists it: the homepage's merged this week, a
// project's merged work and top helpers, the leaderboard, a person's page,
// and the ended PRs a donor's session offers. Each piece reads a claim as
// `c`, a claims row, and its PR as `p`, a prs row, which may be missing
// when the query joins it with LEFT JOIN. The index.ts barrel leaves this
// module out, since nothing outside src/db/ builds SQL.

/** True when the claimant is a blocked donor. Their work shows nowhere. */
const BLOCKED = `EXISTS (SELECT 1 FROM donor_blocks b WHERE b.github_id = c.github_id)`;

/**
 * True when the do-not-list names one of `repos`, or the repo the claim's
 * project keeps its issues in now.
 */
function doNotListNames(repos: string): string {
  return `EXISTS (SELECT 1 FROM do_not_list d
    WHERE d.repo IN (${repos})
      OR d.repo = (SELECT issue_repo FROM projects WHERE repo = c.project))`;
}

/**
 * A claim the site shows: not a blocked donor's, and not one the
 * do-not-list names by its project, the repo its issue is in, or the
 * project's issue repo now.
 */
export const CLAIM_SHOWN = `NOT ${BLOCKED} AND NOT ${doNotListNames('c.project, c.issue_repo')}`;

/**
 * A claim and its PR the site shows: as CLAIM_SHOWN, and the do-not-list
 * doesn't name the PR's repo either. With no PR, as through a LEFT JOIN, it
 * is CLAIM_SHOWN, since the PR's repo is NULL and matches nothing.
 */
export const SHOWN = `NOT ${BLOCKED} AND NOT ${doNotListNames('c.project, c.issue_repo, p.repo')}`;
