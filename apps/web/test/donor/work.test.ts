import { describe, expect, test } from 'vitest';
import {
  branchFor,
  closingLine,
  commitMessage,
  isWorkflowPath,
  prBody,
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
    unchecked: null,
    prMode: 'automatic',
    personWrittenDescription: false,
    atOpenPrCap: false,
  };

  test('automatic work with nothing in the way opens by itself', () => {
    expect(reviewReason(opens)).toBeNull();
  });

  test('each reason alone sends the work to the review queue', () => {
    expect(reviewReason({ ...opens, prOnIssue: true })).toBe('pr_exists');
    expect(reviewReason({ ...opens, workflowFiles: true })).toBe('workflow_files');
    expect(reviewReason({ ...opens, unchecked: 'too_many_files' })).toBe('too_many_files');
    expect(reviewReason({ ...opens, unchecked: 'comparison_unread' })).toBe('comparison_unread');
    expect(reviewReason({ ...opens, prMode: 'reviewed' })).toBe('reviewed_mode');
    expect(reviewReason({ ...opens, personWrittenDescription: true })).toBe('person_written_description');
    expect(reviewReason({ ...opens, atOpenPrCap: true })).toBe('open_pr_cap');
  });

  test('with several reasons, a PR on the issue comes first, then workflow files, then a change not checked for them, then the PR mode', () => {
    const all: ReviewFacts = {
      prOnIssue: true,
      workflowFiles: true,
      unchecked: 'comparison_unread',
      prMode: 'reviewed',
      personWrittenDescription: true,
      atOpenPrCap: true,
    };
    expect(reviewReason(all)).toBe('pr_exists');
    expect(reviewReason({ ...all, prOnIssue: false })).toBe('workflow_files');
    expect(reviewReason({ ...all, prOnIssue: false, workflowFiles: false })).toBe('comparison_unread');
    expect(reviewReason({ ...all, prOnIssue: false, workflowFiles: false, unchecked: null })).toBe('reviewed_mode');
  });
});

describe('the branch, the commit, and the PR', () => {
  test("a claim's branch is named for its issue and its claim, so each claim has its own", () => {
    expect(branchFor({ id: 'c_2x8Qm0vT4kLp9aZr1yWc', issue: 'sample-owner/sample-app#311' })).toBe(
      'goodfirsttoken/issue-311-c_2x8Qm0vT4kLp9aZr1yWc',
    );
    expect(branchFor({ id: 'c_other', issue: 'sample-owner/sample-app#311' })).not.toBe(
      branchFor({ id: 'c_2x8Qm0vT4kLp9aZr1yWc', issue: 'sample-owner/sample-app#311' }),
    );
  });

  test("the commit carries the project's trailer with the agent and model, and no trailer when the project uses none", () => {
    const base = { title: 'Keep the slash', summary: 'Keeps it.', agent: 'codex', model: 'gpt-5.5-codex' };
    expect(commitMessage({ ...base, disclosure: { trailer: 'Assisted-by', prBody: null } })).toEqual({
      headline: 'Keep the slash',
      body: 'Keeps it.\n\nAssisted-by: codex (gpt-5.5-codex)',
    });
    expect(commitMessage({ ...base, disclosure: { trailer: 'Generated-by', prBody: 'Made with an agent.' } }).body).toBe(
      'Keeps it.\n\nGenerated-by: codex (gpt-5.5-codex)',
    );
    expect(commitMessage({ ...base, disclosure: { trailer: null, prBody: 'Made with an agent.' } }).body).toBe('Keeps it.');
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
