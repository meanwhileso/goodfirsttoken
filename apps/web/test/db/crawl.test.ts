import type { CrawlPass } from '@goodfirsttoken/core';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  addCandidate,
  addSeed,
  addToDoNotList,
  crawlerSkips,
  decideCandidate,
  latestCrawlPass,
  listSeedsToQueue,
  markSeedsQueued,
  moveCrawlPass,
  startCrawlPass,
} from '../../src/db';
import { admin, DAY, db, emptyDatabase, HOUR, maintainer, refusal, registeredProject, signIn, t0 } from './helpers';

// The policy crawler's tables: its seed list, and where each pass of its
// search stands. Every repo here is made up.

const pass: CrawlPass = {
  startedAt: t0,
  pushedSince: t0 - 30 * DAY,
  pool: null,
  low: 1000,
  width: 10,
  open: true,
  page: 1,
  queued: 0,
  finishedAt: null,
};

beforeEach(async () => {
  await emptyDatabase();
  await signIn(admin, maintainer);
});

describe('the seed list', () => {
  test('a repo is added once, whatever the case of its name, and keeps its first entry', async () => {
    const first = await addSeed(db, { repo: 'sample-owner/seeded', addedBy: admin.githubId }, t0);
    const again = await addSeed(db, { repo: 'Sample-Owner/Seeded', addedBy: maintainer.githubId }, t0 + HOUR);

    expect(first).toEqual({ seed: { repo: 'sample-owner/seeded', addedBy: admin.githubId, addedAt: t0, queuedAt: null }, added: true });
    expect(again).toEqual({ seed: first.seed, added: false });
  });

  test('the seeds to queue are the ones not queued yet, oldest first, and queuing one again keeps its first time', async () => {
    await addSeed(db, { repo: 'sample-owner/second', addedBy: admin.githubId }, t0 + HOUR);
    await addSeed(db, { repo: 'sample-owner/first', addedBy: admin.githubId }, t0);
    await addSeed(db, { repo: 'sample-owner/third', addedBy: admin.githubId }, t0 + 2 * HOUR);

    await markSeedsQueued(db, ['Sample-Owner/Second'], t0 + 3 * HOUR);
    await markSeedsQueued(db, ['sample-owner/second'], t0 + 4 * HOUR);

    expect((await listSeedsToQueue(db, 10)).map((seed) => seed.repo)).toEqual(['sample-owner/first', 'sample-owner/third']);
    expect((await listSeedsToQueue(db, 1)).map((seed) => seed.repo)).toEqual(['sample-owner/first']);
    const second = await db.prepare("SELECT queued_at FROM crawl_seeds WHERE repo = 'sample-owner/second'").first<number>('queued_at');
    expect(second).toBe(t0 + 3 * HOUR);
  });

  test('only a numeric GitHub ID of someone who signed in can add a seed', async () => {
    expect(await refusal(addSeed(db, { repo: 'sample-owner/seeded', addedBy: 424242 }, t0))).toMatch(/FOREIGN KEY/);
    expect(await refusal(addSeed(db, { repo: 'not a repo', addedBy: admin.githubId }, t0))).toMatch(/repo/);
  });
});

describe('crawl passes', () => {
  test('one pass runs at a time', async () => {
    const started = await startCrawlPass(db, pass);
    const second = await startCrawlPass(db, { ...pass, startedAt: t0 + HOUR });

    expect(started).toEqual(pass);
    expect(second).toBeNull();
    expect(await latestCrawlPass(db)).toEqual(pass);
  });

  test('a new pass can start once the last one is done', async () => {
    await startCrawlPass(db, pass);
    await moveCrawlPass(db, pass, { ...pass, finishedAt: t0 + DAY });

    const next = await startCrawlPass(db, { ...pass, startedAt: t0 + 30 * DAY });

    expect(next).toMatchObject({ startedAt: t0 + 30 * DAY });
    expect(await latestCrawlPass(db)).toEqual(next);
  });

  test('a pass moves on only from where it stands, so two runs never both move it from the same place', async () => {
    await startCrawlPass(db, pass);
    const one = { ...pass, open: false, pool: 5000 };
    const other = { ...pass, page: 2, queued: 100 };

    const first = await moveCrawlPass(db, pass, one);
    const second = await moveCrawlPass(db, pass, other);

    expect([first, second]).toEqual([true, false]);
    expect(await latestCrawlPass(db)).toEqual(one);
  });

  test('a pass that is done moves no more', async () => {
    await startCrawlPass(db, pass);
    const done = { ...pass, finishedAt: t0 + DAY };
    await moveCrawlPass(db, pass, done);

    expect(await moveCrawlPass(db, done, { ...done, page: 2 })).toBe(false);
  });
});

describe('what the crawler leaves alone', () => {
  test('a repo on the do-not-list, a project, or one it proposed before, whatever the admin decided, with the do-not-list first', async () => {
    await registeredProject({ tags: ['help wanted'] }, 'sample-owner/listed');
    await addToDoNotList(db, { repo: 'sample-owner/listed', reason: null, addedBy: admin.githubId }, t0);
    await registeredProject({ tags: ['help wanted'] }, 'sample-owner/project');
    const found = await addCandidate(
      db,
      {
        repo: 'sample-owner/proposed',
        facts: { stars: 1200, createdAt: t0 - DAY, pushedAt: t0, ownerCreatedAt: t0 - DAY },
        policy: { quote: 'AI help is fine.', url: 'https://github.com/sample-owner/proposed/blob/main/CONTRIBUTING.md', tier: 'allows_with_conditions' },
        settings: {},
        suggestedTags: [],
      },
      t0,
    );
    await decideCandidate(db, found?.id ?? '', { status: 'rejected', decidedBy: admin.githubId, reason: 'Not now.' }, t0 + HOUR);

    const skips = await crawlerSkips(db, ['Sample-Owner/Listed', 'sample-owner/project', 'SAMPLE-OWNER/PROPOSED', 'sample-owner/new']);

    expect(skips).toEqual(
      new Map([
        ['sample-owner/listed', 'do_not_list'],
        ['sample-owner/project', 'project'],
        ['sample-owner/proposed', 'proposed'],
      ]),
    );
    expect(await crawlerSkips(db, [])).toEqual(new Map());
  });
});
