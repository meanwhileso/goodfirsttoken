import { count, crawlSeedSchema, githubId, mustParse, repoName, type CrawlSeed } from '@goodfirsttoken/core';
import { checkTime } from './shared';

// The crawl_seeds table: repos an admin asked the policy crawler to read,
// whatever their stars or last push (src/crawl/).

interface SeedRow {
  repo: string;
  added_by: number;
  added_at: number;
  queued_at: number | null;
}

function toSeed(row: SeedRow): CrawlSeed {
  return mustParse(
    crawlSeedSchema,
    { repo: row.repo, addedBy: row.added_by, addedAt: row.added_at, queuedAt: row.queued_at },
    'crawl seed',
  );
}

/**
 * Puts a repo on the seed list, added by the admin `addedBy` at `now`. A repo
 * on it already, whatever the case of its name, keeps its first entry, and
 * `added` is false.
 */
export async function addSeed(
  db: D1Database,
  seed: { repo: string; addedBy: number },
  now: number,
): Promise<{ seed: CrawlSeed; added: boolean }> {
  const repo = mustParse(repoName, seed.repo, 'repo');
  const row = await db
    .prepare(
      `INSERT INTO crawl_seeds (repo, added_by, added_at, queued_at) VALUES (?, ?, ?, NULL)
       ON CONFLICT (repo) DO NOTHING
       RETURNING *`,
    )
    .bind(repo, mustParse(githubId, seed.addedBy, 'addedBy'), checkTime(now))
    .first<SeedRow>();
  if (row !== null) return { seed: toSeed(row), added: true };
  const stored = await getSeed(db, repo);
  if (stored === null) throw new Error(`${repo} was not added to the seed list.`);
  return { seed: stored, added: false };
}

/** The repo's entry on the seed list, compared without case, or null. */
export async function getSeed(db: D1Database, repo: string): Promise<CrawlSeed | null> {
  const row = await db
    .prepare('SELECT * FROM crawl_seeds WHERE repo = ?')
    .bind(mustParse(repoName, repo, 'repo'))
    .first<SeedRow>();
  return row === null ? null : toSeed(row);
}

/** Up to `limit` seeds the crawler hasn't queued yet, oldest first. */
export async function listSeedsToQueue(db: D1Database, limit: number): Promise<CrawlSeed[]> {
  const { results } = await db
    .prepare('SELECT * FROM crawl_seeds WHERE queued_at IS NULL ORDER BY added_at, repo LIMIT ?')
    .bind(mustParse(count, limit, 'limit'))
    .all<SeedRow>();
  return results.map(toSeed);
}

/** Records that the crawler queued these seeds at `now`. A seed queued before keeps its time. */
export async function markSeedsQueued(db: D1Database, repos: readonly string[], now: number): Promise<void> {
  const checked = repos.map((repo) => mustParse(repoName, repo, 'repo'));
  if (checked.length === 0) return;
  await db
    .prepare('UPDATE crawl_seeds SET queued_at = ? WHERE queued_at IS NULL AND repo IN (SELECT value FROM json_each(?))')
    .bind(checkTime(now), JSON.stringify(checked))
    .run();
}
