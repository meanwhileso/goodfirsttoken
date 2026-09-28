import {
  candidateStatusSchema,
  crawlCandidateSchema,
  id,
  mustParse,
  repoName,
  type CandidateStatus,
  type CrawlCandidate,
  type Policy,
  type ProjectSettingsPatch,
  type RepoFacts,
  type SuggestedTag,
} from '@goodfirsttoken/core';
import { checkTime, fromJson, newId } from './shared';

// The crawl_candidates table: repos the crawler found whose own docs welcome
// AI help, waiting for an admin or decided by one.

interface CandidateRow {
  id: string;
  repo: string;
  found_at: number;
  stars: number;
  repo_created_at: number;
  repo_pushed_at: number;
  owner_created_at: number;
  policy_quote: string;
  policy_url: string;
  policy_tier: string;
  settings: string;
  suggested_tags: string;
  status: string;
  decided_by: number | null;
  decided_at: number | null;
  reason: string | null;
}

function toCandidate(row: CandidateRow): CrawlCandidate {
  return mustParse(
    crawlCandidateSchema,
    {
      id: row.id,
      repo: row.repo,
      foundAt: row.found_at,
      facts: {
        stars: row.stars,
        createdAt: row.repo_created_at,
        pushedAt: row.repo_pushed_at,
        ownerCreatedAt: row.owner_created_at,
      },
      policy: { quote: row.policy_quote, url: row.policy_url, tier: row.policy_tier },
      settings: fromJson(row.settings),
      suggestedTags: fromJson(row.suggested_tags),
      status: row.status,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      reason: row.reason,
    },
    'candidate',
  );
}

export interface NewCandidate {
  repo: string;
  facts: RepoFacts;
  policy: Policy;
  settings: ProjectSettingsPatch;
  suggestedTags: SuggestedTag[];
}

/**
 * Puts a repo the crawler found in the admin queue, found at `now`. A repo on
 * the do-not-list never enters it, and a repo waits in it at most once, so
 * this returns null for either. A repo decided before can wait again.
 */
export async function addCandidate(
  db: D1Database,
  candidate: NewCandidate,
  now: number,
): Promise<CrawlCandidate | null> {
  const c = mustParse(
    crawlCandidateSchema,
    {
      ...candidate,
      id: newId('cand'),
      foundAt: checkTime(now),
      status: 'waiting',
      decidedBy: null,
      decidedAt: null,
      reason: null,
    },
    'candidate',
  );
  // The do-not-list check is in the same statement, so a repo added to the
  // list at the same moment can't slip in.
  const result = await db
    .prepare(
      `INSERT INTO crawl_candidates (id, repo, found_at, stars, repo_created_at, repo_pushed_at,
         owner_created_at, policy_quote, policy_url, policy_tier, settings, suggested_tags, status,
         decided_by, decided_at, reason)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'waiting', NULL, NULL, NULL
       WHERE NOT EXISTS (SELECT 1 FROM do_not_list WHERE repo = ?2)
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      c.id,
      c.repo,
      c.foundAt,
      c.facts.stars,
      c.facts.createdAt,
      c.facts.pushedAt,
      c.facts.ownerCreatedAt,
      c.policy.quote,
      c.policy.url,
      c.policy.tier,
      JSON.stringify(c.settings),
      JSON.stringify(c.suggestedTags),
    )
    .run();
  return result.meta.changes === 1 ? c : null;
}

/** Why the crawler leaves a repo alone. */
export type CrawlerSkip =
  /** Its maintainers asked to be removed. */
  | 'do_not_list'
  /** It is a project already, whatever its status. */
  | 'project'
  /** The crawler put it in the admin queue before, whatever the admin decided. */
  | 'proposed';

/**
 * Which of these repos the crawler leaves alone, and why, by the repo's name
 * in lower case. The do-not-list comes first, then projects, then earlier
 * finds. Names compare without case. The repos go in as one JSON array, so
 * any number of them takes one query.
 */
export async function crawlerSkips(db: D1Database, repos: Iterable<string>): Promise<Map<string, CrawlerSkip>> {
  const checked = [...new Set([...repos].map((repo) => mustParse(repoName, repo, 'repo').toLowerCase()))];
  if (checked.length === 0) return new Map();
  const { results } = await db
    .prepare(
      `SELECT repo, why FROM (
         SELECT j.value AS repo,
           CASE WHEN EXISTS (SELECT 1 FROM do_not_list d WHERE d.repo = j.value) THEN 'do_not_list'
                WHEN EXISTS (SELECT 1 FROM projects p WHERE p.repo = j.value) THEN 'project'
                WHEN EXISTS (SELECT 1 FROM crawl_candidates c WHERE c.repo = j.value) THEN 'proposed'
           END AS why
         FROM json_each(?) j)
       WHERE why IS NOT NULL`,
    )
    .bind(JSON.stringify(checked))
    .all<{ repo: string; why: CrawlerSkip }>();
  return new Map(results.map((row) => [row.repo.toLowerCase(), row.why]));
}

export async function getCandidate(db: D1Database, candidateId: string): Promise<CrawlCandidate | null> {
  const row = await db
    .prepare('SELECT * FROM crawl_candidates WHERE id = ?')
    .bind(mustParse(id, candidateId, 'candidateId'))
    .first<CandidateRow>();
  return row === null ? null : toCandidate(row);
}

/** The repo's candidate waiting in the admin queue, compared without case, or null. */
export async function getWaitingCandidate(db: D1Database, repo: string): Promise<CrawlCandidate | null> {
  const row = await db
    .prepare("SELECT * FROM crawl_candidates WHERE repo = ? AND status = 'waiting'")
    .bind(mustParse(repoName, repo, 'repo'))
    .first<CandidateRow>();
  return row === null ? null : toCandidate(row);
}

/** Every candidate with `status`, oldest first. */
export async function listCandidates(db: D1Database, status: CandidateStatus): Promise<CrawlCandidate[]> {
  const { results } = await db
    .prepare('SELECT * FROM crawl_candidates WHERE status = ? ORDER BY found_at, id')
    .bind(mustParse(candidateStatusSchema, status, 'status'))
    .all<CandidateRow>();
  return results.map(toCandidate);
}

/**
 * Records an admin's decision on a waiting candidate. A rejection needs a
 * reason. A candidate is decided once, so this returns null unless it waits.
 */
export async function decideCandidate(
  db: D1Database,
  candidateId: string,
  decision: { status: 'approved' | 'rejected'; decidedBy: number; reason: string | null },
  now: number,
): Promise<CrawlCandidate | null> {
  const current = await getCandidate(db, candidateId);
  if (current?.status !== 'waiting') return null;
  const decided = mustParse(
    crawlCandidateSchema,
    {
      ...current,
      status: decision.status,
      decidedBy: decision.decidedBy,
      decidedAt: checkTime(now),
      reason: decision.reason,
    },
    'candidate',
  );
  const result = await db
    .prepare(
      `UPDATE crawl_candidates SET status = ?, decided_by = ?, decided_at = ?, reason = ?
       WHERE id = ? AND status = 'waiting'`,
    )
    .bind(decided.status, decided.decidedBy, decided.decidedAt, decided.reason, decided.id)
    .run();
  return result.meta.changes === 1 ? decided : null;
}
