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

/** A repo an admin asked the crawler to read, whatever its stars or last push. */
export const crawlSeedSchema = z.object({
  repo: repoName,
  /** The admin who added it. */
  addedBy: githubId,
  addedAt: epochMs,
  /** When the crawler put it in its queue, or null until then. */
  queuedAt: epochMs.nullable(),
});
export type CrawlSeed = z.infer<typeof crawlSeedSchema>;

/** GitHub's search serves 100 results a page, and 10 pages of any query. */
export const SEARCH_PAGES = 10;

/**
 * Where the crawler's search stands in one pass over the pool of repos. The
 * search reads the pool in bands of star counts, each small enough for
 * GitHub's search to serve whole.
 */
export const crawlPassSchema = z.object({
  startedAt: epochMs,
  /** The pass looks for repos pushed on or after this time. */
  pushedSince: epochMs,
  /** How many repos GitHub's search counted in the whole pool, once the pass asked. */
  pool: count.nullable(),
  /** The fewest stars in the band the pass reads now. */
  low: count,
  /** How many star counts the band spans, when it has an upper end. */
  width: z.int().min(1),
  /** True while the band has no upper end. */
  open: z.boolean(),
  /** The page of the band to read next. */
  page: z.int().min(1).max(SEARCH_PAGES),
  /** Repos the pass has put in the queue so far. */
  queued: count,
  finishedAt: epochMs.nullable(),
});
export type CrawlPass = z.infer<typeof crawlPassSchema>;

/** The most repos one message in the crawl queue holds. */
export const MAX_CRAWL_BATCH = 25;

/** Repos in the crawl queue, for a consumer to read. */
export const crawlMessageSchema = z.object({
  repos: z.array(repoName).min(1).max(MAX_CRAWL_BATCH),
});
export type CrawlMessage = z.infer<typeof crawlMessageSchema>;

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
