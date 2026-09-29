import {
  MAX_SUBMIT_NOTES,
  stripSecrets,
  type ClaimRecord,
  type Disclosure,
  type ReviewReason,
} from '@goodfirsttoken/core';

// The rules for a claim's submitted work, as pure functions: which paths are
// workflow files, why work waits for the donor, the branch it goes on, and
// the words of its commit and its PR. submit_work and open_pr
// (src/mcp/submit.ts) use them. The rules are in docs/how-it-works.md,
// under The donor's tools.

/**
 * Whether a path is under `.github/workflows/`, where GitHub Actions reads
 * workflow files. Case is ignored, since some filesystems ignore it. Every
 * file under the folder counts, whatever its name, and so does a file
 * named `.github/workflows` itself, which would take the folder's place.
 */
export function isWorkflowPath(path: string): boolean {
  const [first = '', second] = path.toLowerCase().split('/');
  return first === '.github' && second === 'workflows';
}

/** What decides whether finished work opens its PR by itself. */
export interface ReviewFacts {
  /** An open PR on the issue other than the claim's own, from anyone. */
  prOnIssue: boolean;
  /** The branch's change touches a workflow file. */
  workflowFiles: boolean;
  /**
   * Why the branch's change couldn't be checked for workflow files, when it
   * holds someone else's push: GitHub's comparison was too long to list
   * every file, or GitHub gave none. Null when it was checked.
   */
  unchecked: 'too_many_files' | 'comparison_unread' | null;
  prMode: 'automatic' | 'reviewed';
  personWrittenDescription: boolean;
  /** The donor has as many open PRs in the project as it allows. */
  atOpenPrCap: boolean;
}

/**
 * Why finished work waits in the donor's review queue, or null when its PR
 * opens by itself. When several reasons apply, the first in core's
 * reviewReasons is the one given.
 */
export function reviewReason(facts: ReviewFacts): ReviewReason | null {
  if (facts.prOnIssue) return 'pr_exists';
  if (facts.workflowFiles) return 'workflow_files';
  if (facts.unchecked !== null) return facts.unchecked;
  if (facts.prMode === 'reviewed') return 'reviewed_mode';
  if (facts.personWrittenDescription) return 'person_written_description';
  if (facts.atOpenPrCap) return 'open_pr_cap';
  return null;
}

/**
 * The branch a claim's work goes on. It holds the claim's ID, so it is the
 * same for every submit of the claim, and no other claim's branch has it.
 */
export function branchFor(claim: Pick<ClaimRecord, 'id' | 'issue'>): string {
  const number = claim.issue.slice(claim.issue.lastIndexOf('#') + 1);
  return `goodfirsttoken/issue-${number}-${claim.id}`;
}

/** Text the agent wrote, with keys and tokens replaced, cut to what a submit takes. */
export function redacted(text: string, max = MAX_SUBMIT_NOTES): string {
  return stripSecrets(text.slice(0, max)).slice(0, max);
}

/**
 * The commit's message: the title, then the summary, then the project's
 * disclosure trailer, when it has one, naming the agent and the model.
 */
export function commitMessage(input: {
  title: string;
  summary: string;
  agent: string;
  model: string;
  disclosure: Disclosure;
}): { headline: string; body: string } {
  const trailer =
    input.disclosure.trailer === null ? null : `${input.disclosure.trailer}: ${input.agent} (${input.model})`;
  return {
    headline: input.title,
    body: trailer === null ? input.summary : `${input.summary}\n\n${trailer}`,
  };
}

/**
 * The line that links the PR to its issue, with GitHub's closing keyword: the
 * issue's number alone when it is in the code repo, and its repo too when
 * the project keeps its issues elsewhere.
 */
export function closingLine(issue: string, codeRepo: string): string {
  const hash = issue.lastIndexOf('#');
  const repo = issue.slice(0, hash);
  return repo.toLowerCase() === codeRepo.toLowerCase() ? `Closes ${issue.slice(hash)}` : `Closes ${issue}`;
}

/**
 * The PR's description. A description the donor wrote comes first, as they
 * wrote it, in place of the agent's summary and notes. Then the line that
 * links the issue, and the project's disclosure, word for word, when the
 * project asks for one in the PR body.
 */
export function prBody(input: {
  description?: string | undefined;
  summary: string;
  checks: string;
  agent: string;
  model: string;
  issue: string;
  codeRepo: string;
  disclosure: Disclosure;
}): string {
  const opening =
    input.description ?? `${input.summary}\n\nWhat ${input.agent} (${input.model}) checked: ${input.checks}`;
  return [opening, closingLine(input.issue, input.codeRepo), input.disclosure.prBody]
    .filter((part): part is string => part !== null)
    .join('\n\n');
}
