import {
  MAX_REMOVALS_WITHDRAWN,
  githubId,
  githubLogin,
  id,
  mustParse,
  removalReason,
  removalRequestSchema,
  removalStatusSchema,
  repoName,
  type RemovalRequest,
} from '@goodfirsttoken/core';
import { checkTime, newId } from './shared';

// The removal_requests table: maintainers' requests to have a repo removed,
// waiting for an admin, or closed when an admin removed the repo or a
// maintainer of it withdrew the request.

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
  // A new reason is checked as request_removal takes it. The request's own
  // schema also reads reasons stored under the fold before, so it is looser.
  const reason = mustParse(removalReason, ask.reason, 'reason');
  for (let attempt = 0; attempt < 3; attempt++) {
    const request = mustParse(
      removalRequestSchema,
      { ...ask, reason, id: newId('rem'), requestedAt: checkTime(now), status: 'waiting', closedBy: null, closedAt: null },
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
 * The last request `requestedBy` made for the repo, compared without case,
 * waiting or closed, or null when they made none.
 */
export async function lastRemovalBy(db: D1Database, repo: string, requestedBy: number): Promise<RemovalRequest | null> {
  const row = await db
    .prepare(
      'SELECT * FROM removal_requests WHERE repo = ? AND requested_by = ? ORDER BY requested_at DESC, id DESC LIMIT 1',
    )
    .bind(mustParse(repoName, repo, 'repo'), mustParse(githubId, requestedBy, 'requestedBy'))
    .first<RequestRow>();
  return row === null ? null : toRequest(row);
}

/** A request someone other than its asker withdrew: who asked, who withdrew it, and when. */
export interface WithdrawnByOther {
  requestedBy: string;
  withdrawnBy: string;
  withdrawnAt: number;
}

interface WithdrawnRow {
  requested_by: string;
  withdrawn_by: string;
  withdrawn_at: number;
  total: number;
}

/**
 * The repo's requests, compared without case, that someone other than their
 * asker withdrew since an admin last removed the repo on a request, or every
 * one with no such removal. One query reads the first
 * MAX_REMOVALS_WITHDRAWN withdrawn, first withdrawn first, with the logins
 * of who asked and who withdrew each, and counts the rest, so the repo's
 * maintainers can't make the queue longer or slower by trading withdrawals.
 */
export async function withdrawnByOthers(
  db: D1Database,
  repo: string,
): Promise<{ first: WithdrawnByOther[]; more: number }> {
  const { results } = await db
    .prepare(
      `SELECT asker.login AS requested_by, withdrawer.login AS withdrawn_by, r.closed_at AS withdrawn_at,
              COUNT(*) OVER () AS total
       FROM removal_requests r
       JOIN people asker ON asker.github_id = r.requested_by
       JOIN people withdrawer ON withdrawer.github_id = r.closed_by
       WHERE r.repo = ?1 AND r.status = 'withdrawn' AND r.closed_by != r.requested_by
         AND r.requested_at >= COALESCE(
           (SELECT MAX(closed_at) FROM removal_requests WHERE repo = ?1 AND status = 'removed'), 0)
       ORDER BY r.closed_at, r.id
       LIMIT ?2`,
    )
    .bind(mustParse(repoName, repo, 'repo'), MAX_REMOVALS_WITHDRAWN)
    .all<WithdrawnRow>();
  const first = results.map((row) => ({
    requestedBy: mustParse(githubLogin, row.requested_by, 'requestedBy'),
    withdrawnBy: mustParse(githubLogin, row.withdrawn_by, 'withdrawnBy'),
    withdrawnAt: checkTime(row.withdrawn_at, 'withdrawnAt'),
  }));
  return { first, more: (results[0]?.total ?? 0) - first.length };
}

/** The request with this ID, waiting or closed, or null. */
export async function getRemoval(db: D1Database, requestId: string): Promise<RemovalRequest | null> {
  const row = await db
    .prepare('SELECT * FROM removal_requests WHERE id = ?')
    .bind(mustParse(id, requestId, 'requestId'))
    .first<RequestRow>();
  return row === null ? null : toRequest(row);
}

/**
 * Closes the repo's waiting request, compared without case, at `now`:
 * `removed` by the admin who removed the repo, or `withdrawn` by the
 * maintainer who took it back. Only a waiting request closes, so a closed one
 * keeps who closed it and when. The closed request stays, as the record of
 * who asked. Returns it, or null when none waited.
 */
export async function closeRemoval(
  db: D1Database,
  repo: string,
  close: { status: 'removed' | 'withdrawn'; by: number },
  now: number,
): Promise<RemovalRequest | null> {
  const row = await db
    .prepare(
      `UPDATE removal_requests SET status = ?, closed_by = ?, closed_at = ?
       WHERE repo = ? AND status = 'waiting'
       RETURNING *`,
    )
    .bind(
      mustParse(removalStatusSchema, close.status, 'status'),
      mustParse(githubId, close.by, 'by'),
      checkTime(now),
      mustParse(repoName, repo, 'repo'),
    )
    .first<RequestRow>();
  return row === null ? null : toRequest(row);
}
