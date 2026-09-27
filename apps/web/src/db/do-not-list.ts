import { doNotListEntrySchema, mustParse, repoName, type DoNotListEntry } from '@goodfirsttoken/core';
import { checkTime } from './shared';

// The do_not_list table: repos whose maintainers asked to be removed.

interface EntryRow {
  repo: string;
  reason: string | null;
  added_by: number;
  added_at: number;
}

function toEntry(row: EntryRow): DoNotListEntry {
  return mustParse(
    doNotListEntrySchema,
    { repo: row.repo, reason: row.reason, addedBy: row.added_by, addedAt: row.added_at },
    'do-not-list entry',
  );
}

const entryInput = doNotListEntrySchema.pick({ repo: true, reason: true, addedBy: true });

/** Puts a repo on the do-not-list. A repo already on it keeps its first entry. */
export async function addToDoNotList(
  db: D1Database,
  entry: { repo: string; reason: string | null; addedBy: number },
  now: number,
): Promise<DoNotListEntry> {
  const input = mustParse(entryInput, entry, 'do-not-list entry');
  const row = await db
    .prepare(
      `INSERT INTO do_not_list (repo, reason, added_by, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (repo) DO NOTHING
       RETURNING *`,
    )
    .bind(input.repo, input.reason, input.addedBy, checkTime(now))
    .first<EntryRow>();
  if (row !== null) return toEntry(row);
  const stored = await getDoNotListEntry(db, input.repo);
  if (stored === null) throw new Error(`${input.repo} was not added to the do-not-list.`);
  return stored;
}

/** Takes a repo off the do-not-list. False when it wasn't on it. */
export async function removeFromDoNotList(db: D1Database, repo: string): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM do_not_list WHERE repo = ?')
    .bind(mustParse(repoName, repo, 'repo'))
    .run();
  return result.meta.changes > 0;
}

/**
 * Which of these repos the do-not-list covers, as the repos where issues
 * live: a repo on the list, or the issue repo of a project whose code repo
 * is on it now. Each comes back in lower case. The repos go in as one JSON
 * array, so any number of them takes one query, under D1's limit on bound
 * values.
 */
export async function doNotListedAmong(db: D1Database, repos: Iterable<string>): Promise<Set<string>> {
  const checked = [...new Set([...repos].map((repo) => mustParse(repoName, repo, 'repo').toLowerCase()))];
  if (checked.length === 0) return new Set();
  const { results } = await db
    .prepare(
      `SELECT j.value AS repo FROM json_each(?) j
       WHERE EXISTS (SELECT 1 FROM do_not_list d WHERE d.repo = j.value)
          OR EXISTS (SELECT 1 FROM projects p JOIN do_not_list d ON d.repo = p.repo WHERE p.issue_repo = j.value)`,
    )
    .bind(JSON.stringify(checked))
    .all<{ repo: string }>();
  return new Set(results.map((row) => row.repo.toLowerCase()));
}

/** The repo's entry on the do-not-list, compared without case, or null. */
export async function getDoNotListEntry(db: D1Database, repo: string): Promise<DoNotListEntry | null> {
  const row = await db
    .prepare('SELECT * FROM do_not_list WHERE repo = ?')
    .bind(mustParse(repoName, repo, 'repo'))
    .first<EntryRow>();
  return row === null ? null : toEntry(row);
}
