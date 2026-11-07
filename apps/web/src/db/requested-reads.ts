import { count, crawlSeedOutcomeSchema, githubRepoId, mustParse, repoName, type CrawlSeedOutcome } from '@goodfirsttoken/core';
import { checkTime } from './shared';

// The requested_reads table: when the policy crawler last read each repo
// donors requested (src/crawl/producer.ts), by GitHub's repo ID. Which
// repos are on the list comes from repo_requests, read live, so a withdrawn
// last request, or a block on its donor, takes a repo off at once.

/** How long after the cron job read a requested repo it is due again, as a seed is. */
export const REQUESTED_EVERY_MS = 30 * 86_400_000;

/** A requested repo due for a read. */
export interface RequestedRepo {
  repoId: number;
  /** The name GitHub gave at the newest live request. The consumer reads the repo under its name now. */
  repo: string;
  /** When the crawler last read it, or null when it never did. */
  readAt: number | null;
}

/**
 * Up to `limit` requested repos due at `now`. A repo is on the list while it
 * has a live request from a donor who isn't blocked. Repos never read come
 * first, by their oldest such request. Then the ones read REQUESTED_EVERY_MS
 * ago or more, longest since read first.
 */
export async function listRequestedToRead(db: D1Database, limit: number, now: number): Promise<RequestedRepo[]> {
  const at = checkTime(now);
  const { results } = await db
    .prepare(
      `WITH live AS (
         SELECT q.repo_id, q.repo, q.requested_at FROM repo_requests q
         WHERE q.withdrawn_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM donor_blocks b WHERE b.github_id = q.github_id)
       )
       SELECT l.repo_id,
         (SELECT n.repo FROM live n WHERE n.repo_id = l.repo_id ORDER BY n.requested_at DESC LIMIT 1) AS repo,
         MIN(l.requested_at) AS first_asked,
         r.read_at
       FROM live l LEFT JOIN requested_reads r ON r.repo_id = l.repo_id
       GROUP BY l.repo_id
       HAVING r.read_at IS NULL OR r.read_at <= ?1
       ORDER BY r.read_at IS NOT NULL, COALESCE(r.read_at, MIN(l.requested_at)), l.repo_id
       LIMIT ?2`,
    )
    .bind(at - REQUESTED_EVERY_MS, mustParse(count, limit, 'limit'))
    .all<{ repo_id: number; repo: string; first_asked: number; read_at: number | null }>();
  return results.map((row) => ({
    repoId: mustParse(githubRepoId, row.repo_id, 'repoId'),
    repo: mustParse(repoName, row.repo, 'repo'),
    readAt: row.read_at === null ? null : checkTime(row.read_at, 'readAt'),
  }));
}

/** When the crawler last read the requested repo, and what it did, or null when it never did. */
export async function getRequestedRead(
  db: D1Database,
  repoId: number,
): Promise<{ repo: string; readAt: number; outcome: CrawlSeedOutcome } | null> {
  const row = await db
    .prepare('SELECT repo, read_at, outcome FROM requested_reads WHERE repo_id = ?')
    .bind(mustParse(githubRepoId, repoId, 'repoId'))
    .first<{ repo: string; read_at: number; outcome: string }>();
  if (row === null) return null;
  return { repo: row.repo, readAt: checkTime(row.read_at, 'readAt'), outcome: mustParse(crawlSeedOutcomeSchema, row.outcome, 'outcome') };
}

/**
 * Records what the cron job did with each requested repo at `now`: queued
 * it, or left it out, and why. A repo read less than REQUESTED_EVERY_MS
 * before keeps its time and outcome, as when two runs read it at once.
 */
export async function markRequestedRead(
  db: D1Database,
  read: readonly { repoId: number; repo: string; outcome: CrawlSeedOutcome }[],
  now: number,
): Promise<void> {
  if (read.length === 0) return;
  const at = checkTime(now);
  await db.batch(
    read.map(({ repoId, repo, outcome }) =>
      db
        .prepare(
          `INSERT INTO requested_reads (repo_id, repo, read_at, outcome) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (repo_id) DO UPDATE SET repo = excluded.repo, read_at = excluded.read_at, outcome = excluded.outcome
             WHERE requested_reads.read_at <= ?5`,
        )
        .bind(
          mustParse(githubRepoId, repoId, 'repoId'),
          mustParse(repoName, repo, 'repo'),
          at,
          mustParse(crawlSeedOutcomeSchema, outcome, 'outcome'),
          at - REQUESTED_EVERY_MS,
        ),
    ),
  );
}
