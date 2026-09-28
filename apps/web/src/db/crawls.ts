import { crawlPassSchema, mustParse, type CrawlPass } from '@goodfirsttoken/core';

// The crawl_passes table: each pass of the policy crawler's search over the
// pool of repos, and where it stands (src/crawl/search.ts).

interface PassRow {
  started_at: number;
  pushed_since: number;
  pool: number | null;
  low: number;
  width: number;
  open: number;
  page: number;
  queued: number;
  finished_at: number | null;
}

function toPass(row: PassRow): CrawlPass {
  return mustParse(
    crawlPassSchema,
    {
      startedAt: row.started_at,
      pushedSince: row.pushed_since,
      pool: row.pool,
      low: row.low,
      width: row.width,
      open: row.open === 1,
      page: row.page,
      queued: row.queued,
      finishedAt: row.finished_at,
    },
    'crawl pass',
  );
}

/** The pass that started last, finished or not, or null before the first. */
export async function latestCrawlPass(db: D1Database): Promise<CrawlPass | null> {
  const row = await db.prepare('SELECT * FROM crawl_passes ORDER BY started_at DESC LIMIT 1').first<PassRow>();
  return row === null ? null : toPass(row);
}

/**
 * Starts a pass, unless one is in progress. Null when one is, as when two
 * runs start a pass at the same moment.
 */
export async function startCrawlPass(db: D1Database, pass: CrawlPass): Promise<CrawlPass | null> {
  const p = mustParse(crawlPassSchema, pass, 'crawl pass');
  const row = await db
    .prepare(
      `INSERT INTO crawl_passes (started_at, pushed_since, pool, low, width, open, page, queued, finished_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
       WHERE NOT EXISTS (SELECT 1 FROM crawl_passes WHERE finished_at IS NULL)
       ON CONFLICT DO NOTHING
       RETURNING *`,
    )
    .bind(p.startedAt, p.pushedSince, p.pool, p.low, p.width, p.open ? 1 : 0, p.page, p.queued, p.finishedAt)
    .first<PassRow>();
  return row === null ? null : toPass(row);
}

/**
 * Moves the pass on from where `from` says it stands to `to`. It lands only
 * when the pass still stands where `from` says, so two runs never both move
 * it from the same place. False when it didn't land.
 */
export async function moveCrawlPass(db: D1Database, from: CrawlPass, to: CrawlPass): Promise<boolean> {
  const a = mustParse(crawlPassSchema, from, 'from');
  const b = mustParse(crawlPassSchema, to, 'to');
  if (a.startedAt !== b.startedAt || a.pushedSince !== b.pushedSince) throw new Error('A pass moves on only within itself.');
  const result = await db
    .prepare(
      `UPDATE crawl_passes SET pool = ?, low = ?, width = ?, open = ?, page = ?, queued = ?, finished_at = ?
       WHERE started_at = ? AND low = ? AND width = ? AND open = ? AND page = ? AND queued = ? AND finished_at IS NULL`,
    )
    .bind(
      b.pool,
      b.low,
      b.width,
      b.open ? 1 : 0,
      b.page,
      b.queued,
      b.finishedAt,
      a.startedAt,
      a.low,
      a.width,
      a.open ? 1 : 0,
      a.page,
      a.queued,
    )
    .run();
  return result.meta.changes === 1;
}
