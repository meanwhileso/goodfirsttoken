import {
  agentName,
  count,
  githubId,
  githubLogin,
  id,
  issueRef,
  mustParse,
  prRecordSchema,
  prRefSchema,
  prStateSchema,
  repoName,
  type PrRecord,
  type PrRef,
  type PrState,
} from '@goodfirsttoken/core';
import { checkTime, joinIssue, prFromColumns, splitIssue } from './shared';

// The prs table: the PR opened for each claim, followed until it merges or
// closes.

interface PrRow {
  claim_id: string;
  repo: string;
  number: number;
  url: string;
  state: string;
  opened_at: number;
  merged_at: number | null;
  closed_at: number | null;
}

function toPr(row: PrRow): PrRecord {
  return mustParse(
    prRecordSchema,
    {
      claimId: row.claim_id,
      pr: prFromColumns(row.repo, row.number, row.url),
      state: row.state,
      openedAt: row.opened_at,
      mergedAt: row.merged_at,
      closedAt: row.closed_at,
    },
    'PR',
  );
}

function samePr(repo: string, number: number, pr: PrRef): boolean {
  return repo.toLowerCase() === pr.repo.toLowerCase() && number === pr.number;
}

function name(repo: string, number: number): string {
  return `${repo}#${String(number)}`;
}

/**
 * Records the PR opened for a claim, as open. The PR must be the one the
 * claim records, once it records one. A claim has one PR, so recording the
 * same PR again keeps the first record, and a different one is refused. A PR
 * recorded for another claim is refused too.
 */
export async function addPr(
  db: D1Database,
  added: { claimId: string; pr: PrRef; openedAt: number },
): Promise<PrRecord> {
  const record = mustParse(
    prRecordSchema,
    { ...added, state: 'open', mergedAt: null, closedAt: null },
    'PR',
  );
  const { claimId, pr } = record;
  // The claim's own PR is checked in the same statement as the insert, and
  // saveClaim checks this table the same way, so the two always agree.
  const inserted = await db
    .prepare(
      `INSERT INTO prs (claim_id, repo, number, url, state, opened_at, merged_at, closed_at)
       SELECT ?1, ?2, ?3, ?4, 'open', ?5, NULL, NULL
       WHERE EXISTS (SELECT 1 FROM claims WHERE id = ?1
         AND (pr_number IS NULL OR (pr_repo = ?2 AND pr_number = ?3)))
       ON CONFLICT DO NOTHING
       RETURNING *`,
    )
    .bind(claimId, pr.repo, pr.number, pr.url, record.openedAt)
    .first<PrRow>();
  if (inserted !== null) return toPr(inserted);

  // Nothing was inserted. Find out why.
  const claim = await db
    .prepare('SELECT pr_repo, pr_number FROM claims WHERE id = ?')
    .bind(claimId)
    .first<{ pr_repo: string | null; pr_number: number | null }>();
  if (claim === null) throw new Error(`There is no claim ${claimId}.`);
  if (claim.pr_repo !== null && claim.pr_number !== null && !samePr(claim.pr_repo, claim.pr_number, pr)) {
    throw new Error(
      `Claim ${claimId} records ${name(claim.pr_repo, claim.pr_number)}. It can't take ${name(pr.repo, pr.number)}.`,
    );
  }
  const stored = await getPr(db, claimId);
  if (stored === null) {
    const owner = await db
      .prepare('SELECT claim_id FROM prs WHERE repo = ? AND number = ?')
      .bind(pr.repo, pr.number)
      .first<{ claim_id: string }>();
    throw new Error(`${name(pr.repo, pr.number)} is already recorded for claim ${owner?.claim_id ?? 'another claim'}.`);
  }
  if (!samePr(stored.pr.repo, stored.pr.number, pr)) {
    throw new Error(
      `Claim ${claimId} already has ${name(stored.pr.repo, stored.pr.number)}. It can't take ${name(pr.repo, pr.number)}.`,
    );
  }
  return stored;
}

/** The claim's PR, or null when it has none. */
export async function getPr(db: D1Database, claimId: string): Promise<PrRecord | null> {
  const row = await db
    .prepare('SELECT * FROM prs WHERE claim_id = ?')
    .bind(mustParse(id, claimId, 'claimId'))
    .first<PrRow>();
  return row === null ? null : toPr(row);
}

/**
 * Records the state GitHub shows for a claim's PR at `at`. Its times change
 * only when its state does, and a merged PR stays merged. Reopening a closed
 * PR clears its close time. GitHub's clock and ours can differ, so a time
 * before the PR opened counts as the time it opened. A PR recorded closed
 * without merging has its issue due to be read again, until rereadDone
 * says it was. Null when the claim has no PR.
 */
export async function setPrState(
  db: D1Database,
  claimId: string,
  state: PrState,
  at: number,
): Promise<PrRecord | null> {
  const next = mustParse(prStateSchema, state, 'state');
  const time = checkTime(at, 'at');
  const current = await getPr(db, claimId);
  if (current === null || current.state === next || current.state === 'merged') return current;
  const when = Math.max(time, current.openedAt);
  const updated = mustParse(
    prRecordSchema,
    {
      ...current,
      state: next,
      mergedAt: next === 'merged' ? when : null,
      closedAt: next === 'open' ? null : when,
    },
    'PR',
  );
  // Only from the state just read, so a change that landed since then wins.
  const row = await db
    .prepare(
      `UPDATE prs SET state = ?1, merged_at = ?2, closed_at = ?3, reread_due = CASE WHEN ?1 = 'closed' THEN 1 ELSE 0 END
       WHERE claim_id = ?4 AND state = ?5 RETURNING *`,
    )
    .bind(updated.state, updated.mergedAt, updated.closedAt, current.claimId, current.state)
    .first<PrRow>();
  return row === null ? getPr(db, current.claimId) : toPr(row);
}

/**
 * Whether `pr` is the PR of a claim on `issue`, like `owner/name#12`, and
 * still open here, so the PR job follows it and tells that issue's room
 * when it closes. A claim's PR is followed in its own issue's room only.
 */
export async function isOpenClaimPr(db: D1Database, pr: PrRef, issue: string): Promise<boolean> {
  const { repo, number } = splitIssue(issue);
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM prs p JOIN claims c ON c.id = p.claim_id
       WHERE p.repo = ? AND p.number = ? AND p.state = 'open' AND c.issue_repo = ? AND c.issue_number = ?`,
    )
    .bind(mustParse(repoName, pr.repo, 'pr.repo'), pr.number, repo, number)
    .first<{ found: number }>();
  return row !== null;
}

/** How much of a claim's open PR's reviews the PR job's latest read covered. */
export interface ReviewsRead {
  claimId: string;
  /** Every review GitHub counts on the PR, pending and dismissed ones left out. */
  reviews: number;
  /** How many of the newest the read took. */
  reviewsRead: number;
  /** Comments on lines of a maintainer's review the read took that it left out. */
  commentsLeftOut: number;
}

/** Records what the PR job's latest read covered of each PR, in one statement. */
export async function setReviewsRead(db: D1Database, read: readonly ReviewsRead[]): Promise<void> {
  if (read.length === 0) return;
  const rows = read.map((row) => ({
    claimId: mustParse(id, row.claimId, 'claimId'),
    reviews: mustParse(count, row.reviews, 'reviews'),
    reviewsRead: mustParse(count, row.reviewsRead, 'reviewsRead'),
    commentsLeftOut: mustParse(count, row.commentsLeftOut, 'commentsLeftOut'),
  }));
  await db
    .prepare(
      `UPDATE prs SET reviews = json_extract(j.value, '$.reviews'), reviews_read = json_extract(j.value, '$.reviewsRead'),
         comments_left_out = json_extract(j.value, '$.commentsLeftOut')
       FROM json_each(?) j WHERE prs.claim_id = json_extract(j.value, '$.claimId')`,
    )
    .bind(JSON.stringify(rows))
    .run();
}

/**
 * The claims whose PR closed without merging, and whose issue waits to be
 * read again, oldest close first, with the issue.
 */
export async function listRereadsDue(db: D1Database): Promise<{ claimId: string; issue: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT p.claim_id, c.issue_repo, c.issue_number FROM prs p JOIN claims c ON c.id = p.claim_id
       WHERE p.reread_due = 1 ORDER BY p.closed_at, p.claim_id`,
    )
    .all<{ claim_id: string; issue_repo: string; issue_number: number }>();
  return results.map((row) => ({
    claimId: mustParse(id, row.claim_id, 'claimId'),
    issue: mustParse(issueRef, joinIssue(row.issue_repo, row.issue_number), 'issue'),
  }));
}

/** Records that the issue of the claim's closed PR was read again. */
export async function rereadDone(db: D1Database, claimId: string): Promise<void> {
  await db.prepare('UPDATE prs SET reread_due = 0 WHERE claim_id = ?').bind(mustParse(id, claimId, 'claimId')).run();
}

/** Every PR still open, oldest first, for the job that follows them. */
export async function listOpenPrs(db: D1Database): Promise<PrRecord[]> {
  const { results } = await db
    .prepare("SELECT * FROM prs WHERE state = 'open' ORDER BY opened_at, claim_id")
    .all<PrRow>();
  return results.map(toPr);
}

/** How many PRs opened for a project's claims are open, and how many merged. */
export async function countProjectPrs(db: D1Database, project: string): Promise<{ open: number; merged: number }> {
  const { results } = await db
    .prepare(
      `SELECT prs.state AS state, COUNT(*) AS n FROM prs JOIN claims ON claims.id = prs.claim_id
       WHERE claims.project = ? GROUP BY prs.state`,
    )
    .bind(mustParse(repoName, project, 'project'))
    .all<{ state: string; n: number }>();
  const countOf = (state: PrState) => results.find((row) => row.state === state)?.n ?? 0;
  return { open: countOf('open'), merged: countOf('merged') };
}

/**
 * How many PRs opened for a person's claims are open, by each claim's
 * project, keyed by the project in lower case. A project with none is left
 * out.
 */
export async function countOpenPrsByProject(db: D1Database, person: number): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT c.project AS project, COUNT(*) AS n FROM prs p JOIN claims c ON c.id = p.claim_id
       WHERE c.github_id = ? AND p.state = 'open' GROUP BY c.project`,
    )
    .bind(mustParse(githubId, person, 'githubId'))
    .all<{ project: string; n: number }>();
  return new Map(results.map((row) => [row.project.toLowerCase(), mustParse(count, row.n, 'n')]));
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * When the week that holds `now` began: Monday at 00:00 UTC. The
 * leaderboard's week resets then, and so does the homepage's merged this
 * week.
 */
export function startOfWeek(now: number): number {
  const time = checkTime(now);
  const day = new Date(time);
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  // getUTCDay is 0 on Sunday, so Monday is 1.
  return midnight - ((day.getUTCDay() + 6) % 7) * DAY;
}

/** One person's PRs merged in a time range, for the homepage's ranks. */
export interface Merger {
  githubId: number;
  /** Their login now, from people. */
  login: string;
  /** The agent that did their latest merged PR in the range. */
  agent: string;
  merged: number;
}

interface MergerRow {
  github_id: number;
  login: string;
  agent: string;
  merged: number;
}

// A merged PR the site shows, over a PR `p` and its claim `c`: not a blocked
// donor's, and not one the do-not-list names by its repo, its claim's
// project or issue repo, or the project's issue repo now.
const SHOWN = `NOT EXISTS (SELECT 1 FROM donor_blocks b WHERE b.github_id = c.github_id)
  AND NOT EXISTS (SELECT 1 FROM do_not_list d
    WHERE d.repo IN (c.project, c.issue_repo, p.repo)
      OR d.repo = (SELECT issue_repo FROM projects WHERE repo = c.project))`;

/**
 * The people with the most shown PRs merged that `scope` picks, most first,
 * at most `limit` of them. A PR from a claim on the claimant's own project
 * doesn't count. Ties go to whoever reached the count first, then by login.
 */
async function rankMergers(
  db: D1Database,
  scope: { sql: string; binds: (string | number)[] },
  limit: number,
): Promise<Merger[]> {
  // With MAX() in the select list, SQLite takes the bare column c.agent from
  // the row that has the latest merge. A merged PR's close time is when it
  // merged.
  const { results } = await db
    .prepare(
      `SELECT c.github_id, pe.login, c.agent, COUNT(*) AS merged, MAX(p.closed_at) AS last_merged
       FROM prs p
       JOIN claims c ON c.id = p.claim_id
       JOIN people pe ON pe.github_id = c.github_id
       WHERE p.state = 'merged' AND ${scope.sql} AND c.own_project = 0 AND ${SHOWN}
       GROUP BY c.github_id
       ORDER BY merged DESC, last_merged, pe.login, c.github_id
       LIMIT ?`,
    )
    .bind(...scope.binds, mustParse(count, limit, 'limit'))
    .all<MergerRow>();
  return results.map((row) => ({
    githubId: mustParse(githubId, row.github_id, 'githubId'),
    login: mustParse(githubLogin, row.login, 'login'),
    agent: mustParse(agentName, row.agent, 'agent'),
    merged: mustParse(count, row.merged, 'merged'),
  }));
}

/**
 * The people with the most PRs merged from `from` up to `until`, most first,
 * at most `limit` of them. A PR counts when it merged in the range, from a
 * claim on someone else's project. Blocked donors are left out, and so is a
 * PR when the do-not-list names its repo, its claim's project or issue
 * repo, or the project's issue repo now. Ties go to whoever reached the
 * count first, then by login.
 */
export async function topMergers(
  db: D1Database,
  { from, until, limit }: { from: number; until: number; limit: number },
): Promise<Merger[]> {
  // Only closed_at is indexed, so the range reads prs_by_closed.
  return rankMergers(
    db,
    { sql: 'p.closed_at >= ? AND p.closed_at < ?', binds: [checkTime(from, 'from'), checkTime(until, 'until')] },
    limit,
  );
}

/**
 * A project's top helpers: the people with the most PRs merged from claims
 * on it, of all time, most first, at most `limit` of them. The rest is as
 * for topMergers: a claim on the claimant's own project doesn't count,
 * blocked donors are left out, and so are PRs the do-not-list names.
 */
export async function topHelpers(db: D1Database, project: string, limit: number): Promise<Merger[]> {
  // The project's claims through claims_by_project, and each one's PR by key.
  return rankMergers(db, { sql: 'c.project = ?', binds: [mustParse(repoName, project, 'project')] }, limit);
}

/** A merged PR from a claim, as a project page lists it. */
export interface MergedPr {
  pr: { repo: string; number: number };
  /** The issue the claim was on, like `owner/name#12`. */
  issue: string;
  githubId: number;
  /** The claimant's login now, from people. */
  login: string;
  agent: string;
  mergedAt: number;
}

/**
 * The PRs merged from claims on a project, newest merge first, left out as
 * for topMergers: a blocked donor's, or one the do-not-list names. Work on
 * the claimant's own project is in. `total` is how many there are, and
 * `prs` the first `limit` of them.
 */
export async function listMergedPrs(
  db: D1Database,
  project: string,
  limit: number,
): Promise<{ total: number; prs: MergedPr[] }> {
  const { results } = await db
    .prepare(
      `SELECT p.repo, p.number, p.merged_at, p.claim_id, c.issue_repo, c.issue_number, c.github_id, c.agent,
         pe.login, COUNT(*) OVER () AS total
       FROM claims c
       JOIN prs p ON p.claim_id = c.id
       JOIN people pe ON pe.github_id = c.github_id
       WHERE c.project = ? AND p.state = 'merged' AND ${SHOWN}
       ORDER BY p.merged_at DESC, p.claim_id
       LIMIT ?`,
    )
    .bind(mustParse(repoName, project, 'project'), mustParse(count, limit, 'limit'))
    .all<{
      repo: string;
      number: number;
      merged_at: number;
      claim_id: string;
      issue_repo: string;
      issue_number: number;
      github_id: number;
      agent: string;
      login: string;
      total: number;
    }>();
  return {
    total: mustParse(count, results[0]?.total ?? 0, 'total'),
    prs: results.map((row) => ({
      pr: splitIssue(joinIssue(row.repo, row.number)),
      issue: mustParse(issueRef, joinIssue(row.issue_repo, row.issue_number), 'issue'),
      githubId: mustParse(githubId, row.github_id, 'githubId'),
      login: mustParse(githubLogin, row.login, 'login'),
      agent: mustParse(agentName, row.agent, 'agent'),
      mergedAt: checkTime(row.merged_at, 'mergedAt'),
    })),
  };
}

/** A donor's merged PR, offered once to share. */
export interface MergedToShare {
  claimId: string;
  issue: string;
  pr: PrRef;
  agent: string;
  /** The title of the claim's latest submit, which its PR opened with, or null when it has none. */
  title: string | null;
  mergedAt: number;
}

/**
 * The donor's PRs that merged and that no session offered yet, oldest merge
 * first, marked offered at `now` in the same statement, so each is offered
 * once, however many sessions start at the same moment. Left out, and left
 * unoffered, as for listMergedPrs: a blocked donor's, and one the
 * do-not-list names. So is one on a project the sync delisted, since
 * nothing cached from its repos goes out.
 */
export async function takeMergedToOffer(db: D1Database, person: number, now: number): Promise<MergedToShare[]> {
  const { results: taken } = await db
    .prepare(
      `UPDATE prs SET offered_at = ?2
       WHERE state = 'merged' AND offered_at IS NULL AND claim_id IN (
         SELECT c.id FROM claims c JOIN prs p ON p.claim_id = c.id
         WHERE c.github_id = ?1 AND p.state = 'merged' AND ${SHOWN}
           AND NOT EXISTS (SELECT 1 FROM issue_syncs u WHERE u.project = c.project AND u.delisted IS NOT NULL))
       RETURNING claim_id`,
    )
    .bind(mustParse(githubId, person, 'githubId'), checkTime(now))
    .all<{ claim_id: string }>();
  if (taken.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT p.claim_id, p.repo, p.number, p.url, p.merged_at, c.issue_repo, c.issue_number, c.agent, sub.title
       FROM json_each(?) j
       JOIN prs p ON p.claim_id = j.value
       JOIN claims c ON c.id = p.claim_id
       LEFT JOIN submissions sub ON sub.claim_id = p.claim_id
       ORDER BY p.merged_at, p.claim_id`,
    )
    .bind(JSON.stringify(taken.map((row) => row.claim_id)))
    .all<{
      claim_id: string;
      repo: string;
      number: number;
      url: string;
      merged_at: number;
      issue_repo: string;
      issue_number: number;
      agent: string;
      title: string | null;
    }>();
  return results.map((row) => ({
    claimId: mustParse(id, row.claim_id, 'claimId'),
    issue: mustParse(issueRef, joinIssue(row.issue_repo, row.issue_number), 'issue'),
    pr: mustParse(prRefSchema, prFromColumns(row.repo, row.number, row.url), 'pr'),
    agent: mustParse(agentName, row.agent, 'agent'),
    title: row.title,
    mergedAt: checkTime(row.merged_at, 'mergedAt'),
  }));
}
