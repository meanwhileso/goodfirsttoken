import { describe, expect, test } from 'vitest';
import {
  branchFor,
  closingLine,
  isWorkflowPath,
  prBody,
  pullMismatch,
  reviewReason,
  type ReviewFacts,
} from '../../src/donor/work';

// The rules for a claim's submitted work. submit_work and open_pr are
// tested through the MCP server in test/mcp/submit.test.ts. Every repo and
// issue here is made up.

describe('workflow files', () => {
  test('every path under .github/workflows/ is a workflow file, in any case, and nothing else is', () => {
    for (const path of [
      '.github/workflows/ci.yml',
      '.github/workflows/release.yaml',
      '.github/workflows/scripts/check.sh',
      '.GitHub/Workflows/ci.yml',
      '.github/workflows',
    ]) {
      expect(isWorkflowPath(path), path).toBe(true);
    }
    for (const path of ['.github/CODEOWNERS', '.github/workflow/ci.yml', 'docs/.github/workflows/ci.yml', 'workflows/ci.yml']) {
      expect(isWorkflowPath(path), path).toBe(false);
    }
  });
});

describe('why work waits for the donor', () => {
  const opens: ReviewFacts = {
    prOnIssue: false,
    workflowFiles: false,
    tooManyFiles: false,
    prMode: 'automatic',
    personWrittenDescription: false,
    atOpenPrCap: false,
  };

  test('automatic work with nothing in the way is cleared by itself', () => {
    expect(reviewReason(opens)).toBeNull();
  });

  test('each reason alone sends the work to the review queue', () => {
    expect(reviewReason({ ...opens, prOnIssue: true })).toBe('pr_exists');
    expect(reviewReason({ ...opens, workflowFiles: true })).toBe('workflow_files');
    expect(reviewReason({ ...opens, tooManyFiles: true })).toBe('too_many_files');
    expect(reviewReason({ ...opens, prMode: 'reviewed' })).toBe('reviewed_mode');
    expect(reviewReason({ ...opens, personWrittenDescription: true })).toBe('person_written_description');
    expect(reviewReason({ ...opens, atOpenPrCap: true })).toBe('open_pr_cap');
  });

  test('with several reasons, a PR on the issue comes first, then workflow files, then a change not checked for them, then the PR mode', () => {
    const all: ReviewFacts = {
      prOnIssue: true,
      workflowFiles: true,
      tooManyFiles: true,
      prMode: 'reviewed',
      personWrittenDescription: true,
      atOpenPrCap: true,
    };
    expect(reviewReason(all)).toBe('pr_exists');
    expect(reviewReason({ ...all, prOnIssue: false })).toBe('workflow_files');
    expect(reviewReason({ ...all, prOnIssue: false, workflowFiles: false })).toBe('too_many_files');
    expect(reviewReason({ ...all, prOnIssue: false, workflowFiles: false, tooManyFiles: false })).toBe('reviewed_mode');
  });
});

describe('the branch and the PR', () => {
  test("a claim's branch is named for its issue and its claim, so each claim has its own", () => {
    expect(branchFor({ id: 'c_2x8Qm0vT4kLp9aZr1yWc', issue: 'sample-owner/sample-app#311' })).toBe(
      'goodfirsttoken/issue-311-c_2x8Qm0vT4kLp9aZr1yWc',
    );
    expect(branchFor({ id: 'c_other', issue: 'sample-owner/sample-app#311' })).not.toBe(
      branchFor({ id: 'c_2x8Qm0vT4kLp9aZr1yWc', issue: 'sample-owner/sample-app#311' }),
    );
  });

  test('the PR closes an issue in its own repo by number, and one the project keeps elsewhere by its repo too', () => {
    expect(closingLine('sample-owner/sample-app#311', 'sample-owner/sample-app')).toBe('Closes #311');
    expect(closingLine('Sample-Owner/Sample-App#311', 'sample-owner/sample-app')).toBe('Closes #311');
    expect(closingLine('sample-owner/sample-issues#12', 'sample-owner/sample-app')).toBe(
      'Closes sample-owner/sample-issues#12',
    );
  });

  test("the PR's description carries the project's disclosure word for word, and a description the donor wrote takes the agent's place", () => {
    const base = {
      summary: 'Keeps the slash.',
      checks: 'pnpm test',
      agent: 'claude-code',
      model: 'claude-opus-5-5',
      issue: 'sample-owner/sample-app#311',
      codeRepo: 'sample-owner/sample-app',
      disclosure: { trailer: 'Assisted-by', prBody: 'This PR was written with an AI agent.' },
    };
    expect(prBody(base)).toBe(
      'Keeps the slash.\n\nWhat claude-code (claude-opus-5-5) checked: pnpm test\n\nCloses #311\n\nThis PR was written with an AI agent.',
    );
    expect(prBody({ ...base, description: 'I wrote this myself.' })).toBe(
      'I wrote this myself.\n\nCloses #311\n\nThis PR was written with an AI agent.',
    );
    expect(prBody({ ...base, disclosure: { trailer: 'Assisted-by', prBody: null } })).toBe(
      'Keeps the slash.\n\nWhat claude-code (claude-opus-5-5) checked: pnpm test\n\nCloses #311',
    );
  });
});

describe('whether a PR is the one a clearance allows', () => {
  const issue = 'sample-owner/sample-app#12';
  const disclosure = { trailer: 'Assisted-by', prBody: 'Written with an agent.\nReviewed by a person.' };
  const cleared = {
    codeRepo: 'sample-owner/sample-app',
    defaultBranch: 'main',
    repo: 'priya/sample-app',
    branch: 'goodfirsttoken/issue-12-c_1',
    commit: 'a'.repeat(40),
    githubId: 1001,
    issue,
    disclosure,
    description: null,
  };
  const pull = {
    url: 'https://github.com/sample-owner/sample-app/pull/40',
    state: 'open' as const,
    authorId: 1001,
    baseRepo: 'sample-owner/sample-app',
    baseRef: 'main',
    headRepo: 'priya/sample-app',
    headRef: 'goodfirsttoken/issue-12-c_1',
    headSha: 'a'.repeat(40),
    title: 'Keep the slash',
    body: 'Keeps the slash.\n\nCloses #12\n\nWritten with an agent.\nReviewed by a person.',
  };

  test('a PR from the cleared head, with the closing line and the disclosure, passes', () => {
    expect(pullMismatch(pull, cleared)).toBeNull();
  });

  test('the closing line must be a line of its own, naming this issue and no other', () => {
    expect(pullMismatch({ ...pull, body: pull.body.replace('Closes #12', 'Closes #123') }, cleared)).toContain('lacks the line "Closes #12"');
    expect(pullMismatch({ ...pull, body: pull.body.replace('Closes #12', 'This Closes #12 too') }, cleared)).toContain('lacks the line');
  });

  test('line breaks from a web form, and indented lines, still match the disclosure', () => {
    expect(pullMismatch({ ...pull, body: pull.body.replaceAll('\n', '\r\n') }, cleared)).toBeNull();
    expect(pullMismatch({ ...pull, body: pull.body.split('\n').map((line) => `  ${line}`).join('\n') }, cleared)).toBeNull();
  });

  test('a merged PR whose fork was deleted passes when its branch, head, and author match', () => {
    expect(pullMismatch({ ...pull, state: 'merged', headRepo: null }, cleared)).toBeNull();
    expect(pullMismatch({ ...pull, state: 'merged', headRepo: null, headRef: 'other' }, cleared)).toContain('comes from');
  });

  test('a PR from another branch or fork, in another repo, closed, or with a key in it, fails', () => {
    expect(pullMismatch({ ...pull, headRef: 'other' }, cleared)).toContain('comes from');
    expect(pullMismatch({ ...pull, headRepo: 'sam/sample-app' }, cleared)).toContain('comes from');
    expect(pullMismatch({ ...pull, baseRepo: 'priya/sample-app' }, cleared)).toContain('is in priya/sample-app');
    expect(pullMismatch({ ...pull, state: 'closed' }, cleared)).toContain('closed without merging');
    expect(pullMismatch({ ...pull, body: `${pull.body}\n\nghp_${'a'.repeat(36)}` }, cleared)).toContain('looks like a key');
  });

  test("a description the donor wrote must be in the PR, as they wrote it", () => {
    const written = { ...cleared, description: 'I checked this on my phone.\nIt works.' };
    expect(pullMismatch(pull, written)).toContain('description the donor wrote');
    expect(pullMismatch({ ...pull, body: `I checked this on my phone.\r\nIt works.\n\n${pull.body}` }, written)).toBeNull();
  });
});
