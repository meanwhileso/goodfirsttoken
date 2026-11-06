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

/** How long after the cron job handled a seed it is due again. */
export const SEED_EVERY_MS = 30 * 86_400_000;

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
 * Puts a repo on the seed list, added by the admin `addedBy` at `now`, due at
 * the cron job's next run. A repo on it already, whatever the case of its
 * name, keeps who added it and when, is due again, and `added` is false.
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
  const stored = await db
    .prepare('UPDATE crawl_seeds SET handled_at = NULL, outcome = NULL WHERE repo = ? RETURNING *')
    .bind(repo)
    .first<SeedRow>();
  if (stored === null) throw new Error(`${repo} was not added to the seed list.`);
  return { seed: toSeed(stored), added: false };
}

/** The repo's entry on the seed list, compared without case, or null. */
export async function getSeed(db: D1Database, repo: string): Promise<CrawlSeed | null> {
  const row = await db
    .prepare('SELECT * FROM crawl_seeds WHERE repo = ?')
    .bind(mustParse(repoName, repo, 'repo'))
    .first<SeedRow>();
  return row === null ? null : toSeed(row);
}

/**
 * Save or clear evidence. An existing seed keeps all its handling history,
 * unless `due` asks for it to be due at the cron job's next run. A `proposed`
 * seed, for a find that waits, is recorded as handled.
 */
export async function saveSeedEvidence(
  db: D1Database,
  input: { repo: string; addedBy: number; evidence: CrawlPriority | null; proposed?: boolean; due?: boolean },
  now: number,
): Promise<{ seed: CrawlSeed; added: boolean; evidenceChanged: boolean } | null> {
  const repo = mustParse(repoName, input.repo, 'repo');
  const evidence = mustParse(crawlPrioritySchema.nullable(), input.evidence, 'priority evidence');
  const at = checkTime(now);
  const before = await getSeed(db, repo);
  const row = await db.prepare(
    `INSERT INTO crawl_seeds (repo, added_by, added_at, handled_at, outcome, priority_evidence)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE NOT EXISTS (SELECT 1 FROM do_not_list WHERE repo = ?1)
     ON CONFLICT (repo) DO UPDATE SET priority_evidence = excluded.priority_evidence,
       handled_at = CASE WHEN ?7 THEN NULL ELSE handled_at END,
       outcome = CASE WHEN ?7 THEN NULL ELSE outcome END
       WHERE NOT EXISTS (SELECT 1 FROM do_not_list WHERE repo = ?1)
     RETURNING *`,
  ).bind(repo, mustParse(githubId, input.addedBy, 'addedBy'), at, input.proposed ? at : null,
    input.proposed ? 'proposed' : null, evidence === null ? null : JSON.stringify(evidence),
    input.due === true && input.proposed !== true ? 1 : 0).first<SeedRow>();
  if (row === null) return null;
  return { seed: toSeed(row), added: before === null, evidenceChanged: JSON.stringify(before?.evidence ?? null) !== JSON.stringify(evidence) };
}

/**
 * Up to `limit` seeds due at `now`, qualifying evidence first, then oldest
 * added first. Qualification uses the producer's clock, before the limit. A
 * seed is due until the cron job handles it, and again SEED_EVERY_MS after,
 * unless its repo is a project or a find of it waits in the admin queue.
 */
export async function listSeedsToHandle(db: D1Database, limit: number, now: number = Date.now()): Promise<CrawlSeed[]> {
  const at = checkTime(now);
  const iso = (time: number) => new Date(Math.max(0, time)).toISOString();
  const { results } = await db
    .prepare(`SELECT * FROM crawl_seeds s WHERE s.handled_at IS NULL
        OR (s.handled_at <= ?1
          AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.repo = s.repo)
          AND NOT EXISTS (SELECT 1 FROM crawl_candidates c WHERE c.repo = s.repo AND c.status = 'waiting'))
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
    .bind(at - SEED_EVERY_MS, iso(at - CRAWL_METADATA_DAYS * 86_400_000),
      iso(at), iso(at - CRAWL_POST_DAYS * 86_400_000), mustParse(count, limit, 'limit'))
    .all<SeedRow>();
  return results.map(toSeed);
}

/**
 * Records what the cron job did with each seed at `now`: queued it, or left
 * it alone, and why. A seed handled less than SEED_EVERY_MS before keeps its
 * time and outcome, as when two runs handle it at once.
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
           WHERE (handled_at IS NULL OR handled_at <= ?) AND repo IN (SELECT value FROM json_each(?))`,
        )
        .bind(at, outcome, at - SEED_EVERY_MS, JSON.stringify(repos)),
    ),
  );
}
