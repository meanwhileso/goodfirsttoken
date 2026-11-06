import { z } from 'zod';
import { count, epochMs, githubId, httpsUrl, id, labelName, repoName, trimmedText } from './primitives';
import { policySchema, projectSettingsPatchSchema } from './projects';
import { crawlPrioritySchema } from './crawl-priority';

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

/** What a line behind a crawler's suggestion is about: a setting it suggests, or a canary for the admin to see. */
export const candidateSourceAbouts = [
  'excludedTags',
  'whoCanClaim',
  'disclosure',
  'personWrittenDescription',
  'claUrl',
  'prMode',
  /** A line that keeps agents to issues with one label, which is the suggested tag. */
  'tags',
  /** A line that keeps agents to issues with a label the repo doesn't have, or keeps for people, so no tag comes from it. */
  'labelMissing',
  /** A line in AGENTS.md or CLAUDE.md that asks an agent reading it to prove it did. Nothing follows from it. */
  'canary',
] as const;

/** The longest line the crawler keeps from a repo's file. */
export const MAX_SOURCE_LINE = 500;

/** The line in a repo's file behind a crawler's suggestion, as the file has it, for the admin to check. */
export const candidateSourceSchema = z.object({
  about: z.enum(candidateSourceAbouts),
  /** The file's path in the repo. */
  path: trimmedText(MAX_SOURCE_LINE),
  /** The line, cut to MAX_SOURCE_LINE characters, or null when the file itself is the reason, as a vouch file is. */
  line: trimmedText(MAX_SOURCE_LINE).nullable(),
});
export type CandidateSource = z.infer<typeof candidateSourceSchema>;

/**
 * The most sentences that name AI a crawler find keeps from the repo's docs,
 * for the admin to read before a verdict.
 */
export const MAX_AI_SENTENCES = 60;

/** The longest passage the crawler keeps around a sentence that names AI. */
export const MAX_AI_PASSAGE = 1000;

/**
 * A sentence in the repo's docs that names AI, with the rest of its
 * paragraph, as the file has it. A paragraph longer than MAX_AI_PASSAGE
 * characters is cut around the sentence, and says where.
 */
export const aiSentenceSchema = z.object({
  /** The file's path in the repo. */
  path: trimmedText(MAX_SOURCE_LINE),
  /** The paragraph, or the part of it around the sentence. */
  text: trimmedText(MAX_AI_PASSAGE),
  /** True when the paragraph starts before the text. */
  cutBefore: z.boolean().default(false),
  /** True when the paragraph goes on after the text. */
  cutAfter: z.boolean().default(false),
});
export type AiSentence = z.infer<typeof aiSentenceSchema>;

/**
 * What the crawler read in a repo's docs, as a hash: each file's path and
 * exact text, sorted by path, and whether there is a vouch file. It holds
 * none of the repo's text. A model reading is kept for the docs hash it was
 * made for, so docs that read the same cost no model call.
 */
export const docsHashSchema = z
  .string({ error: 'must be a docs hash' })
  .regex(/^docs-v[1-9][0-9]{0,3}:[0-9a-f]{64}$/, 'must be a docs hash');
export type DocsHash = z.infer<typeof docsHashSchema>;

/** The tiers a reading of a repo's docs can give: the two a listing can have, a ban, and no policy. */
export const crawlTiers = ['invites_agents', 'allows_with_conditions', 'bans_or_restricts', 'no_policy'] as const;
export const crawlTierSchema = z.enum(crawlTiers);

/** What a statement in a model reading says, from docs/specs/model-policy-reader.md, under What the model returns. */
export const modelStatementAbouts = [
  'welcomesAgents',
  'welcomesAi',
  'bansAi',
  'refusesOutsidePrs',
  'noAutonomy',
  'personInLoop',
  'personWrittenDescription',
  'reservedLabel',
  'onlyLabel',
  'disclosureTrailer',
  'cla',
  'canary',
] as const;

/** The most lines one statement in a model reading may span. */
export const MAX_READING_LINES = 20;
/** The most statements a model reading keeps. */
export const MAX_READING_STATEMENTS = 60;
/** The most steering lines a model reading keeps. */
export const MAX_READING_STEERING = 20;
/** The longest note the model writes about one statement. */
export const MAX_READING_NOTE = 300;
/** The longest summary the model writes for the admin. */
export const MAX_READING_SUMMARY = 500;

/** Lines in a repo's file, as the file has them, each cut to MAX_SOURCE_LINE characters. */
const readingLines = z.string().max(MAX_READING_LINES * (MAX_SOURCE_LINE + 1));
const lineNumber = z.int().min(1);

/** Lines a model reading points at, checked against the file: its path, the lines, and the lines as the file has them. */
export const readingPointerSchema = z.object({
  path: trimmedText(MAX_SOURCE_LINE),
  startLine: lineNumber,
  endLine: lineNumber,
  lines: readingLines,
});

/**
 * What the model policy reader read in a repo's docs, for the admin queue:
 * the statements that checked out against the files, each with its lines as
 * the files have them and the model's note on it, the steering lines that
 * checked out, the tier the Worker worked out from the statements and the one
 * the model gave, and the model's summary. The lines are the repo's text, and
 * the notes and the summary are text the model wrote from it, so all of it is
 * data to the admin. In shadow it decides nothing.
 */
export const modelReadingSchema = z.object({
  /** The model, the prompt, and the output schema, like claude-opus-5-5/p1/s1. */
  readerVersion: trimmedText(100),
  docsHash: docsHashSchema,
  /** The tier the Worker worked out from the statements that checked out. */
  tier: crawlTierSchema,
  /** The tier the model gave. */
  modelTier: crawlTierSchema,
  /** Whether the two tiers agree. */
  agree: z.boolean(),
  statements: z
    .array(
      readingPointerSchema.extend({
        about: z.enum(modelStatementAbouts),
        /** The label, for reservedLabel and onlyLabel, as the docs spell it. */
        label: z.string().max(MAX_SOURCE_LINE).nullable(),
        /** The trailer's name, or the CLA link. */
        value: z.string().max(MAX_SOURCE_LINE).nullable(),
        /** The model's note on it. */
        why: z.string().max(MAX_READING_NOTE),
      }),
    )
    .max(MAX_READING_STATEMENTS),
  /** How many of the model's statements failed a check against the files, and were dropped. */
  dropped: count,
  /** Lines that try to steer a reader of the docs, which checked out against the files. */
  steering: z.array(readingPointerSchema).max(MAX_READING_STEERING),
  /** How many steering lines failed a check. */
  droppedSteering: count,
  /** The model's summary for the admin. */
  summary: z.string().max(MAX_READING_SUMMARY),
});
export type ModelReading = z.infer<typeof modelReadingSchema>;

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
    /** The line behind each suggestion the docs gave, and any canary. */
    sources: z.array(candidateSourceSchema).default([]),
    /**
     * The first MAX_AI_SENTENCES sentences in the docs that name AI, each
     * with the rest of its paragraph, for the admin to read. A sentence in a
     * paragraph already kept is not kept again.
     */
    aiSentences: z.array(aiSentenceSchema).max(MAX_AI_SENTENCES).default([]),
    /** How many more sentences that name AI the docs have, in no paragraph kept. */
    moreAiSentences: count.default(0),
    /** What the crawler read in the docs it found the repo in, as a docs hash, or null for a find made before. */
    docsHash: docsHashSchema.nullable().default(null),
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

/** What the crawler's cron job did with a seed. */
export const crawlSeedOutcomes = ['queued', 'do_not_list', 'project', 'proposed'] as const;
export const crawlSeedOutcomeSchema = z.enum(crawlSeedOutcomes);
export type CrawlSeedOutcome = z.infer<typeof crawlSeedOutcomeSchema>;

/** A repo an admin asked the crawler to read, whatever its stars or last push. */
export const crawlSeedSchema = z.object({
  repo: repoName,
  /** Admin research affecting discovery order, or null for an ordinary seed. */
  evidence: crawlPrioritySchema.nullable().default(null),
  /** The admin who added it. */
  addedBy: githubId,
  addedAt: epochMs,
  /** When the crawler's cron job handled it, or null until then. */
  handledAt: epochMs.nullable(),
  /**
   * What the cron job did with it: `queued` for the crawler to read, or left
   * alone, as on the do-not-list, a project already, or proposed before.
   * Null until it did.
   */
  outcome: crawlSeedOutcomeSchema.nullable(),
}).refine((seed) => (seed.handledAt === null) === (seed.outcome === null), {
  path: ['outcome'],
  message: 'must be set once the seed is handled, and only then',
});
export type CrawlSeed = z.infer<typeof crawlSeedSchema>;

/** The most repos one message in the crawl queue holds. */
export const MAX_CRAWL_BATCH = 25;

/**
 * Repos in the crawl queue, for a consumer to read. With `reread`, they are
 * listed projects, read again to keep their listings current.
 */
export const crawlMessageSchema = z.object({
  repos: z.array(repoName).min(1).max(MAX_CRAWL_BATCH),
  reread: z.literal(true).optional(),
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

/**
 * What the crawler's rules read in a repo's docs, as a version and a hash:
 * the tier, the words of the quote, of each sentence that names AI with its
 * paragraph, and of the conditions the settings follow. The repo's text
 * isn't kept, only the hash.
 */
export const policyFingerprintSchema = z
  .string({ error: 'must be a policy fingerprint' })
  .regex(/^v[1-9][0-9]{0,3}:[0-9a-f]{64}$/, 'must be a policy fingerprint');
export type PolicyFingerprint = z.infer<typeof policyFingerprintSchema>;

/** The line in a repo's docs the crawler's rules read as a ban, with a link to its file. */
export const banLineSchema = z.object({
  /** The file's path in the repo. */
  path: trimmedText(MAX_SOURCE_LINE),
  /** The line, cut to MAX_SOURCE_LINE characters, as the file has it, or null when it is blank. */
  line: trimmedText(MAX_SOURCE_LINE).nullable(),
  /** The file on github.com, on the repo's default branch. */
  url: httpsUrl,
});
export type BanLine = z.infer<typeof banLineSchema>;

/**
 * Why the crawler last paused a listed project on its own, for the admins:
 * a ban its docs now read as, with the line and the sentences that name AI,
 * or pull requests limited to collaborators, which the pause's reason says.
 */
export const crawlerPauseSchema = z.object({
  /** When the pause was made, which is when the project's status changed. */
  pausedAt: epochMs,
  /** The line read as a ban, or null when the pause is for the repo's pull request settings. */
  ban: banLineSchema.nullable(),
  aiSentences: z.array(aiSentenceSchema).max(MAX_AI_SENTENCES).default([]),
  moreAiSentences: count.default(0),
});
export type CrawlerPause = z.infer<typeof crawlerPauseSchema>;

/** Where the crawler stands with a listed project it reads again each week. */
export const policyReadSchema = z.object({
  project: repoName,
  /** When the crawler's cron job last put it in the crawl queue. */
  queuedAt: epochMs,
  /** What the rules read in its docs the last time the crawler read them whole, or null before. */
  fingerprint: policyFingerprintSchema.nullable(),
  /** Whether the rules read a ban in its docs then, or null before. */
  banned: z.boolean().nullable(),
  /** The crawler's last pause of the project, or null. */
  pause: crawlerPauseSchema.nullable(),
});
export type PolicyRead = z.infer<typeof policyReadSchema>;

/**
 * A listed project whose policy, as the crawler's rules read it, changed
 * since the crawler last read it, waiting for an admin or decided by one.
 */
export const policyChangeSchema = z
  .object({
    id,
    repo: repoName,
    foundAt: epochMs,
    /** The repo's facts, as the crawler read them. */
    facts: repoFactsSchema,
    /**
     * The policy text that welcomes agent work now, with its link and tier,
     * or null when the rules read none.
     */
    policy: policySchema.nullable(),
    /** The line behind each setting the docs give now, and any canary. */
    sources: z.array(candidateSourceSchema).default([]),
    aiSentences: z.array(aiSentenceSchema).max(MAX_AI_SENTENCES).default([]),
    moreAiSentences: count.default(0),
    /** What the crawler read in the docs, as a docs hash, or null for a change found before. */
    docsHash: docsHashSchema.nullable().default(null),
    status: candidateStatusSchema,
    decidedBy: githubId.nullable(),
    decidedAt: epochMs.nullable(),
    /** Why the admin kept the listing as it was. */
    reason: trimmedText(MAX_CRAWL_REASON).nullable(),
  })
  .superRefine((change, ctx) => {
    const problem = (field: string, message: string) => {
      ctx.addIssue({ code: 'custom', path: [field], message });
    };
    const waiting = change.status === 'waiting';
    for (const field of ['decidedBy', 'decidedAt'] as const) {
      if (waiting && change[field] !== null) problem(field, 'must be null while the change waits');
      if (!waiting && change[field] === null) problem(field, `is required once it is ${change.status}`);
    }
    if (change.status === 'rejected' && change.reason === null) problem('reason', 'is required to reject');
    if (change.status !== 'rejected' && change.reason !== null) {
      problem('reason', 'must be null unless the change was rejected');
    }
  });
export type PolicyChange = z.infer<typeof policyChangeSchema>;
