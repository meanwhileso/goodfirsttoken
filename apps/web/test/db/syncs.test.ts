import { beforeEach, describe, expect, test } from 'vitest';
import {
  addToDoNotList,
  beginPass,
  createProject,
  finishPass,
  getIssueSync,
  listProjectsToSync,
  markSyncTried,
  setProjectStatus,
  takeSyncTurn,
} from '../../src/db';
import { db, emptyDatabase, HOUR, maintainer, MINUTE, registeredProject, repo, signIn, t0 } from './helpers';

// Where the tagged-issue sync stands for each project. Every repo here is
// made up.

const second = 'sample-owner/second-app';
const third = 'sample-owner/third-app';

beforeEach(async () => {
  await emptyDatabase();
  await signIn(maintainer);
});

describe('issue syncs', () => {
  test('a pass that stopped partway is taken up by the next run, and ends when it finishes', async () => {
    await registeredProject();

    const started = await beginPass(db, repo, t0);
    const resumed = await beginPass(db, repo, t0 + HOUR);
    const midway = await getIssueSync(db, repo);
    await finishPass(db, repo, started, t0 + 2 * HOUR);

    expect(resumed).toBe(started);
    expect(midway).toMatchObject({ passStartedAt: t0, readAt: null });
    expect(await getIssueSync(db, repo)).toMatchObject({ passStartedAt: null, readAt: t0 + 2 * HOUR });
  });

  test('a new pass starts after the last one finished, even on a clock that ran behind', async () => {
    await registeredProject();
    await finishPass(db, repo, await beginPass(db, repo, t0), t0 + HOUR);

    expect(await beginPass(db, repo, t0 + HOUR)).toBe(t0 + HOUR + 1);
  });

  test('a run takes a pass in progress first, then the project read longest ago, never read first', async () => {
    await registeredProject({ tags: ['help wanted'] }, repo);
    await registeredProject({ tags: ['help wanted'] }, second);
    await registeredProject({ tags: ['help wanted'] }, third);
    await finishPass(db, repo, await beginPass(db, repo, t0), t0 + MINUTE);
    await finishPass(db, second, await beginPass(db, second, t0), t0 + 2 * MINUTE);
    const readFirst = await listProjectsToSync(db);
    await beginPass(db, second, t0 + HOUR);

    expect(readFirst).toEqual([third, repo, second]);
    expect(await listProjectsToSync(db)).toEqual([second, third, repo]);
  });

  test('only approved projects are synced, and none whose repo or issue repo is on the do-not-list', async () => {
    await registeredProject({ tags: ['help wanted'] }, repo);
    await registeredProject({ tags: ['help wanted'], issueRepo: 'sample-owner/listed-issues' }, second);
    await createProject(
      db,
      { repo: third, status: 'pending', source: 'registered', policy: null, settings: { tags: ['ready'] }, addedBy: maintainer.githubId },
      t0,
    );
    await addToDoNotList(db, { repo: 'Sample-Owner/Listed-Issues', reason: null, addedBy: maintainer.githubId }, t0);
    const before = await listProjectsToSync(db);
    await setProjectStatus(db, repo, { status: 'paused', reason: null, changedBy: maintainer.githubId }, t0);

    expect(before).toEqual([repo]);
    expect(await listProjectsToSync(db)).toEqual([]);
  });

  test('a refresh takes a turn only when no run started on the project in the interval, one of two at once', async () => {
    await registeredProject();
    await markSyncTried(db, repo, t0);

    const tooSoon = await takeSyncTurn(db, repo, t0 + 9 * MINUTE, 10 * MINUTE);
    const both = await Promise.all([
      takeSyncTurn(db, repo, t0 + 10 * MINUTE, 10 * MINUTE),
      takeSyncTurn(db, repo, t0 + 10 * MINUTE, 10 * MINUTE),
    ]);

    expect(tooSoon).toBe(false);
    expect(both.sort()).toEqual([false, true]);
    expect(await getIssueSync(db, repo)).toMatchObject({ triedAt: t0 + 10 * MINUTE });
  });

  test("a project's first refresh takes a turn", async () => {
    await registeredProject();

    expect(await takeSyncTurn(db, repo, t0, 10 * MINUTE)).toBe(true);
    expect(await getIssueSync(db, repo)).toEqual({ project: repo, passStartedAt: null, readAt: null, triedAt: t0 });
  });
});
