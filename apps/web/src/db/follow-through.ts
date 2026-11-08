import {
  DEFAULT_FOLLOW_MODE,
  followModeSchema,
  followUpId,
  githubId,
  id,
  MAX_WAKES,
  mustParse,
  prFollowModeSchema,
  WAKE_STOPPED_AFTER_MS,
  wakeHarnessSchema,
  wakeInterval,
  wakeLevelSchema,
  wakeRecordSchema,
  type FollowMode,
  type PrFollowMode,
  type WakeHarness,
  type WakeLevel,
  type WakeRecord,
} from '@goodfirsttoken/core';
import { checkTime, newId } from './shared';
import { SHOWN } from './shown';

// The donor's follow-through (docs/specs/follow-through.md): the
// follow_modes table, the mode each donor chose for all their PRs, the
// pr_follow_modes table, the mode they chose for one PR by its claim, the
// wakes table, what starts their runs in each harness, and
// wake_follow_ups, the follow-ups my_work gave each wake. The rules are in
// docs/how-it-works.md, under The donor's tools.

/** The donor's mode for all their PRs, and whether they chose it. */
export interface FollowModeChoice {
  mode: FollowMode;
  chosen: boolean;
}

/** The donor's mode, or go_ahead, not chosen, for a donor who never chose. */
export async function getFollowMode(db: D1Database, person: number): Promise<FollowModeChoice> {
  const row = await db
    .prepare('SELECT mode FROM follow_modes WHERE github_id = ?')
    .bind(mustParse(githubId, person, 'githubId'))
    .first<{ mode: string }>();
  return row === null
    ? { mode: DEFAULT_FOLLOW_MODE, chosen: false }
    : { mode: mustParse(followModeSchema, row.mode, 'mode'), chosen: true };
}

/** The modes the donor set for one PR each, by claim. A PR not here follows the donor's own mode. */
export async function listPrFollowModes(db: D1Database, person: number): Promise<Map<string, PrFollowMode>> {
  const { results } = await db
    .prepare(
      `SELECT m.claim_id, m.mode FROM pr_follow_modes m JOIN claims c ON c.id = m.claim_id
       WHERE c.github_id = ? ORDER BY m.claim_id`,
    )
    .bind(mustParse(githubId, person, 'githubId'))
    .all<{ claim_id: string; mode: string }>();
  return new Map(results.map((row) => [row.claim_id, mustParse(prFollowModeSchema, row.mode, 'mode')]));
}

export interface WakeRow {
  id: string;
  github_id: number;
  harness: string;
  level: string;
  interval_minutes: number;
  created_at: number;
  last_run_at: number | null;
  trigger_url: string | null;
  trigger_key: string | null;
  trigger_on: number;
  trigger_off: string | null;
  trigger_saved_at: number | null;
  trigger_called_at: number | null;
  trigger_fired_at: number | null;
  trigger_failures: number;
  trigger_held_until: number | null;
}

/** The wake's trigger as the record gives it: its host and where it stands, never its key. */
function triggerOf(row: WakeRow): WakeRecord['trigger'] {
  if (row.trigger_url === null || row.trigger_saved_at === null) return null;
  return {
    host: new URL(row.trigger_url).hostname,
    on: row.trigger_on === 1,
    off: row.trigger_off,
    hasKey: row.trigger_key !== null,
    savedAt: row.trigger_saved_at,
    calledAt: row.trigger_called_at,
    firedAt: row.trigger_fired_at,
    failures: row.trigger_failures,
    heldUntil: row.trigger_held_until,
  } as WakeRecord['trigger'];
}

export function toWake(row: WakeRow): WakeRecord {
  return mustParse(
    wakeRecordSchema,
    {
      id: row.id,
      githubId: row.github_id,
      harness: row.harness,
      level: row.level,
      intervalMinutes: row.interval_minutes,
      createdAt: row.created_at,
      lastRunAt: row.last_run_at,
      trigger: triggerOf(row),
    },
    'wake',
  );
}

/** A wake as set_follow_through saves it. */
export interface NewWake {
  harness: WakeHarness;
  level: WakeLevel;
  intervalMinutes: number;
}

/** The donor's wakes, oldest first. */
export async function listWakes(db: D1Database, person: number): Promise<WakeRecord[]> {
  const { results } = await db
    .prepare('SELECT * FROM wakes WHERE github_id = ? ORDER BY created_at, id')
    .bind(mustParse(githubId, person, 'githubId'))
    .all<WakeRow>();
  return results.map(toWake);
}

/** What one set_follow_through call changes. */
export interface FollowThroughChange {
  /** A mode for all the donor's PRs, or with `claimId`, for that claim's PR alone. */
  mode?: { mode: PrFollowMode; claimId?: string | undefined } | undefined;
  /** The ID of a wake of the donor's to remove, with what it was given. */
  remove?: string | undefined;
  /** A wake to save. */
  save?: NewWake | undefined;
  /** A claim whose open PR goes on past its round limits: its rounds today and in all start again from 0. */
  goOn?: string | undefined;
}

/**
 * Makes the change at `now`, all of it or none, in one batch. A mode for
 * all the donor's PRs takes the place of each PR's own go_ahead or
 * ask_first, and a PR they stopped following stays off. A wake that isn't
 * the donor's is not removed. A new wake is saved only while the donor
 * keeps fewer than MAX_WAKES, not counting the one the change removes.
 * When it isn't, nothing changes, and `saved` is null. A PR that goes on
 * keeps its bot rounds, and the UTC day of its last round. `wentOn` is
 * true when the donor's open PR went on. The donor must
 * be in the people table, and a claim in the claims table.
 */
export async function saveFollowThrough(
  db: D1Database,
  person: number,
  change: FollowThroughChange,
  now: number,
): Promise<{ removed: boolean; saved: WakeRecord | null; wentOn: boolean }> {
  const who = mustParse(githubId, person, 'githubId');
  const at = checkTime(now);
  const removing = change.remove === undefined ? null : mustParse(id, change.remove, 'wakeId');
  const wakeId = change.save === undefined ? null : newId('w');
  // Every statement after the new wake's waits on it, so a wake past the
  // limit changes nothing.
  const saved = '(?9 IS NULL OR EXISTS (SELECT 1 FROM wakes WHERE id = ?9))';
  const bind = (statement: D1PreparedStatement, ...values: unknown[]) => {
    const params: unknown[] = [who, at, removing, null, null, null, null, null, wakeId];
    values.forEach((value, i) => {
      if (value !== undefined) params[i + 3] = value;
    });
    return statement.bind(...params);
  };
  const statements: D1PreparedStatement[] = [];
  if (change.save !== undefined) {
    statements.push(
      bind(
        db.prepare(
          `INSERT INTO wakes (id, github_id, harness, level, interval_minutes, created_at, last_run_at)
           SELECT ?9, ?1, ?4, ?5, ?6, ?2, NULL
           WHERE (SELECT COUNT(*) FROM wakes WHERE github_id = ?1 AND id IS NOT ?3) < ?7`,
        ),
        mustParse(wakeHarnessSchema, change.save.harness, 'harness'),
        mustParse(wakeLevelSchema, change.save.level, 'level'),
        mustParse(wakeInterval, change.save.intervalMinutes, 'intervalMinutes'),
        MAX_WAKES,
      ),
    );
  }
  if (removing !== null) {
    statements.push(
      bind(
        db.prepare(
          `DELETE FROM wake_follow_ups WHERE wake_id = (SELECT id FROM wakes WHERE id = ?3 AND github_id = ?1) AND ${saved}`,
        ),
      ),
      // The wake's trigger goes with its row, and the follow-ups it was called for with it.
      bind(
        db.prepare(
          `DELETE FROM trigger_follow_ups WHERE wake_id = (SELECT id FROM wakes WHERE id = ?3 AND github_id = ?1) AND ${saved}`,
        ),
      ),
      bind(db.prepare(`DELETE FROM wakes WHERE id = ?3 AND github_id = ?1 AND ${saved} RETURNING id`)),
    );
  }
  if (change.mode !== undefined) {
    const mode = mustParse(prFollowModeSchema, change.mode.mode, 'mode');
    if (change.mode.claimId !== undefined) {
      statements.push(
        bind(
          db.prepare(
            `INSERT INTO pr_follow_modes (claim_id, mode, chosen_at) SELECT ?4, ?5, ?2 WHERE ${saved}
             ON CONFLICT (claim_id) DO UPDATE SET mode = excluded.mode, chosen_at = excluded.chosen_at`,
          ),
          mustParse(id, change.mode.claimId, 'claimId'),
          mode,
        ),
      );
    } else {
      statements.push(
        bind(
          db.prepare(
            `INSERT INTO follow_modes (github_id, mode, chosen_at) SELECT ?1, ?4, ?2 WHERE ${saved}
             ON CONFLICT (github_id) DO UPDATE SET mode = excluded.mode, chosen_at = excluded.chosen_at`,
          ),
          mustParse(followModeSchema, mode, 'mode'),
        ),
        bind(
          db.prepare(
            `DELETE FROM pr_follow_modes WHERE mode <> 'off' AND claim_id IN (SELECT id FROM claims WHERE github_id = ?1)
             AND ${saved}`,
          ),
        ),
      );
    }
  }
  if (change.goOn !== undefined) {
    statements.push(
      bind(
        db.prepare(
          `UPDATE prs SET rounds = 0, rounds_on_day = 0
           WHERE claim_id = ?4 AND state = 'open' AND claim_id IN (SELECT id FROM claims WHERE github_id = ?1) AND ${saved}
           RETURNING claim_id AS id`,
        ),
        mustParse(id, change.goOn, 'claimId'),
      ),
    );
  }
  if (statements.length === 0) return { removed: false, saved: null, wentOn: false };
  const results = await db.batch<{ id: string }>(statements);
  const removedRows = removing === null ? [] : (results[change.save === undefined ? 2 : 3]?.results ?? []);
  const wake = wakeId === null ? null : await db.prepare('SELECT * FROM wakes WHERE id = ?').bind(wakeId).first<WakeRow>();
  // The go on is the batch's last statement when there is one.
  const wentOn = change.goOn !== undefined && (results[results.length - 1]?.results.length ?? 0) > 0;
  return { removed: removedRows.length > 0, saved: wake === null ? null : toWake(wake), wentOn };
}

/** One of the donor's wakes, or null when they have no such wake. */
export async function getWake(db: D1Database, person: number, wakeId: string): Promise<WakeRecord | null> {
  const row = await db
    .prepare('SELECT * FROM wakes WHERE id = ?1 AND github_id = ?2')
    .bind(mustParse(id, wakeId, 'wakeId'), mustParse(githubId, person, 'githubId'))
    .first<WakeRow>();
  return row === null ? null : toWake(row);
}

/**
 * Records that a run of the donor's wake called my_work at `now`, and
 * gives the wake after it, or null when the donor has no such wake. A run
 * that lands after a later one keeps the later one's time.
 */
export async function recordWakeRun(db: D1Database, person: number, wakeId: string, now: number): Promise<WakeRecord | null> {
  const row = await db
    .prepare(
      `UPDATE wakes SET last_run_at = max(COALESCE(last_run_at, ?3), ?3) WHERE id = ?1 AND github_id = ?2 RETURNING *`,
    )
    .bind(mustParse(id, wakeId, 'wakeId'), mustParse(githubId, person, 'githubId'), checkTime(now))
    .first<WakeRow>();
  return row === null ? null : toWake(row);
}

/** A follow-up, by its claim and its ID, as my_work gives it to a wake. */
export interface WakeFollowUp {
  claimId: string;
  followUpId: string;
}

function keysJson(keys: readonly WakeFollowUp[]): string {
  return JSON.stringify(keys.map((key) => [mustParse(id, key.claimId, 'claimId'), mustParse(followUpId, key.followUpId, 'followUpId')]));
}

/**
 * Gives the wake these follow-ups at `now`, in one statement, and returns
 * those it wasn't given before, in their order. So two runs of one wake
 * at once are each given a follow-up the other wasn't.
 */
export async function giveToWake(db: D1Database, wakeId: string, keys: readonly WakeFollowUp[], now: number): Promise<WakeFollowUp[]> {
  if (keys.length === 0) return [];
  const { results } = await db
    .prepare(
      `INSERT INTO wake_follow_ups (wake_id, claim_id, comment_id, given_at)
       SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), ?3 FROM json_each(?2) WHERE true
       ON CONFLICT DO NOTHING
       RETURNING claim_id, comment_id`,
    )
    .bind(mustParse(id, wakeId, 'wakeId'), keysJson(keys), checkTime(now))
    .all<{ claim_id: string; comment_id: string }>();
  const given = new Set(results.map((row) => JSON.stringify([row.claim_id, row.comment_id])));
  return keys.filter((key) => given.has(JSON.stringify([key.claimId, key.followUpId])));
}

/**
 * The donor's wakes that stopped at `now`, oldest first: no run for 24
 * hours past its interval, or none that long since it was saved, while
 * one of the donor's PRs is open, as listOpenPrsOf lists them. The
 * interval keeps a daily wake that runs a little late from looking
 * stopped. A session wake is left out, since it runs only while a session
 * does. For start_session, my_work, and /me.
 */
export async function listStoppedWakes(db: D1Database, person: number, now: number): Promise<WakeRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT w.* FROM wakes w
       WHERE w.github_id = ?1 AND w.level <> 'session'
         AND COALESCE(w.last_run_at, w.created_at) + w.interval_minutes * 60000 <= ?2
         AND EXISTS (SELECT 1 FROM prs p JOIN claims c ON c.id = p.claim_id
           WHERE c.github_id = w.github_id AND p.state = 'open' AND ${SHOWN}
             AND NOT EXISTS (SELECT 1 FROM issue_syncs u WHERE u.project = c.project AND u.delisted IS NOT NULL))
       ORDER BY w.created_at, w.id`,
    )
    .bind(mustParse(githubId, person, 'githubId'), checkTime(now) - WAKE_STOPPED_AFTER_MS)
    .all<WakeRow>();
  return results.map(toWake);
}
