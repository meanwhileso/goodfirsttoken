import type { TaggedIssue } from '@goodfirsttoken/core';
import { beforeEach, describe, expect, test } from 'vitest';
import { getIssue, listIssues, pruneIssues, saveIssues } from '../../src/db';
import { db, emptyDatabase, HOUR, maintainer, refusal, registeredProject, repo, signIn, t0 } from './helpers';

const issueRepo = 'sample-owner/sample-issues';
const linkedPr = { repo, number: 40, url: `https://github.com/${repo}/pull/40` };

function issue(number: number, changes: Partial<TaggedIssue> = {}): TaggedIssue {
  return {
    issue: `${issueRepo}#${String(number)}`,
    project: repo,
    title: `Sample issue ${String(number)}`,
    labels: ['help wanted'],
    linkedPr: null,
    syncedAt: t0,
    ...changes,
  };
}

beforeEach(async () => {
  await emptyDatabase();
  await signIn(maintainer);
  await registeredProject({ tags: ['help wanted'], issueRepo });
});

describe('the tagged-issue cache', () => {
  test('a sync saves each tagged issue with its labels and its linked PR', async () => {
    const saved = [issue(7, { labels: ['help wanted', 'bug'], linkedPr }), issue(8)];

    await saveIssues(db, saved);

    expect(await getIssue(db, repo, `${issueRepo}#7`)).toEqual(saved[0]);
    expect(await getIssue(db, repo, 'Sample-Owner/Sample-Issues#8')).toEqual(saved[1]);
    expect(await getIssue(db, repo, `${issueRepo}#9`)).toBeNull();
  });

  test('a later sync replaces what an issue says, including a linked PR that closed', async () => {
    await saveIssues(db, [issue(7, { linkedPr })]);

    const later = issue(7, { title: 'Sample issue 7, retitled', labels: ['help wanted', 'docs'], syncedAt: t0 + HOUR });
    await saveIssues(db, [later]);

    expect(await getIssue(db, repo, `${issueRepo}#7`)).toEqual(later);
  });

  test('pruning drops the issues the latest sync did not see and keeps the rest', async () => {
    await saveIssues(db, [issue(7), issue(8)]);
    await saveIssues(db, [issue(8, { syncedAt: t0 + HOUR })]);

    expect(await pruneIssues(db, repo, t0 + HOUR)).toBe(1);

    expect((await listIssues(db, repo)).map((i) => i.issue)).toEqual([`${issueRepo}#8`]);
  });

  test("a project's issues are listed by number, apart from other projects' issues", async () => {
    await registeredProject({ tags: ['ready'] }, 'sample-owner/other-app');
    await saveIssues(db, [
      issue(12),
      issue(3),
      issue(5, { issue: 'sample-owner/other-app#5', project: 'sample-owner/other-app' }),
    ]);

    expect((await listIssues(db, repo)).map((i) => i.issue)).toEqual([`${issueRepo}#3`, `${issueRepo}#12`]);
    expect(await pruneIssues(db, repo, t0 + HOUR)).toBe(2);
    expect(await listIssues(db, 'sample-owner/other-app')).toHaveLength(1);
  });

  test('two projects that keep issues in the same repo each keep their own copy of a shared issue', async () => {
    const other = 'sample-owner/other-app';
    await registeredProject({ tags: ['ready'], issueRepo }, other);

    await saveIssues(db, [issue(7)]);
    await saveIssues(db, [issue(7, { project: other, labels: ['help wanted', 'ready'], syncedAt: t0 + HOUR })]);

    expect((await listIssues(db, repo)).map((i) => i.labels)).toEqual([['help wanted']]);
    expect((await listIssues(db, other)).map((i) => i.labels)).toEqual([['help wanted', 'ready']]);
    expect(await pruneIssues(db, repo, t0 + HOUR)).toBe(1);
    expect(await listIssues(db, other)).toHaveLength(1);
  });

  test('an issue belongs to a project, and a sync with one that does not saves none of them', async () => {
    await refusal(saveIssues(db, [issue(7), issue(8, { project: 'sample-owner/not-listed' })]));

    expect(await listIssues(db, repo)).toEqual([]);
  });

  test('a malformed issue is refused before it reaches the database, naming the field', async () => {
    const message = await refusal(saveIssues(db, [issue(7), issue(8, { labels: ['x'.repeat(51)] })]));

    expect(message).toContain('labels[0]: must be at most 50 characters');
    expect(message).toContain('issues[1]');
    expect(await listIssues(db, repo)).toEqual([]);
  });
});
