import type { CrawlMessage, CrawlPass } from '@goodfirsttoken/core';
import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fillCrawlQueue } from '../../src/crawl/search';
import { addSeed, getSeed, latestCrawlPass, markSeedsHandled, moveCrawlPass, startCrawlPass } from '../../src/db';
import { ServiceGitHub } from '../../src/sync/github';
import { startGitHub } from '../auth/helpers';
import { admin, DAY, db, emptyDatabase, HOUR, maintainer, registeredProject, signIn } from '../db/helpers';
import { knowServiceToken } from '../sync/helpers';

const start = Date.UTC(2100, 3, 1, 12);
const broad: CrawlPass = {
  startedAt: start - DAY, pushedSince: start - 31 * DAY, pool: 2000,
  low: 1000, width: 10, open: false, page: 1, queued: 0, finishedAt: null,
};
let github: GitHubFake;
let sent: CrawlMessage[];
let logged: string[];
const queue = {
  sendBatch: (messages: Iterable<MessageSendRequest<CrawlMessage>>) => {
    for (const message of messages) sent.push(message.body);
    return Promise.resolve();
  },
};
function fill(maxCalls = 3, overrides: Partial<Parameters<typeof fillCrawlQueue>[0]> = {}) {
  return fillCrawlQueue({ db, queue, github: new ServiceGitHub(env.GH_SERVICE_TOKEN, { leave: 0.1, maxCalls }), now: Date.now, ...overrides });
}
function searches() {
  return github.calls.filter((call) => call.operation === 'GET /search/repositories').map((call) => new URL(call.url));
}
async function popular() {
  return db.prepare('SELECT * FROM popular_crawl_passes ORDER BY started_at DESC LIMIT 1').first();
}
function bulk(count: number, stars = 20000) {
  const template = github.state.repos['sample-policies/silent'];
  if (!template) throw new Error('missing sample repo');
  return Array.from({ length: count }, (_, n) => {
    const name = `popular${String(n).padStart(4, '0')}`;
    const repo = `sample-bulk/${name}`;
    github.state.repos[repo] = { ...template, id: 9_000_000 + n, owner: 'sample-bulk', name, stars: stars + n, pushedAt: new Date(start - HOUR).toISOString() };
    return repo;
  });
}
/** Change a GitHub search answer while preserving its budget headers. */
function changeSearch(change: (body: Record<string, unknown>, url: URL) => Record<string, unknown>) {
  const answer = github.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await answer(request);
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/search/')) return response;
    return new Response(JSON.stringify(change(await response.json<Record<string, unknown>>(), url)), { status: response.status, headers: response.headers });
  });
}
beforeEach(async () => {
  await emptyDatabase();
  await signIn(admin, maintainer);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
  sent = [];
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => void logged.push(parts.map(String).join(' ')));
  vi.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => void logged.push(parts.map(String).join(' ')));
  github = startGitHub();
  knowServiceToken(github);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the popular sample', () => {
  test('starts during an unfinished broad pass and uses the last call for the highest-star popular page', async () => {
    const names = bulk(250);
    await startCrawlPass(db, broad);
    const run = await fill();
    expect(searches().map((url) => url.searchParams.get('order'))).toEqual(['asc', 'desc']);
    expect(github.calls.filter((call) => call.operation === 'GET /rate_limit')).toHaveLength(1);
    expect(searches()[1]?.searchParams.get('q')).toBe('stars:>=10000 pushed:>=2100-03-02 archived:false is:public');
    expect(searches()[1]?.searchParams.get('per_page')).toBe('100');
    expect(sent.flatMap((message) => message.repos)).toContain(names.at(-1));
    expect(sent.flatMap((message) => message.repos)).not.toContain(names[0]);
    expect(run).toMatchObject({ calls: 3, stopped: 'calls' });
    expect(await popular()).toMatchObject({ started_at: start, pushed_since: start - 30 * DAY, pool: 252, page: 2, queued: 100, finished_at: null });
    expect((await latestCrawlPass(db))?.startedAt).toBe(broad.startedAt);
  });

  test('resumes the popular page and its push date without resetting the broad band', async () => {
    bulk(450);
    await startCrawlPass(db, broad);
    await fill();
    const firstBroad = await latestCrawlPass(db);
    vi.setSystemTime(start + HOUR);
    await fill();
    expect(searches().filter((url) => url.searchParams.get('order') === 'desc').map((url) => url.searchParams.get('page'))).toEqual(['1', '2']);
    expect(await popular()).toMatchObject({ started_at: start, pushed_since: start - 30 * DAY, page: 3, queued: 200 });
    expect(await latestCrawlPass(db)).toMatchObject({ startedAt: firstBroad?.startedAt, low: firstBroad?.low, page: 2, open: true, finishedAt: null });
  });

  test('caps a sample above 1000 results at ten pages while broad search keeps advancing', async () => {
    bulk(1100);
    await startCrawlPass(db, broad);
    const broadPlaces: number[] = [];
    for (let n = 0; n < 10; n++) {
      await fill();
      broadPlaces.push((await latestCrawlPass(db))?.low ?? 0);
      vi.setSystemTime(start + (n + 1) * HOUR);
    }
    expect(searches().filter((url) => url.searchParams.get('order') === 'desc').map((url) => Number(url.searchParams.get('page')))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await popular()).toMatchObject({ pool: 1102, page: 10, queued: 1000, finished_at: start + 9 * HOUR });
    expect(new Set(broadPlaces).size).toBeGreaterThan(1);
    expect(logged.some((line) => /popular.*1102.*1000.*cap/i.test(line))).toBe(true);
    await fill();
    expect(searches().filter((url) => url.searchParams.get('order') === 'desc')).toHaveLength(10);
  });

  test('a shrinking result pool can finish early without claiming the sample cap was reached', async () => {
    bulk(1100);
    await startCrawlPass(db, broad);
    await fill();
    changeSearch((body, url) => url.searchParams.get('order') === 'desc' ? { ...body, total_count: 150, items: (body.items as unknown[]).slice(0, 50) } : body);
    await fill();
    expect(await popular()).toMatchObject({ pool: 1102, page: 2, queued: 150, finished_at: start });
    expect(logged.at(-1)).not.toContain('Finished at the sample cap');
  });

  test('starts another sample only once the finished sample is thirty days old', async () => {
    bulk(3);
    await startCrawlPass(db, { ...broad, finishedAt: start - HOUR });
    await fill();
    vi.setSystemTime(start + 30 * DAY - 1);
    await fill();
    expect(await popular()).toMatchObject({ started_at: start, finished_at: start });
    const count = searches().filter((url) => url.searchParams.get('order') === 'desc').length;
    vi.setSystemTime(start + 30 * DAY);
    await fill();
    expect(await popular()).toMatchObject({ started_at: start + 30 * DAY, pushed_since: start, page: 1, finished_at: start + 30 * DAY });
    expect(searches().filter((url) => url.searchParams.get('order') === 'desc')).toHaveLength(count + 1);
  });

  test('seeds and weekly reads enter the FIFO queue before searches even with no search calls left', async () => {
    await addSeed(db, { repo: 'sample-policies/small-seed', addedBy: admin.githubId }, start);
    await registeredProject({ tags: ['help wanted'] }, 'sample-policies/invites-agents');
    const run = await fill(1);
    expect(sent).toEqual([{ repos: ['sample-policies/small-seed'] }, { repos: ['sample-policies/invites-agents'], reread: true }]);
    expect(run).toMatchObject({ seeds: 1, rereads: 1, calls: 1, searches: 0, stopped: 'calls' });
    expect(await popular()).toMatchObject({ page: 1, finished_at: null });
  });

  test('popular search honors the threshold, visibility, and archive status', async () => {
    const names = bulk(4, 9999);
    const archived = github.state.repos[names[2] ?? ''];
    const hidden = github.state.repos[names[3] ?? ''];
    if (!archived || !hidden) throw new Error('missing sample repo');
    archived.archived = true;
    hidden.private = true;
    await startCrawlPass(db, { ...broad, finishedAt: start - HOUR });
    await fill();
    const repos = sent.flatMap((message) => message.repos);
    expect(repos).toContain(names[1]);
    expect(repos).not.toContain(names[0]);
    expect(repos).not.toContain(names[2]);
    expect(repos).not.toContain(names[3]);
  });

  test('seeds handled before the ledger migration stay protected during the first popular sample', async () => {
    const names = bulk(3);
    await startCrawlPass(db, { ...broad, finishedAt: start - HOUR });
    await addSeed(db, { repo: names[2] ?? '', addedBy: admin.githubId }, broad.startedAt);
    await markSeedsHandled(db, [{ repo: names[2] ?? '', outcome: 'queued' }], start - HOUR, broad.startedAt);
    await fill();
    expect(sent.flatMap((message) => message.repos)).not.toContain(names[2]);
    expect(await popular()).toMatchObject({ queued: 4 });
  });

  test('gives popular search at most four calls and sends the rest to the broad pass', async () => {
    bulk(1100);
    await startCrawlPass(db, broad);
    await fill(8);
    expect(searches().map((url) => url.searchParams.get('order'))).toEqual(['asc', 'desc', 'desc', 'desc', 'desc', 'asc', 'asc']);
  });

  test.each(['incomplete', 'malformed'])('a popular %s response preserves its page after the broad call succeeds', async (kind) => {
    bulk(250);
    await startCrawlPass(db, broad);
    changeSearch((body, url) => url.searchParams.get('order') !== 'desc' ? body : kind === 'incomplete' ? { ...body, incomplete_results: true } : { ...body, total_count: '250' });
    const run = await fill();
    expect(run).toMatchObject({ stopped: 'github_error', searches: 2 });
    expect(await popular()).toMatchObject({ pool: null, page: 1, queued: 0, finished_at: null });
    expect((await latestCrawlPass(db))?.low).toBeGreaterThan(broad.low);
  });

  test.each([null, [null], [42]])('a malformed popular body or item %j does not advance its checkpoint', async (items) => {
    bulk(250);
    await startCrawlPass(db, broad);
    changeSearch((body, url) => url.searchParams.get('order') !== 'desc' ? body : { ...body, items });
    const run = await fill();
    expect(run.stopped).toBe('github_error');
    expect(await popular()).toMatchObject({ page: 1, queued: 0, pool: null });
  });

  test('a failed popular queue send leaves the successful broad move and popular page intact', async () => {
    bulk(250);
    await startCrawlPass(db, broad);
    const failure = new Error('The queue is down.');
    const failing = { sendBatch: async (messages: Iterable<MessageSendRequest<CrawlMessage>>) => {
      const batch = [...messages];
      if (batch.some((message) => message.body.repos.some((repo) => repo.startsWith('sample-bulk/')))) throw failure;
      await queue.sendBatch(batch);
    } };
    await expect(fill(3, { queue: failing })).rejects.toThrow(failure);
    expect(await popular()).toMatchObject({ page: 1, queued: 0, finished_at: null });
    expect((await latestCrawlPass(db))?.low).toBeGreaterThan(broad.low);
    await fill();
    expect(await popular()).toMatchObject({ page: 2, queued: 100 });
  });

  test('successfully recorded seed and popular sends prevent later broad sends without case', async () => {
    const names = bulk(3);
    await addSeed(db, { repo: (names[2] ?? '').toUpperCase(), addedBy: admin.githubId }, start);
    await startCrawlPass(db, broad);
    await fill();
    await addSeed(db, { repo: (names[1] ?? '').toUpperCase(), addedBy: admin.githubId }, start + 1);
    // Broad reaches the popular repos after the sample is finished.
    const current = await latestCrawlPass(db);
    if (!current) throw new Error('missing broad pass');
    await moveCrawlPass(db, current, { ...current, low: 10000, open: true });
    await fill(8);
    const queued = sent.flatMap((message) => message.repos).map((repo) => repo.toLowerCase());
    for (const name of names) expect(queued.filter((repo) => repo === name)).toHaveLength(1);
    expect(await getSeed(db, names[1] ?? '')).toMatchObject({ outcome: 'queued', handledAt: start });
  });

  test('a broad result recorded first is counted as seen by the popular sample', async () => {
    const names = bulk(3);
    await fill(8);
    expect(searches().map((url) => url.searchParams.get('order'))).toEqual(['asc', 'desc']);
    for (const name of names) expect(sent.flatMap((message) => message.repos).filter((repo) => repo === name)).toHaveLength(1);
    expect(await popular()).toMatchObject({ pool: 5, queued: 0, finished_at: start });
  });

  test('starts with a finished latest broad pass and deduplicates using its scope', async () => {
    const names = bulk(3);
    await startCrawlPass(db, { ...broad, finishedAt: start - HOUR });
    await addSeed(db, { repo: names[2] ?? '', addedBy: admin.githubId }, start);
    const run = await fill();
    expect(searches().map((url) => url.searchParams.get('order'))).toEqual(['desc']);
    expect(run.pass).toMatchObject({ startedAt: broad.startedAt, finishedAt: start - HOUR });
    expect(await popular()).toMatchObject({ queued: 4, finished_at: start });
    expect(sent.flatMap((message) => message.repos).filter((repo) => repo === names[2])).toHaveLength(1);
    const scopes = await db.prepare('SELECT DISTINCT broad_started_at FROM crawl_queued_repos').all<{ broad_started_at: number }>();
    expect(scopes.results).toEqual([{ broad_started_at: broad.startedAt }]);
  });

  test('concurrent producers leave one checkpoint move and permit duplicate delivery before recording', async () => {
    bulk(250);
    await startCrawlPass(db, { ...broad, finishedAt: start - HOUR });
    let release: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    let sends = 0;
    const simultaneous = { sendBatch: async (messages: Iterable<MessageSendRequest<CrawlMessage>>) => {
      await queue.sendBatch(messages);
      if (++sends === 2) release();
      await ready;
    } };
    const runs = await Promise.all([fill(2, { queue: simultaneous }), fill(2, { queue: simultaneous })]);
    expect(runs.map((run) => run.stopped).sort()).toEqual(['calls', 'moved']);
    expect(await popular()).toMatchObject({ page: 2, queued: 100 });
    expect(sent.flatMap((message) => message.repos)).toHaveLength(200);
    const recorded = await db.prepare('SELECT COUNT(*) AS n FROM crawl_queued_repos').first<number>('n');
    expect(recorded).toBe(100);
  });

  test('a failure after sending and before recording permits redelivery without advancing the popular page', async () => {
    const names = bulk(3);
    await startCrawlPass(db, { ...broad, finishedAt: start - HOUR });
    const broken: D1Database = {
      prepare: (sql) => {
        if (/INSERT INTO crawl_queued_repos/.test(sql)) throw new Error('Lost after send.');
        return db.prepare(sql);
      },
      batch: db.batch.bind(db), exec: db.exec.bind(db),
      withSession: db.withSession.bind(db), dump: () => Promise.reject(new Error('No database export in this test.')),
    };
    await expect(fill(3, { db: broken })).rejects.toThrow('Lost after send.');
    expect(sent.flatMap((message) => message.repos)).toContain(names[2]);
    expect(await popular()).toMatchObject({ page: 1, queued: 0, finished_at: null });
    await fill();
    expect(sent.flatMap((message) => message.repos).filter((repo) => repo === names[2])).toHaveLength(2);
  });

  test('a new broad scope keeps an unfinished popular cursor and prunes completed older records', async () => {
    const names = bulk(450);
    await startCrawlPass(db, { ...broad, startedAt: start - 31 * DAY, finishedAt: start - DAY });
    await fill();
    const old = await latestCrawlPass(db);
    if (!old) throw new Error('missing broad pass');
    await moveCrawlPass(db, old, { ...old, finishedAt: start });
    vi.setSystemTime(start + 30 * DAY);
    await fill();
    expect(await popular()).toMatchObject({ started_at: start, pushed_since: start - 30 * DAY, page: 3 });
    expect((await latestCrawlPass(db))?.startedAt).toBe(start + 30 * DAY);
    const scopes = await db.prepare('SELECT DISTINCT broad_started_at FROM crawl_queued_repos').all<{ broad_started_at: number }>();
    expect(scopes.results.map((row) => row.broad_started_at)).toEqual([start + 30 * DAY]);
    expect(sent.flatMap((message) => message.repos)).toContain(names.at(-101));
  });
});


const validSearchItem = { full_name: 'sample-policies/invites-agents', private: false, archived: false };
const validSearchResponse = { total_count: 250, incomplete_results: false, items: [validSearchItem] };
const malformedSearchResponses: [string, Record<string, unknown>][] = [
  ['missing full_name', { ...validSearchResponse, items: [validSearchItem, { private: false, archived: false }] }],
  ['invalid full_name', { ...validSearchResponse, items: [validSearchItem, { ...validSearchItem, full_name: 'not a repo' }] }],
  ['non-string full_name', { ...validSearchResponse, items: [validSearchItem, { ...validSearchItem, full_name: 42 }] }],
  ['missing private', { ...validSearchResponse, items: [validSearchItem, { full_name: validSearchItem.full_name, archived: false }] }],
  ['nonboolean private', { ...validSearchResponse, items: [validSearchItem, { ...validSearchItem, private: 'false' }] }],
  ['missing archived', { ...validSearchResponse, items: [validSearchItem, { full_name: validSearchItem.full_name, private: false }] }],
  ['nonboolean archived', { ...validSearchResponse, items: [validSearchItem, { ...validSearchItem, archived: 'false' }] }],
  ['missing incomplete_results', { ...validSearchResponse, incomplete_results: undefined }],
  ['nonboolean incomplete_results', { ...validSearchResponse, incomplete_results: 'false' }],
  ['null incomplete_results', { ...validSearchResponse, incomplete_results: null }],
];

describe.each(['broad', 'popular'])('%s response validation', (path) => {
  test.each(malformedSearchResponses)('%s preserves both checkpoints and sends nothing', async (_kind, response) => {
    const before = path === 'popular' ? { ...broad, finishedAt: start - HOUR } : broad;
    await startCrawlPass(db, before);
    changeSearch(() => response);
    const run = await fill(2);
    expect(run).toMatchObject({ stopped: 'github_error', searches: 1, queued: 0 });
    expect(sent).toEqual([]);
    expect(await latestCrawlPass(db)).toEqual(before);
    expect(await popular()).toMatchObject({
      started_at: start, pushed_since: start - 30 * DAY, pool: null,
      page: 1, queued: 0, finished_at: null,
    });
  });

  test('valid archived and private results keep their skips while the public repo is sent', async () => {
    await startCrawlPass(db, path === 'popular' ? { ...broad, finishedAt: start - HOUR } : broad);
    changeSearch(() => ({
      total_count: 3, incomplete_results: false,
      items: [
        { full_name: 'sample-owner/archived', private: false, archived: true },
        { full_name: 'sample-owner/private', private: true, archived: false },
        validSearchItem,
      ],
    }));
    await fill(2);
    expect(sent).toEqual([{ repos: [validSearchItem.full_name] }]);
    if (path === 'popular') expect(await popular()).toMatchObject({ queued: 1, finished_at: start });
    else expect(await latestCrawlPass(db)).toMatchObject({ queued: 1, low: broad.low + broad.width });
  });
});
