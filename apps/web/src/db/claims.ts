import { claimRecordSchema, githubId, id, mustParse, type ClaimRecord } from '@goodfirsttoken/core';
import { joinIssue, prColumns, prFromColumns, splitIssue } from './shared';

// The claims table: a mirror of each issue room's claims, for search and the
// leaderboard. The issue room holds the claim and decides every change.

interface ClaimRow {
  id: string;
  issue_repo: string;
  issue_number: number;
  project: string;
  github_id: number;
  login: string;
  agent: string;
  own_project: number;
  start_commit: string;
  token_estimate: number | null;
  state: string;
  claimed_at: number;
  last_update_at: number;
  submitted_at: number | null;
  release_reason: string | null;
  pr_repo: string | null;
  pr_number: number | null;
  pr_url: string | null;
}

function toClaim(row: ClaimRow): ClaimRecord {
  return mustParse(
    claimRecordSchema,
    {
      id: row.id,
      issue: joinIssue(row.issue_repo, row.issue_number),
      project: row.project,
      githubId: row.github_id,
      login: row.login,
      agent: row.agent,
      ownProject: row.own_project === 1,
      startCommit: row.start_commit,
      tokenEstimate: row.token_estimate,
      state: row.state,
      claimedAt: row.claimed_at,
      lastUpdateAt: row.last_update_at,
      submittedAt: row.submitted_at,
      releaseReason: row.release_reason,
      pr: prFromColumns(row.pr_repo, row.pr_number, row.pr_url),
    },
    'claim',
  );
}

/**
 * Saves a claim as the issue room holds it. Saving it again updates its
 * timeline, PR, and token estimate. A claim's issue, project, claimant,
 * agent, start commit, and claim time never change, so a save that changes
 * one is refused.
 */
export async function saveClaim(db: D1Database, claim: ClaimRecord): Promise<void> {
  const c = mustParse(claimRecordSchema, claim, 'claim');
  const { repo, number } = splitIssue(c.issue);
  const result = await db
    .prepare(
      `INSERT INTO claims (id, issue_repo, issue_number, project, github_id, login, agent, own_project,
         start_commit, token_estimate, state, claimed_at, last_update_at, submitted_at, release_reason,
         pr_repo, pr_number, pr_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         token_estimate = excluded.token_estimate, state = excluded.state,
         last_update_at = excluded.last_update_at, submitted_at = excluded.submitted_at,
         release_reason = excluded.release_reason, pr_repo = excluded.pr_repo,
         pr_number = excluded.pr_number, pr_url = excluded.pr_url
       WHERE claims.issue_repo = excluded.issue_repo AND claims.issue_number = excluded.issue_number
         AND claims.project = excluded.project AND claims.github_id = excluded.github_id
         AND claims.login = excluded.login AND claims.agent = excluded.agent
         AND claims.own_project = excluded.own_project AND claims.start_commit = excluded.start_commit
         AND claims.claimed_at = excluded.claimed_at`,
    )
    .bind(
      c.id,
      repo,
      number,
      c.project,
      c.githubId,
      c.login,
      c.agent,
      c.ownProject ? 1 : 0,
      c.startCommit,
      c.tokenEstimate,
      c.state,
      c.claimedAt,
      c.lastUpdateAt,
      c.submittedAt,
      c.releaseReason,
      ...prColumns(c.pr),
    )
    .run();
  if (result.meta.changes !== 1) {
    throw new Error(
      `Claim ${c.id} is already stored with a different issue, project, claimant, agent, start commit, or claim time.`,
    );
  }
}

export async function getClaim(db: D1Database, claimId: string): Promise<ClaimRecord | null> {
  const row = await db
    .prepare('SELECT * FROM claims WHERE id = ?')
    .bind(mustParse(id, claimId, 'claimId'))
    .first<ClaimRow>();
  return row === null ? null : toClaim(row);
}

/** Every claim on an issue, like `owner/name#12`, in the order they were made. */
export async function listIssueClaims(db: D1Database, issue: string): Promise<ClaimRecord[]> {
  const { repo, number } = splitIssue(issue);
  const { results } = await db
    .prepare('SELECT * FROM claims WHERE issue_repo = ? AND issue_number = ? ORDER BY claimed_at, id')
    .bind(repo, number)
    .all<ClaimRow>();
  return results.map(toClaim);
}

/** Every claim a person made, newest first. */
export async function listPersonClaims(db: D1Database, person: number): Promise<ClaimRecord[]> {
  const { results } = await db
    .prepare('SELECT * FROM claims WHERE github_id = ? ORDER BY claimed_at DESC, id')
    .bind(mustParse(githubId, person, 'githubId'))
    .all<ClaimRow>();
  return results.map(toClaim);
}
