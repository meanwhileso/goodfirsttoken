import { githubId, githubRepoId, MAX_LIVE_REQUESTS, MAX_REQUESTS_PER_DAY, mustParse, repoName } from '@goodfirsttoken/core';
import { checkTime, newId } from './shared';

// The repo_requests table: donors' requests for a repo they want to work on
// (src/requests/request.ts). Each keeps the repo by GitHub's ID, with the
// name GitHub gave when the person asked, and stores no status. A withdrawn
// request is kept, so it still counts toward the person's requests that day.

/** One person's request for one repo. */
export interface RepoRequest {
  id: string;
  repoId: number;
  /** The repo as GitHub named it when the person asked. */
  repo: string;
  githubId: number;
  requestedAt: number;
  withdrawnAt: number | null;
}

interface RequestRow {
  id: string;
  repo_id: number;
  repo: string;
  github_id: number;
  requested_at: number;
  withdrawn_at: number | null;
}

function toRequest(row: RequestRow): RepoRequest {
  return {
    id: row.id,
    repoId: mustParse(githubRepoId, row.repo_id, 'repoId'),
    repo: mustParse(repoName, row.repo, 'repo'),
    githubId: mustParse(githubId, row.github_id, 'githubId'),
    requestedAt: checkTime(row.requested_at, 'requestedAt'),
    withdrawnAt: row.withdrawn_at === null ? null : checkTime(row.withdrawn_at, 'withdrawnAt'),
  };
}

const DAY_MS = 86_400_000;

/** The start of the UTC day a time falls on. Epoch time has no leap seconds, so each UTC day is DAY_MS long. */
function startOfUtcDay(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

/** The person's live request for the repo, by its GitHub ID, or null. */
export async function getLiveRequest(db: D1Database, person: number, repoId: number): Promise<RepoRequest | null> {
  const row = await db
    .prepare('SELECT * FROM repo_requests WHERE github_id = ? AND repo_id = ? AND withdrawn_at IS NULL')
    .bind(mustParse(githubId, person, 'githubId'), mustParse(githubRepoId, repoId, 'repoId'))
    .first<RequestRow>();
  return row === null ? null : toRequest(row);
}

/**
 * The person's live request for a repo GitHub named `repo` when they asked,
 * compared without case, or null. For withdrawing a request for a repo
 * GitHub no longer shows, so it gives no ID.
 */
export async function getLiveRequestByName(db: D1Database, person: number, repo: string): Promise<RepoRequest | null> {
  const row = await db
    .prepare('SELECT * FROM repo_requests WHERE github_id = ? AND repo = ? AND withdrawn_at IS NULL ORDER BY requested_at DESC LIMIT 1')
    .bind(mustParse(githubId, person, 'githubId'), mustParse(repoName, repo, 'repo'))
    .first<RequestRow>();
  return row === null ? null : toRequest(row);
}

/** What adding a request did. */
export type AddedRequest =
  | { added: RepoRequest }
  /** The person has a live request for the repo already, so nothing was recorded. */
  | { live: RepoRequest }
  /** The person sent MAX_REQUESTS_PER_DAY today, withdrawn ones included. */
  | { limit: 'day'; nextAt: number }
  /** The person has MAX_LIVE_REQUESTS live. */
  | { limit: 'live' };

/**
 * Records the person's request for the repo at `now`, in one statement that
 * checks both limits and the live request, so two calls at once can't pass
 * a limit or record the repo twice.
 */
export async function addRequest(
  db: D1Database,
  request: { repoId: number; repo: string; githubId: number },
  now: number,
): Promise<AddedRequest> {
  const person = mustParse(githubId, request.githubId, 'githubId');
  const repoId = mustParse(githubRepoId, request.repoId, 'repoId');
  const at = checkTime(now);
  const dayStart = startOfUtcDay(at);
  const row = await db
    .prepare(
      `INSERT INTO repo_requests (id, repo_id, repo, github_id, requested_at, withdrawn_at)
       SELECT ?1, ?2, ?3, ?4, ?5, NULL
       WHERE (SELECT COUNT(*) FROM repo_requests WHERE github_id = ?4 AND requested_at >= ?6) < ?7
         AND (SELECT COUNT(*) FROM repo_requests WHERE github_id = ?4 AND withdrawn_at IS NULL) < ?8
       ON CONFLICT (github_id, repo_id) WHERE withdrawn_at IS NULL DO NOTHING
       RETURNING *`,
    )
    .bind(newId('rq'), repoId, mustParse(repoName, request.repo, 'repo'), person, at, dayStart, MAX_REQUESTS_PER_DAY, MAX_LIVE_REQUESTS)
    .first<RequestRow>();
  if (row !== null) return { added: toRequest(row) };
  const live = await getLiveRequest(db, person, repoId);
  if (live !== null) return { live };
  const today = await db
    .prepare('SELECT COUNT(*) AS n FROM repo_requests WHERE github_id = ? AND requested_at >= ?')
    .bind(person, dayStart)
    .first<{ n: number }>();
  if ((today?.n ?? 0) >= MAX_REQUESTS_PER_DAY) return { limit: 'day', nextAt: dayStart + DAY_MS };
  return { limit: 'live' };
}

/** Withdraws the request at `now`. True when it was live. */
export async function withdrawRequest(db: D1Database, id: string, now: number): Promise<boolean> {
  const result = await db
    .prepare('UPDATE repo_requests SET withdrawn_at = ? WHERE id = ? AND withdrawn_at IS NULL')
    .bind(checkTime(now), id)
    .run();
  return result.meta.changes === 1;
}

/** Every request the person made, live or withdrawn, newest first. */
export async function listPersonRequests(db: D1Database, person: number): Promise<RepoRequest[]> {
  const { results } = await db
    .prepare('SELECT * FROM repo_requests WHERE github_id = ? ORDER BY requested_at DESC, id DESC')
    .bind(mustParse(githubId, person, 'githubId'))
    .all<RequestRow>();
  return results.map(toRequest);
}
