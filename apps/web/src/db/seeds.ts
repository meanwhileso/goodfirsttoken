import {
  count,
  CRAWL_METADATA_DAYS,
  CRAWL_POST_DAYS,
  crawlPrioritySchema,
  crawlSeedOutcomeSchema,
  crawlSeedSchema,
  githubId,
  mustParse,
  repoName,
  type CrawlSeed,
  type CrawlSeedOutcome,
  type CrawlPriority,
} from '@goodfirsttoken/core';
import { checkTime, fromJson } from './shared';

// The crawl_seeds table: repos an admin asked the policy crawler to read,
// whatever their stars or last push (src/crawl/).

interface SeedRow {
  repo: string;
  added_by: number;
  added_at: number;
  handled_at: number | null;
  outcome: string | null;
  priority_evidence: string | null;
}

function toSeed(row: SeedRow): CrawlSeed {
  return mustParse(
    crawlSeedSchema,
    { repo: row.repo, addedBy: row.added_by, addedAt: row.added_at, handledAt: row.handled_at, outcome: row.outcome,
      evidence: row.priority_evidence === null ? null : fromJson(row.priority_evidence) },
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

/** Save or clear evidence alone. An existing seed keeps all its handling history. */
export async function saveSeedEvidence(
  db: D1Database,
  input: { repo: string; addedBy: number; evidence: CrawlPriority | null; proposed?: boolean },
  now: number,
): Promise<{ seed: CrawlSeed; added: boolean; evidenceChanged: boolean } | null> {
  const repo = mustParse(repoName, input.repo, 'repo');
  const evidence = mustParse(crawlPrioritySchema.nullable(), input.evidence, 'priority evidence');
  const at = checkTime(now);
  const before = await getSeed(db, repo);
  const row = await db.prepare(
    `INSERT INTO crawl_seeds (repo, added_by, added_at, handled_at, outcome, priority_evidence)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE NOT EXISTS (SELECT 1 FROM do_not_list WHERE repo = ?1)
     ON CONFLICT (repo) DO UPDATE SET priority_evidence = excluded.priority_evidence
       WHERE NOT EXISTS (SELECT 1 FROM do_not_list WHERE repo = ?1)
     RETURNING *`,
  ).bind(repo, mustParse(githubId, input.addedBy, 'addedBy'), at, input.proposed ? at : null,
    input.proposed ? 'proposed' : null, evidence === null ? null : JSON.stringify(evidence)).first<SeedRow>();
  if (row === null) return null;
  return { seed: toSeed(row), added: before === null, evidenceChanged: JSON.stringify(before?.evidence ?? null) !== JSON.stringify(evidence) };
}

/**
 * Up to `limit` due seeds, qualifying evidence first, then oldest first.
 * Qualification uses the producer's clock, before the limit. With `since`, a seed it
 * handled before that is due again.
 */
export async function listSeedsToHandle(db: D1Database, limit: number, since: number | null = null, now: number = Date.now()): Promise<CrawlSeed[]> {
  const at = checkTime(now);
  const iso = (time: number) => new Date(Math.max(0, time)).toISOString();
  const { results } = await db
    .prepare(`SELECT * FROM crawl_seeds WHERE handled_at IS NULL OR handled_at < ?1
      ORDER BY CASE WHEN priority_evidence IS NOT NULL
        AND json_extract(priority_evidence, '$.stars') >= 10000
        AND json_extract(priority_evidence, '$.public') = 1
        AND json_extract(priority_evidence, '$.archived') = 0
        AND json_extract(priority_evidence, '$.role') IN ('owner', 'creator', 'maintainer')
        AND json_extract(priority_evidence, '$.postKind') IN ('authored', 'quote')
        AND json_extract(priority_evidence, '$.pushedAt') BETWEEN ?2 AND ?3
        AND json_extract(priority_evidence, '$.metadataCheckedAt') BETWEEN ?2 AND ?3
        AND json_extract(priority_evidence, '$.evidenceCheckedAt') BETWEEN ?2 AND ?3
        AND json_extract(priority_evidence, '$.publishedAt') BETWEEN ?4 AND ?3
        THEN 0 ELSE 1 END, added_at, repo LIMIT ?5`)
    .bind(since === null ? null : checkTime(since, 'since'), iso(at - CRAWL_METADATA_DAYS * 86_400_000),
      iso(at), iso(at - CRAWL_POST_DAYS * 86_400_000), mustParse(count, limit, 'limit'))
    .all<SeedRow>();
  return results.map(toSeed);
}

/**
 * Which of these repos are seeds the cron job queued at `since` or after, as
 * in the pass that started then, by name in lower case. The repos go in as
 * one JSON array, so any number of them takes one query.
 */
export async function seedsQueuedSince(db: D1Database, repos: readonly string[], since: number): Promise<Set<string>> {
  if (repos.length === 0) return new Set();
  const { results } = await db
    .prepare(
      `SELECT repo FROM crawl_seeds
       WHERE outcome = 'queued' AND handled_at >= ? AND repo IN (SELECT value FROM json_each(?))`,
    )
    .bind(checkTime(since, 'since'), JSON.stringify(repos.map((repo) => mustParse(repoName, repo, 'repo'))))
    .all<{ repo: string }>();
  return new Set(results.map((row) => row.repo.toLowerCase()));
}

/**
 * Records what the cron job did with each seed at `now`: queued it, or left
 * it alone, and why. A seed handled before keeps its time and outcome, unless
 * it was handled before `since`, as for listSeedsToHandle.
 */
export async function markSeedsHandled(
  db: D1Database,
  handled: readonly { repo: string; outcome: CrawlSeedOutcome }[],
  now: number,
  since: number | null = null,
): Promise<void> {
  const byOutcome = new Map<CrawlSeedOutcome, string[]>();
  for (const { repo, outcome } of handled) {
    const checked = mustParse(crawlSeedOutcomeSchema, outcome, 'outcome');
    byOutcome.set(checked, [...(byOutcome.get(checked) ?? []), mustParse(repoName, repo, 'repo')]);
  }
  if (byOutcome.size === 0) return;
  const at = checkTime(now);
  const before = since === null ? null : checkTime(since, 'since');
  await db.batch(
    [...byOutcome].map(([outcome, repos]) =>
      db
        .prepare(
          `UPDATE crawl_seeds SET handled_at = ?, outcome = ?
           WHERE (handled_at IS NULL OR handled_at < ?) AND repo IN (SELECT value FROM json_each(?))`,
        )
        .bind(at, outcome, before, JSON.stringify(repos)),
    ),
  );
}
