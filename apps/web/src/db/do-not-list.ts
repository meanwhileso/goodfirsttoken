import { doNotListEntrySchema, githubId, mustParse, repoName, type DoNotListEntry } from '@goodfirsttoken/core';
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

// The two statements below go in the batch of a status change, and apply
// only when that change landed: the project has the status, and was given it
// by that person at that time. So the list and the status change together,
// and a change that lands between them can't split them.

/**
 * Puts the repo on the do-not-list, keeping an entry already there, when its
 * project was just rejected by `addedBy` at `now`.
 */
export function doNotListWhenRejected(
  db: D1Database,
  entry: { repo: string; reason: string | null; addedBy: number },
  now: number,
): D1PreparedStatement {
  const input = mustParse(entryInput, entry, 'do-not-list entry');
  return db
    .prepare(
      `INSERT INTO do_not_list (repo, reason, added_by, added_at)
       SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM projects WHERE repo = ?1 AND status = 'rejected'
         AND status_changed_by = ?3 AND status_changed_at = ?4)
       ON CONFLICT (repo) DO NOTHING`,
    )
    .bind(input.repo, input.reason, input.addedBy, checkTime(now));
}

/**
 * Takes the repo off the do-not-list when the admin `by` just approved its
 * maintainer's registration at `now`. A registration waits on the list, so
 * the admin sees the request to be removed, and a rejection leaves it there.
 */
export function leaveDoNotListWhenApproved(db: D1Database, repo: string, by: number, now: number): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM do_not_list WHERE repo = ?1 AND EXISTS (SELECT 1 FROM projects WHERE repo = ?1
         AND source = 'registered' AND status = 'approved' AND status_changed_by = ?2 AND status_changed_at = ?3)`,
    )
    .bind(mustParse(repoName, repo, 'repo'), mustParse(githubId, by, 'by'), checkTime(now));
}

/**
 * Which of these repos the do-not-list covers, as the repos where issues
 * live. A repo on the list is covered, and so is every project's issue there,
 * whether or not that project is on the list. An issue repo is covered when
 * a project on the list keeps its issues there, and no approved or paused
 * project off the list does. Only those have claims, so removing one project
 * never hides the events of a listed project that shares its issue repo.
 * Each comes back in lower case. The repos go in as one JSON array, so any
 * number of them takes one query, under D1's limit on bound values.
 */
export async function doNotListedAmong(db: D1Database, repos: Iterable<string>): Promise<Set<string>> {
  const checked = [...new Set([...repos].map((repo) => mustParse(repoName, repo, 'repo').toLowerCase()))];
  if (checked.length === 0) return new Set();
  const { results } = await db
    .prepare(
      `SELECT j.value AS repo FROM json_each(?) j
       WHERE EXISTS (SELECT 1 FROM do_not_list d WHERE d.repo = j.value)
          OR (EXISTS (SELECT 1 FROM projects p JOIN do_not_list d ON d.repo = p.repo WHERE p.issue_repo = j.value)
            AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.issue_repo = j.value AND p.status IN ('approved', 'paused')
              AND NOT EXISTS (SELECT 1 FROM do_not_list d WHERE d.repo = p.repo)))`,
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
