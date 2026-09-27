import { count, epochMs, issueSyncSchema, mustParse, repoName, type IssueSync } from '@goodfirsttoken/core';
import { checkTime } from './shared';

// The issue_syncs table: where the tagged-issue sync (src/sync/issues.ts)
// stands for each project. A pass reads each of a project's tagged issues
// once, and can take several runs.

interface SyncRow {
  project: string;
  pass_started_at: number | null;
  read_at: number | null;
  tried_at: number;
}

function toSync(row: SyncRow): IssueSync {
  return mustParse(
    issueSyncSchema,
    { project: row.project, passStartedAt: row.pass_started_at, readAt: row.read_at, triedAt: row.tried_at },
    'issue sync',
  );
}

/** Where the sync stands for the project, or null before any run started on it. */
export async function getIssueSync(db: D1Database, project: string): Promise<IssueSync | null> {
  const row = await db
    .prepare('SELECT * FROM issue_syncs WHERE project = ?')
    .bind(mustParse(repoName, project, 'project'))
    .first<SyncRow>();
  return row === null ? null : toSync(row);
}

/**
 * The approved projects a scheduled run syncs, in the order it takes them:
 * any with a pass in progress, so a run picks up where the last one
 * stopped, then the one whose issues were read longest ago, never first,
 * then the oldest added. Projects whose repo or issue repo is on the
 * do-not-list are left out.
 */
export async function listProjectsToSync(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT p.repo FROM projects p LEFT JOIN issue_syncs s ON s.project = p.repo
       WHERE p.status = 'approved'
         AND NOT EXISTS (SELECT 1 FROM do_not_list d WHERE d.repo IN (p.repo, p.issue_repo))
       ORDER BY s.pass_started_at IS NULL, s.read_at IS NOT NULL, s.read_at, p.added_at, p.repo`,
    )
    .all<{ repo: string }>();
  return results.map((row) => mustParse(repoName, row.repo, 'repo'));
}

/** Records that a scheduled run started on the project at `now`. */
export async function markSyncTried(db: D1Database, project: string, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO issue_syncs (project, pass_started_at, read_at, tried_at) VALUES (?1, NULL, NULL, ?2)
       ON CONFLICT (project) DO UPDATE SET tried_at = ?2`,
    )
    .bind(mustParse(repoName, project, 'project'), checkTime(now))
    .run();
}

/**
 * Takes a turn to sync the project at `now`, for a refresh a maintainer
 * asked for. True, with the try recorded, unless a run started on the
 * project less than `interval` ago. Two refreshes at the same moment get
 * one turn between them.
 */
export async function takeSyncTurn(db: D1Database, project: string, now: number, interval: number): Promise<boolean> {
  const at = checkTime(now);
  const row = await db
    .prepare(
      `INSERT INTO issue_syncs (project, pass_started_at, read_at, tried_at) VALUES (?1, NULL, NULL, ?2)
       ON CONFLICT (project) DO UPDATE SET tried_at = ?2 WHERE issue_syncs.tried_at <= ?3
       RETURNING project`,
    )
    .bind(mustParse(repoName, project, 'project'), at, at - mustParse(count, interval, 'interval'))
    .first<{ project: string }>();
  return row !== null;
}

/**
 * When the project's pass in progress started, or a new pass that starts
 * now. A new pass always starts after the last one finished, so an issue
 * read in the last pass never counts as read in this one.
 */
export async function beginPass(db: D1Database, project: string, now: number): Promise<number> {
  const name = mustParse(repoName, project, 'project');
  const row = await db
    .prepare(
      `INSERT INTO issue_syncs (project, pass_started_at, read_at, tried_at) VALUES (?1, ?2, NULL, ?2)
       ON CONFLICT (project) DO UPDATE SET pass_started_at = MAX(?2, COALESCE(issue_syncs.read_at + 1, 0))
         WHERE issue_syncs.pass_started_at IS NULL
       RETURNING pass_started_at`,
    )
    .bind(name, checkTime(now))
    .first<{ pass_started_at: number }>();
  if (row !== null) return mustParse(epochMs, row.pass_started_at, 'passStartedAt');
  const sync = await getIssueSync(db, name);
  if (sync?.passStartedAt == null) throw new Error(`The sync of ${name} has no pass in progress.`);
  return sync.passStartedAt;
}

/**
 * Finishes the pass that started at `startedAt`: every tagged issue has
 * been read, and the last of them at `now`. A pass that another run
 * finished already stays as it was.
 */
export async function finishPass(db: D1Database, project: string, startedAt: number, now: number): Promise<void> {
  await db
    .prepare('UPDATE issue_syncs SET pass_started_at = NULL, read_at = ?3 WHERE project = ?1 AND pass_started_at = ?2')
    .bind(mustParse(repoName, project, 'project'), checkTime(startedAt, 'startedAt'), checkTime(now))
    .run();
}
