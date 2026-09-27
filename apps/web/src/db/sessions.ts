import {
  githubId,
  id,
  mustParse,
  sessionRecordSchema,
  type Budget,
  type SessionRecord,
} from '@goodfirsttoken/core';
import { checkTime, fromJson, newId } from './shared';

// The donor_sessions table: each run of a donor spending tokens, with its
// budget.

interface SessionRow {
  id: string;
  github_id: number;
  agent: string;
  budget: string;
  started_at: number;
  issues_claimed: number;
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
    },
    'session',
  );
}

/** Starts a session for a donor at `now`, with no issues claimed yet. */
export async function createSession(
  db: D1Database,
  session: { githubId: number; agent: string; budget: Budget },
  now: number,
): Promise<SessionRecord> {
  const record = mustParse(
    sessionRecordSchema,
    { ...session, id: newId('s'), startedAt: checkTime(now), issuesClaimed: 0 },
    'session',
  );
  await db
    .prepare(
      `INSERT INTO donor_sessions (id, github_id, agent, budget, started_at, issues_claimed)
       VALUES (?, ?, ?, ?, ?, 0)`,
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
