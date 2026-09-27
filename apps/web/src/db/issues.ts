import { mustParse, repoName, taggedIssueSchema, type TaggedIssue } from '@goodfirsttoken/core';
import { checkTime, fromJson, joinIssue, prColumns, prFromColumns, splitIssue } from './shared';

// The tagged_issues table: a cache of each project's open tagged issues, as
// the last sync read them from GitHub.

interface IssueRow {
  issue_repo: string;
  number: number;
  project: string;
  title: string;
  labels: string;
  linked_pr_repo: string | null;
  linked_pr_number: number | null;
  linked_pr_url: string | null;
  /** A JSON list of how the sync found the linked PR, or null. */
  linked_pr_found_by: string | null;
  synced_at: number;
}

function toIssue(row: IssueRow): TaggedIssue {
  return mustParse(
    taggedIssueSchema,
    {
      issue: joinIssue(row.issue_repo, row.number),
      project: row.project,
      title: row.title,
      labels: fromJson(row.labels),
      linkedPr: prFromColumns(row.linked_pr_repo, row.linked_pr_number, row.linked_pr_url),
      ...(row.linked_pr_found_by === null ? {} : { linkedPrFoundBy: fromJson(row.linked_pr_found_by) }),
      syncedAt: row.synced_at,
    },
    'issue',
  );
}

/**
 * Saves issues as a sync read them, each for its project. An issue the
 * project already has takes the new title, labels, linked PR with how it
 * was found, and sync time. All of them save or none do.
 */
export async function saveIssues(db: D1Database, issues: readonly TaggedIssue[]): Promise<void> {
  const checked = issues.map((issue, i) => mustParse(taggedIssueSchema, issue, `issues[${String(i)}]`));
  if (checked.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO tagged_issues (project, issue_repo, number, title, labels, linked_pr_repo,
       linked_pr_number, linked_pr_url, linked_pr_found_by, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project, issue_repo, number) DO UPDATE SET
       title = excluded.title, labels = excluded.labels,
       linked_pr_repo = excluded.linked_pr_repo, linked_pr_number = excluded.linked_pr_number,
       linked_pr_url = excluded.linked_pr_url, linked_pr_found_by = excluded.linked_pr_found_by,
       synced_at = excluded.synced_at`,
  );
  await db.batch(
    checked.map((issue) => {
      const { repo, number } = splitIssue(issue.issue);
      return insert.bind(
        issue.project,
        repo,
        number,
        issue.title,
        JSON.stringify(issue.labels),
        ...prColumns(issue.linkedPr),
        issue.linkedPrFoundBy === undefined ? null : JSON.stringify(issue.linkedPrFoundBy),
        issue.syncedAt,
      );
    }),
  );
}

/** A project's cached copy of an issue, like `owner/name#12`, or null. */
export async function getIssue(db: D1Database, project: string, issue: string): Promise<TaggedIssue | null> {
  const { repo, number } = splitIssue(issue);
  const row = await db
    .prepare('SELECT * FROM tagged_issues WHERE project = ? AND issue_repo = ? AND number = ?')
    .bind(mustParse(repoName, project, 'project'), repo, number)
    .first<IssueRow>();
  return row === null ? null : toIssue(row);
}

/** A project's cached issues, by issue number. */
export async function listIssues(db: D1Database, project: string): Promise<TaggedIssue[]> {
  const { results } = await db
    .prepare('SELECT * FROM tagged_issues WHERE project = ? ORDER BY issue_repo, number')
    .bind(mustParse(repoName, project, 'project'))
    .all<IssueRow>();
  return results.map(toIssue);
}

/**
 * The copies of an issue like `owner/name#12` that the projects keeping
 * their issues in its repo have, oldest project first.
 */
export async function listIssueCopies(db: D1Database, issue: string): Promise<TaggedIssue[]> {
  const { repo, number } = splitIssue(issue);
  // Through projects_by_issue_repo, then each copy by its key.
  const { results } = await db
    .prepare(
      `SELECT t.* FROM projects p JOIN tagged_issues t ON t.project = p.repo AND t.issue_repo = ?1 AND t.number = ?2
       WHERE p.issue_repo = ?1 ORDER BY p.added_at, p.repo`,
    )
    .bind(repo, number)
    .all<IssueRow>();
  return results.map(toIssue);
}

/**
 * Drops a project's copies of these issues, like `owner/name#12`, all or
 * none. Returns how many it dropped.
 */
export async function dropIssues(db: D1Database, project: string, issues: readonly string[]): Promise<number> {
  const name = mustParse(repoName, project, 'project');
  if (issues.length === 0) return 0;
  const drop = db.prepare('DELETE FROM tagged_issues WHERE project = ? AND issue_repo = ? AND number = ?');
  const results = await db.batch(
    issues.map((issue) => {
      const { repo, number } = splitIssue(issue);
      return drop.bind(name, repo, number);
    }),
  );
  return results.reduce((sum, result) => sum + result.meta.changes, 0);
}

/**
 * Drops a project's issues that the latest sync didn't see: every one synced
 * before `syncedBefore`. Returns how many it dropped.
 */
export async function pruneIssues(db: D1Database, project: string, syncedBefore: number): Promise<number> {
  const result = await db
    .prepare('DELETE FROM tagged_issues WHERE project = ? AND synced_at < ?')
    .bind(mustParse(repoName, project, 'project'), checkTime(syncedBefore, 'syncedBefore'))
    .run();
  return result.meta.changes;
}
