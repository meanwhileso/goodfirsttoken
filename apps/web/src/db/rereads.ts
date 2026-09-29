import {
  candidateStatusSchema,
  count,
  crawlerPauseSchema,
  id,
  mustParse,
  policyChangeSchema,
  policyFingerprintSchema,
  policyReadSchema,
  repoName,
  type AiSentence,
  type CandidateSource,
  type CandidateStatus,
  type CrawlerPause,
  type Policy,
  type PolicyChange,
  type PolicyRead,
  type RepoFacts,
} from '@goodfirsttoken/core';
import { checkTime, fromJson, newId } from './shared';

// The policy_reads and policy_changes tables: the policy crawler's weekly
// reads of listed projects (src/crawl/reread.ts), and the changes in their
// policies it puts in the admin queue.

interface ReadRow {
  project: string;
  queued_at: number;
  fingerprint: string | null;
  banned: number | null;
  pause: string | null;
}

function toRead(row: ReadRow): PolicyRead {
  return mustParse(
    policyReadSchema,
    {
      project: row.project,
      queuedAt: row.queued_at,
      fingerprint: row.fingerprint,
      banned: row.banned === null ? null : row.banned === 1,
      pause: fromJson(row.pause),
    },
    'policy read',
  );
}

/**
 * The listed projects due for the crawler's weekly read at `now`: approved or
 * paused, whoever paused them, and not put in the crawl queue since
 * `dueBefore`, the one queued longest ago first, never first, then the
 * oldest added. Projects whose repo or issue repo is on the do-not-list, and
 * projects the sync delisted, are left out: the crawler can't read a repo
 * GitHub doesn't show, and the sync reads those. At most `limit`.
 */
export async function listProjectsToReread(db: D1Database, dueBefore: number, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT p.repo FROM projects p
       LEFT JOIN policy_reads r ON r.project = p.repo
       LEFT JOIN issue_syncs s ON s.project = p.repo
       WHERE p.status IN ('approved', 'paused')
         AND s.delisted IS NULL
         AND NOT EXISTS (SELECT 1 FROM do_not_list d WHERE d.repo IN (p.repo, p.issue_repo))
         AND (r.queued_at IS NULL OR r.queued_at <= ?1)
       ORDER BY r.queued_at IS NOT NULL, r.queued_at, p.added_at, p.repo
       LIMIT ?2`,
    )
    .bind(checkTime(dueBefore, 'dueBefore'), mustParse(count, limit, 'limit'))
    .all<{ repo: string }>();
  return results.map((row) => mustParse(repoName, row.repo, 'repo'));
}

/** Records that the cron job put these projects in the crawl queue at `now`. The repos go in as one JSON array. */
export async function markRereadsQueued(db: D1Database, projects: readonly string[], now: number): Promise<void> {
  const checked = projects.map((project) => mustParse(repoName, project, 'project'));
  if (checked.length === 0) return;
  await db
    .prepare(
      `INSERT INTO policy_reads (project, queued_at, fingerprint, banned, pause)
       SELECT p.repo, ?2, NULL, NULL, NULL FROM json_each(?1) j JOIN projects p ON p.repo = j.value WHERE true
       ON CONFLICT (project) DO UPDATE SET queued_at = excluded.queued_at`,
    )
    .bind(JSON.stringify(checked), checkTime(now))
    .run();
}

/** Where the crawler stands with the project, or null before it first queued it. */
export async function getPolicyRead(db: D1Database, project: string): Promise<PolicyRead | null> {
  const row = await db
    .prepare('SELECT * FROM policy_reads WHERE project = ?')
    .bind(mustParse(repoName, project, 'project'))
    .first<ReadRow>();
  return row === null ? null : toRead(row);
}

/**
 * Keeps what the rules read in the project's docs, read whole at `now`, for
 * the next read to compare with: the hash, and whether they read a ban.
 */
export async function keepFingerprint(
  db: D1Database,
  project: string,
  read: { fingerprint: string; banned: boolean },
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO policy_reads (project, queued_at, fingerprint, banned, pause) VALUES (?1, ?3, ?2, ?4, NULL)
       ON CONFLICT (project) DO UPDATE SET fingerprint = ?2, banned = ?4`,
    )
    .bind(
      mustParse(repoName, project, 'project'),
      mustParse(policyFingerprintSchema, read.fingerprint, 'fingerprint'),
      checkTime(now),
      read.banned ? 1 : 0,
    )
    .run();
}

/** Keeps why the crawler paused the project, for the admin queue. */
export async function keepCrawlerPause(db: D1Database, project: string, pause: CrawlerPause, now: number): Promise<void> {
  const checked = mustParse(crawlerPauseSchema, pause, 'pause');
  await db
    .prepare(
      `INSERT INTO policy_reads (project, queued_at, fingerprint, banned, pause) VALUES (?1, ?3, NULL, NULL, ?2)
       ON CONFLICT (project) DO UPDATE SET pause = ?2`,
    )
    .bind(mustParse(repoName, project, 'project'), JSON.stringify(checked), checkTime(now))
    .run();
}

interface ChangeRow {
  id: string;
  project: string;
  found_at: number;
  facts: string;
  policy: string | null;
  sources: string;
  ai_sentences: string;
  more_ai_sentences: number;
  status: string;
  decided_by: number | null;
  decided_at: number | null;
  reason: string | null;
}

function toChange(row: ChangeRow): PolicyChange {
  return mustParse(
    policyChangeSchema,
    {
      id: row.id,
      repo: row.project,
      foundAt: row.found_at,
      facts: fromJson(row.facts),
      policy: fromJson(row.policy),
      sources: fromJson(row.sources),
      aiSentences: fromJson(row.ai_sentences),
      moreAiSentences: row.more_ai_sentences,
      status: row.status,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      reason: row.reason,
    },
    'policy change',
  );
}

export interface NewPolicyChange {
  repo: string;
  facts: RepoFacts;
  policy: Policy | null;
  sources: CandidateSource[];
  aiSentences: AiSentence[];
  moreAiSentences: number;
}

/**
 * Puts a listed project's changed policy in the admin queue, found at `now`.
 * A change waiting for the same project is replaced, in the same
 * transaction, so the queue holds the latest reading once, under a new ID.
 * Null when the project is gone.
 */
export async function addPolicyChange(db: D1Database, change: NewPolicyChange, now: number): Promise<PolicyChange | null> {
  const c = mustParse(
    policyChangeSchema,
    { ...change, id: newId('pchg'), foundAt: checkTime(now), status: 'waiting', decidedBy: null, decidedAt: null, reason: null },
    'policy change',
  );
  const [, inserted] = await db.batch([
    db.prepare("DELETE FROM policy_changes WHERE project = ? AND status = 'waiting'").bind(c.repo),
    db
      .prepare(
        `INSERT INTO policy_changes (id, project, found_at, facts, policy, sources, ai_sentences, more_ai_sentences,
           status, decided_by, decided_at, reason)
         SELECT ?1, p.repo, ?3, ?4, ?5, ?6, ?7, ?8, 'waiting', NULL, NULL, NULL FROM projects p WHERE p.repo = ?2`,
      )
      .bind(
        c.id,
        c.repo,
        c.foundAt,
        JSON.stringify(c.facts),
        c.policy === null ? null : JSON.stringify(c.policy),
        JSON.stringify(c.sources),
        JSON.stringify(c.aiSentences),
        c.moreAiSentences,
      ),
  ]);
  return inserted?.meta.changes === 1 ? c : null;
}

/**
 * Drops the project's policy change that waits in the admin queue, if one
 * does: when the repo is removed at its maintainers' request, or a maintainer
 * takes the listing over, there is no listing left to list again from it.
 */
export async function dropWaitingPolicyChange(db: D1Database, project: string): Promise<void> {
  await db
    .prepare("DELETE FROM policy_changes WHERE project = ? AND status = 'waiting'")
    .bind(mustParse(repoName, project, 'project'))
    .run();
}

export async function getPolicyChange(db: D1Database, changeId: string): Promise<PolicyChange | null> {
  const row = await db
    .prepare('SELECT * FROM policy_changes WHERE id = ?')
    .bind(mustParse(id, changeId, 'changeId'))
    .first<ChangeRow>();
  return row === null ? null : toChange(row);
}

/** Every policy change with `status`, oldest first. */
export async function listPolicyChanges(db: D1Database, status: CandidateStatus): Promise<PolicyChange[]> {
  const { results } = await db
    .prepare('SELECT * FROM policy_changes WHERE status = ? ORDER BY found_at, id')
    .bind(mustParse(candidateStatusSchema, status, 'status'))
    .all<ChangeRow>();
  return results.map(toChange);
}

/**
 * Records an admin's decision on a waiting policy change. Keeping the
 * listing as it was needs a reason. A change is decided once, so this
 * returns null unless it waits.
 */
export async function decidePolicyChange(
  db: D1Database,
  changeId: string,
  decision: { status: 'approved' | 'rejected'; decidedBy: number; reason: string | null },
  now: number,
): Promise<PolicyChange | null> {
  const current = await getPolicyChange(db, changeId);
  if (current?.status !== 'waiting') return null;
  const decided = mustParse(
    policyChangeSchema,
    { ...current, status: decision.status, decidedBy: decision.decidedBy, decidedAt: checkTime(now), reason: decision.reason },
    'policy change',
  );
  const result = await db
    .prepare(
      `UPDATE policy_changes SET status = ?, decided_by = ?, decided_at = ?, reason = ?
       WHERE id = ? AND status = 'waiting'`,
    )
    .bind(decided.status, decided.decidedBy, decided.decidedAt, decided.reason, decided.id)
    .run();
  return result.meta.changes === 1 ? decided : null;
}
