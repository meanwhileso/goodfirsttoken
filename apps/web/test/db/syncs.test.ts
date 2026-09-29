import type { D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  addToDoNotList,
  beginPass,
  createProject,
  finishPass,
  getIssueSync,
  holdProject,
  listProjectsToCheck,
  listProjectsToSync,
  releaseProject,
  setDelisted,
  setProjectStatus,
  takeRefresh,
} from '../../src/db';
import { admin, db, emptyDatabase, HOUR, maintainer, MINUTE, registeredProject, repo, signIn, t0 } from './helpers';

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

describe('delisting', () => {
  const fourth = 'sample-owner/fourth-app';
  const pause = (name: string, changedBy: number | null = maintainer.githubId) =>
    setProjectStatus(db, name, { status: 'paused', reason: changedBy === null ? `${name} is archived on GitHub.` : null, changedBy }, t0);

  test('a run checks every paused project and every approved one delisted, the one read longest ago first, never read first', async () => {
    for (const name of [repo, second, third, fourth]) await registeredProject({ tags: ['help wanted'] }, name);
    await pause(repo);
    await pause(second, null);
    await setDelisted(db, second, `${second} is archived on GitHub.`, t0 + MINUTE);
    await setDelisted(db, third, `${third} is archived on GitHub.`, t0);
    await setDelisted(db, fourth, null, t0);

    // The fourth is approved and shown, so its pass reads its repos.
    expect(await listProjectsToCheck(db)).toEqual([repo, third, second]);
  });

  test('no pending, rejected, or do-not-listed project is checked, delisted or not', async () => {
    await signIn(admin);
    for (const name of [repo, second, third]) await registeredProject({ tags: ['help wanted'], issueRepo: 'sample-owner/listed-issues' }, name);
    await setProjectStatus(db, repo, { status: 'pending', reason: null, changedBy: maintainer.githubId }, t0);
    await setProjectStatus(db, second, { status: 'rejected', reason: 'No tests to run.', changedBy: admin.githubId }, t0);
    await pause(third);
    for (const name of [repo, second]) await setDelisted(db, name, `${name} is archived on GitHub.`, t0);
    const before = await listProjectsToCheck(db);

    await addToDoNotList(db, { repo: 'Sample-Owner/Listed-Issues', reason: null, addedBy: admin.githubId }, t0);

    expect(before).toEqual([third]);
    expect(await listProjectsToCheck(db)).toEqual([]);
  });

  test("a read that shows the repos public and open takes the mark off, and keeps the pass where it stands", async () => {
    await registeredProject();
    const started = await beginPass(db, repo, t0);
    await setDelisted(db, repo, `${repo} is archived on GitHub.`, t0 + MINUTE);
    const marked = await getIssueSync(db, repo);

    await setDelisted(db, repo, null, t0 + HOUR);

    expect(marked).toMatchObject({ delisted: `${repo} is archived on GitHub.`, reposReadAt: t0 + MINUTE });
    expect(await getIssueSync(db, repo)).toMatchObject({ delisted: null, reposReadAt: t0 + HOUR, passStartedAt: started });
  });

  test('the mark keeps when the sync first set it, through later reads in the same words or others, and loses it when it comes off', async () => {
    await registeredProject();

    await setDelisted(db, repo, `${repo} is archived on GitHub.`, t0);
    const set = await getIssueSync(db, repo);
    await setDelisted(db, repo, `${repo} is archived on GitHub.`, t0 + MINUTE);
    const readAgain = await getIssueSync(db, repo);
    await setDelisted(db, repo, `${repo} is no longer public on GitHub.`, t0 + HOUR);
    const otherWords = await getIssueSync(db, repo);
    await setDelisted(db, repo, null, t0 + 2 * HOUR);
    const lifted = await getIssueSync(db, repo);
    await setDelisted(db, repo, `${repo} is archived on GitHub.`, t0 + 3 * HOUR);

    expect(set).toMatchObject({ delistedAt: t0, reposReadAt: t0 });
    expect(readAgain).toMatchObject({ delistedAt: t0, reposReadAt: t0 + MINUTE });
    expect(otherWords).toMatchObject({ delisted: `${repo} is no longer public on GitHub.`, delistedAt: t0, reposReadAt: t0 + HOUR });
    expect(lifted).toMatchObject({ delisted: null, delistedAt: null, reposReadAt: t0 + 2 * HOUR });
    expect(await getIssueSync(db, repo)).toMatchObject({ delistedAt: t0 + 3 * HOUR, reposReadAt: t0 + 3 * HOUR });
  });

  test('a mark set before the sync kept its time stays without one while it stays, and a new one gets its time', async () => {
    await registeredProject();
    await setDelisted(db, repo, `${repo} is archived on GitHub.`, t0);
    // As migration 0012 leaves a mark that was there before it.
    await db.prepare('UPDATE issue_syncs SET delisted_at = NULL WHERE project = ?').bind(repo).run();

    await setDelisted(db, repo, `${repo} is archived on GitHub.`, t0 + HOUR);
    const stillUnknown = await getIssueSync(db, repo);
    await setDelisted(db, repo, null, t0 + 2 * HOUR);
    await setDelisted(db, repo, `${repo} is archived on GitHub.`, t0 + 3 * HOUR);

    expect(stillUnknown).toMatchObject({ delisted: `${repo} is archived on GitHub.`, delistedAt: null });
    expect(await getIssueSync(db, repo)).toMatchObject({ delistedAt: t0 + 3 * HOUR });
  });

  test("the migration that brought the mark marks each project Good First Token paused before it, with its pause's reason", async () => {
    for (const name of [repo, second, third]) await registeredProject({ tags: ['help wanted'] }, name);
    await pause(repo);
    await pause(second, null);
    await beginPass(db, second, t0);
    await pause(third, null);
    const { TEST_MIGRATIONS } = env as Env & { TEST_MIGRATIONS: D1Migration[] };
    const migration = TEST_MIGRATIONS.find((m) => m.name === '0006_delisting.sql');
    // The columns are there already, so only the rows it writes run again.
    const writes = migration?.queries.filter((query) => /^\s*INSERT\b/i.test(query)) ?? [];

    for (const query of writes) await db.prepare(query).run();

    expect(writes).toHaveLength(1);
    expect(await getIssueSync(db, repo)).toBeNull();
    expect(await getIssueSync(db, second)).toMatchObject({ delisted: `${second} is archived on GitHub.`, passStartedAt: t0 });
    expect(await getIssueSync(db, third)).toMatchObject({ delisted: `${third} is archived on GitHub.` });
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
