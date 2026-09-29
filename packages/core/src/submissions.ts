import { z } from 'zod';
import { agentName, commitSha, count, epochMs, id, modelName, oneLine, repoName, trimmedText } from './primitives';

// The work a claim submitted (spec section 7, steps 5 and 6). submit_work
// commits it to a branch as the donor, then opens the PR or puts the work in
// the donor's review queue, where open_pr opens it.

/**
 * Why submitted work waits in the donor's review queue for them to open its
 * PR. When several apply, the first in this list is the one given.
 *
 * - `pr_exists`: a PR is already open on the issue, so a person decides
 *   whether a second one helps.
 * - `workflow_files`: the change touches a GitHub Actions workflow file.
 * - `too_many_files`: someone else pushed to the branch, and GitHub's
 *   comparison lists 300 files, its most, so it may leave a workflow file
 *   out.
 * - `comparison_unread`: someone else pushed to the branch, and GitHub gave
 *   no comparison to check for workflow files.
 * - `reviewed_mode`: the project's PR mode is `reviewed`.
 * - `person_written_description`: the project wants the donor to write the
 *   PR description.
 * - `open_pr_cap`: the donor has as many open PRs in the project as it allows.
 * - `pr_refused`: the PR was to open by itself, and GitHub didn't open it.
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

/** A branch the server made, like `goodfirsttoken/issue-12-c_2x8Qm0vT4kLp9aZr1yWc`. */
export const branchName = z.string({ error: 'must be a branch name' }).min(1).max(255);

/**
 * A claim's submitted work, as its latest submit left it. A claim has one
 * branch, and every submit adds a commit to it.
 */
export const submissionRecordSchema = z.object({
  claimId: id,
  /** Where the branch is: the project's code repo, or the donor's fork of it. */
  repo: repoName,
  branch: branchName,
  /** The commit the latest submit made. */
  commit: commitSha,
  /**
   * The commit the submits' files are read against: the claim's start
   * commit, or the branch's head a submit named with `onto` after someone
   * else pushed to it.
   */
  base: commitSha,
  /**
   * The head of the code repo's default branch when the latest submit was
   * made. The lines and the diff are measured from where the branch parts
   * from it, as the PR's own change is.
   */
  diffFrom: commitSha,
  /** The paths the latest submit sent, which the branch changes from `base`. */
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
  /** Why the work waits for the donor, or null when its PR was to open by itself. */
  reviewReason: reviewReasonSchema.nullable(),
  submittedAt: epochMs,
});
export type SubmissionRecord = z.infer<typeof submissionRecordSchema>;
