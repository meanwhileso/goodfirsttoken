import { beforeEach, describe, expect, test } from 'vitest';
import { listPushers, savePushers } from '../../src/db';
import { DAY, db, emptyDatabase, repo, t0 } from './helpers';

// The logins whose reviews showed push access to a repo, which the PR job
// counts as maintainers for comments in a PR's conversation. The repos and
// people are made up.

beforeEach(async () => {
  await emptyDatabase();
});

const rows = () => db.prepare('SELECT repo, login, seen_at FROM repo_pushers ORDER BY login').all();

describe('who showed push access to a repo', () => {
  test('counts for 90 days from the latest read that saw it, by repo, whatever the case of either name', async () => {
    await savePushers(db, [{ repo, login: 'Kenji' }], t0);
    await savePushers(db, [{ repo: 'sample-owner/sample-desktop', login: 'lena' }], t0);

    const pushers = await listPushers(db, [repo.toUpperCase()], t0 + 90 * DAY);

    expect(pushers).toEqual(new Map([[repo, new Set(['kenji'])]]));
    expect(await listPushers(db, [repo], t0 + 90 * DAY + 1)).toEqual(new Map());
  });

  test('a later read moves the time on, and one made before it, landing after, changes nothing', async () => {
    await savePushers(db, [{ repo, login: 'kenji' }], t0 + DAY);
    await savePushers(db, [{ repo, login: 'kenji' }], t0);

    expect((await rows()).results).toEqual([{ repo, login: 'kenji', seen_at: t0 + DAY }]);

    await savePushers(db, [{ repo, login: 'KENJI' }], t0 + 2 * DAY);

    expect((await rows()).results).toEqual([{ repo, login: 'kenji', seen_at: t0 + 2 * DAY }]);
  });

  test('a save drops what no read saw in the 90 days before it', async () => {
    await savePushers(db, [{ repo, login: 'kenji' }], t0);
    await savePushers(db, [{ repo, login: 'lena' }], t0 + 10 * DAY);

    await savePushers(db, [], t0 + 95 * DAY);

    expect((await rows()).results).toEqual([{ repo, login: 'lena', seen_at: t0 + 10 * DAY }]);
  });
});
