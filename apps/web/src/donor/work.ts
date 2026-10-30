import {
  MAX_SUBMIT_NOTES,
  stripSecrets,
  stripSecretsFromText,
  type ClaimRecord,
  type Disclosure,
  type ReviewReason,
} from '@goodfirsttoken/core';
import type { PullFacts } from './branches';

// The rules for a claim's submitted work, as pure functions: which paths are
// workflow files, why work waits for the donor, the branch it goes on, the
// trailer its commits carry, the words of its PR, and whether a PR the
// donor opened is the one open_pr cleared. submit_work, open_pr, and record_pr
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

/** What decides whether finished work is cleared to open by itself. */
export interface ReviewFacts {
  /** An open PR on the issue other than the claim's own, from anyone. */
  prOnIssue: boolean;
  /** The branch's change touches a workflow file. */
  workflowFiles: boolean;
  /**
   * GitHub's comparison of the branch was too long to list every file and
   * commit, so it couldn't all be checked.
   */
  tooManyFiles: boolean;
  prMode: 'automatic' | 'reviewed';
  personWrittenDescription: boolean;
  /** The donor has as many open PRs in the project as it allows. */
  atOpenPrCap: boolean;
}

/**
 * Why finished work waits in the donor's review queue, or null when it is
 * cleared to open by itself. When several reasons apply, the first in core's
 * reviewReasons is the one given.
 */
export function reviewReason(facts: ReviewFacts): ReviewReason | null {
  if (facts.prOnIssue) return 'pr_exists';
  if (facts.workflowFiles) return 'workflow_files';
  if (facts.tooManyFiles) return 'too_many_files';
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

/**
 * Whether a commit message carries the trailer, as a line of its own below
 * the first that starts with its name, a colon, and some text. Git compares
 * trailer names without case.
 * https://git-scm.com/docs/git-interpret-trailers
 */
export function hasTrailer(message: string, trailer: string): boolean {
  const name = trailer.toLowerCase();
  return message.split('\n').slice(1).some((line) => {
    const colon = line.indexOf(':');
    return colon > 0 && line.slice(0, colon).trim().toLowerCase() === name && line.slice(colon + 1).trim() !== '';
  });
}

/** What a PR must be to count for a cleared claim (docs/specs/agent-submits.md). */
export interface ClearedPr {
  codeRepo: string;
  defaultBranch: string;
  /** Where the claim's branch is, and its name. */
  repo: string;
  branch: string;
  /** The head open_pr cleared. */
  commit: string;
  /** The claimant's GitHub ID. */
  githubId: number;
  issue: string;
  disclosure: Disclosure;
  /** The description the donor wrote, for a project that asks for one, or null. */
  description: string | null;
}

/**
 * Text as lines with their ends trimmed. GitHub's web form sends CR LF, and
 * an agent may copy a body indented, so neither keeps text from matching.
 */
function plainLines(text: string): string[] {
  return text.replaceAll('\r\n', '\n').split('\n').map((line) => line.trim());
}

/** Whether `text` holds `part` as whole lines, in order. */
function holdsLines(text: string, part: string): boolean {
  const lines = plainLines(text);
  const wanted = plainLines(part.trim());
  return lines.some((_, start) => wanted.every((line, i) => lines[start + i] === line));
}

/**
 * Why the PR isn't the one the clearance allows, or null when it is: in
 * the code repo, aimed at its default branch, open or merged, from the
 * claim's branch at the cleared head, opened by the claimant, with the
 * closing line, the disclosure text, and a description the donor wrote, as
 * whole lines in its body, and no key or token in its words. A PR whose
 * fork was deleted is judged by its branch name, head, and author.
 */
export function pullMismatch(
  pull: Pick<PullFacts, 'url' | 'state' | 'authorId' | 'baseRepo' | 'baseRef' | 'headRepo' | 'headRef' | 'headSha' | 'title' | 'body'>,
  cleared: ClearedPr,
): string | null {
  const lower = (text: string) => text.toLowerCase();
  if (lower(pull.baseRepo) !== lower(cleared.codeRepo)) return `${pull.url} is in ${pull.baseRepo}, and the PR goes in ${cleared.codeRepo}.`;
  if (pull.baseRef !== cleared.defaultBranch) return `${pull.url} is aimed at ${pull.baseRef}, and the PR goes into ${cleared.defaultBranch}.`;
  if (pull.state === 'closed') return `${pull.url} closed without merging.`;
  const fromRepo = pull.headRepo === null || lower(pull.headRepo) === lower(cleared.repo);
  if (!fromRepo || pull.headRef !== cleared.branch) {
    return `${pull.url} comes from ${pull.headRepo ?? 'a deleted fork'}:${pull.headRef}, and the claim's branch is ${cleared.repo}:${cleared.branch}.`;
  }
  if (pull.headSha !== cleared.commit) {
    return `${pull.url} is at ${pull.headSha}, and open_pr cleared ${cleared.commit}. Submit the branch again, and clear it with open_pr.`;
  }
  if (pull.authorId !== cleared.githubId) return `${pull.url} was opened by another GitHub account than the claim's.`;
  const closing = closingLine(cleared.issue, cleared.codeRepo);
  if (!holdsLines(pull.body, closing)) return `${pull.url}'s description lacks the line "${closing}". Add it with gh pr edit.`;
  const disclosure = cleared.disclosure.prBody;
  if (disclosure !== null && !holdsLines(pull.body, disclosure)) {
    return `${pull.url}'s description lacks the project's disclosure text, word for word. Add it with gh pr edit.`;
  }
  if (cleared.description !== null && !holdsLines(pull.body, cleared.description)) {
    return `${pull.url}'s description lacks the description the donor wrote, word for word. Put it back with gh pr edit.`;
  }
  if (stripSecretsFromText(pull.title) !== pull.title || stripSecretsFromText(pull.body) !== pull.body) {
    return `${pull.url}'s title or description has what looks like a key or a token. Take it out with gh pr edit.`;
  }
  return null;
}

/** Text the agent wrote, with keys and tokens replaced, cut to what a submit takes. */
export function redacted(text: string, max = MAX_SUBMIT_NOTES): string {
  return stripSecrets(text.slice(0, max)).slice(0, max);
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
