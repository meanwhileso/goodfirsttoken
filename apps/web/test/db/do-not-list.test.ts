import { beforeEach, describe, expect, test } from 'vitest';
import { addToDoNotList, createProject, doNotListedAmong, getDoNotListEntry, removeFromDoNotList } from '../../src/db';
import { admin, db, emptyDatabase, HOUR, maintainer, repo, signIn, t0 } from './helpers';

beforeEach(async () => {
  await emptyDatabase();
  await signIn(admin);
});

describe('the do-not-list', () => {
  test('a repo on the do-not-list is found whatever the case of its name', async () => {
    const entry = await addToDoNotList(
      db,
      { repo, reason: 'The maintainers asked in sample-owner/sample-app#90.', addedBy: admin.githubId },
      t0,
    );

    expect(entry).toEqual({
      repo,
      reason: 'The maintainers asked in sample-owner/sample-app#90.',
      addedBy: admin.githubId,
      addedAt: t0,
    });
    expect(await getDoNotListEntry(db, 'Sample-Owner/Sample-App')).toEqual(entry);
  });

  test('a repo not on the list is not found', async () => {
    expect(await getDoNotListEntry(db, repo)).toBeNull();
  });

  test('adding a repo again keeps its first entry', async () => {
    const first = await addToDoNotList(db, { repo, reason: null, addedBy: admin.githubId }, t0);

    const again = await addToDoNotList(
      db,
      { repo: 'SAMPLE-OWNER/sample-app', reason: 'Asked again.', addedBy: admin.githubId },
      t0 + HOUR,
    );

    expect(again).toEqual(first);
  });

  test('a repo comes off the list whatever the case of its name', async () => {
    await addToDoNotList(db, { repo, reason: null, addedBy: admin.githubId }, t0);

    expect(await removeFromDoNotList(db, 'SAMPLE-OWNER/Sample-App')).toBe(true);
    expect(await getDoNotListEntry(db, repo)).toBeNull();
    expect(await removeFromDoNotList(db, repo)).toBe(false);
  });

  test("covers a repo on it, and the issue repo of a project whose code repo is on it, and nothing else", async () => {
    await signIn(maintainer);
    await createProject(
      db,
      {
        repo: 'sample-owner/sample-code',
        status: 'approved',
        source: 'registered',
        policy: null,
        settings: { tags: ['help wanted'], issueRepo: 'sample-owner/sample-issues' },
        addedBy: maintainer.githubId,
      },
      t0,
    );
    await addToDoNotList(db, { repo: 'Sample-Owner/Sample-Code', reason: null, addedBy: admin.githubId }, t0);
    await addToDoNotList(db, { repo, reason: null, addedBy: admin.githubId }, t0);

    const covered = await doNotListedAmong(db, [
      'sample-owner/SAMPLE-APP',
      'sample-owner/sample-issues',
      'sample-owner/sample-code',
      'sample-owner/sample-tools',
    ]);

    expect(covered).toEqual(new Set(['sample-owner/sample-app', 'sample-owner/sample-issues', 'sample-owner/sample-code']));
    expect(await doNotListedAmong(db, [])).toEqual(new Set());
  });
});
