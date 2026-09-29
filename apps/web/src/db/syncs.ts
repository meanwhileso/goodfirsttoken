import { count, epochMs, issueSyncSchema, mustParse, repoName, type IssueSync } from '@goodfirsttoken/core';
import { checkTime } from './shared';

// The issue_syncs table: where the tagged-issue sync (src/sync/issues.ts)
// stands for each project. A pass reads each of a project's tagged issues
// once, and can take several runs. One run at a time holds a project while
// it reads it.

interface SyncRow {
  project: string;
  pass_started_at: number | null;
  read_at: number | null;
  refreshed_at: number | null;
  reading_until: number | null;
  language: string | null;
  delisted: string | null;
  delisted_at: number | null;
  repos_read_at: number | null;
}

function toSync(row: SyncRow): IssueSync {
  return mustParse(
    issueSyncSchema,
    {
      project: row.project,
      passStartedAt: row.pass_started_at,
      readAt: row.read_at,
      refreshedAt: row.refreshed_at,
      readingUntil: row.reading_until,
      language: row.language,
      delisted: row.delisted,
      delistedAt: row.delisted_at,
      reposReadAt: row.repos_read_at,
    },
    'issue sync',
  );
}

const languageOf = issueSyncSchema.shape.language;
const delistedFor = issueSyncSchema.shape.delisted;

/** Keeps the code repo's main language as GitHub named it, or null when it names none. */
export async function setProjectLanguage(db: D1Database, project: string, language: string | null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO issue_syncs (project, pass_started_at, read_at, refreshed_at, reading_until, language)
       VALUES (?1, NULL, NULL, NULL, NULL, ?2)
       ON CONFLICT (project) DO UPDATE SET language = ?2`,
    )
    .bind(mustParse(repoName, project, 'project'), mustParse(languageOf, language, 'language'))
    .run();
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

/**
 * Keeps what the sync saw of the project's code repo and issue repo at
 * `now`: why GitHub delists the project, or null when it showed both repos
 * public and open. The mark hides what the site cached from them, whatever
 * the project's status, until the sync sees them again. A mark set now,
 * where there was none, keeps `now` as when the sync delisted the project,
 * until it comes off. A read that finds the repos private, archived,
 * blocked, or gone again keeps that time, whatever its words.
 */
export async function setDelisted(db: D1Database, project: string, delisted: string | null, now: number): Promise<void> {
  // SET reads the row as it was, so issue_syncs.delisted is the mark before this read.
  await db
    .prepare(
      `INSERT INTO issue_syncs (project, pass_started_at, read_at, refreshed_at, reading_until, delisted, delisted_at, repos_read_at)
       VALUES (?1, NULL, NULL, NULL, NULL, ?2, CASE WHEN ?2 IS NULL THEN NULL ELSE ?3 END, ?3)
       ON CONFLICT (project) DO UPDATE SET
         delisted = ?2,
         delisted_at = CASE
           WHEN ?2 IS NULL THEN NULL
           WHEN issue_syncs.delisted IS NULL THEN ?3
           ELSE issue_syncs.delisted_at
         END,
         repos_read_at = ?3`,
    )
    .bind(mustParse(repoName, project, 'project'), mustParse(delistedFor, delisted, 'delisted'), checkTime(now))
    .run();
}

/**
 * The projects whose repos alone a scheduled run reads, before it reads any
 * project's issues: every paused project, and every approved one the sync
 * delisted, as after a resume, the one whose repos were read longest ago
 * first, never first, then the oldest added. Projects whose repo or issue
 * repo is on the do-not-list are left out, as they are from the passes.
 */
export async function listProjectsToCheck(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT p.repo FROM projects p LEFT JOIN issue_syncs s ON s.project = p.repo
       WHERE (p.status = 'paused' OR (p.status = 'approved' AND s.delisted IS NOT NULL))
         AND NOT EXISTS (SELECT 1 FROM do_not_list d WHERE d.repo IN (p.repo, p.issue_repo))
       ORDER BY s.repos_read_at IS NOT NULL, s.repos_read_at, p.added_at, p.repo`,
    )
    .all<{ repo: string }>();
  return results.map((row) => mustParse(repoName, row.repo, 'repo'));
}

/**
 * Holds the project for a scheduled run from `now` until `until`, so no
 * other run reads it meanwhile. False when another run holds it. A hold
 * whose time is up counts as none, so a run that died frees the project.
 */
export async function holdProject(db: D1Database, project: string, now: number, until: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO issue_syncs (project, pass_started_at, read_at, refreshed_at, reading_until)
       VALUES (?1, NULL, NULL, NULL, ?3)
       ON CONFLICT (project) DO UPDATE SET reading_until = ?3
         WHERE issue_syncs.reading_until IS NULL OR issue_syncs.reading_until <= ?2
       RETURNING project`,
    )
    .bind(mustParse(repoName, project, 'project'), checkTime(now), checkTime(until, 'until'))
    .first<{ project: string }>();
  return row !== null;
}

/** Lets go of the hold that runs out at `until`. A hold another run took since stays. */
export async function releaseProject(db: D1Database, project: string, until: number): Promise<void> {
  await db
    .prepare('UPDATE issue_syncs SET reading_until = NULL WHERE project = ? AND reading_until = ?')
    .bind(mustParse(repoName, project, 'project'), checkTime(until, 'until'))
    .run();
}

/**
 * Takes a maintainer's refresh of the project at `now`, holding it until
 * `until`. `taken` records the refresh and the hold, in one statement, so two
 * refreshes at the same moment get one turn between them. `too_soon` when an
 * earlier refresh started less than `interval` ago, and `busy` when another
 * run holds the project.
 */
export async function takeRefresh(
  db: D1Database,
  project: string,
  now: number,
  interval: number,
  until: number,
): Promise<'taken' | 'too_soon' | 'busy'> {
  const name = mustParse(repoName, project, 'project');
  const at = checkTime(now);
  const earliest = at - mustParse(count, interval, 'interval');
  const row = await db
    .prepare(
      `INSERT INTO issue_syncs (project, pass_started_at, read_at, refreshed_at, reading_until)
       VALUES (?1, NULL, NULL, ?2, ?4)
       ON CONFLICT (project) DO UPDATE SET refreshed_at = ?2, reading_until = ?4
         WHERE (issue_syncs.refreshed_at IS NULL OR issue_syncs.refreshed_at <= ?3)
           AND (issue_syncs.reading_until IS NULL OR issue_syncs.reading_until <= ?2)
       RETURNING project`,
    )
    .bind(name, at, earliest, checkTime(until, 'until'))
    .first<{ project: string }>();
  if (row !== null) return 'taken';
  const sync = await getIssueSync(db, name);
  return sync?.refreshedAt != null && sync.refreshedAt > earliest ? 'too_soon' : 'busy';
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
      `INSERT INTO issue_syncs (project, pass_started_at, read_at, refreshed_at, reading_until)
       VALUES (?1, ?2, NULL, NULL, NULL)
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
