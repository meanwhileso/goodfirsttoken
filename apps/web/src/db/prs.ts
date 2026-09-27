import {
  agentName,
  count,
  githubId,
  githubLogin,
  id,
  mustParse,
  prRecordSchema,
  prStateSchema,
  repoName,
  type PrRecord,
  type PrRef,
  type PrState,
} from '@goodfirsttoken/core';
import { checkTime, prFromColumns } from './shared';

// The prs table: the PR opened for each claim, followed until it merges or
// closes.

interface PrRow {
  claim_id: string;
  repo: string;
  number: number;
  url: string;
  state: string;
  opened_at: number;
  merged_at: number | null;
  closed_at: number | null;
}

function toPr(row: PrRow): PrRecord {
  return mustParse(
    prRecordSchema,
    {
      claimId: row.claim_id,
      pr: prFromColumns(row.repo, row.number, row.url),
      state: row.state,
      openedAt: row.opened_at,
      mergedAt: row.merged_at,
      closedAt: row.closed_at,
    },
    'PR',
  );
}

function samePr(repo: string, number: number, pr: PrRef): boolean {
  return repo.toLowerCase() === pr.repo.toLowerCase() && number === pr.number;
}

function name(repo: string, number: number): string {
  return `${repo}#${String(number)}`;
}

/**
 * Records the PR opened for a claim, as open. The PR must be the one the
 * claim records, once it records one. A claim has one PR, so recording the
 * same PR again keeps the first record, and a different one is refused. A PR
 * recorded for another claim is refused too.
 */
export async function addPr(
  db: D1Database,
  added: { claimId: string; pr: PrRef; openedAt: number },
): Promise<PrRecord> {
  const record = mustParse(
    prRecordSchema,
    { ...added, state: 'open', mergedAt: null, closedAt: null },
    'PR',
  );
  const { claimId, pr } = record;
  // The claim's own PR is checked in the same statement as the insert, and
  // saveClaim checks this table the same way, so the two always agree.
  const inserted = await db
    .prepare(
      `INSERT INTO prs (claim_id, repo, number, url, state, opened_at, merged_at, closed_at)
       SELECT ?1, ?2, ?3, ?4, 'open', ?5, NULL, NULL
       WHERE EXISTS (SELECT 1 FROM claims WHERE id = ?1
         AND (pr_number IS NULL OR (pr_repo = ?2 AND pr_number = ?3)))
       ON CONFLICT DO NOTHING
       RETURNING *`,
    )
    .bind(claimId, pr.repo, pr.number, pr.url, record.openedAt)
    .first<PrRow>();
  if (inserted !== null) return toPr(inserted);

  // Nothing was inserted. Find out why.
  const claim = await db
    .prepare('SELECT pr_repo, pr_number FROM claims WHERE id = ?')
    .bind(claimId)
    .first<{ pr_repo: string | null; pr_number: number | null }>();
  if (claim === null) throw new Error(`There is no claim ${claimId}.`);
  if (claim.pr_repo !== null && claim.pr_number !== null && !samePr(claim.pr_repo, claim.pr_number, pr)) {
    throw new Error(
      `Claim ${claimId} records ${name(claim.pr_repo, claim.pr_number)}. It can't take ${name(pr.repo, pr.number)}.`,
    );
  }
  const stored = await getPr(db, claimId);
  if (stored === null) {
    const owner = await db
      .prepare('SELECT claim_id FROM prs WHERE repo = ? AND number = ?')
      .bind(pr.repo, pr.number)
      .first<{ claim_id: string }>();
    throw new Error(`${name(pr.repo, pr.number)} is already recorded for claim ${owner?.claim_id ?? 'another claim'}.`);
  }
  if (!samePr(stored.pr.repo, stored.pr.number, pr)) {
    throw new Error(
      `Claim ${claimId} already has ${name(stored.pr.repo, stored.pr.number)}. It can't take ${name(pr.repo, pr.number)}.`,
    );
  }
  return stored;
}

/** The claim's PR, or null when it has none. */
export async function getPr(db: D1Database, claimId: string): Promise<PrRecord | null> {
  const row = await db
    .prepare('SELECT * FROM prs WHERE claim_id = ?')
    .bind(mustParse(id, claimId, 'claimId'))
    .first<PrRow>();
  return row === null ? null : toPr(row);
}

/**
 * Records the state GitHub shows for a claim's PR at `at`. Its times change
 * only when its state does, and a merged PR stays merged. Reopening a closed
 * PR clears its close time. GitHub's clock and ours can differ, so a time
 * before the PR opened counts as the time it opened. Null when the claim has
 * no PR.
 */
export async function setPrState(
  db: D1Database,
  claimId: string,
  state: PrState,
  at: number,
): Promise<PrRecord | null> {
  const next = mustParse(prStateSchema, state, 'state');
  const time = checkTime(at, 'at');
  const current = await getPr(db, claimId);
  if (current === null || current.state === next || current.state === 'merged') return current;
  const when = Math.max(time, current.openedAt);
  const updated = mustParse(
    prRecordSchema,
    {
      ...current,
      state: next,
      mergedAt: next === 'merged' ? when : null,
      closedAt: next === 'open' ? null : when,
    },
    'PR',
  );
  // Only from the state just read, so a change that landed since then wins.
  const row = await db
    .prepare('UPDATE prs SET state = ?, merged_at = ?, closed_at = ? WHERE claim_id = ? AND state = ? RETURNING *')
    .bind(updated.state, updated.mergedAt, updated.closedAt, current.claimId, current.state)
    .first<PrRow>();
  return row === null ? getPr(db, current.claimId) : toPr(row);
}

/** Every PR still open, oldest first, for the job that follows them. */
export async function listOpenPrs(db: D1Database): Promise<PrRecord[]> {
  const { results } = await db
    .prepare("SELECT * FROM prs WHERE state = 'open' ORDER BY opened_at, claim_id")
    .all<PrRow>();
  return results.map(toPr);
}

/** How many PRs opened for a project's claims are open, and how many merged. */
export async function countProjectPrs(db: D1Database, project: string): Promise<{ open: number; merged: number }> {
  const { results } = await db
    .prepare(
      `SELECT prs.state AS state, COUNT(*) AS n FROM prs JOIN claims ON claims.id = prs.claim_id
       WHERE claims.project = ? GROUP BY prs.state`,
    )
    .bind(mustParse(repoName, project, 'project'))
    .all<{ state: string; n: number }>();
  const count = (state: PrState) => results.find((row) => row.state === state)?.n ?? 0;
  return { open: count('open'), merged: count('merged') };
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * When the week that holds `now` began: Monday at 00:00 UTC. The
 * leaderboard's week resets then, and so does the homepage's merged this
 * week.
 */
export function startOfWeek(now: number): number {
  const time = checkTime(now);
  const day = new Date(time);
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  // getUTCDay is 0 on Sunday, so Monday is 1.
  return midnight - ((day.getUTCDay() + 6) % 7) * DAY;
}

/** One person's PRs merged in a time range, for the homepage's ranks. */
export interface Merger {
  githubId: number;
  /** Their login now, from people. */
  login: string;
  /** The agent that did their latest merged PR in the range. */
  agent: string;
  merged: number;
}

interface MergerRow {
  github_id: number;
  login: string;
  agent: string;
  merged: number;
}

/**
 * The people with the most PRs merged from `from` up to `until`, most first,
 * at most `limit` of them. A PR counts when it merged in the range, from a
 * claim on someone else's project. Blocked donors are left out, and so is a
 * PR when the do-not-list names its repo, its claim's project or issue
 * repo, or the project's issue repo now. Ties go to whoever reached the
 * count first, then by login.
 */
export async function topMergers(
  db: D1Database,
  { from, until, limit }: { from: number; until: number; limit: number },
): Promise<Merger[]> {
  // A merged PR's close time is when it merged, and only closed_at is
  // indexed. With MAX() in the select list, SQLite takes the bare column
  // c.agent from the row that has the latest merge.
  const { results } = await db
    .prepare(
      `SELECT c.github_id, pe.login, c.agent, COUNT(*) AS merged, MAX(p.closed_at) AS last_merged
       FROM prs p
       JOIN claims c ON c.id = p.claim_id
       JOIN people pe ON pe.github_id = c.github_id
       WHERE p.state = 'merged' AND p.closed_at >= ?1 AND p.closed_at < ?2 AND c.own_project = 0
         AND NOT EXISTS (SELECT 1 FROM donor_blocks b WHERE b.github_id = c.github_id)
         AND NOT EXISTS (SELECT 1 FROM do_not_list d
           WHERE d.repo IN (c.project, c.issue_repo, p.repo)
             OR d.repo = (SELECT issue_repo FROM projects WHERE repo = c.project))
       GROUP BY c.github_id
       ORDER BY merged DESC, last_merged, pe.login, c.github_id
       LIMIT ?3`,
    )
    .bind(checkTime(from, 'from'), checkTime(until, 'until'), mustParse(count, limit, 'limit'))
    .all<MergerRow>();
  return results.map((row) => ({
    githubId: mustParse(githubId, row.github_id, 'githubId'),
    login: mustParse(githubLogin, row.login, 'login'),
    agent: mustParse(agentName, row.agent, 'agent'),
    merged: mustParse(count, row.merged, 'merged'),
  }));
}
