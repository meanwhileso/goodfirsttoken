import { crawlPassSchema, mustParse, repoName } from '@goodfirsttoken/core';
import { checkTime } from './shared';

// Internal discovery state. Popular sampling does not change the core or
// MCP interfaces used for policy review and public listings.
const popularPassSchema = crawlPassSchema.pick({
  startedAt: true, pushedSince: true, pool: true, page: true, queued: true, finishedAt: true,
});
export interface PopularCrawlPass {
  startedAt: number;
  pushedSince: number;
  pool: number | null;
  page: number;
  queued: number;
  finishedAt: number | null;
}
interface PassRow {
  started_at: number;
  pushed_since: number;
  pool: number | null;
  page: number;
  queued: number;
  finished_at: number | null;
}
function toPass(row: PassRow): PopularCrawlPass {
  return mustParse(popularPassSchema, {
    startedAt: row.started_at, pushedSince: row.pushed_since, pool: row.pool,
    page: row.page, queued: row.queued, finishedAt: row.finished_at,
  }, 'popular crawl pass');
}
/** Latest popular sample, including a finished one. */
export async function latestPopularCrawlPass(db: D1Database): Promise<PopularCrawlPass | null> {
  const row = await db.prepare('SELECT * FROM popular_crawl_passes ORDER BY started_at DESC LIMIT 1').first<PassRow>();
  return row === null ? null : toPass(row);
}
/** Starts one sample, unless another run has a sample in progress. */
export async function startPopularCrawlPass(db: D1Database, pass: PopularCrawlPass): Promise<PopularCrawlPass | null> {
  const p = mustParse(popularPassSchema, pass, 'popular crawl pass');
  const row = await db.prepare(
    `INSERT INTO popular_crawl_passes (started_at, pushed_since, pool, page, queued, finished_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6
     WHERE NOT EXISTS (SELECT 1 FROM popular_crawl_passes WHERE finished_at IS NULL)
     ON CONFLICT DO NOTHING RETURNING *`,
  ).bind(p.startedAt, p.pushedSince, p.pool, p.page, p.queued, p.finishedAt).first<PassRow>();
  return row === null ? null : toPass(row);
}
/** Compare and swap the sample's last successful page. */
export async function movePopularCrawlPass(db: D1Database, from: PopularCrawlPass, to: PopularCrawlPass): Promise<boolean> {
  const a = mustParse(popularPassSchema, from, 'from');
  const b = mustParse(popularPassSchema, to, 'to');
  if (a.startedAt !== b.startedAt || a.pushedSince !== b.pushedSince) throw new Error('A sample moves on only within itself.');
  const result = await db.prepare(
    `UPDATE popular_crawl_passes SET pool = ?, page = ?, queued = ?, finished_at = ?
     WHERE started_at = ? AND page = ? AND queued = ? AND pool IS ? AND finished_at IS NULL`,
  ).bind(b.pool, b.page, b.queued, b.finishedAt, a.startedAt, a.page, a.queued, a.pool).run();
  return result.meta.changes === 1;
}
/** Repos whose successful sends were recorded in this broad pass, without case. */
export async function queuedCrawlRepos(db: D1Database, repos: readonly string[], broadStartedAt: number): Promise<Set<string>> {
  if (repos.length === 0) return new Set();
  const { results } = await db.prepare(
    `SELECT repo FROM crawl_queued_repos WHERE broad_started_at = ? AND repo IN (SELECT value FROM json_each(?))`,
  ).bind(checkTime(broadStartedAt), JSON.stringify(repos.map((repo) => mustParse(repoName, repo, 'repo')))).all<{ repo: string }>();
  return new Set(results.map((row) => row.repo.toLowerCase()));
}
/** Call only after the queue send succeeds. Concurrent recordings are harmless. */
export async function recordCrawlQueuedRepos(db: D1Database, repos: readonly string[], broadStartedAt: number): Promise<void> {
  if (repos.length === 0) return;
  await db.prepare(
    `INSERT INTO crawl_queued_repos (broad_started_at, repo)
     SELECT ?, value FROM json_each(?) WHERE true ON CONFLICT DO NOTHING`,
  ).bind(checkTime(broadStartedAt), JSON.stringify(repos.map((repo) => mustParse(repoName, repo, 'repo')))).run();
}
/** Completed older scopes are no longer needed after popular pages switch scope. Keep the latest even when done. */
export async function retireCrawlQueuedRepos(db: D1Database, broadStartedAt: number): Promise<void> {
  await db.prepare(
    `DELETE FROM crawl_queued_repos WHERE broad_started_at < ? AND broad_started_at IN
     (SELECT started_at FROM crawl_passes WHERE finished_at IS NOT NULL)`,
  ).bind(checkTime(broadStartedAt)).run();
}
