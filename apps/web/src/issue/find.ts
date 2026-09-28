import type { ClaimRecord, ProjectRecord, TaggedIssue } from '@goodfirsttoken/core';
import { listIssueClaims, listJudgedCopies, listProjectsByIssueRepo, type ClosedBecause } from '../db';

// Whether an issue is on the site, which decides whether it has a text
// stream, a live socket, and a page. An issue is on the site when it has a
// claim, or when it is among the tagged issues of a project that keeps its
// issues in that repo. Anything else would make an issue room that nothing
// could fill, so the streams (src/feed/streams.ts) and the issue page
// (./load.ts) answer 404 for it without touching a room.

/** A project's cached copy of an issue, with why a new agent can't claim it. */
export interface JudgedCopy {
  project: ProjectRecord;
  copy: TaggedIssue;
  /**
   * Why a new agent can't claim it, whatever its slots and open PRs, by the
   * rule the homepage counts with, in src/db/waiting.ts. Null when it can.
   */
  closed: ClosedBecause;
}

/** What D1 holds about an issue on the site. */
export interface IssueOnSite {
  /** Its claims, from the claims table, in the order made. */
  claims: ClaimRecord[];
  /** Each project's cached copy of it, oldest project first. */
  copies: JudgedCopy[];
}

/**
 * The issue's claims and cached copies, like `owner/name#12`, or null when
 * it has neither, and so is not on the site.
 */
export async function findIssue(db: D1Database, issue: string): Promise<IssueOnSite | null> {
  const repo = issue.slice(0, issue.lastIndexOf('#'));
  const [claims, projects, judged] = await Promise.all([
    listIssueClaims(db, issue),
    listProjectsByIssueRepo(db, repo),
    listJudgedCopies(db, issue),
  ]);
  const byRepo = new Map(projects.map((project) => [project.repo.toLowerCase(), project]));
  const copies = judged.flatMap(({ copy, closed }) => {
    const project = byRepo.get(copy.project.toLowerCase());
    return project ? [{ project, copy, closed }] : [];
  });
  return claims.length === 0 && copies.length === 0 ? null : { claims, copies };
}

/**
 * The copy the issue page follows, and the project a new claim goes to, when
 * more than one project keeps its issues in the repo. The copies come oldest
 * project first. It is the oldest a new agent could claim, with no linked PR
 * and fewer than its own claims per issue among the `taken` slots, which
 * the caller counts live from the issue's room. Then the oldest that would
 * but for a linked PR or a full cap, then the oldest.
 */
export function followedCopy<T extends JudgedCopy>(judged: readonly T[], taken: number): T | undefined {
  return (
    judged.find(
      (copy) => copy.closed === null && copy.copy.linkedPr === null && taken < copy.project.settings.claimsPerIssue,
    ) ??
    judged.find((copy) => copy.closed === null) ??
    judged[0]
  );
}
