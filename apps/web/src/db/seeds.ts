import {
  count,
  crawlSeedOutcomeSchema,
  crawlSeedSchema,
  githubId,
  mustParse,
  repoName,
  type CrawlSeed,
  type CrawlSeedOutcome,
} from '@goodfirsttoken/core';
import { checkTime } from './shared';

// The crawl_seeds table: repos an admin asked the policy crawler to read,
// whatever their stars or last push (src/crawl/).

interface SeedRow {
  repo: string;
  added_by: number;
  added_at: number;
  handled_at: number | null;
  outcome: string | null;
}

function toSeed(row: SeedRow): CrawlSeed {
  return mustParse(
    crawlSeedSchema,
    { repo: row.repo, addedBy: row.added_by, addedAt: row.added_at, handledAt: row.handled_at, outcome: row.outcome },
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
      `INSERT INTO crawl_seeds (repo, added_by, added_at, handled_at, outcome) VALUES (?, ?, ?, NULL, NULL)
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

/** Up to `limit` seeds the crawler's cron job hasn't handled yet, oldest first. */
export async function listSeedsToHandle(db: D1Database, limit: number): Promise<CrawlSeed[]> {
  const { results } = await db
    .prepare('SELECT * FROM crawl_seeds WHERE handled_at IS NULL ORDER BY added_at, repo LIMIT ?')
    .bind(mustParse(count, limit, 'limit'))
    .all<SeedRow>();
  return results.map(toSeed);
}

/**
 * Records what the cron job did with each seed at `now`: queued it, or left
 * it alone, and why. A seed handled before keeps its time and outcome.
 */
export async function markSeedsHandled(
  db: D1Database,
  handled: readonly { repo: string; outcome: CrawlSeedOutcome }[],
  now: number,
): Promise<void> {
  const byOutcome = new Map<CrawlSeedOutcome, string[]>();
  for (const { repo, outcome } of handled) {
    const checked = mustParse(crawlSeedOutcomeSchema, outcome, 'outcome');
    byOutcome.set(checked, [...(byOutcome.get(checked) ?? []), mustParse(repoName, repo, 'repo')]);
  }
  if (byOutcome.size === 0) return;
  const at = checkTime(now);
  await db.batch(
    [...byOutcome].map(([outcome, repos]) =>
      db
        .prepare(
          `UPDATE crawl_seeds SET handled_at = ?, outcome = ?
           WHERE handled_at IS NULL AND repo IN (SELECT value FROM json_each(?))`,
        )
        .bind(at, outcome, JSON.stringify(repos)),
    ),
  );
}
