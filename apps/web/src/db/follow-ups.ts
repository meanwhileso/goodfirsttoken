import {
  count,
  followUpId,
  followUpOutcomeSchema,
  followUpQuestion,
  followUpRecordSchema,
  followUpStateSchema,
  githubId,
  id,
  issueRef,
  mustParse,
  prRefSchema,
  repoName,
  webUrl,
  type FollowUpRecord,
  type PrRef,
} from '@goodfirsttoken/core';
import { checkTime, joinIssue, prFromColumns } from './shared';
import { ASKING_FOR_HELP } from './waiting';

// The follow_ups table: what maintainers and review bots wrote on each
// claim's open PR, and its failed checks and conflicts, as the PR job read
// them, and where each stands: open, waiting for the reviewer or the donor,
// or settled by a submit, the donor's agent, or a read that superseded it.
// The rules are in docs/how-it-works.md, under PRs and The donor's tools.

interface FollowUpRow {
  claim_id: string;
  comment_id: string;
  kind: string;
  reviewer: string | null;
  author_kind: string | null;
  body: string;
  path: string | null;
  url: string;
  written_at: number;
  read_at: number;
  shown_at: number | null;
  answered_at: number | null;
  state: string;
  outcome: string | null;
  question: string | null;
  reply_url: string | null;
}

function toFollowUp(row: FollowUpRow): FollowUpRecord {
  return mustParse(
    followUpRecordSchema,
    {
      claimId: row.claim_id,
      commentId: row.comment_id,
      kind: row.kind,
      reviewer: row.reviewer,
      authorKind: row.author_kind,
      body: row.body,
      path: row.path,
      url: row.url,
      writtenAt: row.written_at,
      readAt: row.read_at,
      shownAt: row.shown_at,
      answeredAt: row.answered_at,
      state: row.state,
      outcome: row.outcome,
      question: row.question,
      replyUrl: row.reply_url,
    },
    'follow-up',
  );
}

/** A review or comment the PR job read, before it is stored. */
export type NewFollowUp = Omit<
  FollowUpRecord,
  'claimId' | 'readAt' | 'shownAt' | 'answeredAt' | 'state' | 'outcome' | 'question' | 'replyUrl'
>;

/** The fields a follow-up has when the PR job first stores it: open, and shown to no one. */
const NEW_STATE = { shownAt: null, answeredAt: null, state: 'open', outcome: null, question: null, replyUrl: null } as const;

/**
 * Stores what the PR job read on a claim's PR at `readAt`, in one
 * statement, in the order given, each one open. A follow-up read before,
 * by its comment ID, stays as it was first read, and as it stands. So
 * checks that fail again on the same head add none. A conflict adds none
 * while another on the claim isn't settled, since a base that moves on
 * gives the same conflict a new ID. supersedeFollowUps runs first, and
 * settles one for an older head. The claim must be in the claims table.
 * Returns how many are new.
 */
export async function saveFollowUps(
  db: D1Database,
  claimId: string,
  followUps: readonly NewFollowUp[],
  readAt: number,
): Promise<number> {
  const rows = followUps.map((followUp) =>
    mustParse(followUpRecordSchema, { ...followUp, claimId, readAt, ...NEW_STATE }, 'follow-up'),
  );
  if (rows.length === 0) return 0;
  // The rows go in as one JSON array, so any number of them takes one
  // query. A WHERE lets SQLite read ON CONFLICT after a SELECT.
  const result = await db
    .prepare(
      `INSERT INTO follow_ups (claim_id, comment_id, kind, reviewer, author_kind, body, path, url, written_at, read_at, shown_at,
         answered_at, state, outcome, question, reply_url)
       SELECT ?1, json_extract(j.value, '$.commentId'), json_extract(j.value, '$.kind'), json_extract(j.value, '$.reviewer'),
         json_extract(j.value, '$.authorKind'), json_extract(j.value, '$.body'), json_extract(j.value, '$.path'),
         json_extract(j.value, '$.url'), json_extract(j.value, '$.writtenAt'), ?2, NULL, NULL, 'open', NULL, NULL, NULL
       FROM json_each(?3) j
       WHERE json_extract(j.value, '$.kind') <> 'conflict' OR NOT EXISTS
         (SELECT 1 FROM follow_ups w WHERE w.claim_id = ?1 AND w.kind = 'conflict' AND w.state <> 'settled')
       ORDER BY j.key
       ON CONFLICT (claim_id, comment_id) DO NOTHING`,
    )
    .bind(mustParse(id, claimId, 'claimId'), checkTime(readAt, 'readAt'), JSON.stringify(rows))
    .run();
  return result.meta.changes;
}

/** What a read of a claim's open PR showed of its head and whether it can merge. */
export interface HeadRead {
  claimId: string;
  /** The PR's head, GitHub's `headRefOid`. */
  head: string;
  /** GitHub's `mergeable`: `MERGEABLE`, `CONFLICTING`, or `UNKNOWN`, or null when it gave none. */
  mergeable: string | null;
  /** When the read was made. */
  readAt: number;
}

/**
 * Settles as superseded, at `now`, the checks and conflicts these reads
 * replaced, in one statement for all of them: checks for any head but the
 * one read, every conflict on a PR the read found `MERGEABLE`, and a
 * conflict for another head on a PR it found `CONFLICTING`. A conflict on
 * the same head stays, since a base that moves on gives it a new ID.
 * `UNKNOWN` supersedes no conflict. Only follow-ups that aren't settled,
 * and that were stored by the time of the read, are taken, so a read made
 * before another that lands after it supersedes nothing that one stored.
 * Returns how many it settled.
 */
export async function supersedeFollowUps(db: D1Database, reads: readonly HeadRead[], now: number): Promise<number> {
  if (reads.length === 0) return 0;
  const rows = reads.map((read) => ({
    claimId: mustParse(id, read.claimId, 'claimId'),
    head: read.head,
    mergeable: read.mergeable,
    readAt: checkTime(read.readAt, 'readAt'),
  }));
  const result = await db
    .prepare(
      `UPDATE follow_ups SET state = 'settled', outcome = 'superseded', answered_at = ?1, question = NULL
       FROM (SELECT json_extract(j.value, '$.claimId') AS claim_id, json_extract(j.value, '$.head') AS head,
               json_extract(j.value, '$.mergeable') AS mergeable, json_extract(j.value, '$.readAt') AS read_at
             FROM json_each(?2) j) r
       WHERE follow_ups.claim_id = r.claim_id AND follow_ups.state <> 'settled' AND follow_ups.read_at <= r.read_at
         AND ((follow_ups.kind = 'checks' AND follow_ups.comment_id <> r.head)
           OR (follow_ups.kind = 'conflict' AND (r.mergeable = 'MERGEABLE'
             OR (r.mergeable = 'CONFLICTING' AND substr(follow_ups.comment_id, 1, length(r.head) + 1) <> r.head || ':'))))`,
    )
    .bind(checkTime(now), JSON.stringify(rows))
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
}

/**
 * When a follow-up on a claim `c` shows, over its PR `pr` and its project
 * `p`: the PR is open in the PRs table, the project asks for help, and the
 * claimant isn't blocked. Exactly then submit_work would take a fix.
 */
const SHOWS = `pr.state = 'open' AND ${ASKING_FOR_HELP}
  AND NOT EXISTS (SELECT 1 FROM donor_blocks b WHERE b.github_id = c.github_id)`;

/**
 * The states of the follow-ups the tools list: open ones, and those that
 * wait for the donor, with the agent's question. One that waits for its
 * reviewer, or settled, lists no more.
 */
const LISTED = `('open', 'waiting_donor')`;

/**
 * How many follow-ups on the claim's PR wait that no tool has shown yet,
 * counting only those listWaitingFollowUps would list, for check_pr to say
 * my_work has new ones.
 */
export async function countUnshownFollowUps(db: D1Database, claimId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM claims c
       JOIN follow_ups f ON f.claim_id = c.id
       JOIN prs pr ON pr.claim_id = c.id
       JOIN submissions sub ON sub.claim_id = c.id
       JOIN projects p ON p.repo = c.project
       WHERE c.id = ? AND f.state IN ${LISTED} AND f.shown_at IS NULL AND ${SHOWS}`,
    )
    .bind(mustParse(id, claimId, 'claimId'))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * The donor's follow-ups that are open or wait for the donor, at most
 * `limit` of them: every one that waits for the donor first, then the rest
 * taken in turn from each claim, its oldest first: the oldest of each,
 * then the next of each, and so on. So a question for the donor is never
 * left out, and a PR with many follow-ups hides no other PR's. The ones
 * taken come back the same way, those that wait for the donor first, then
 * oldest first, with how many wait in all. Each is on one of their claims
 * whose PR the PRs table shows open, with its submitted work, while its
 * project asks for help and the donor isn't blocked: exactly when
 * submit_work would take a fix. A follow-up on a project on the
 * do-not-list, or one the sync delisted, stays stored, and shows nowhere.
 */
export async function listWaitingFollowUps(
  db: D1Database,
  person: number,
  limit: number,
): Promise<{ followUps: WaitingFollowUp[]; waiting: number }> {
  const { results } = await db
    .prepare(
      `SELECT * FROM (
         SELECT f.*, f.rowid AS seq, c.issue_repo, c.issue_number, c.project, pr.repo AS pr_repo, pr.number AS pr_number,
           pr.url AS pr_url, sub.repo AS branch_repo, sub.branch,
           f.state <> 'waiting_donor' AS later,
           ROW_NUMBER() OVER (PARTITION BY f.claim_id ORDER BY f.written_at, f.rowid) AS turn,
           COUNT(*) OVER () AS waiting
         FROM claims c
         JOIN follow_ups f ON f.claim_id = c.id
         JOIN prs pr ON pr.claim_id = c.id
         JOIN submissions sub ON sub.claim_id = c.id
         JOIN projects p ON p.repo = c.project
         WHERE c.github_id = ?1 AND f.state IN ${LISTED} AND ${SHOWS}
         ORDER BY later, turn, f.written_at, f.rowid
         LIMIT ?2)
       ORDER BY later, written_at, seq`,
    )
    .bind(mustParse(githubId, person, 'githubId'), mustParse(count, limit, 'limit'))
    .all<WaitingRow & { waiting: number }>();
  const followUps = results.map((row) => ({
    record: toFollowUp(row),
    issue: mustParse(issueRef, joinIssue(row.issue_repo, row.issue_number), 'issue'),
    project: mustParse(repoName, row.project, 'project'),
    pr: mustParse(prRefSchema, prFromColumns(row.pr_repo, row.pr_number, row.pr_url), 'pr'),
    branch: { repo: mustParse(repoName, row.branch_repo, 'branch.repo'), name: row.branch },
  }));
  return { followUps, waiting: mustParse(count, results[0]?.waiting ?? 0, 'waiting') };
}

/** One of the donor's open PRs that the PR job read in part. */
export interface ReadInPartPr {
  claimId: string;
  issue: string;
  pr: PrRef;
  reviews: number;
  reviewsRead: number;
  commentsLeftOut: number;
  conversation: number;
  conversationRead: number;
}

/**
 * The donor's open PRs that the PR job's reads took in part, in the order
 * they opened, when their follow-ups would show: more reviews than the
 * reads took, comments on lines of a maintainer's or a bot's review they
 * left out, or more comments in the conversation than they took.
 */
export async function listReadInPart(db: D1Database, person: number): Promise<ReadInPartPr[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id AS claim_id, c.issue_repo, c.issue_number, pr.repo AS pr_repo, pr.number AS pr_number,
         pr.url AS pr_url, pr.reviews, pr.reviews_read, pr.comments_left_out, pr.conversation, pr.conversation_read
       FROM claims c
       JOIN prs pr ON pr.claim_id = c.id
       JOIN projects p ON p.repo = c.project
       WHERE c.github_id = ?1
         AND (pr.reviews > pr.reviews_read OR pr.comments_left_out > 0 OR pr.conversation > pr.conversation_read) AND ${SHOWS}
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
      conversation: number;
      conversation_read: number;
    }>();
  return results.map((row) => ({
    claimId: mustParse(id, row.claim_id, 'claimId'),
    issue: mustParse(issueRef, joinIssue(row.issue_repo, row.issue_number), 'issue'),
    pr: mustParse(prRefSchema, prFromColumns(row.pr_repo, row.pr_number, row.pr_url), 'pr'),
    reviews: mustParse(count, row.reviews, 'reviews'),
    reviewsRead: mustParse(count, row.reviews_read, 'reviewsRead'),
    commentsLeftOut: mustParse(count, row.comments_left_out, 'commentsLeftOut'),
    conversation: mustParse(count, row.conversation, 'conversation'),
    conversationRead: mustParse(count, row.conversation_read, 'conversationRead'),
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

/** What settles a follow-up as fixed at ?2, as a submit does. */
const FIXED = `state = 'settled', outcome = 'fixed', answered_at = ?2, question = NULL`;

/**
 * Settles as fixed the claim's follow-ups, not settled yet, that a tool
 * showed at `now` or before, as a submit to the claim with no `answers`
 * does once it lands. A follow-up read since, or not shown yet, stays as it
 * is. Returns how many it settled.
 */
export async function answerFollowUps(db: D1Database, claimId: string, now: number): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE follow_ups SET ${FIXED}
       WHERE claim_id = ?1 AND state <> 'settled' AND shown_at IS NOT NULL AND shown_at <= ?2`,
    )
    .bind(mustParse(id, claimId, 'claimId'), checkTime(now))
    .run();
  return result.meta.changes;
}

/**
 * Settles as fixed, at `now`, the claim's follow-ups with these IDs that
 * aren't settled yet, as a submit with `answers` does once it lands. No
 * other follow-up changes. Returns how many it settled.
 */
export async function answerFollowUpsById(
  db: D1Database,
  claimId: string,
  ids: readonly string[],
  now: number,
): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await db
    .prepare(
      `UPDATE follow_ups SET ${FIXED}
       WHERE claim_id = ?1 AND state <> 'settled' AND comment_id IN (SELECT value FROM json_each(?3))`,
    )
    .bind(mustParse(id, claimId, 'claimId'), checkTime(now), JSON.stringify(ids.map((key) => mustParse(followUpId, key, 'followUpId'))))
    .run();
  return result.meta.changes;
}

/** The IDs among these that name no follow-up on the claim, in their order. */
export async function unknownFollowUps(db: D1Database, claimId: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { results } = await db
    .prepare('SELECT comment_id FROM follow_ups WHERE claim_id = ?1 AND comment_id IN (SELECT value FROM json_each(?2))')
    .bind(mustParse(id, claimId, 'claimId'), JSON.stringify(ids))
    .all<{ comment_id: string }>();
  const known = new Set(results.map((row) => row.comment_id));
  return ids.filter((key) => !known.has(key));
}

/** How an agent sorts one follow-up, as sort_follow_ups takes it. */
export interface FollowUpSort {
  followUpId: string;
  state: 'waiting_reviewer' | 'waiting_donor' | 'settled';
  outcome?: 'replied' | 'no_change' | 'resolved' | undefined;
  question?: string | undefined;
  replyUrl?: string | undefined;
}

/**
 * Sets each named follow-up on the claim as the agent sorted it, at `now`,
 * in one statement: its state, and its outcome, question, and reply's link
 * as the sort gives them. A reply's link given before stays when a sort
 * gives none. A follow-up settled as fixed or superseded stays as it is,
 * since a submit or a read settled it. answered_at is set when it first
 * settles, and cleared when it doesn't. Returns the IDs it changed. Every ID must
 * name a follow-up on the claim, as unknownFollowUps checks.
 */
export async function sortFollowUps(
  db: D1Database,
  claimId: string,
  sorts: readonly FollowUpSort[],
  now: number,
): Promise<Set<string>> {
  if (sorts.length === 0) return new Set();
  const rows = sorts.map((sort) => ({
    id: mustParse(followUpId, sort.followUpId, 'followUpId'),
    state: mustParse(followUpStateSchema, sort.state, 'state'),
    outcome: sort.state === 'settled' ? mustParse(followUpOutcomeSchema, sort.outcome, 'outcome') : null,
    question: sort.state === 'waiting_donor' ? mustParse(followUpQuestion, sort.question, 'question') : null,
    replyUrl: sort.replyUrl === undefined ? null : mustParse(webUrl, sort.replyUrl, 'replyUrl'),
  }));
  const { results } = await db
    .prepare(
      `UPDATE follow_ups SET state = s.state, outcome = s.outcome, question = s.question,
         reply_url = COALESCE(s.reply_url, follow_ups.reply_url), answered_at = iif(s.state = 'settled', COALESCE(follow_ups.answered_at, ?2), NULL)
       FROM (SELECT json_extract(j.value, '$.id') AS comment_id, json_extract(j.value, '$.state') AS state,
               json_extract(j.value, '$.outcome') AS outcome, json_extract(j.value, '$.question') AS question,
               json_extract(j.value, '$.replyUrl') AS reply_url
             FROM json_each(?3) j) s
       WHERE follow_ups.claim_id = ?1 AND follow_ups.comment_id = s.comment_id
         AND follow_ups.outcome IS NOT 'fixed' AND follow_ups.outcome IS NOT 'superseded'
       RETURNING follow_ups.comment_id`,
    )
    .bind(mustParse(id, claimId, 'claimId'), checkTime(now), JSON.stringify(rows))
    .all<{ comment_id: string }>();
  return new Set(results.map((row) => row.comment_id));
}

/** Every follow-up read on a claim's PR, oldest first, answered or not. */
export async function listClaimFollowUps(db: D1Database, claimId: string): Promise<FollowUpRecord[]> {
  const { results } = await db
    .prepare('SELECT * FROM follow_ups WHERE claim_id = ? ORDER BY written_at, rowid')
    .bind(mustParse(id, claimId, 'claimId'))
    .all<FollowUpRow>();
  return results.map(toFollowUp);
}
