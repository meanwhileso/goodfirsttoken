import { z } from 'zod';
import { agentName, commitSha, count, epochMs, id, modelName, oneLine, repoName, trimmedText } from './primitives';

// The work a claim submitted (spec section 7, steps 5 and 6). submit_work
// takes a branch the donor's agent pushed (docs/specs/agent-submits.md), and
// puts the work in the donor's review queue, where open_pr clears it to open
// as a PR. The server writes nothing to GitHub for it.

/**
 * Why submitted work waits in the donor's review queue for them to open its
 * PR. When several apply, the first in this list is the one given.
 *
 * - `pr_exists`: a PR is already open on the issue, so a person decides
 *   whether a second one helps.
 * - `workflow_files`: the change touches a GitHub Actions workflow file.
 * - `too_many_files`: GitHub's comparison of the branch lists 300 files,
 *   its most, or fewer commits than the branch has, so it may leave a
 *   workflow file or a commit out.
 * - `comparison_unread`: only older submits with files gave this. GitHub
 *   gave no comparison to check.
 * - `reviewed_mode`: the project's PR mode is `reviewed`.
 * - `person_written_description`: the project wants the donor to write the
 *   PR description.
 * - `open_pr_cap`: the donor has as many open PRs in the project as it allows.
 * - `pr_refused`: only submits with files gave this, when the server opened
 *   PRs: the PR was to open by itself, and GitHub didn't open it. Stored
 *   work may still have it.
 * - `ready_to_open`: work with no other reason to wait, cleared to open.
 */
export const reviewReasons = [
  'pr_exists',
  'workflow_files',
  'too_many_files',
  'comparison_unread',
  'reviewed_mode',
  'person_written_description',
  'open_pr_cap',
  'pr_refused',
  'ready_to_open',
] as const;
export const reviewReasonSchema = z.enum(reviewReasons);
export type ReviewReason = z.infer<typeof reviewReasonSchema>;

/**
 * The longest summary, and the longest note on what was checked. Both go
 * into the PR's description, so keys and tokens in them are replaced first,
 * as in a posted line, which takes at most this many characters.
 */
export const MAX_SUBMIT_NOTES = 1000;

/** The longest PR title GitHub takes. */
export const MAX_PR_TITLE = 256;

/** A PR title, and the commit's first line: one line of text. */
export const prTitle = oneLine(MAX_PR_TITLE, `must be at most ${String(MAX_PR_TITLE)} characters, the GitHub limit`);

/** A claim's branch, like `goodfirsttoken/issue-12-c_2x8Qm0vT4kLp9aZr1yWc`. */
export const branchName = z.string({ error: 'must be a branch name' }).min(1).max(255);

/**
 * How a claim's work reached its branch: `branch`, which the donor's agent
 * pushed, or `files`, which the server committed for older submits. Those
 * keep their branches, which open_pr, the compare page link, and the job
 * that records cleared PRs work for too.
 */
export const submissionSources = ['files', 'branch'] as const;
export const submissionSourceSchema = z.enum(submissionSources);
export type SubmissionSource = z.infer<typeof submissionSourceSchema>;

/**
 * A claim's submitted work, as its latest submit left it. A claim has one
 * branch, and every submit adds a commit to it, or names the head the agent
 * pushed.
 */
export const submissionRecordSchema = z.object({
  claimId: id,
  source: submissionSourceSchema,
  /** Where the branch is: the project's code repo, or the donor's fork of it. */
  repo: repoName,
  branch: branchName,
  /** The commit the latest submit made, or the head it named. */
  commit: commitSha,
  /**
   * The claim's start commit. Older submits with files could name a later
   * head here.
   */
  base: commitSha,
  /**
   * The head of the code repo's default branch when the latest submit was
   * made. The lines and the diff are measured from where the branch parts
   * from it, as the PR's own change is.
   */
  diffFrom: commitSha,
  /** The paths GitHub's comparison lists from `diffFrom`. */
  paths: z.array(z.string().min(1)).max(300),
  title: prTitle,
  /** The agent's summary, with keys and tokens replaced. */
  summary: trimmedText(MAX_SUBMIT_NOTES),
  /** What the agent checked, with keys and tokens replaced. */
  checks: trimmedText(MAX_SUBMIT_NOTES),
  agent: agentName,
  model: modelName,
  /** Lines added and removed from `diffFrom`, as GitHub counts them, or null when it didn't say. */
  additions: count.nullable(),
  deletions: count.nullable(),
  /** Why the work waits for the donor, or null when its claim's PR is open. */
  reviewReason: reviewReasonSchema.nullable(),
  submittedAt: epochMs,
  /**
   * open_pr's word that the work may become a PR: the
   * head it cleared, the PR's body, and when. A PR counts only from that
   * head. A later submit ends it. Null until then.
   */
  clearance: z.object({ commit: commitSha, body: z.string().min(1), at: epochMs }).nullable(),
});
export type SubmissionRecord = z.infer<typeof submissionRecordSchema>;
