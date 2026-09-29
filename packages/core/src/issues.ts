import { z } from 'zod';
import { epochMs, issueRef, labelName, prRefSchema, repoName, trimmedText } from './primitives';
import { MAX_STATUS_REASON } from './projects';

// The cache of each project's tagged issues (spec section 6). GitHub is the
// source of truth, and the server checks it again before suggesting,
// claiming, and opening a PR.

/** How long a maintainer waits between two refreshes of a project's tagged issues with project_status. */
export const ISSUE_REFRESH_INTERVAL_MS = 10 * 60_000;

/**
 * How the sync found a PR linked to an issue: a `closing_reference`, which
 * GitHub records for a PR whose description closes the issue with a keyword
 * or that someone linked by hand, or a `cross_reference`, an event on the
 * issue's timeline for any PR that mentions it.
 */
export const linkMethods = ['closing_reference', 'cross_reference'] as const;
export const linkMethodSchema = z.enum(linkMethods);
export type LinkMethod = z.infer<typeof linkMethodSchema>;

/** An open issue carrying one of its project's tags, as GitHub last showed it. */
export const taggedIssueSchema = z
  .object({
    issue: issueRef,
    /** The project's code repo. */
    project: repoName,
    title: z.string(),
    /** Every label on the issue, so a change to the project's tags applies without a new sync. */
    labels: z.array(labelName),
    /** An open PR linked to the issue, from anyone, or null. */
    linkedPr: prRefSchema.nullable(),
    /**
     * The ways the sync found the linked PR, one or both. Left out with no
     * linked PR.
     */
    linkedPrFoundBy: z.array(linkMethodSchema).min(1).optional(),
    /** When the sync last read the issue from GitHub. */
    syncedAt: epochMs,
  })
  .superRefine((issue, ctx) => {
    if (issue.linkedPr === null && issue.linkedPrFoundBy !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['linkedPrFoundBy'], message: 'must be left out with no linked PR' });
    }
  });
export type TaggedIssue = z.infer<typeof taggedIssueSchema>;

/**
 * Where the sync stands for a project. A pass reads each of its tagged
 * issues once, across as many runs as it takes.
 */
export const issueSyncSchema = z.object({
  project: repoName,
  /** When the pass in progress started, or null between passes. */
  passStartedAt: epochMs.nullable(),
  /** When the last whole pass finished, or null before the first. */
  readAt: epochMs.nullable(),
  /** When a maintainer's refresh last started on the project, or null. */
  refreshedAt: epochMs.nullable(),
  /** While a run reads the project, when its hold on it runs out. Null when none holds it. */
  readingUntil: epochMs.nullable(),
  /**
   * The code repo's main language, as GitHub named it when the sync last read
   * the repo, for ranking suggestions. Null when GitHub names none, or before
   * the sync read it.
   */
  language: z.string().max(100).nullable(),
  /**
   * Why GitHub showed the project's code repo or issue repo private,
   * archived, blocked, or gone when the sync last read them, in the words
   * delistedReason gives, like `sample-owner/app is archived on GitHub.`, or
   * null when it showed both public and open, or before the sync read them.
   * While it is set, what the site cached from the repos stays hidden,
   * whatever the project's status.
   */
  delisted: trimmedText(MAX_STATUS_REASON).nullable(),
  /**
   * When the mark went from none to set. It stays while the mark does,
   * whatever words later reads give it. Null without a mark, or for a mark
   * set before the sync kept this time.
   */
  delistedAt: epochMs.nullable(),
  /** When the sync last read the project's code repo and issue repo, or null before it did. */
  reposReadAt: epochMs.nullable(),
});
export type IssueSync = z.infer<typeof issueSyncSchema>;

/**
 * What GitHub showed of a repo when the sync delisted its project. `private`
 * is a repo GitHub showed and said isn't public. `archived` is an archived
 * repo. `blocked` is a repo GitHub blocked access to, with a 451. `gone` is
 * no public repo by that name at all: the service token reads public repos
 * only, so a repo that went private and one that was deleted look the same.
 */
export const delistedShowings = ['private', 'archived', 'blocked', 'gone'] as const;
export const delistedShowingSchema = z.enum(delistedShowings);
export type DelistedShowing = z.infer<typeof delistedShowingSchema>;

/**
 * The sync's reason for each showing, as the words before and after the
 * repo's name. The reason is all the mark keeps, so the repo and what GitHub
 * showed are read back from these words, and they live here alone.
 */
const DELISTED_WORDS: Record<DelistedShowing, readonly [before: string, after: string]> = {
  private: ['', ' is no longer public on GitHub.'],
  archived: ['', ' is archived on GitHub.'],
  blocked: ['GitHub blocked access to ', '.'],
  gone: ['GitHub shows no public repo named ', '. It went private or was deleted.'],
};

/** The reason the sync delists a project with, which names the repo and what GitHub showed of it. */
export function delistedReason(repo: string, showed: DelistedShowing): string {
  const [before, after] = DELISTED_WORDS[showed];
  return `${before}${repo}${after}`;
}

/**
 * The repo and what GitHub showed of it, read from a reason delistedReason
 * gave. Null for a reason in other words, like the one migration 0006 gave
 * a pause that had none.
 */
export function readDelistedReason(reason: string): { repo: string; showed: DelistedShowing } | null {
  for (const showed of delistedShowings) {
    const [before, after] = DELISTED_WORDS[showed];
    if (reason.length <= before.length + after.length || !reason.startsWith(before) || !reason.endsWith(after)) continue;
    const repo = repoName.safeParse(reason.slice(before.length, reason.length - after.length));
    if (repo.success) return { repo: repo.data, showed };
  }
  return null;
}
