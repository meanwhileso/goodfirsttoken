import { readDelistedReason, type Delisting, type IssueSync, type ProjectRecord } from '@goodfirsttoken/core';
import { getDoNotListEntry, getIssueSync } from '../db';

// Which projects have a page, for a project's page itself, and on its
// issues' pages for the breadcrumb, which leads there only when it has one,
// the cached copy, and whether the project takes claims. And why the sync
// delisted a project, for its maintainers' project_status and the admins'
// admin_pause_project.

/** Whether the project is approved or paused, the statuses a project with a page can have. */
function couldHavePage(project: ProjectRecord): boolean {
  return project.status === 'approved' || project.status === 'paused';
}

const iso = (time: number | null) => (time === null ? null : new Date(time).toISOString());

/**
 * Why the sync delisted a project that could have a page, from its mark in
 * `sync`: the repo GitHub showed private, archived, blocked, or gone, what it
 * showed, the sync's reason, when the sync delisted it, when it last checked
 * the repos, and whether the project's repo or issue repo is on the
 * do-not-list, `listed`, so the sync reads them no more. Null when the mark
 * is off, or when the project is pending or rejected, which has no page
 * whatever the mark says, and which the sync doesn't check. hasPage reads
 * the mark through this, so project_status reports a delisting exactly when
 * the mark takes a project's page away.
 *
 * The mark keeps the reason, and not the repo or what GitHub showed apart,
 * so those two are read back from its words. Nothing the site cached from
 * the repos is in it.
 */
export function delistingOf(project: ProjectRecord, sync: IssueSync | null, listed: boolean): Delisting | null {
  if (!couldHavePage(project) || sync === null || sync.delisted === null) return null;
  const said = readDelistedReason(sync.delisted);
  return {
    repo: said?.repo ?? null,
    showed: said?.showed ?? null,
    reason: sync.delisted,
    delistedAt: iso(sync.delistedAt),
    checkedAt: iso(sync.reposReadAt),
    onDoNotList: listed,
  };
}

/**
 * Whether the project's repo, or the repo where its issues live, has an
 * entry of its own on the do-not-list, as in the homepage's query.
 */
async function onDoNotList(db: D1Database, project: ProjectRecord): Promise<boolean> {
  const repos = new Set([project.repo, project.settings.issueRepo ?? project.repo].map((repo) => repo.toLowerCase()));
  const entries = await Promise.all([...repos].map((repo) => getDoNotListEntry(db, repo)));
  return entries.some((entry) => entry !== null);
}

/**
 * Why the sync delisted the project, as delistingOf says, with the
 * do-not-list read now, and the mark read now unless `sync` is its row as
 * the caller read it.
 */
export async function readDelisting(db: D1Database, project: ProjectRecord, sync?: IssueSync | null): Promise<Delisting | null> {
  if (!couldHavePage(project)) return null;
  const [mark, listed] = await Promise.all([
    sync === undefined ? getIssueSync(db, project.repo) : Promise.resolve(sync),
    onDoNotList(db, project),
  ]);
  return delistingOf(project, mark, listed);
}

/**
 * Whether a project has a page: it is approved or paused, the sync hasn't
 * delisted it, and neither its repo nor the repo where its issues live is
 * on the do-not-list. A pending or rejected project has none.
 *
 * The sync delists a project when GitHub shows its repo or issue repo
 * private, archived, blocked, or gone, whoever paused it, so what the site
 * cached from the repos stops showing. The mark stays until the sync sees
 * both public and open again, so a resume meanwhile shows nothing.
 * ASKING_FOR_HELP in src/db/waiting.ts reads the same mark.
 *
 * Only the two repos' own do-not-list entries count, as in the homepage's
 * query. For a project that could have a page, doNotListedAmong, which the
 * rooms and feeds hide events by, says the same of its issue repo, since
 * the project is approved or paused, off the list, and keeps its issues
 * there. It reads every repo as an issue repo, so asking it about the code
 * repo would let a project on the list that kept its issues there take this
 * page away.
 */
export async function hasPage(db: D1Database, project: ProjectRecord): Promise<boolean> {
  if (!couldHavePage(project)) return false;
  const [sync, listed] = await Promise.all([getIssueSync(db, project.repo), onDoNotList(db, project)]);
  return !listed && delistingOf(project, sync, listed) === null;
}
