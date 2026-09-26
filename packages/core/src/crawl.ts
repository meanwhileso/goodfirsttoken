import { z } from 'zod';
import { count, epochMs, githubId, id, labelName, repoName, trimmedText } from './primitives';
import { policySchema, projectSettingsPatchSchema } from './projects';

// The policy crawler's records (spec section 5): the repos it found for the
// admin queue, and the do-not-list it honors.

/** A label that could mean "ready for outside help", with its open issue count. */
export const suggestedTagSchema = z.object({ name: labelName, openIssues: count });
export type SuggestedTag = z.infer<typeof suggestedTagSchema>;

/** What GitHub says about a repo, for an admin to weigh. */
export const repoFactsSchema = z.object({
  stars: count,
  createdAt: epochMs,
  pushedAt: epochMs,
  /** When the repo owner's account was made. */
  ownerCreatedAt: epochMs,
});
export type RepoFacts = z.infer<typeof repoFactsSchema>;

/** `waiting` for an admin, then `approved` or `rejected`. */
export const candidateStatuses = ['waiting', 'approved', 'rejected'] as const;
export const candidateStatusSchema = z.enum(candidateStatuses);
export type CandidateStatus = z.infer<typeof candidateStatusSchema>;

/** The longest reason for rejecting a candidate or adding a repo to the do-not-list. */
export const MAX_CRAWL_REASON = 500;

/** A repo whose own docs welcome AI help, waiting for an admin or decided by one. */
export const crawlCandidateSchema = z
  .object({
    id,
    repo: repoName,
    foundAt: epochMs,
    facts: repoFactsSchema,
    /** The policy text that welcomes agent work, with its link and tier. */
    policy: policySchema,
    /** The settings the crawler's rules suggest. The admin confirms them and picks the tags. */
    settings: projectSettingsPatchSchema,
    suggestedTags: z.array(suggestedTagSchema),
    status: candidateStatusSchema,
    /** The admin who decided, or null while it waits. */
    decidedBy: githubId.nullable(),
    decidedAt: epochMs.nullable(),
    /** Why it was rejected. */
    reason: trimmedText(MAX_CRAWL_REASON).nullable(),
  })
  .superRefine((candidate, ctx) => {
    const problem = (field: string, message: string) => {
      ctx.addIssue({ code: 'custom', path: [field], message });
    };
    const waiting = candidate.status === 'waiting';
    for (const field of ['decidedBy', 'decidedAt'] as const) {
      if (waiting && candidate[field] !== null) problem(field, 'must be null while the candidate waits');
      if (!waiting && candidate[field] === null) problem(field, `is required once it is ${candidate.status}`);
    }
    if (candidate.status === 'rejected' && candidate.reason === null) {
      problem('reason', 'is required to reject');
    }
    if (candidate.status !== 'rejected' && candidate.reason !== null) {
      problem('reason', 'must be null unless the candidate was rejected');
    }
  });
export type CrawlCandidate = z.infer<typeof crawlCandidateSchema>;

/**
 * A repo whose maintainers asked to be removed. The crawler never proposes it
 * again. Its maintainers can still register it themselves.
 */
export const doNotListEntrySchema = z.object({
  repo: repoName,
  /** Where and how the maintainers asked, for the record. */
  reason: trimmedText(MAX_CRAWL_REASON).nullable(),
  /** The admin who added it. */
  addedBy: githubId,
  addedAt: epochMs,
});
export type DoNotListEntry = z.infer<typeof doNotListEntrySchema>;
