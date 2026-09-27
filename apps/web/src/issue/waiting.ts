import type { ProjectRecord, ProjectSettings, TaggedIssue } from '@goodfirsttoken/core';
import { getDoNotListEntry } from '../db';

// Which issues take claims now: the homepage's rule for an issue waiting for
// an agent, in one place for the issue page's claim pane (./load.ts) and the
// donor's claim_issue (src/mcp/donor.ts). The homepage counts waiting issues
// with the same rule in SQL, in src/db/projects.ts, where listWaitingIssues
// shares it for suggest_issues. The rules are in docs/how-it-works.md, under
// The homepage and The donor's tools.

/** A label compared without case, folding ASCII letters as SQLite's lower() does in the homepage's query. */
export function foldLabel(label: string): string {
  return label.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/** Whether the labels carry one of the project's tags and none of its excluded tags. */
export function carriesTags(labels: readonly string[], settings: ProjectSettings): boolean {
  const folded = new Set(labels.map(foldLabel));
  const has = (names: readonly string[]) => names.some((name) => folded.has(foldLabel(name)));
  return has(settings.tags) && !has(settings.excludedTags);
}

/** Why an issue takes no claims whatever its slots and PRs: its project isn't asking for help, or it isn't tagged. */
export type ClosedBecause = 'project' | 'issue' | null;

/**
 * Why the issue takes no claims, by the homepage's rule, less the open PRs
 * and the free slot: the project isn't approved, or its repo or the issue's
 * repo is on the do-not-list, or it has no cached copy with one of its tags
 * and none of its excluded ones. Null when it takes them.
 */
export async function closedBecause(
  db: D1Database,
  project: ProjectRecord | null,
  tagged: { project: ProjectRecord; copy: TaggedIssue } | undefined,
  issueRepo: string,
): Promise<ClosedBecause> {
  if (project?.status !== 'approved') return 'project';
  if (!tagged) return 'issue';
  if (!carriesTags(tagged.copy.labels, tagged.project.settings)) return 'issue';
  const listed = await Promise.all([project.repo, issueRepo].map((repo) => getDoNotListEntry(db, repo)));
  return listed.some((entry) => entry !== null) ? 'project' : null;
}

/** A project's cached copy of an issue, judged by closedBecause. */
export interface JudgedCopy {
  project: ProjectRecord;
  copy: TaggedIssue;
  closed: ClosedBecause;
}

/**
 * The copy the issue page follows, and the project a new claim goes to, when
 * more than one project keeps its issues in the repo. The copies come oldest
 * project first. It is the oldest whose copy waits for an agent, with no
 * linked PR and fewer than its own claims per issue among the `taken` slots.
 * Then the oldest that would but for a linked PR or a full cap, then the
 * oldest.
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
