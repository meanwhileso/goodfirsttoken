import { beforeEach, describe, expect, test } from 'vitest';
import { addToDoNotList, getDoNotListEntry } from '../../src/db';
import { admin, db, emptyDatabase, HOUR, repo, signIn, t0 } from './helpers';

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
});
