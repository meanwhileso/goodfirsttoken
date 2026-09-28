import {
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
  repo: string;
  branch: string;
  commit_sha: string;
  base: string;
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
}

function toSubmission(row: SubmissionRow): SubmissionRecord {
  return mustParse(
    submissionRecordSchema,
    {
      claimId: row.claim_id,
      repo: row.repo,
      branch: row.branch,
      commit: row.commit_sha,
      base: row.base,
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
         additions, deletions, review_reason, submitted_at, base)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
       ON CONFLICT (claim_id) DO UPDATE SET repo = ?2, branch = ?3, commit_sha = ?4, paths = ?5, title = ?6,
         summary = ?7, checks = ?8, agent = ?9, model = ?10, additions = ?11, deletions = ?12,
         review_reason = ?13, submitted_at = ?14, base = ?15
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
    )
    .first<SubmissionRow>();
  if (row === null) throw new Error(`Claim ${s.claimId}'s submission was not saved.`);
  return toSubmission(row);
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
