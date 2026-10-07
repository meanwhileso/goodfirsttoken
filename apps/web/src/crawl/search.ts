import { repoName, SEARCH_PAGES, type CrawlMessage, type CrawlPass } from '@goodfirsttoken/core';
import {
  crawlerSkips,
  latestCrawlPass,
  latestPopularCrawlPass,
  listProjectsToReread,
  listSeedsToHandle,
  markRereadsQueued,
  markSeedsHandled,
  moveCrawlPass,
  movePopularCrawlPass,
  queuedCrawlRepos,
  recordCrawlQueuedRepos,
  retireCrawlQueuedRepos,
  seedsQueuedSince,
  startCrawlPass,
  startPopularCrawlPass,
  type CrawlerSkip,
  type PopularCrawlPass,
} from '../db';
import { SyncStopped, type ServiceGitHub, type StopReason } from '../sync/github';

// The policy crawler's cron job (spec section 5). It fills the crawl queue
// with batches of repos for its consumer (src/crawl/queue.ts) to read: first
// the seeds an admin added and listed projects due for their weekly read.
// Then it advances the broad search, reads up to four popular pages, and
// spends the remaining calls on the broad search. Both find public repos
// pushed in the last 30 days. Broad search starts at 1,000 stars. The popular
// sample starts at 10,000 stars and reads the highest-star results first.
// Search serves at most
// 1,000 results for a query, so it reads the pool in bands of star counts,
// each narrow enough for search to serve whole, and keeps where it stands in
// crawl_passes. A run stops when its share of the search budget or its calls
// run out, and the next run picks up there. A new pass starts a month after
// the last one started. Each run also queues the listed projects due for
// their weekly read, which src/crawl/reread.ts keeps current. The rules are
// in docs/how-it-works.md, under The policy crawler and Keeping listings
// current.

/** The fewest stars a repo needs for the search to find it. */
export const CRAWL_MIN_STARS = 1000;
/** The popular sample reads the highest-star results above this threshold. */
const POPULAR_MIN_STARS = 10000;
const POPULAR_CALLS_PER_RUN = 4;
/** The search finds repos pushed in this many days before the pass started. */
export const CRAWL_PUSHED_DAYS = 30;
/** Repos in one message of the crawl queue. */
export const CRAWL_BATCH = 10;
/** The most seeds one run queues. */
const SEEDS_PER_RUN = 500;
/** The most listed projects one run queues for their weekly read. */
const REREADS_PER_RUN = 500;
/** How many star counts the first closed band spans. */
const FIRST_WIDTH = 10;
/** A band with fewer repos than this is sparse, and the next one spans twice as many star counts. */
const SPARSE = 250;
/** GitHub's largest page, and the most results search serves for a query. */
const PER_PAGE = 100;
const SEARCH_LIMIT = PER_PAGE * SEARCH_PAGES;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How often a listed project's docs are read again. */
export const REREAD_EVERY_MS = 7 * DAY_MS;
/** How long after a pass started the next one starts, once it is done. */
export const CRAWL_PASS_EVERY_MS = 30 * DAY_MS;

export interface FillDeps {
  db: D1Database;
  /** The crawl queue, or a stand-in that takes its batches the same way. */
  queue: { sendBatch: (messages: Iterable<MessageSendRequest<CrawlMessage>>) => Promise<unknown> };
  github: ServiceGitHub;
  now: () => number;
}

/** What one run did, for its log line. */
export interface FillRun {
  seeds: number;
  /** Listed projects queued for their weekly read. */
  rereads: number;
  searches: number;
  queued: number;
  /** The pass as the run left it, or null when there is none. */
  pass: CrawlPass | null;
  popularPass: PopularCrawlPass | null;
  popularSearches: number;
  popularQueued: number;
  calls: number;
  stopped: StopReason | 'moved' | null;
}

// https://docs.github.com/en/rest/search/search#search-repositories
interface SearchAnswer {
  total_count: number;
  items: { full_name: string; archived: boolean; private: boolean }[];
}

/**
 * Puts the repos in the queue, in messages of CRAWL_BATCH repos, leaving out
 * the ones the crawler leaves alone: on the do-not-list, a project already,
 * or proposed before. With `readRejected`, as for the search, a repo whose
 * finds an admin rejected goes in, and comes back when its docs read
 * differently. Their consumer checks again. Returns the repos it queued, and
 * why it left each other one out.
 */
async function send(
  deps: FillDeps,
  repos: readonly string[],
  options: { readRejected?: boolean; broadStartedAt?: number } = {},
): Promise<{ queued: string[]; skips: Map<string, CrawlerSkip> }> {
  const skips = await crawlerSkips(deps.db, repos, options);
  const unique = [...new Map(repos.map((repo) => [repo.toLowerCase(), repo])).values()];
  const recorded = options.broadStartedAt === undefined ? new Set<string>() : await queuedCrawlRepos(deps.db, unique, options.broadStartedAt);
  // Keep recognizing seeds handled before the successful-send ledger existed.
  const seeded = options.broadStartedAt === undefined ? new Set<string>() : await seedsQueuedSince(deps.db, unique, options.broadStartedAt);
  const queued = unique.filter((repo) => !skips.has(repo.toLowerCase()) && !recorded.has(repo.toLowerCase()) && !seeded.has(repo.toLowerCase()));
  const messages: { body: CrawlMessage }[] = [];
  for (let start = 0; start < queued.length; start += CRAWL_BATCH) {
    messages.push({ body: { repos: queued.slice(start, start + CRAWL_BATCH) } });
  }
  if (messages.length > 0) {
    await deps.queue.sendBatch(messages);
    if (options.broadStartedAt !== undefined) await recordCrawlQueuedRepos(deps.db, queued, options.broadStartedAt);
  }
  return { queued, skips };
}

function newPass(now: number): CrawlPass {
  return {
    startedAt: now,
    pushedSince: now - CRAWL_PUSHED_DAYS * DAY_MS,
    pool: null,
    low: CRAWL_MIN_STARS,
    width: FIRST_WIDTH,
    // The first band is the whole pool, so its count says how big the pool is.
    open: true,
    page: 1,
    queued: 0,
    finishedAt: null,
  };
}

/** The search for the band the pass reads now, one page of it. */
function searchPath(pass: CrawlPass): string {
  const since = new Date(pass.pushedSince).toISOString().slice(0, 10);
  const stars = pass.open ? `>=${String(pass.low)}` : `${String(pass.low)}..${String(pass.low + pass.width - 1)}`;
  const q = `stars:${stars} pushed:>=${since} archived:false is:public`;
  return `/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=asc&per_page=${String(PER_PAGE)}&page=${String(pass.page)}`;
}

/** Validate whole search responses before sending or moving a checkpoint. */
function searchAnswer(data: unknown): SearchAnswer {
  const malformed = () => new SyncStopped('github_error', "GitHub's API answered a search in a form GitHub doesn't use.");
  if (data === null || typeof data !== 'object' || !('total_count' in data) || !('items' in data)) throw malformed();
  const total = data.total_count;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0 || !Array.isArray(data.items)) throw malformed();
  // A search that ran out of time serves only part of what it finds.
  // Its checkpoint stays where it is, and the next run asks again.
  if (!('incomplete_results' in data) || typeof data.incomplete_results !== 'boolean') throw malformed();
  if (data.incomplete_results) {
    throw new SyncStopped('github_error', "GitHub's search ran out of time and gave only part of its results.");
  }
  const items: SearchAnswer['items'] = [];
  for (const item of data.items as unknown[]) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw malformed();
    const name = repoName.safeParse('full_name' in item ? item.full_name : undefined);
    if (!name.success || !('archived' in item) || typeof item.archived !== 'boolean' || !('private' in item) || typeof item.private !== 'boolean') {
      throw malformed();
    }
    items.push({ full_name: name.data, archived: item.archived, private: item.private });
  }
  return { total_count: total, items };
}
function searchRepos(data: SearchAnswer): string[] {
  return data.items.flatMap((item) => {
    return item.archived || item.private ? [] : [item.full_name];
  });
}

/**
 * Reads one page of the band the pass reads now, queues what it finds, and
 * says where the pass stands after it. A band search counts more than 1,000
 * repos in is split before anything in it is queued: the band with no upper
 * end gets one, and a closed band spans half as many star counts. A band of
 * one star count with more than search serves gives what search serves.
 */
async function searchOnce(deps: FillDeps, pass: CrawlPass, run: FillRun): Promise<CrawlPass> {
  const response = await deps.github.read<unknown>(searchPath(pass));
  run.searches += 1;
  const data = searchAnswer(response.data);
  const total = data.total_count;
  const next: CrawlPass = { ...pass };
  if (pass.open && pass.low === CRAWL_MIN_STARS && pass.page === 1) next.pool = total;
  if (pass.page === 1 && total > SEARCH_LIMIT) {
    if (pass.open) return { ...next, open: false };
    if (pass.width > 1) return { ...next, width: Math.floor(pass.width / 2) };
    console.warn(`The crawler's search counts ${String(total)} repos with ${String(pass.low)} stars, more than it serves. It reads the first ${String(SEARCH_LIMIT)}.`);
  }
  const { queued } = await send(deps, searchRepos(data), { readRejected: true, broadStartedAt: pass.startedAt });
  await markSeedsHandled(
    deps.db,
    queued.map((repo) => ({ repo, outcome: 'queued' as const })),
    deps.now(),
    pass.startedAt,
  );
  run.queued += queued.length;
  next.queued += queued.length;
  const pages = Math.min(SEARCH_PAGES, Math.ceil(Math.min(total, SEARCH_LIMIT) / PER_PAGE));
  if (pass.page < pages) return { ...next, page: pass.page + 1 };
  // The band is done. The pass is done when the band had no upper end.
  if (pass.open) return { ...next, finishedAt: deps.now() };
  const sparse = total < SPARSE;
  return { ...next, low: pass.low + pass.width, page: 1, width: sparse ? pass.width * 2 : pass.width, open: sparse };
}

/** One descending page of the popular sample, with the broad pass's send scope. */
async function popularSearchOnce(deps: FillDeps, pass: PopularCrawlPass, broadStartedAt: number, run: FillRun): Promise<PopularCrawlPass> {
  const since = new Date(pass.pushedSince).toISOString().slice(0, 10);
  const q = `stars:>=${String(POPULAR_MIN_STARS)} pushed:>=${since} archived:false is:public`;
  const path = `/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${String(PER_PAGE)}&page=${String(pass.page)}`;
  const response = await deps.github.read<unknown>(path);
  run.searches += 1;
  run.popularSearches += 1;
  const data = searchAnswer(response.data);
  const total = data.total_count;
  const { queued } = await send(deps, searchRepos(data), { readRejected: true, broadStartedAt });
  await markSeedsHandled(deps.db, queued.map((repo) => ({ repo, outcome: 'queued' as const })), deps.now(), broadStartedAt);
  run.queued += queued.length;
  run.popularQueued += queued.length;
  const next = { ...pass, pool: pass.page === 1 ? total : pass.pool, queued: pass.queued + queued.length };
  const pages = Math.min(SEARCH_PAGES, Math.ceil(Math.min(total, SEARCH_LIMIT) / PER_PAGE));
  return pass.page < pages ? { ...next, page: pass.page + 1 } : { ...next, finishedAt: deps.now() };
}

/**
 * Queues the listed projects due for their weekly read, in messages of
 * CRAWL_BATCH marked as weekly reads, and records when. Returns how many.
 */
async function queueRereads(deps: FillDeps): Promise<number> {
  const due = await listProjectsToReread(deps.db, deps.now() - REREAD_EVERY_MS, REREADS_PER_RUN);
  const messages: { body: CrawlMessage }[] = [];
  for (let start = 0; start < due.length; start += CRAWL_BATCH) {
    messages.push({ body: { repos: due.slice(start, start + CRAWL_BATCH), reread: true } });
  }
  if (messages.length === 0) return 0;
  await deps.queue.sendBatch(messages);
  await markRereadsQueued(deps.db, due, deps.now());
  return due.length;
}

/**
 * The cron job: it starts a pass when there has never been one, or when the
 * last one is done and started CRAWL_PASS_EVERY_MS ago or more, so the
 * search reads the pool once a month. It queues the seeds an admin added
 * that it hasn't handled in this pass, and records for each seed whether it
 * queued it or left it alone, and why. Then it queues the listed projects
 * due for their weekly read. It spends one call on the broad pass, up to
 * four on the independent monthly popular sample, then the rest on broad
 * search. Both share the run's allowance and keep their own checkpoints.
 */
export async function fillCrawlQueue(deps: FillDeps): Promise<FillRun> {
  const { db, github, now } = deps;
  const run: FillRun = {
    seeds: 0, rereads: 0, searches: 0, queued: 0, pass: null,
    popularPass: null, popularSearches: 0, popularQueued: 0, calls: 0, stopped: null,
  };

  // Starting a pass, the seeds, and the weekly reads need no call to GitHub.
  let pass = await latestCrawlPass(db);
  if (pass === null || (pass.finishedAt !== null && now() - pass.startedAt >= CRAWL_PASS_EVERY_MS)) {
    pass = (await startCrawlPass(db, newPass(now()))) ?? (await latestCrawlPass(db));
  }
  run.pass = pass;
  let popularPass = await latestPopularCrawlPass(db);
  if (popularPass === null || (popularPass.finishedAt !== null && now() - popularPass.startedAt >= CRAWL_PASS_EVERY_MS)) {
    const sample = { startedAt: now(), pushedSince: now() - CRAWL_PUSHED_DAYS * DAY_MS, pool: null, page: 1, queued: 0, finishedAt: null };
    popularPass = (await startPopularCrawlPass(db, sample)) ?? (await latestPopularCrawlPass(db));
  }
  run.popularPass = popularPass;
  // Every path in this run uses the latest broad scope, even once it is done.
  if (pass !== null) await retireCrawlQueuedRepos(db, pass.startedAt);

  // A seed is read once in each pass, whatever its stars or last push. A
  // seed whose finds an admin rejected goes in, and comes back only when its
  // docs read differently, as a repo the search finds does.
  const since = pass?.startedAt ?? null;
  const seeds = (await listSeedsToHandle(db, SEEDS_PER_RUN, since)).map((seed) => seed.repo);
  const { queued: seeded, skips } = await send(deps, seeds, { readRejected: true, ...(since === null ? {} : { broadStartedAt: since }) });
  run.seeds = seeded.length;
  await markSeedsHandled(
    db,
    seeds.map((repo) => ({ repo, outcome: skips.get(repo.toLowerCase()) ?? 'queued' })),
    now(),
    since,
  );

  run.rereads = await queueRereads(deps);

  try {
    if (pass?.finishedAt === null || popularPass?.finishedAt === null) await github.checkGitHub();
    const advanceBroad = async (): Promise<boolean> => {
      if (pass === null || pass.finishedAt !== null) return true;
      const next = await searchOnce(deps, pass, run);
      if (!(await moveCrawlPass(db, pass, next))) {
        run.stopped = 'moved';
        return false;
      }
      pass = next;
      run.pass = pass;
      return true;
    };
    if (await advanceBroad()) {
      for (let calls = 0; calls < POPULAR_CALLS_PER_RUN && popularPass !== null && popularPass.finishedAt === null && pass !== null; calls++) {
        const next = await popularSearchOnce(deps, popularPass, pass.startedAt, run);
        if (!(await movePopularCrawlPass(db, popularPass, next))) {
          run.stopped = 'moved';
          break;
        }
        popularPass = next;
        run.popularPass = popularPass;
      }
      while (run.stopped === null && pass !== null && pass.finishedAt === null) {
        if (!(await advanceBroad())) break;
      }
    }
  } catch (error) {
    if (!(error instanceof SyncStopped)) throw error;
    run.stopped = error.reason;
    console.warn(`The crawler's search stopped. ${error.message}`);
  }
  run.calls = github.calls;
  const where =
    run.pass === null
      ? 'no pass'
      : run.pass.finishedAt !== null
        ? `the pass is done, with ${String(run.pass.queued)} repos of ${String(run.pass.pool ?? 'an unknown number')} queued`
        : `the pass is at ${run.pass.open ? `${String(run.pass.low)} stars and up` : `${String(run.pass.low)} to ${String(run.pass.low + run.pass.width - 1)} stars`}, page ${String(run.pass.page)}, with ${String(run.pass.queued)} repos of ${String(run.pass.pool ?? 'an unknown number')} queued`;
  const sample = run.popularPass;
  const popularWhere = sample === null ? 'No popular sample' :
    `The popular sample counted ${String(sample.pool ?? 'an unknown number')} repos, with a ${String(SEARCH_LIMIT)}-repo cap. It queued ${String(sample.queued)}. ${sample.finishedAt === null ? `Next page: ${String(sample.page)}` : `Finished${sample.page === SEARCH_PAGES && (sample.pool ?? 0) > SEARCH_LIMIT ? ' at the sample cap' : ''}`}`;
  console.log(
    `The crawler queued seeds: ${String(run.seeds)}, listed projects to read again: ${String(run.rereads)}, repos from search: ${String(run.queued)}, searches: ${String(run.searches)}, calls to GitHub: ${String(run.calls)}. ${where[0]?.toUpperCase() ?? ''}${where.slice(1)}. ${popularWhere}. Popular searches this run: ${String(run.popularSearches)}, popular repos queued: ${String(run.popularQueued)}. Left: ${JSON.stringify(github.left())}.${run.stopped === null ? '' : ` Stopped: ${run.stopped}.`}`,
  );
  return run;
}
