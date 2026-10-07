import { beforeEach, describe, expect, test } from 'vitest';
import {
  latestCrawlPass, latestPopularCrawlPass, moveCrawlPass, movePopularCrawlPass,
  queuedCrawlRepos, recordCrawlQueuedRepos, retireCrawlQueuedRepos,
  startCrawlPass, startPopularCrawlPass, type PopularCrawlPass,
} from '../../src/db';
import { DAY, db, emptyDatabase, HOUR, refusal, t0 } from './helpers';

const sample: PopularCrawlPass = { startedAt: t0, pushedSince: t0 - 30 * DAY, pool: null, page: 1, queued: 0, finishedAt: null };
const broad = { ...sample, low: 1000, width: 10, open: true };
beforeEach(emptyDatabase);

describe('popular checkpoints', () => {
  test('concurrent starts leave one unfinished sample while broad discovery is in progress', async () => {
    await startCrawlPass(db, broad);
    const starts = await Promise.all([startPopularCrawlPass(db, sample), startPopularCrawlPass(db, { ...sample, startedAt: t0 + 1 })]);
    expect(starts.filter((pass) => pass !== null)).toHaveLength(1);
    expect(await latestCrawlPass(db)).toEqual(broad);
    expect(await latestPopularCrawlPass(db)).toEqual(starts.find((pass) => pass !== null));
    expect(await startPopularCrawlPass(db, { ...sample, startedAt: t0 + 31 * DAY })).toBeNull();
  });

  test('competing page moves preserve the winning page and count', async () => {
    await startPopularCrawlPass(db, sample);
    const next = { ...sample, pool: 350, page: 2, queued: 100 };
    const moves = await Promise.all([
      movePopularCrawlPass(db, sample, next),
      movePopularCrawlPass(db, sample, { ...next, queued: 90 }),
    ]);
    expect(moves.filter(Boolean)).toHaveLength(1);
    expect(await latestPopularCrawlPass(db)).toEqual(moves[0] ? next : { ...next, queued: 90 });
    expect(await movePopularCrawlPass(db, sample, { ...sample, finishedAt: t0 + HOUR })).toBe(false);
  });

  test('finished samples stop moving and allow another sample with its own push date', async () => {
    await startPopularCrawlPass(db, sample);
    const done = { ...sample, pool: 0, finishedAt: t0 + HOUR };
    expect(await movePopularCrawlPass(db, sample, done)).toBe(true);
    expect(await movePopularCrawlPass(db, done, { ...done, page: 2 })).toBe(false);
    const next = { ...sample, startedAt: t0 + 30 * DAY, pushedSince: t0 };
    expect(await startPopularCrawlPass(db, next)).toEqual(next);
    expect(await latestPopularCrawlPass(db)).toEqual(next);
  });

  test('an already finished sample prevents new starts before thirty days, including a stale producer request', async () => {
    await startPopularCrawlPass(db, sample);
    await movePopularCrawlPass(db, sample, { ...sample, pool: 0, finishedAt: t0 + 1 });
    expect(await startPopularCrawlPass(db, { ...sample, startedAt: t0 + 11 })).toBeNull();
    expect(await startPopularCrawlPass(db, { ...sample, startedAt: t0 + 30 * DAY - 1 })).toBeNull();
    const next = { ...sample, startedAt: t0 + 30 * DAY, pushedSince: t0 };
    expect(await startPopularCrawlPass(db, next)).toEqual(next);
    expect(await latestPopularCrawlPass(db)).toEqual(next);
  });

  test('a move cannot change the sample identity and invalid pages cannot be stored', async () => {
    await startPopularCrawlPass(db, sample);
    expect(await refusal(movePopularCrawlPass(db, sample, { ...sample, startedAt: t0 + 1 }))).toMatch(/within itself/);
    expect(await refusal(movePopularCrawlPass(db, sample, { ...sample, pushedSince: t0 }))).toMatch(/within itself/);
    expect(await refusal(movePopularCrawlPass(db, sample, { ...sample, page: 11 }))).toMatch(/page/);
    expect(await latestPopularCrawlPass(db)).toEqual(sample);
  });
});

describe('successful queue sends', () => {
  test('records without case, once in each broad scope, including when the broad pass is finished', async () => {
    await startCrawlPass(db, broad);
    await recordCrawlQueuedRepos(db, ['sample-owner/repo', 'SAMPLE-OWNER/REPO'], t0);
    await recordCrawlQueuedRepos(db, ['Sample-Owner/Repo'], t0);
    await moveCrawlPass(db, broad, { ...broad, finishedAt: t0 + HOUR });
    expect(await queuedCrawlRepos(db, ['SAMPLE-OWNER/REPO', 'sample-owner/new'], t0)).toEqual(new Set(['sample-owner/repo']));
    const next = { ...broad, startedAt: t0 + DAY };
    await startCrawlPass(db, next);
    expect(await queuedCrawlRepos(db, ['sample-owner/repo'], next.startedAt)).toEqual(new Set());
    await recordCrawlQueuedRepos(db, ['sample-owner/repo'], next.startedAt);
    expect((await db.prepare('SELECT * FROM crawl_queued_repos').all()).results).toHaveLength(2);
  });

  test('retirement keeps the current finished scope and only removes completed older scopes', async () => {
    await startCrawlPass(db, { ...broad, finishedAt: t0 + HOUR });
    await recordCrawlQueuedRepos(db, ['sample-owner/old'], t0);
    const next = { ...broad, startedAt: t0 + DAY, finishedAt: t0 + DAY + HOUR };
    await startCrawlPass(db, next);
    await recordCrawlQueuedRepos(db, ['sample-owner/current'], next.startedAt);
    await retireCrawlQueuedRepos(db, next.startedAt);
    expect(await queuedCrawlRepos(db, ['sample-owner/old'], t0)).toEqual(new Set());
    expect(await queuedCrawlRepos(db, ['sample-owner/current'], next.startedAt)).toEqual(new Set(['sample-owner/current']));
    expect(await queuedCrawlRepos(db, [], next.startedAt)).toEqual(new Set());
  });
});
