import type { ProjectRecord } from '@goodfirsttoken/core';
import { getDoNotListEntry, getIssueSync } from '../db';

// Which projects have a page, for a project's page itself, and on its
// issues' pages for the breadcrumb, which leads there only when it has one,
// the cached copy, and whether the project takes claims.

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
  if (project.status !== 'approved' && project.status !== 'paused') return false;
  const repos = new Set([project.repo, project.settings.issueRepo ?? project.repo].map((repo) => repo.toLowerCase()));
  const [sync, listed] = await Promise.all([
    getIssueSync(db, project.repo),
    Promise.all([...repos].map((repo) => getDoNotListEntry(db, repo))),
  ]);
  return (sync?.delisted ?? null) === null && listed.every((entry) => entry === null);
}
