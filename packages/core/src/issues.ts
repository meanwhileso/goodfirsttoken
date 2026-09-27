import { z } from 'zod';
import { epochMs, issueRef, labelName, prRefSchema, repoName } from './primitives';

// The cache of each project's tagged issues (spec section 6). GitHub is the
// source of truth, and the server checks it again before suggesting,
// claiming, and opening a PR.

/** An open issue carrying one of its project's tags, as GitHub last showed it. */
export const taggedIssueSchema = z.object({
  issue: issueRef,
  /** The project's code repo. */
  project: repoName,
  title: z.string(),
  /** Every label on the issue, so a change to the project's tags applies without a new sync. */
  labels: z.array(labelName),
  /** An open PR linked to the issue, from anyone, or null. */
  linkedPr: prRefSchema.nullable(),
  /** When the sync last read the issue from GitHub. */
  syncedAt: epochMs,
});
export type TaggedIssue = z.infer<typeof taggedIssueSchema>;
