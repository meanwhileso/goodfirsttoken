import { beforeEach, describe, expect, test } from 'vitest';
import {
  addToDoNotList,
  beginPass,
  createProject,
  finishPass,
  getIssueSync,
  holdProject,
  listProjectsToSync,
  releaseProject,
  setProjectStatus,
  takeRefresh,
} from '../../src/db';
import { db, emptyDatabase, HOUR, maintainer, MINUTE, registeredProject, repo, signIn, t0 } from './helpers';

// Where the tagged-issue sync stands for each project. Every repo here is
// made up.

const second = 'sample-owner/second-app';
const third = 'sample-owner/third-app';
const HOLD = 15 * MINUTE;
const INTERVAL = 10 * MINUTE;

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
});

describe('one run at a time', () => {
  test('a run holds a project until it lets go, or its time runs out, and no other run holds it meanwhile', async () => {
    await registeredProject();

    const first = await holdProject(db, repo, t0, t0 + HOLD);
    const meanwhile = await holdProject(db, repo, t0 + MINUTE, t0 + MINUTE + HOLD);
    const afterTimeUp = await holdProject(db, repo, t0 + HOLD, t0 + 2 * HOLD);
    // The first run lets go late. The hold the third took stays.
    await releaseProject(db, repo, t0 + HOLD);
    const stillHeld = await holdProject(db, repo, t0 + HOLD + MINUTE, t0 + 3 * HOLD);
    await releaseProject(db, repo, t0 + 2 * HOLD);

    expect([first, meanwhile, afterTimeUp, stillHeld]).toEqual([true, false, true, false]);
    expect(await holdProject(db, repo, t0 + HOLD + 2 * MINUTE, t0 + 3 * HOLD)).toBe(true);
  });

  test('a refresh waits 10 minutes after the last refresh, but not after a scheduled run', async () => {
    await registeredProject();
    await holdProject(db, repo, t0, t0 + HOLD);
    await releaseProject(db, repo, t0 + HOLD);

    const afterScheduled = await takeRefresh(db, repo, t0 + MINUTE, INTERVAL, t0 + MINUTE + HOLD);
    await releaseProject(db, repo, t0 + MINUTE + HOLD);
    const tooSoon = await takeRefresh(db, repo, t0 + 9 * MINUTE, INTERVAL, t0 + 9 * MINUTE + HOLD);
    const onTime = await takeRefresh(db, repo, t0 + 11 * MINUTE, INTERVAL, t0 + 11 * MINUTE + HOLD);

    expect([afterScheduled, tooSoon, onTime]).toEqual(['taken', 'too_soon', 'taken']);
    expect(await getIssueSync(db, repo)).toMatchObject({ refreshedAt: t0 + 11 * MINUTE, readingUntil: t0 + 11 * MINUTE + HOLD });
  });

  test("a refresh while another run holds the project is busy, and doesn't count as a refresh", async () => {
    await registeredProject();
    await holdProject(db, repo, t0, t0 + HOLD);

    const busy = await takeRefresh(db, repo, t0 + MINUTE, INTERVAL, t0 + MINUTE + HOLD);
    await releaseProject(db, repo, t0 + HOLD);
    const after = await takeRefresh(db, repo, t0 + 2 * MINUTE, INTERVAL, t0 + 2 * MINUTE + HOLD);

    expect([busy, after]).toEqual(['busy', 'taken']);
  });

  test('of two refreshes at the same moment, one takes the turn', async () => {
    await registeredProject();

    const both = await Promise.all([
      takeRefresh(db, repo, t0, INTERVAL, t0 + HOLD),
      takeRefresh(db, repo, t0, INTERVAL, t0 + HOLD),
    ]);

    expect(both.sort()).toEqual(['taken', 'too_soon']);
  });
});
