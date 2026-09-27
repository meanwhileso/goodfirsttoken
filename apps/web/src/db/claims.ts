import {
  claimRecordSchema,
  count,
  githubId,
  holdsSlot,
  id,
  mustParse,
  repoName,
  type ClaimRecord,
} from '@goodfirsttoken/core';
import { checkTime, joinIssue, prColumns, prFromColumns, splitIssue } from './shared';

// The claims table: a mirror of each issue room's claims, for search and the
// leaderboard. The issue room holds the claim and decides every change, and
// numbers each version it saves.

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

// Whether the stored claim's fixed fields match the save's, as SQL over the
// save's parameters. `stored` prefixes the column names. The upsert and the
// check that explains a refused save both use it, so they test the same
// fields.
function sameFixedFields(stored: string): string {
  return [
    'issue_repo = ?2',
    'issue_number = ?3',
    'project = ?4',
    'github_id = ?5',
    'login = ?6',
    'agent = ?7',
    'own_project = ?8',
    'start_commit = ?9',
    'claimed_at = ?12',
  ]
    .map((test) => stored + test)
    .join(' AND ');
}

// Whether the save names a PR and the PRs table holds a different one for the
// claim. A save with no PR passes, since the room may save before it records
// the PR the PRs table already has. addPr checks the other way the same way.
const OTHER_PR = `EXISTS (SELECT 1 FROM prs WHERE prs.claim_id = ?1
  AND ?17 IS NOT NULL AND (prs.repo != ?16 OR prs.number != ?17))`;

const UPSERT = `
  INSERT INTO claims (id, issue_repo, issue_number, project, github_id, login, agent, own_project,
    start_commit, token_estimate, state, claimed_at, last_update_at, submitted_at, release_reason,
    pr_repo, pr_number, pr_url, revision)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
  ON CONFLICT (id) DO UPDATE SET
    token_estimate = ?10, state = ?11, last_update_at = ?13, submitted_at = ?14, release_reason = ?15,
    pr_repo = ?16, pr_number = ?17, pr_url = ?18, revision = ?19
  WHERE ?19 > claims.revision AND ${sameFixedFields('claims.')} AND NOT ${OTHER_PR}`;

const WHY_NOT_SAVED = `
  SELECT (${sameFixedFields('')}) AS same_fixed, ?19 > revision AS newer, ${OTHER_PR} AS other_pr,
    (SELECT repo || '#' || number FROM prs WHERE claim_id = ?1) AS recorded_pr
  FROM claims WHERE id = ?1`;

/**
 * Saves a claim as the issue room holds it, as the room's `revision` of it.
 * The room numbers the versions of a claim it saves, and each change gets a
 * higher number. Saving a claim again updates its timeline, PR, token
 * estimate, and revision, and applies only when its revision is higher than
 * the stored one. A stale save, older or repeated, changes nothing and
 * returns false.
 *
 * A save is refused when it changes a field that is fixed once the claim is
 * made: its issue, project, claimant, login, agent, own-project flag, start
 * commit, or claim time. It is refused too when it names a PR other than the
 * one the PRs table records for the claim, so the two tables never name two
 * different PRs for one claim. A save with no PR is not refused, because the
 * room may not have recorded the PR yet.
 */
export async function saveClaim(db: D1Database, claim: ClaimRecord, revision: number): Promise<boolean> {
  const c = mustParse(claimRecordSchema, claim, 'claim');
  const rev = mustParse(count, revision, 'revision');
  const { repo, number } = splitIssue(c.issue);
  const values = [
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
    rev,
  ];
  const result = await db.prepare(UPSERT).bind(...values).run();
  if (result.meta.changes === 1) return true;

  const why = await db
    .prepare(WHY_NOT_SAVED)
    .bind(...values)
    .first<{ same_fixed: number; newer: number; other_pr: number; recorded_pr: string | null }>();
  if (why?.same_fixed === 0) {
    throw new Error(
      `Claim ${c.id} is already stored with a different issue, project, claimant, login, agent, own-project flag, start commit, or claim time.`,
    );
  }
  if (why?.newer === 0) return false;
  if (why?.other_pr === 1 && c.pr !== null) {
    throw new Error(
      `The PRs table records ${why.recorded_pr ?? 'a PR'} for claim ${c.id}. The claim can't have ${c.pr.repo}#${String(c.pr.number)}.`,
    );
  }
  throw new Error(`Claim ${c.id} was not saved.`);
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

/**
 * How many claims in a project hold a slot at `now`: people working on its
 * issues. A claim the table still has as working but whose deadline passed
 * doesn't count, as the issue room would free its slot.
 */
export async function countWorkingClaims(db: D1Database, project: string, now: number): Promise<number> {
  const at = checkTime(now);
  const { results } = await db
    .prepare(
      `SELECT * FROM claims WHERE project = ? AND state IN ('active', 'paused', 'awaiting_review')`,
    )
    .bind(mustParse(repoName, project, 'project'))
    .all<ClaimRow>();
  return results.map(toClaim).filter((claim) => holdsSlot(claim, at)).length;
}
