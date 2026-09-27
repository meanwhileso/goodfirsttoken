import {
  budgetLeft,
  githubId,
  id,
  mustParse,
  queueSchema,
  sessionRecordSchema,
  type Budget,
  type SessionRecord,
} from '@goodfirsttoken/core';
import { checkTime, fromJson, newId } from './shared';

// The donor_sessions table: each run of a donor spending tokens, with its
// budget and the picks waiting in its queue.

interface SessionRow {
  id: string;
  github_id: number;
  agent: string;
  budget: string;
  started_at: number;
  issues_claimed: number;
  queue: string;
}

function toSession(row: SessionRow): SessionRecord {
  return mustParse(
    sessionRecordSchema,
    {
      id: row.id,
      githubId: row.github_id,
      agent: row.agent,
      budget: fromJson(row.budget),
      startedAt: row.started_at,
      issuesClaimed: row.issues_claimed,
      queue: fromJson(row.queue),
    },
    'session',
  );
}

/** Starts a session for a donor at `now`, with no issues claimed and nothing queued yet. */
export async function createSession(
  db: D1Database,
  session: { githubId: number; agent: string; budget: Budget },
  now: number,
): Promise<SessionRecord> {
  const record = mustParse(
    sessionRecordSchema,
    { ...session, id: newId('s'), startedAt: checkTime(now), issuesClaimed: 0, queue: [] },
    'session',
  );
  await db
    .prepare(
      `INSERT INTO donor_sessions (id, github_id, agent, budget, started_at, issues_claimed, queue)
       VALUES (?, ?, ?, ?, ?, 0, '[]')`,
    )
    .bind(record.id, record.githubId, record.agent, JSON.stringify(record.budget), record.startedAt)
    .run();
  return record;
}

export async function getSession(db: D1Database, sessionId: string): Promise<SessionRecord | null> {
  const row = await db
    .prepare('SELECT * FROM donor_sessions WHERE id = ?')
    .bind(mustParse(id, sessionId, 'sessionId'))
    .first<SessionRow>();
  return row === null ? null : toSession(row);
}

/** The donor's most recent session, or null before their first. */
export async function lastSession(db: D1Database, person: number): Promise<SessionRecord | null> {
  const row = await db
    .prepare('SELECT * FROM donor_sessions WHERE github_id = ? ORDER BY started_at DESC, id LIMIT 1')
    .bind(mustParse(githubId, person, 'githubId'))
    .first<SessionRow>();
  return row === null ? null : toSession(row);
}

/**
 * Counts one more issue claimed in the session, and returns the session.
 * Concurrent claims each count. Null when there's no such session.
 */
export async function countSessionIssue(db: D1Database, sessionId: string): Promise<SessionRecord | null> {
  const row = await db
    .prepare('UPDATE donor_sessions SET issues_claimed = issues_claimed + 1 WHERE id = ? RETURNING *')
    .bind(mustParse(id, sessionId, 'sessionId'))
    .first<SessionRow>();
  return row === null ? null : toSession(row);
}

/** How many times a count is tried when other claims in the session keep landing first. */
const COUNT_ATTEMPTS = 5;

/**
 * Counts one more issue against the session's budget at `now`, before the
 * claim is made, and returns the session. Null when the budget is spent, as
 * core's budgetLeft says, or there's no such session. Each count lands only
 * on the count it read, so claims at the same moment never take more issues
 * than the budget has. Give a count back with returnSessionIssue when the
 * claim isn't made.
 */
export async function takeSessionIssue(db: D1Database, sessionId: string, now: number): Promise<SessionRecord | null> {
  const at = checkTime(now);
  for (let attempt = 0; attempt < COUNT_ATTEMPTS; attempt++) {
    const session = await getSession(db, sessionId);
    if (session === null || budgetLeft(session, at).spent) return null;
    const row = await db
      .prepare(
        'UPDATE donor_sessions SET issues_claimed = issues_claimed + 1 WHERE id = ? AND issues_claimed = ? RETURNING *',
      )
      .bind(session.id, session.issuesClaimed)
      .first<SessionRow>();
    if (row !== null) return toSession(row);
  }
  throw new Error(`Session ${sessionId} kept changing while an issue was counted.`);
}

/** Gives back an issue takeSessionIssue counted, for a claim that wasn't made. */
export async function returnSessionIssue(db: D1Database, sessionId: string): Promise<void> {
  await db
    .prepare('UPDATE donor_sessions SET issues_claimed = issues_claimed - 1 WHERE id = ? AND issues_claimed > 0')
    .bind(mustParse(id, sessionId, 'sessionId'))
    .run();
}

/** Replaces the picks waiting in the session's queue. Null when there's no such session. */
export async function setSessionQueue(
  db: D1Database,
  sessionId: string,
  queue: readonly string[],
): Promise<SessionRecord | null> {
  const row = await db
    .prepare('UPDATE donor_sessions SET queue = ? WHERE id = ? RETURNING *')
    .bind(JSON.stringify(mustParse(queueSchema, queue, 'queue')), mustParse(id, sessionId, 'sessionId'))
    .first<SessionRow>();
  return row === null ? null : toSession(row);
}
