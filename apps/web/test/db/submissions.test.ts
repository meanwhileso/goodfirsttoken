import { newClaim, type ClaimRecord, type SubmissionRecord } from '@goodfirsttoken/core';
import { beforeEach, describe, expect, test } from 'vitest';
import { getSubmission, getSubmissions, saveClaim, saveSubmission, setReviewReason } from '../../src/db';
import { db, emptyDatabase, HOUR, priya, refusal, repo, sha, signIn, t0 } from './helpers';

// The submissions table: each claim's branch and its latest submit. Every
// repo, branch, and note here is made up.

function claimOn(claimId: string, number: number): ClaimRecord {
  return {
    id: claimId,
    issue: `${repo}#${String(number)}`,
    project: repo,
    githubId: priya.githubId,
    login: priya.login,
    agent: 'claude-code',
    ownProject: false,
    startCommit: sha,
    tokenEstimate: null,
    ...newClaim(t0),
    state: 'awaiting_review',
    submittedAt: t0 + HOUR,
  };
}

function submission(claimId: string, rest: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return {
    claimId,
    repo: 'priya/sample-app',
    branch: `goodfirsttoken/issue-12-${claimId}`,
    commit: 'a'.repeat(40),
    base: sha,
    diffFrom: sha,
    paths: ['src/rewrite.ts'],
    title: 'Keep the trailing slash in rewrites',
    summary: 'Keeps the slash.',
    checks: 'pnpm test',
    agent: 'claude-code',
    model: 'claude-opus-5-5',
    additions: 3,
    deletions: 1,
    reviewReason: 'reviewed_mode',
    submittedAt: t0 + HOUR,
    ...rest,
  };
}

beforeEach(async () => {
  await emptyDatabase();
  await signIn(priya);
  await saveClaim(db, claimOn('c_1', 12), 1);
  await saveClaim(db, claimOn('c_2', 13), 1);
});

describe('submissions', () => {
  test("a claim's latest submit replaces its earlier one, and each claim keeps its own", async () => {
    await saveSubmission(db, submission('c_1'));
    const later = submission('c_1', {
      commit: 'b'.repeat(40),
      base: 'c'.repeat(40),
      diffFrom: 'd'.repeat(40),
      paths: ['src/a.ts'],
      additions: null,
      deletions: null,
      reviewReason: null,
    });
    await saveSubmission(db, later);
    await saveSubmission(db, submission('c_2'));

    expect(await getSubmission(db, 'c_1')).toEqual(later);
    expect([...(await getSubmissions(db, ['c_1', 'c_2', 'c_3'])).keys()].sort()).toEqual(['c_1', 'c_2']);
    expect(await getSubmission(db, 'c_3')).toBeNull();
  });

  test("a work's reason for waiting can change once GitHub didn't open its PR", async () => {
    await saveSubmission(db, submission('c_1', { reviewReason: null }));

    const changed = await setReviewReason(db, 'c_1', 'pr_refused');

    expect(changed?.reviewReason).toBe('pr_refused');
    expect(await setReviewReason(db, 'c_3', 'pr_refused')).toBeNull();
  });

  test('a submit for a claim the claims table lacks, or one that breaks its schema, is refused', async () => {
    expect(await refusal(saveSubmission(db, submission('c_9')))).toMatch(/FOREIGN KEY/);
    expect(await refusal(saveSubmission(db, submission('c_1', { commit: 'not-a-sha' })))).toContain('commit');
    expect(await getSubmission(db, 'c_1')).toBeNull();
  });
});
