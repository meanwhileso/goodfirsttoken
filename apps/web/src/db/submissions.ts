import {
  REVIEW_WINDOW_MS,
  githubId,
  id,
  mustParse,
  reviewReasonSchema,
  submissionRecordSchema,
  type ReviewReason,
  type SubmissionRecord,
} from '@goodfirsttoken/core';
import { fromJson } from './shared';

// The submissions table: the branch each claim's work is on, and what its
// latest submit sent. submit_work writes it after the commit lands, and
// open_pr and my_work read it.

interface SubmissionRow {
  claim_id: string;
  source: string;
  repo: string;
  branch: string;
  commit_sha: string;
  base: string;
  diff_from: string;
  paths: string;
  title: string;
  summary: string;
  checks: string;
  agent: string;
  model: string;
  additions: number | null;
  deletions: number | null;
  review_reason: string | null;
  submitted_at: number;
  cleared_commit: string | null;
  cleared_body: string | null;
  cleared_at: number | null;
}

function toSubmission(row: SubmissionRow): SubmissionRecord {
  return mustParse(
    submissionRecordSchema,
    {
      claimId: row.claim_id,
      source: row.source,
      repo: row.repo,
      branch: row.branch,
      commit: row.commit_sha,
      base: row.base,
      diffFrom: row.diff_from,
      paths: fromJson(row.paths),
      title: row.title,
      summary: row.summary,
      checks: row.checks,
      agent: row.agent,
      model: row.model,
      additions: row.additions,
      deletions: row.deletions,
      reviewReason: row.review_reason,
      submittedAt: row.submitted_at,
      clearance:
        row.cleared_commit === null || row.cleared_body === null || row.cleared_at === null
          ? null
          : { commit: row.cleared_commit, body: row.cleared_body, at: row.cleared_at },
    },
    'submission',
  );
}

/**
 * Saves a claim's latest submit, over any earlier one. The claim must be in
 * the claims table.
 */
export async function saveSubmission(db: D1Database, submission: SubmissionRecord): Promise<SubmissionRecord> {
  const s = mustParse(submissionRecordSchema, submission, 'submission');
  const row = await db
    .prepare(
      `INSERT INTO submissions (claim_id, repo, branch, commit_sha, paths, title, summary, checks, agent, model,
         additions, deletions, review_reason, submitted_at, base, diff_from, source, cleared_commit, cleared_body,
         cleared_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
       ON CONFLICT (claim_id) DO UPDATE SET repo = ?2, branch = ?3, commit_sha = ?4, paths = ?5, title = ?6,
         summary = ?7, checks = ?8, agent = ?9, model = ?10, additions = ?11, deletions = ?12,
         review_reason = ?13, submitted_at = ?14, base = ?15, diff_from = ?16, source = ?17, cleared_commit = ?18,
         cleared_body = ?19, cleared_at = ?20
       RETURNING *`,
    )
    .bind(
      s.claimId,
      s.repo,
      s.branch,
      s.commit,
      JSON.stringify(s.paths),
      s.title,
      s.summary,
      s.checks,
      s.agent,
      s.model,
      s.additions,
      s.deletions,
      s.reviewReason,
      s.submittedAt,
      s.base,
      s.diffFrom,
      s.source,
      s.clearance?.commit ?? null,
      s.clearance?.body ?? null,
      s.clearance?.at ?? null,
    )
    .first<SubmissionRow>();
  if (row === null) throw new Error(`Claim ${s.claimId}'s submission was not saved.`);
  return toSubmission(row);
}

/**
 * Saves open_pr's clearance of the claim's latest submit, or ends it with
 * null, while that submit's head is still `commit`. Null when the claim has
 * no such submission, as after a submit made meanwhile.
 */
export async function setClearance(
  db: D1Database,
  claimId: string,
  commit: string,
  clearance: SubmissionRecord['clearance'],
): Promise<SubmissionRecord | null> {
  const row = await db
    .prepare(
      'UPDATE submissions SET cleared_commit = ?3, cleared_body = ?4, cleared_at = ?5 WHERE claim_id = ?1 AND commit_sha = ?2 RETURNING *',
    )
    .bind(mustParse(id, claimId, 'claimId'), commit, clearance?.commit ?? null, clearance?.body ?? null, clearance?.at ?? null)
    .first<SubmissionRow>();
  return row === null ? null : toSubmission(row);
}

/**
 * How many of the person's claims in each project, by lowercase repo, are
 * cleared to open with no PR recorded yet, and still waiting for review at
 * `now`. They count toward the project's open-PR cap, as open PRs do.
 * `except` leaves one claim out.
 */
export async function countClearedByProject(
  db: D1Database,
  person: number,
  now: number,
  except?: string,
): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT c.project AS project, COUNT(*) AS n FROM submissions s JOIN claims c ON c.id = s.claim_id
       WHERE c.github_id = ?1 AND c.state = 'awaiting_review' AND c.submitted_at + ?2 > ?3
         AND s.cleared_at IS NOT NULL AND c.id IS NOT ?4
         AND NOT EXISTS (SELECT 1 FROM prs p WHERE p.claim_id = c.id)
       GROUP BY c.project`,
    )
    .bind(mustParse(githubId, person, 'githubId'), REVIEW_WINDOW_MS, now, except ?? null)
    .all<{ project: string; n: number }>();
  return new Map(results.map((row) => [row.project.toLowerCase(), row.n]));
}

/**
 * The claims cleared to open with no PR recorded, oldest clearance first,
 * that waited for review until `since` at least: released claims and claims
 * with a PR are left out. The job that records cleared PRs reads these.
 */
export async function listClearedWithoutPr(db: D1Database, since: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id AS id FROM submissions s JOIN claims c ON c.id = s.claim_id
       WHERE s.cleared_at IS NOT NULL AND c.state IN ('awaiting_review', 'expired') AND c.pr_number IS NULL
         AND c.submitted_at + ?1 > ?2
         AND NOT EXISTS (SELECT 1 FROM prs p WHERE p.claim_id = c.id)
       ORDER BY s.cleared_at, c.id`,
    )
    .bind(REVIEW_WINDOW_MS, since)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

/** The claim's latest submit, or null when it has none. */
export async function getSubmission(db: D1Database, claimId: string): Promise<SubmissionRecord | null> {
  const row = await db
    .prepare('SELECT * FROM submissions WHERE claim_id = ?')
    .bind(mustParse(id, claimId, 'claimId'))
    .first<SubmissionRow>();
  return row === null ? null : toSubmission(row);
}

/** The latest submit of each of these claims that has one, by claim ID. */
export async function getSubmissions(db: D1Database, claimIds: readonly string[]): Promise<Map<string, SubmissionRecord>> {
  const ids = claimIds.map((claimId) => mustParse(id, claimId, 'claimId'));
  if (ids.length === 0) return new Map();
  const { results } = await db
    .prepare('SELECT s.* FROM json_each(?) j JOIN submissions s ON s.claim_id = j.value')
    .bind(JSON.stringify(ids))
    .all<SubmissionRow>();
  return new Map(results.map((row) => [row.claim_id, toSubmission(row)]));
}

/** Records why the claim's work waits for the donor. Null when the claim has no submission. */
export async function setReviewReason(
  db: D1Database,
  claimId: string,
  reason: ReviewReason,
): Promise<SubmissionRecord | null> {
  const row = await db
    .prepare('UPDATE submissions SET review_reason = ? WHERE claim_id = ? RETURNING *')
    .bind(mustParse(reviewReasonSchema, reason, 'reason'), mustParse(id, claimId, 'claimId'))
    .first<SubmissionRow>();
  return row === null ? null : toSubmission(row);
}
