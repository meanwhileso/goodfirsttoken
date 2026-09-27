import type { ClaimRecord, ProjectRecord, TaggedIssue } from '@goodfirsttoken/core';
import { getIssue, listIssueClaims, listProjectsByIssueRepo } from '../db';

// Whether an issue is on the site, which decides whether it has a text
// stream, a live socket, and a page. An issue is on the site when it has a
// claim, or when it is among the tagged issues of a project that keeps its
// issues in that repo. Anything else would make an issue room that nothing
// could fill, so the streams (src/feed/streams.ts) and the issue page
// (./load.ts) answer 404 for it without touching a room.

/** What D1 holds about an issue on the site. */
export interface IssueOnSite {
  /** Its claims, from the claims table, in the order made. */
  claims: ClaimRecord[];
  /** Each project's cached copy of it, oldest project first. */
  copies: { project: ProjectRecord; copy: TaggedIssue }[];
}

/**
 * The issue's claims and cached copies, like `owner/name#12`, or null when
 * it has neither, and so is not on the site.
 */
export async function findIssue(db: D1Database, issue: string): Promise<IssueOnSite | null> {
  const repo = issue.slice(0, issue.lastIndexOf('#'));
  const [claims, projects] = await Promise.all([listIssueClaims(db, issue), listProjectsByIssueRepo(db, repo)]);
  const copies = (
    await Promise.all(
      projects.map(async (project) => {
        const copy = await getIssue(db, project.repo, issue);
        return copy && { project, copy };
      }),
    )
  ).filter((found) => found !== null);
  return claims.length === 0 && copies.length === 0 ? null : { claims, copies };
}
