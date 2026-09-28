import { githubId, mustParse, removalRequestSchema, repoName, type RemovalRequest } from '@goodfirsttoken/core';
import { checkTime, newId } from './shared';

// The removal_requests table: maintainers' requests to have a repo removed,
// waiting for an admin, or closed when an admin removed the repo.

interface RequestRow {
  id: string;
  repo: string;
  reason: string;
  requested_by: number;
  requested_at: number;
  status: string;
  closed_by: number | null;
  closed_at: number | null;
}

function toRequest(row: RequestRow): RemovalRequest {
  return mustParse(
    removalRequestSchema,
    {
      id: row.id,
      repo: row.repo,
      reason: row.reason,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      status: row.status,
      closedBy: row.closed_by,
      closedAt: row.closed_at,
    },
    'removal request',
  );
}

/** A request, and whether this call made it. */
export interface AskedRemoval {
  request: RemovalRequest;
  /** False when a request for the repo was waiting already, which this call left as it was. */
  created: boolean;
}

/**
 * Records a maintainer's request to have `repo` removed, made at `now`. A
 * repo has at most one request waiting, whatever the case of its name, so
 * while one waits this keeps it, with its reason, who asked, and when, and
 * adds nothing. A repo whose request was closed can be asked for again.
 */
export async function askRemoval(
  db: D1Database,
  ask: { repo: string; reason: string; requestedBy: number },
  now: number,
): Promise<AskedRemoval> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const request = mustParse(
      removalRequestSchema,
      { ...ask, id: newId('rem'), requestedAt: checkTime(now), status: 'waiting', closedBy: null, closedAt: null },
      'removal request',
    );
    // The unique index on waiting requests turns a second one into nothing.
    const row = await db
      .prepare(
        `INSERT INTO removal_requests (id, repo, reason, requested_by, requested_at, status, closed_by, closed_at)
         VALUES (?, ?, ?, ?, ?, 'waiting', NULL, NULL)
         ON CONFLICT DO NOTHING
         RETURNING *`,
      )
      .bind(request.id, request.repo, request.reason, request.requestedBy, request.requestedAt)
      .first<RequestRow>();
    if (row !== null) return { request: toRequest(row), created: true };
    const waiting = await getWaitingRemoval(db, request.repo);
    if (waiting !== null) return { request: waiting, created: false };
    // The request that waited was closed between the insert and the read, so
    // this one can wait now.
  }
  throw new Error(`${ask.repo}'s request to be removed kept changing while it was made.`);
}

/** The repo's request waiting for an admin, compared without case, or null. */
export async function getWaitingRemoval(db: D1Database, repo: string): Promise<RemovalRequest | null> {
  const row = await db
    .prepare("SELECT * FROM removal_requests WHERE repo = ? AND status = 'waiting'")
    .bind(mustParse(repoName, repo, 'repo'))
    .first<RequestRow>();
  return row === null ? null : toRequest(row);
}

/** Every request waiting for an admin, oldest first. */
export async function listWaitingRemovals(db: D1Database): Promise<RemovalRequest[]> {
  const { results } = await db
    .prepare("SELECT * FROM removal_requests WHERE status = 'waiting' ORDER BY requested_at, id")
    .all<RequestRow>();
  return results.map(toRequest);
}

/**
 * Closes the repo's waiting request, compared without case, as removed by
 * the admin `by` at `now`. The closed request stays, as the record of who
 * asked. Returns it, or null when none waited.
 */
export async function closeRemoval(db: D1Database, repo: string, by: number, now: number): Promise<RemovalRequest | null> {
  const row = await db
    .prepare(
      `UPDATE removal_requests SET status = 'removed', closed_by = ?, closed_at = ?
       WHERE repo = ? AND status = 'waiting'
       RETURNING *`,
    )
    .bind(mustParse(githubId, by, 'by'), checkTime(now), mustParse(repoName, repo, 'repo'))
    .first<RequestRow>();
  return row === null ? null : toRequest(row);
}
