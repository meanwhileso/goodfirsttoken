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

/** The repo's entry on the do-not-list, compared without case, or null. */
export async function getDoNotListEntry(db: D1Database, repo: string): Promise<DoNotListEntry | null> {
  const row = await db
    .prepare('SELECT * FROM do_not_list WHERE repo = ?')
    .bind(mustParse(repoName, repo, 'repo'))
    .first<EntryRow>();
  return row === null ? null : toEntry(row);
}
