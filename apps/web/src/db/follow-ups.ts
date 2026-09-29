import {
  commitSha,
  count,
  followUpRecordSchema,
  githubId,
  id,
  issueRef,
  mustParse,
  prRefSchema,
  repoName,
  type FollowUpRecord,
  type PrRef,
} from '@goodfirsttoken/core';
import { checkTime, joinIssue, prFromColumns } from './shared';
import { ASKING_FOR_HELP } from './waiting';

// The follow_ups table: what reviewers wrote on each claim's open PR, as the
// PR job read it, until the donor answers it with a submit. The rules are
// in docs/how-it-works.md, under PRs and The donor's tools.

interface FollowUpRow {
  claim_id: string;
  comment_id: string;
  reviewer: string;
  body: string;
  path: string | null;
  url: string;
  written_at: number;
  read_at: number;
  shown_at: number | null;
  answered_at: number | null;
}

function toFollowUp(row: FollowUpRow): FollowUpRecord {
  return mustParse(
    followUpRecordSchema,
    {
      claimId: row.claim_id,
      commentId: row.comment_id,
      reviewer: row.reviewer,
      body: row.body,
      path: row.path,
      url: row.url,
      writtenAt: row.written_at,
      readAt: row.read_at,
      shownAt: row.shown_at,
      answeredAt: row.answered_at,
    },
    'follow-up',
  );
}

/** A review or comment the PR job read, before it is stored. */
export type NewFollowUp = Omit<FollowUpRecord, 'claimId' | 'readAt' | 'shownAt' | 'answeredAt'>;

/**
 * Stores what the PR job read on a claim's PR at `readAt`, in one
 * statement, in the order given. A review or comment read before, by its
 * comment ID, stays as it was first read, shown or answered. The claim must
 * be in the claims table. Returns how many are new.
 */
export async function saveFollowUps(
  db: D1Database,
  claimId: string,
  followUps: readonly NewFollowUp[],
  readAt: number,
): Promise<number> {
  const rows = followUps.map((followUp) =>
    mustParse(followUpRecordSchema, { ...followUp, claimId, readAt, shownAt: null, answeredAt: null }, 'follow-up'),
  );
  if (rows.length === 0) return 0;
  // The rows go in as one JSON array, so any number of them takes one
  // query. `WHERE true` lets SQLite read ON CONFLICT after a SELECT.
  const result = await db
    .prepare(
      `INSERT INTO follow_ups (claim_id, comment_id, reviewer, body, path, url, written_at, read_at, shown_at, answered_at)
       SELECT ?1, json_extract(j.value, '$.commentId'), json_extract(j.value, '$.reviewer'), json_extract(j.value, '$.body'),
         json_extract(j.value, '$.path'), json_extract(j.value, '$.url'), json_extract(j.value, '$.writtenAt'), ?2, NULL, NULL
       FROM json_each(?3) j WHERE true ORDER BY j.key
       ON CONFLICT (claim_id, comment_id) DO NOTHING`,
    )
    .bind(mustParse(id, claimId, 'claimId'), checkTime(readAt, 'readAt'), JSON.stringify(rows))
    .run();
  return result.meta.changes;
}

/** A follow-up waiting for the donor, with what the tools show of its claim. */
export interface WaitingFollowUp {
  record: FollowUpRecord;
  issue: string;
  /** The project's code repo. */
  project: string;
  pr: PrRef;
  /** The claim's branch, which the PR comes from. */
  branch: { repo: string; name: string };
  /** The commit a fix sends every changed file from. */
  base: string;
}

interface WaitingRow extends FollowUpRow {
  issue_repo: string;
  issue_number: number;
  project: string;
  pr_repo: string;
  pr_number: number;
  pr_url: string;
  branch_repo: string;
  branch: string;
  base: string;
}

/**
 * When a follow-up on a claim `c` shows, over its PR `pr` and its project
 * `p`: the PR is open in the PRs table, the project asks for help, and the
 * claimant isn't blocked. Exactly then submit_work would take a fix.
 */
const SHOWS = `pr.state = 'open' AND ${ASKING_FOR_HELP}
  AND NOT EXISTS (SELECT 1 FROM donor_blocks b WHERE b.github_id = c.github_id)`;

/**
 * The donor's follow-ups no submit answered yet, oldest first, at most
 * `limit` of them. Each is on one of their claims whose PR the PRs table
 * shows open, with its submitted work, while its project asks for help
 * and the donor isn't blocked: exactly when submit_work would take a fix.
 * A follow-up on a project on the do-not-list, or one the sync delisted,
 * stays stored, and shows nowhere.
 */
export async function listWaitingFollowUps(db: D1Database, person: number, limit: number): Promise<WaitingFollowUp[]> {
  const { results } = await db
    .prepare(
      `SELECT f.*, c.issue_repo, c.issue_number, c.project, pr.repo AS pr_repo, pr.number AS pr_number,
         pr.url AS pr_url, sub.repo AS branch_repo, sub.branch, sub.base
       FROM claims c
       JOIN follow_ups f ON f.claim_id = c.id
       JOIN prs pr ON pr.claim_id = c.id
       JOIN submissions sub ON sub.claim_id = c.id
       JOIN projects p ON p.repo = c.project
       WHERE c.github_id = ?1 AND f.answered_at IS NULL AND ${SHOWS}
       ORDER BY f.written_at, f.rowid
       LIMIT ?2`,
    )
    .bind(mustParse(githubId, person, 'githubId'), mustParse(count, limit, 'limit'))
    .all<WaitingRow>();
  return results.map((row) => ({
    record: toFollowUp(row),
    issue: mustParse(issueRef, joinIssue(row.issue_repo, row.issue_number), 'issue'),
    project: mustParse(repoName, row.project, 'project'),
    pr: mustParse(prRefSchema, prFromColumns(row.pr_repo, row.pr_number, row.pr_url), 'pr'),
    branch: { repo: mustParse(repoName, row.branch_repo, 'branch.repo'), name: row.branch },
    base: mustParse(commitSha, row.base, 'base'),
  }));
}

/** One of the donor's open PRs whose reviews the PR job read in part. */
export interface ReadInPartPr {
  claimId: string;
  issue: string;
  pr: PrRef;
  reviews: number;
  reviewsRead: number;
  commentsLeftOut: number;
}

/**
 * The donor's open PRs whose reviews the PR job's latest read took in
 * part, in the order they opened, when their follow-ups would show: more
 * reviews than the read took, or comments on lines of a maintainer's
 * review it left out.
 */
export async function listReadInPart(db: D1Database, person: number): Promise<ReadInPartPr[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id AS claim_id, c.issue_repo, c.issue_number, pr.repo AS pr_repo, pr.number AS pr_number,
         pr.url AS pr_url, pr.reviews, pr.reviews_read, pr.comments_left_out
       FROM claims c
       JOIN prs pr ON pr.claim_id = c.id
       JOIN projects p ON p.repo = c.project
       WHERE c.github_id = ?1 AND (pr.reviews > pr.reviews_read OR pr.comments_left_out > 0) AND ${SHOWS}
       ORDER BY pr.opened_at, c.id`,
    )
    .bind(mustParse(githubId, person, 'githubId'))
    .all<{
      claim_id: string;
      issue_repo: string;
      issue_number: number;
      pr_repo: string;
      pr_number: number;
      pr_url: string;
      reviews: number;
      reviews_read: number;
      comments_left_out: number;
    }>();
  return results.map((row) => ({
    claimId: mustParse(id, row.claim_id, 'claimId'),
    issue: mustParse(issueRef, joinIssue(row.issue_repo, row.issue_number), 'issue'),
    pr: mustParse(prRefSchema, prFromColumns(row.pr_repo, row.pr_number, row.pr_url), 'pr'),
    reviews: mustParse(count, row.reviews, 'reviews'),
    reviewsRead: mustParse(count, row.reviews_read, 'reviewsRead'),
    commentsLeftOut: mustParse(count, row.comments_left_out, 'commentsLeftOut'),
  }));
}

/** Marks these follow-ups shown at `now`, each that no tool showed before. */
export async function markFollowUpsShown(
  db: D1Database,
  shown: readonly { claimId: string; commentId: string }[],
  now: number,
): Promise<void> {
  if (shown.length === 0) return;
  const keys = shown.map((key) => [mustParse(id, key.claimId, 'claimId'), key.commentId]);
  await db
    .prepare(
      `UPDATE follow_ups SET shown_at = ?1
       WHERE shown_at IS NULL AND (claim_id, comment_id) IN
         (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?2))`,
    )
    .bind(checkTime(now), JSON.stringify(keys))
    .run();
}

/**
 * Answers the claim's follow-ups that a tool showed at `now` or before, as
 * a submit to the claim does once it lands. A follow-up read since, or not
 * shown yet, still waits. Returns how many it answered.
 */
export async function answerFollowUps(db: D1Database, claimId: string, now: number): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE follow_ups SET answered_at = ?2
       WHERE claim_id = ?1 AND answered_at IS NULL AND shown_at IS NOT NULL AND shown_at <= ?2`,
    )
    .bind(mustParse(id, claimId, 'claimId'), checkTime(now))
    .run();
  return result.meta.changes;
}

/** Every follow-up read on a claim's PR, oldest first, answered or not. */
export async function listClaimFollowUps(db: D1Database, claimId: string): Promise<FollowUpRecord[]> {
  const { results } = await db
    .prepare('SELECT * FROM follow_ups WHERE claim_id = ? ORDER BY written_at, rowid')
    .bind(mustParse(id, claimId, 'claimId'))
    .all<FollowUpRow>();
  return results.map(toFollowUp);
}
