import type { ProjectRecord } from '@goodfirsttoken/core';
import { getDoNotListEntry } from '../db';

// Which projects have a page, for a project's page itself and for the
// breadcrumb on its issues' pages, which leads there only when it has one.

/**
 * Whether a project has a page: it is approved, or paused by a person, one
 * of its maintainers or an admin, and neither its repo nor the repo where
 * its issues live is on the do-not-list. A pause that names no person is
 * one Good First Token made on its own, when the sync found the repo
 * private, archived, blocked, or gone, so what the site cached from the
 * repo stops showing. A pending or rejected project has none.
 */
export async function hasPage(db: D1Database, project: ProjectRecord): Promise<boolean> {
  const shown = project.status === 'approved' || (project.status === 'paused' && project.statusChangedBy !== null);
  if (!shown) return false;
  const repos = new Set([project.repo, project.settings.issueRepo ?? project.repo].map((repo) => repo.toLowerCase()));
  const listed = await Promise.all([...repos].map((repo) => getDoNotListEntry(db, repo)));
  return listed.every((entry) => entry === null);
}
