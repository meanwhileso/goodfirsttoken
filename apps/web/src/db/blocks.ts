import { donorBlockSchema, githubId, githubLogin, mustParse, type DonorBlock } from '@goodfirsttoken/core';
import { checkTime } from './shared';

// The donor_blocks table: donors an admin blocked.

interface BlockRow {
  github_id: number;
  reason: string | null;
  blocked_by: number;
  blocked_at: number;
}

function toBlock(row: BlockRow): DonorBlock {
  return mustParse(
    donorBlockSchema,
    {
      githubId: row.github_id,
      reason: row.reason,
      blockedBy: row.blocked_by,
      blockedAt: row.blocked_at,
    },
    'block',
  );
}

const blockInput = donorBlockSchema.pick({ githubId: true, reason: true, blockedBy: true });

/**
 * Blocks a donor. Blocking someone already blocked records the new reason,
 * admin, and time.
 */
export async function blockDonor(
  db: D1Database,
  block: { githubId: number; reason: string | null; blockedBy: number },
  now: number,
): Promise<DonorBlock> {
  const input = mustParse(blockInput, block, 'block');
  const row = await db
    .prepare(
      `INSERT INTO donor_blocks (github_id, reason, blocked_by, blocked_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (github_id) DO UPDATE SET
         reason = excluded.reason, blocked_by = excluded.blocked_by, blocked_at = excluded.blocked_at
       RETURNING *`,
    )
    .bind(input.githubId, input.reason, input.blockedBy, checkTime(now))
    .first<BlockRow>();
  if (row === null) throw new Error(`Blocking ${String(input.githubId)} returned no row.`);
  return toBlock(row);
}

/** Lifts a block. False when the donor wasn't blocked. */
export async function unblockDonor(db: D1Database, id: number): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM donor_blocks WHERE github_id = ?')
    .bind(mustParse(githubId, id, 'githubId'))
    .run();
  return result.meta.changes > 0;
}

/** The donor's block, or null when they aren't blocked. */
export async function getBlock(db: D1Database, id: number): Promise<DonorBlock | null> {
  const row = await db
    .prepare('SELECT * FROM donor_blocks WHERE github_id = ?')
    .bind(mustParse(githubId, id, 'githubId'))
    .first<BlockRow>();
  return row === null ? null : toBlock(row);
}

/**
 * Which of these donors are blocked now. The IDs go in as one JSON array, so
 * any number of them takes one query, under D1's limit on bound values.
 */
export async function blockedAmong(db: D1Database, ids: Iterable<number>): Promise<Set<number>> {
  const checked = [...new Set(ids)].map((id) => mustParse(githubId, id, 'githubId'));
  if (checked.length === 0) return new Set();
  const { results } = await db
    .prepare('SELECT github_id FROM donor_blocks WHERE github_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(checked))
    .all<{ github_id: number }>();
  return new Set(results.map((row) => row.github_id));
}

/** A block, with the login its donor was last seen with. */
export type ListedBlock = DonorBlock & { login: string };

/** Every blocked donor with their login, most recently blocked first, in one query. */
export async function listBlocks(db: D1Database): Promise<ListedBlock[]> {
  const { results } = await db
    .prepare(
      `SELECT b.*, p.login FROM donor_blocks b JOIN people p ON p.github_id = b.github_id
       ORDER BY b.blocked_at DESC, b.github_id`,
    )
    .all<BlockRow & { login: string }>();
  return results.map((row) => ({ ...toBlock(row), login: mustParse(githubLogin, row.login, 'login') }));
}
