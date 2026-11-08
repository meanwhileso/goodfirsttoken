import type { CrawlMessage, CrawlSeedOutcome } from '@goodfirsttoken/core';
import {
  crawlerSkips,
  listProjectsToReread,
  listRequestedToRead,
  listSeedsToHandle,
  markRequestedRead,
  requestedProjects,
  markRereadsQueued,
  markSeedsHandled,
} from '../db';

// The policy crawler's cron job (spec section 5). It fills the crawl queue
// with batches of repos for its consumer (src/crawl/queue.ts) to read: the
// seeds that are due, and the listed projects due for their weekly read,
// which src/crawl/reread.ts keeps current. It makes no call to GitHub. New
// repos come from maintainers, admins' seeds, donors' requests, and listings
// from a policy, not from a search. The rules are in docs/how-it-works.md, under The
// policy crawler and Keeping listings current.

/** Repos in one message of the crawl queue. */
export const CRAWL_BATCH = 10;
/** The most seeds one run queues. */
const SEEDS_PER_RUN = 500;
/** The most requested repos one run queues, after the seeds. */
export const REQUESTED_PER_RUN = 5;
/** The most requested repos one run looks at, so the ones it leaves out don't hold back the ones it queues. */
const REQUESTED_LOOKED_AT = 100;
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
  /** Requested repos queued for a read. */
  requested: number;
  /** Requested repos left out, by why. */
  requestedLeftOut: Partial<Record<Exclude<CrawlSeedOutcome, 'queued'>, number>>;
  /** Listed projects queued for their weekly read. */
  rereads: number;
}

/** Puts the repos in the queue in messages of CRAWL_BATCH, marked as weekly reads or not. */
export async function sendRepos(deps: FillDeps, repos: readonly string[], reread: boolean): Promise<void> {
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
 * Queues at most REQUESTED_PER_RUN requested repos that are due, in one
 * message that gives each one's repo ID, so the consumer reads it under its
 * name now. It leaves out what the seed list leaves out, with the same
 * checks: the do-not-list and finds by the name GitHub gave last, and
 * projects by the repo's ID. It records for each repo it left out, and each
 * it queued, whether it queued it or left it out, and why, once the queue
 * took the message. The consumer checks again under the name now.
 */
async function queueRequested(deps: FillDeps): Promise<Pick<FillRun, 'requested' | 'requestedLeftOut'>> {
  const due = await listRequestedToRead(deps.db, REQUESTED_LOOKED_AT, deps.now());
  const byName = await crawlerSkips(
    deps.db,
    due.map((repo) => repo.repo),
    { readRejected: true },
  );
  // A project is checked by the repo's ID, so a project under an old name
  // that another repo took now doesn't leave the requested repo out.
  const projects = await requestedProjects(deps.db, due);
  const skips = new Map<number, Exclude<CrawlSeedOutcome, 'queued'>>();
  for (const repo of due) {
    const named = byName.get(repo.repo.toLowerCase());
    const why = named === 'project' ? undefined : named;
    if (why === 'do_not_list') skips.set(repo.repoId, why);
    else if (projects.has(repo.repoId)) skips.set(repo.repoId, 'project');
    else if (why !== undefined) skips.set(repo.repoId, why);
  }
  const leftOut = due.filter((repo) => skips.has(repo.repoId));
  // Two repo IDs under one name, as after a rename and a new repo under the
  // old name, go in separate runs, so a message names each repo once.
  const names = new Set<string>();
  const queued = due
    .filter((repo) => {
      if (skips.has(repo.repoId) || names.has(repo.repo.toLowerCase())) return false;
      names.add(repo.repo.toLowerCase());
      return true;
    })
    .slice(0, REQUESTED_PER_RUN);
  if (queued.length > 0) {
    await deps.queue.sendBatch([{ body: { repos: queued.map((repo) => repo.repo), requested: queued.map((repo) => repo.repoId) } }]);
  }
  const why = (repo: { repoId: number }): CrawlSeedOutcome => skips.get(repo.repoId) ?? 'queued';
  await markRequestedRead(
    deps.db,
    [...queued, ...leftOut].map((repo) => ({ repoId: repo.repoId, repo: repo.repo, outcome: why(repo) })),
    deps.now(),
  );
  const requestedLeftOut: FillRun['requestedLeftOut'] = {};
  for (const repo of leftOut) {
    const reason = why(repo);
    if (reason !== 'queued') requestedLeftOut[reason] = (requestedLeftOut[reason] ?? 0) + 1;
  }
  return { requested: queued.length, requestedLeftOut };
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
 * requested repos due, under queueRequested, then the listed projects due
 * for their weekly read. A seed is due until the job handles it, and again
 * 30 days after, under listSeedsToHandle, and a requested repo the same,
 * under listRequestedToRead.
 */
export async function fillCrawlQueue(deps: FillDeps): Promise<FillRun> {
  const seeds = await queueSeeds(deps);
  const requested = await queueRequested(deps);
  const run: FillRun = { seeds, ...requested, rereads: await queueRereads(deps) };
  const reasons = (['do_not_list', 'project', 'proposed'] as const).flatMap((why) => {
    const n = run.requestedLeftOut[why] ?? 0;
    return n === 0 ? [] : [n === 1 ? why : `${why} ${String(n)}`];
  });
  const leftOut = reasons.length === 0 ? '' : `, left out ${String(Object.values(run.requestedLeftOut).reduce((a, b) => a + b, 0))} (${reasons.join(', ')})`;
  console.log(
    `The crawler queued seeds: ${String(run.seeds)}, requested: queued ${String(run.requested)}${leftOut}, listed projects to read again: ${String(run.rereads)}.`,
  );
  return run;
}
