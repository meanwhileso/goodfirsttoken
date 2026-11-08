import {
  candidateStatusSchema,
  crawlCandidateSchema,
  docsHashSchema,
  heldSchema,
  MAX_HELD_WHY,
  id,
  mustParse,
  policyFingerprintSchema,
  repoName,
  type AiSentence,
  type CandidateSource,
  type CandidateStatus,
  type CrawlCandidate,
  type CrawlReadTier,
  type FindMaker,
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
  sources: string;
  ai_sentences: string;
  more_ai_sentences: number;
  status: string;
  decided_by: number | null;
  decided_at: number | null;
  reason: string | null;
  docs_hash: string | null;
  made_by: string;
  rules_tier: string | null;
  held_at: number | null;
  held_why: string | null;
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
      sources: fromJson(row.sources),
      aiSentences: fromJson(row.ai_sentences),
      moreAiSentences: row.more_ai_sentences,
      docsHash: row.docs_hash,
      madeBy: row.made_by,
      rulesTier: row.rules_tier,
      status: row.status,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      reason: row.reason,
      // A decided row is never held, though a Worker from before holds kept no hold to clear.
      held: row.status !== 'waiting' || row.held_at === null || row.held_why === null ? null : { at: row.held_at, why: row.held_why },
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
  /** The line behind each suggestion the docs gave, and any canary. None when left out. */
  sources?: CandidateSource[];
  /** The sentences in the docs that name AI, for the admin to read, and how many more there are. None when left out. */
  aiSentences?: AiSentence[];
  moreAiSentences?: number;
  /** What the reading of the repo's docs decided, from src/crawl/reader/fingerprint.ts. None when left out. */
  fingerprint?: string;
  /** What the crawler read in the docs, as a docs hash (src/crawl/reader/docs.ts). None when left out. */
  docsHash?: string;
  /** Who made the find: the model reader, or before it read policies, the crawler's rules, which a find left unsaid defaults to. */
  madeBy?: FindMaker;
  /** For a find the model made, the rules' tier for the same docs, when it differs from the model's. */
  rulesTier?: CrawlReadTier | null;
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
  const fingerprint = candidate.fingerprint === undefined ? null : mustParse(policyFingerprintSchema, candidate.fingerprint, 'fingerprint');
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
         owner_created_at, policy_quote, policy_url, policy_tier, settings, suggested_tags, sources, ai_sentences,
         more_ai_sentences, status, decided_by, decided_at, reason, fingerprint, docs_hash, made_by, rules_tier)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'waiting', NULL, NULL, NULL, ?16, ?17, ?18, ?19
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
      JSON.stringify(c.sources),
      JSON.stringify(c.aiSentences),
      c.moreAiSentences,
      fingerprint,
      c.docsHash,
      c.madeBy,
      c.rulesTier,
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
  /**
   * The crawler put it in the admin queue before, whatever the admin
   * decided, or, with `readRejected`, a find for it waits or was approved.
   */
  | 'proposed';

/**
 * Which of these repos the crawler leaves alone, and why, by the repo's name
 * in lower case. The do-not-list comes first, then projects, then earlier
 * finds. Names compare without case. The repos go in as one JSON array, so
 * any number of them takes one query. With `readRejected`, a repo whose
 * finds were all rejected isn't left alone, so its seed is read again each
 * month, and it comes back when its docs read differently.
 */
export async function crawlerSkips(
  db: D1Database,
  repos: Iterable<string>,
  { readRejected = false }: { readRejected?: boolean } = {},
): Promise<Map<string, CrawlerSkip>> {
  const checked = [...new Set([...repos].map((repo) => mustParse(repoName, repo, 'repo').toLowerCase()))];
  if (checked.length === 0) return new Map();
  const { results } = await db
    .prepare(
      `SELECT repo, why FROM (
         SELECT j.value AS repo,
           CASE WHEN EXISTS (SELECT 1 FROM do_not_list d WHERE d.repo = j.value) THEN 'do_not_list'
                WHEN EXISTS (SELECT 1 FROM projects p WHERE p.repo = j.value) THEN 'project'
                WHEN EXISTS (SELECT 1 FROM crawl_candidates c WHERE c.repo = j.value AND (?2 = 0 OR c.status <> 'rejected'))
                  THEN 'proposed'
           END AS why
         FROM json_each(?1) j)
       WHERE why IS NOT NULL`,
    )
    .bind(JSON.stringify(checked), readRejected ? 1 : 0)
    .all<{ repo: string; why: CrawlerSkip }>();
  return new Map(results.map((row) => [row.repo.toLowerCase(), row.why]));
}

/**
 * The repo's find an admin rejected last, with the fingerprint of what was
 * read in its docs then, and the docs hash of those docs, or null when an
 * admin rejected none. The fingerprint is null for a find stored before
 * finds kept one, and the docs hash for one stored before finds kept it.
 */
export async function lastRejectedFind(
  db: D1Database,
  repo: string,
): Promise<{ id: string; fingerprint: string | null; docsHash: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT id, fingerprint, docs_hash FROM crawl_candidates WHERE repo = ? AND status = 'rejected'
       ORDER BY decided_at DESC, found_at DESC, id DESC LIMIT 1`,
    )
    .bind(mustParse(repoName, repo, 'repo'))
    .first<{ id: string; fingerprint: string | null; docs_hash: string | null }>();
  if (row === null) return null;
  return {
    id: row.id,
    fingerprint: row.fingerprint === null ? null : mustParse(policyFingerprintSchema, row.fingerprint, 'fingerprint'),
    docsHash: row.docs_hash === null ? null : mustParse(docsHashSchema, row.docs_hash, 'docsHash'),
  };
}

/**
 * Whether an admin approved a find of the repo. Approving a find lists the
 * repo from it, and a project is never deleted, so for a listing this says
 * whether a find is behind it.
 */
export async function hasApprovedFind(db: D1Database, repo: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS found FROM crawl_candidates WHERE repo = ? AND status = 'approved' LIMIT 1")
    .bind(mustParse(repoName, repo, 'repo'))
    .first<{ found: number }>();
  return row !== null;
}

/**
 * Keeps what the reader read in a find's repo now, as the one to compare the
 * next read with, for a find that kept none, or one of an older version,
 * with the docs hash of the docs read now, when given.
 */
export async function setFindFingerprint(db: D1Database, candidateId: string, fingerprint: string, docsHash?: string): Promise<void> {
  await db
    .prepare('UPDATE crawl_candidates SET fingerprint = ?1, docs_hash = COALESCE(?3, docs_hash) WHERE id = ?2')
    .bind(
      mustParse(policyFingerprintSchema, fingerprint, 'fingerprint'),
      mustParse(id, candidateId, 'candidateId'),
      docsHash === undefined ? null : mustParse(docsHashSchema, docsHash, 'docsHash'),
    )
    .run();
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
      held: null,
    },
    'candidate',
  );
  const result = await db
    .prepare(
      `UPDATE crawl_candidates SET status = ?, decided_by = ?, decided_at = ?, reason = ?, held_at = NULL, held_why = NULL
       WHERE id = ? AND status = 'waiting'`,
    )
    .bind(decided.status, decided.decidedBy, decided.decidedAt, decided.reason, decided.id)
    .run();
  return result.meta.changes === 1 ? decided : null;
}

/**
 * Holds a waiting find out of the admin queue at `now`, for `why`, under
 * docs/specs/held-items.md. False when it no longer waits, or is held
 * already.
 */
export async function holdCandidate(db: D1Database, candidateId: string, why: string, now: number): Promise<boolean> {
  const held = mustParse(heldSchema, { at: checkTime(now), why: why.trim().slice(0, MAX_HELD_WHY) }, 'held');
  const result = await db
    .prepare("UPDATE crawl_candidates SET held_at = ?, held_why = ? WHERE id = ? AND status = 'waiting' AND held_at IS NULL")
    .bind(held.at, held.why, mustParse(id, candidateId, 'candidateId'))
    .run();
  return result.meta.changes === 1;
}

/** The waiting finds held at or before `heldBy`, the longest held first, at most `limit`. */
export async function listHeldCandidates(db: D1Database, heldBy: number, limit: number): Promise<CrawlCandidate[]> {
  const { results } = await db
    .prepare("SELECT * FROM crawl_candidates WHERE status = 'waiting' AND held_at <= ? ORDER BY held_at, id LIMIT ?")
    .bind(heldBy, limit)
    .all<CandidateRow>();
  return results.map(toCandidate);
}

/**
 * Drops a held find, so the crawler can read its repo again and make a new
 * one. False when it is no longer held, as when an admin decided it.
 */
export async function dropHeldCandidate(db: D1Database, candidateId: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM crawl_candidates WHERE id = ? AND status = 'waiting' AND held_at IS NOT NULL")
    .bind(mustParse(id, candidateId, 'candidateId'))
    .run();
  return result.meta.changes === 1;
}

/** How many waiting finds are held out of the admin queue. */
export async function countHeldCandidates(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM crawl_candidates WHERE status = 'waiting' AND held_at IS NOT NULL")
    .first<{ n: number }>();
  return row?.n ?? 0;
}
