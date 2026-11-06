import type { CrawlMessage } from '@goodfirsttoken/core';
import { crawlerSkips, listProjectsToReread, listSeedsToHandle, markRereadsQueued, markSeedsHandled } from '../db';

// The policy crawler's cron job (spec section 5). It fills the crawl queue
// with batches of repos for its consumer (src/crawl/queue.ts) to read: the
// seeds that are due, and the listed projects due for their weekly read,
// which src/crawl/reread.ts keeps current. It makes no call to GitHub. New
// repos come from maintainers, admins' seeds, and listings from a policy,
// not from a search. The rules are in docs/how-it-works.md, under The
// policy crawler and Keeping listings current.

/** Repos in one message of the crawl queue. */
export const CRAWL_BATCH = 10;
/** The most seeds one run queues. */
const SEEDS_PER_RUN = 500;
/** The most listed projects one run queues for their weekly read. */
const REREADS_PER_RUN = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How often a listed project's docs are read again. */
export const REREAD_EVERY_MS = 7 * DAY_MS;

export interface FillDeps {
  db: D1Database;
  /** The crawl queue, or a stand-in that takes its batches the same way. */
  queue: { sendBatch: (messages: Iterable<MessageSendRequest<CrawlMessage>>) => Promise<unknown> };
  now: () => number;
}

/** What one run did, for its log line. */
export interface FillRun {
  /** Seeds queued for a read. */
  seeds: number;
  /** Listed projects queued for their weekly read. */
  rereads: number;
}

/** Puts the repos in the queue in messages of CRAWL_BATCH, marked as weekly reads or not. */
async function sendRepos(deps: FillDeps, repos: readonly string[], reread: boolean): Promise<void> {
  const messages: { body: CrawlMessage }[] = [];
  for (let start = 0; start < repos.length; start += CRAWL_BATCH) {
    const batch = repos.slice(start, start + CRAWL_BATCH);
    messages.push({ body: reread ? { repos: batch, reread: true } : { repos: batch } });
  }
  if (messages.length > 0) await deps.queue.sendBatch(messages);
}

/**
 * Queues the seeds due now, leaving out the ones the crawler leaves alone:
 * on the do-not-list, a project already, or with a find that waits or was
 * approved. A seed whose finds an admin rejected goes in, and comes back
 * only when its docs read differently, which its consumer checks. Records
 * for each seed whether it queued it or left it alone, and why, once the
 * queue took them. Returns how many it queued.
 */
async function queueSeeds(deps: FillDeps): Promise<number> {
  const seeds = (await listSeedsToHandle(deps.db, SEEDS_PER_RUN, deps.now())).map((seed) => seed.repo);
  const skips = await crawlerSkips(deps.db, seeds, { readRejected: true });
  const queued = seeds.filter((repo) => !skips.has(repo.toLowerCase()));
  await sendRepos(deps, queued, false);
  await markSeedsHandled(
    deps.db,
    seeds.map((repo) => ({ repo, outcome: skips.get(repo.toLowerCase()) ?? 'queued' })),
    deps.now(),
  );
  return queued.length;
}

/**
 * Queues the listed projects due for their weekly read, in messages marked
 * as weekly reads, and records when. Returns how many.
 */
async function queueRereads(deps: FillDeps): Promise<number> {
  const due = await listProjectsToReread(deps.db, deps.now() - REREAD_EVERY_MS, REREADS_PER_RUN);
  if (due.length === 0) return 0;
  await sendRepos(deps, due, true);
  await markRereadsQueued(deps.db, due, deps.now());
  return due.length;
}

/**
 * The cron job: it queues the seeds due now, under queueSeeds, then the
 * listed projects due for their weekly read. A seed is due until the job
 * handles it, and again 30 days after, under listSeedsToHandle.
 */
export async function fillCrawlQueue(deps: FillDeps): Promise<FillRun> {
  const run: FillRun = { seeds: await queueSeeds(deps), rereads: await queueRereads(deps) };
  console.log(`The crawler queued seeds: ${String(run.seeds)}, listed projects to read again: ${String(run.rereads)}.`);
  return run;
}
