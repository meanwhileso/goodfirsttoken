import type { ProjectRecord } from '@goodfirsttoken/core';
import { doNotListedAmong } from '../db';

// Which projects have a page, for a project's page itself, and on its
// issues' pages for the breadcrumb, which leads there only when it has one,
// the cached copy, and whether the project takes claims.

/**
 * Whether a project has a page: it is approved, or paused by a person, one
 * of its maintainers or an admin, and the do-not-list covers neither its
 * repo nor the repo where its issues live. A pause that names no person is
 * one Good First Token made on its own, when the sync found the repo
 * private, archived, blocked, or gone, so what the site cached from the
 * repo stops showing. A pending or rejected project has none.
 *
 * What the do-not-list covers is doNotListedAmong's rule, which hides the
 * events on a repo's issues too. For an approved or paused project it
 * covers the project's repos exactly when one of them is on the list, since
 * the project, off the list, keeps its own issues in its issue repo.
 */
export async function hasPage(db: D1Database, project: ProjectRecord): Promise<boolean> {
  const shown = project.status === 'approved' || (project.status === 'paused' && project.statusChangedBy !== null);
  if (!shown) return false;
  const listed = await doNotListedAmong(db, [project.repo, project.settings.issueRepo ?? project.repo]);
  return listed.size === 0;
}
