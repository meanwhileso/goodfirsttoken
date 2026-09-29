import { repoName, SEARCH_PAGES, type CrawlMessage, type CrawlPass } from '@goodfirsttoken/core';
import {
  crawlerSkips,
  latestCrawlPass,
  listProjectsToReread,
  listSeedsToHandle,
  markRereadsQueued,
  markSeedsHandled,
  moveCrawlPass,
  startCrawlPass,
  type CrawlerSkip,
} from '../db';
import { SyncStopped, type ServiceGitHub, type StopReason } from '../sync/github';

// The policy crawler's cron job (spec section 5). It fills the crawl queue
// with batches of repos for its consumer (src/crawl/queue.ts) to read: first
// the seeds an admin added, then the repos GitHub's search finds with at
// least 1,000 stars and a push in the last 30 days. Search serves at most
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
  calls: number;
  stopped: StopReason | 'moved' | null;
}

// https://docs.github.com/en/rest/search/search#search-repositories
interface SearchAnswer {
  total_count?: unknown;
  incomplete_results?: unknown;
  items?: { full_name?: unknown; archived?: unknown; private?: unknown }[];
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
  options: { readRejected?: boolean } = {},
): Promise<{ queued: string[]; skips: Map<string, CrawlerSkip> }> {
  const skips = await crawlerSkips(deps.db, repos, options);
  const queued = repos.filter((repo) => !skips.has(repo.toLowerCase()));
  const messages: { body: CrawlMessage }[] = [];
  for (let start = 0; start < queued.length; start += CRAWL_BATCH) {
    messages.push({ body: { repos: queued.slice(start, start + CRAWL_BATCH) } });
  }
  if (messages.length > 0) await deps.queue.sendBatch(messages);
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

/**
 * Reads one page of the band the pass reads now, queues what it finds, and
 * says where the pass stands after it. A band search counts more than 1,000
 * repos in is split before anything in it is queued: the band with no upper
 * end gets one, and a closed band spans half as many star counts. A band of
 * one star count with more than search serves gives what search serves.
 */
async function searchOnce(deps: FillDeps, pass: CrawlPass, run: FillRun): Promise<CrawlPass> {
  const { data } = await deps.github.read<SearchAnswer>(searchPath(pass));
  run.searches += 1;
  const total = data.total_count;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0 || !Array.isArray(data.items)) {
    throw new SyncStopped('github_error', "GitHub's API answered a search in a form GitHub doesn't use.");
  }
  // A search that ran out of time counts and serves only part of what it
  // finds. The pass stays where it is, and the next run asks again.
  if (data.incomplete_results === true) {
    throw new SyncStopped('github_error', "GitHub's search ran out of time and gave only part of its results.");
  }
  const next: CrawlPass = { ...pass };
  if (pass.open && pass.low === CRAWL_MIN_STARS && pass.page === 1) next.pool = total;
  if (pass.page === 1 && total > SEARCH_LIMIT) {
    if (pass.open) return { ...next, open: false };
    if (pass.width > 1) return { ...next, width: Math.floor(pass.width / 2) };
    console.warn(`The crawler's search counts ${String(total)} repos with ${String(pass.low)} stars, more than it serves. It reads the first ${String(SEARCH_LIMIT)}.`);
  }
  const repos = data.items.flatMap((item) => {
    if (item.archived === true || item.private === true) return [];
    const name = repoName.safeParse(item.full_name);
    return name.success ? [name.data] : [];
  });
  const { queued } = await send(deps, repos, { readRejected: true });
  run.queued += queued.length;
  next.queued += queued.length;
  const pages = Math.min(SEARCH_PAGES, Math.ceil(Math.min(total, SEARCH_LIMIT) / PER_PAGE));
  if (pass.page < pages) return { ...next, page: pass.page + 1 };
  // The band is done. The pass is done when the band had no upper end.
  if (pass.open) return { ...next, finishedAt: deps.now() };
  const sparse = total < SPARSE;
  return { ...next, low: pass.low + pass.width, page: 1, width: sparse ? pass.width * 2 : pass.width, open: sparse };
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
 * The cron job: queues the seeds an admin added that it hasn't handled yet,
 * and records for each seed whether it queued it or left it alone, and why.
 * Then it queues the listed projects due for their weekly read. Then it reads
 * the pool on from where the pass stands, until the pass is done or the run
 * has to stop. It starts a pass when there has never been one, or when the
 * last one is done and started CRAWL_PASS_EVERY_MS ago or more, so the
 * search reads the pool once a month.
 */
export async function fillCrawlQueue(deps: FillDeps): Promise<FillRun> {
  const { db, github, now } = deps;
  const run: FillRun = { seeds: 0, rereads: 0, searches: 0, queued: 0, pass: null, calls: 0, stopped: null };

  // The seeds need no call to GitHub.
  const seeds = (await listSeedsToHandle(db, SEEDS_PER_RUN)).map((seed) => seed.repo);
  const { queued: seeded, skips } = await send(deps, seeds);
  run.seeds = seeded.length;
  await markSeedsHandled(
    db,
    seeds.map((repo) => ({ repo, outcome: skips.get(repo.toLowerCase()) ?? 'queued' })),
    now(),
  );

  // The weekly reads need no call to GitHub either.
  run.rereads = await queueRereads(deps);

  let pass = await latestCrawlPass(db);
  if (pass === null || (pass.finishedAt !== null && now() - pass.startedAt >= CRAWL_PASS_EVERY_MS)) {
    pass = (await startCrawlPass(db, newPass(now()))) ?? (await latestCrawlPass(db));
  }
  run.pass = pass;
  try {
    if (pass !== null && pass.finishedAt === null) await github.checkGitHub();
    while (pass !== null && pass.finishedAt === null) {
      const next = await searchOnce(deps, pass, run);
      if (!(await moveCrawlPass(db, pass, next))) {
        run.stopped = 'moved';
        break;
      }
      pass = next;
      run.pass = pass;
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
  console.log(
    `The crawler queued seeds: ${String(run.seeds)}, listed projects to read again: ${String(run.rereads)}, repos from search: ${String(run.queued)}, searches: ${String(run.searches)}, calls to GitHub: ${String(run.calls)}. ${where[0]?.toUpperCase() ?? ''}${where.slice(1)}. Left: ${JSON.stringify(github.left())}.${run.stopped === null ? '' : ` Stopped: ${run.stopped}.`}`,
  );
  return run;
}
