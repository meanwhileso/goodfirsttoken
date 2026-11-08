import {
  githubId,
  id,
  MAX_BOT_ROUNDS,
  MAX_ROUNDS,
  mustParse,
  ROUNDS_PER_DAY,
  roundDay,
  TRIGGER_CALLS_PER_DAY,
  TRIGGER_EVERY_MS,
  TRIGGER_FAILURES_OFF,
  TRIGGER_HARNESSES,
  TRIGGER_HOLD_MS,
  wakeHarnessSchema,
  type TriggerHarnessName,
  type WakeRecord,
} from '@goodfirsttoken/core';
import { toWake, type WakeFollowUp, type WakeRow } from './follow-through';
import { checkTime } from './shared';
import { ASKING_FOR_HELP } from './waiting';

// The trigger each wake can have (docs/specs/follow-through.md, under
// Waking a run when a follow-up comes), in the trigger_ columns of the
// wakes table, and trigger_follow_ups, the follow-ups each wake's trigger
// was called for. /me saves and removes a trigger (src/me/page.ts), and
// the PR job calls each one (src/sync/triggers.ts). The key is stored
// sealed, as src/sync/triggers.ts seals it, and only the call reads it
// back. The rules are in docs/how-it-works.md, under PRs.

/** The harnesses that take a trigger, as SQL. */
const TAKES = `(${Object.keys(TRIGGER_HARNESSES)
  .map((harness) => `'${mustParse(wakeHarnessSchema, harness, 'harness')}'`)
  .join(', ')})`;

/**
 * Saves a trigger on the donor's wake at `now`, in place of any it had:
 * its URL, checked against its harness's pattern, and its key, sealed. It
 * is on, with no failures. Its calls today, its last call, and a 429's
 * hold stay, so saving again starts no call sooner. Only a wake of the donor's
 * in `harness`, which takes a trigger, at a level that runs on its own.
 * Gives the wake after, or null when there is no such wake.
 */
export async function saveTrigger(
  db: D1Database,
  person: number,
  wakeId: string,
  trigger: { harness: TriggerHarnessName; url: string; sealedKey: string },
  now: number,
): Promise<WakeRecord | null> {
  const row = await db
    .prepare(
      `UPDATE wakes SET trigger_url = ?4, trigger_key = ?5, trigger_on = 1, trigger_off = NULL, trigger_saved_at = ?6,
         trigger_fired_at = NULL, trigger_failures = 0
       WHERE id = ?1 AND github_id = ?2 AND harness = ?3 AND harness IN ${TAKES} AND level <> 'session'
       RETURNING *`,
    )
    .bind(
      mustParse(id, wakeId, 'wakeId'),
      mustParse(githubId, person, 'githubId'),
      trigger.harness,
      trigger.url,
      trigger.sealedKey,
      checkTime(now),
    )
    .first<WakeRow>();
  return row === null ? null : toWake(row);
}

/**
 * Removes the trigger from the donor's wake: its URL, its key, and where
 * it stood. Gives the wake after, or null when the donor has no such wake.
 */
export async function removeTrigger(db: D1Database, person: number, wakeId: string): Promise<WakeRecord | null> {
  const row = await db
    .prepare(
      `UPDATE wakes SET trigger_url = NULL, trigger_key = NULL, trigger_on = 0, trigger_off = NULL, trigger_saved_at = NULL,
         trigger_fired_at = NULL, trigger_failures = 0, trigger_held_until = NULL
       WHERE id = ?1 AND github_id = ?2 RETURNING *`,
    )
    .bind(mustParse(id, wakeId, 'wakeId'), mustParse(githubId, person, 'githubId'))
    .first<WakeRow>();
  return row === null ? null : toWake(row);
}

/**
 * Turns the donor's trigger on again after three failed calls in a row
 * turned it off, with the key it kept. One turned off for a wrong key or a
 * trigger that is gone kept no key, and stays off until the donor saves a
 * new one. A 429's hold stays. Gives the wake after, or null when nothing
 * turned on.
 */
export async function turnTriggerOn(db: D1Database, person: number, wakeId: string): Promise<WakeRecord | null> {
  const row = await db
    .prepare(
      `UPDATE wakes SET trigger_on = 1, trigger_off = NULL, trigger_failures = 0
       WHERE id = ?1 AND github_id = ?2 AND trigger_off = 'failures' AND trigger_key IS NOT NULL RETURNING *`,
    )
    .bind(mustParse(id, wakeId, 'wakeId'), mustParse(githubId, person, 'githubId'))
    .first<WakeRow>();
  return row === null ? null : toWake(row);
}

/** A trigger may be called at ?1, the time now, on the UTC day ?2. */
const CALLABLE = `w.trigger_on = 1 AND w.trigger_key IS NOT NULL AND w.trigger_url IS NOT NULL
  AND w.harness IN ${TAKES} AND w.level <> 'session'
  AND (w.trigger_held_until IS NULL OR w.trigger_held_until <= ?1)
  AND (w.trigger_called_at IS NULL OR w.trigger_called_at <= ?1 - ${String(TRIGGER_EVERY_MS)})
  AND (w.trigger_day IS NOT ?2 OR w.trigger_calls_on_day < ${String(TRIGGER_CALLS_PER_DAY)})`;

/** How the claim's PR is followed: its own mode, or else the donor's, or go_ahead. */
const MODE = `COALESCE((SELECT m.mode FROM pr_follow_modes m WHERE m.claim_id = c.id),
  (SELECT d.mode FROM follow_modes d WHERE d.github_id = c.github_id), 'go_ahead')`;

/** A wake with a trigger that has follow-ups to be called for. */
export interface TriggerDue {
  wakeId: string;
  /** The follow-ups the call is for, by claim and ID. */
  followUps: WakeFollowUp[];
}

/**
 * The wakes whose trigger the PR job calls at `now`, those called longest
 * ago first, at most `limit`, each with the follow-ups it hasn't been
 * called for. A trigger is called only while it is on, held by no 429, at
 * least 15 minutes after its last call, and for fewer than 12 calls on the
 * UTC day. A follow-up counts only on one of the wake's donor's PRs that a
 * tool lists, as listWaitingFollowUps does, and only when:
 *
 * - the PR isn't off, has an open follow-up, so not all of them wait for
 *   the donor, and is at neither round limit,
 * - it isn't a bot's on a PR past its bot rounds,
 * - for a run that follows the PR in full, a full wake's on a go_ahead PR,
 *   it is open and no run holds the PR's lease,
 * - for a run that only reports, a notify wake's or any wake's on an
 *   ask_first PR, it is open or waits for the donor, and my_work didn't give
 *   it to the wake yet.
 *
 * A follow-up left out for the lease or the limits is called for by a later
 * pass, once they let it.
 */
export async function listTriggersDue(db: D1Database, now: number, limit: number): Promise<TriggerDue[]> {
  const at = checkTime(now);
  const { results } = await db
    .prepare(
      `WITH due AS (
         SELECT w.id AS wake_id, COALESCE(w.trigger_called_at, 0) AS called, f.claim_id, f.comment_id, f.written_at, f.rowid AS seq
         FROM wakes w
         JOIN claims c ON c.github_id = w.github_id
         JOIN prs pr ON pr.claim_id = c.id
         JOIN submissions sub ON sub.claim_id = c.id
         JOIN projects p ON p.repo = c.project
         JOIN follow_ups f ON f.claim_id = c.id
         WHERE ${CALLABLE}
           AND pr.state = 'open' AND ${ASKING_FOR_HELP}
           AND NOT EXISTS (SELECT 1 FROM donor_blocks b WHERE b.github_id = c.github_id)
           AND ${MODE} <> 'off'
           AND EXISTS (SELECT 1 FROM follow_ups o WHERE o.claim_id = c.id AND o.state = 'open')
           AND pr.rounds < ${String(MAX_ROUNDS)}
           AND NOT (pr.rounds_day IS ?2 AND pr.rounds_on_day >= ${String(ROUNDS_PER_DAY)})
           AND NOT (f.author_kind = 'bot' AND pr.bot_rounds >= ${String(MAX_BOT_ROUNDS)})
           AND NOT EXISTS (SELECT 1 FROM trigger_follow_ups t
             WHERE t.wake_id = w.id AND t.claim_id = f.claim_id AND t.comment_id = f.comment_id)
           AND (
             (w.level = 'full' AND ${MODE} = 'go_ahead' AND f.state = 'open'
               AND (pr.lease_run IS NULL OR pr.lease_until <= ?1))
             OR ((w.level = 'notify' OR ${MODE} = 'ask_first') AND f.state IN ('open', 'waiting_donor')
               AND NOT EXISTS (SELECT 1 FROM wake_follow_ups g
                 WHERE g.wake_id = w.id AND g.claim_id = f.claim_id AND g.comment_id = f.comment_id))
           )
       ),
       chosen AS (SELECT wake_id, MIN(called) AS called FROM due GROUP BY wake_id ORDER BY called, wake_id LIMIT ?3)
       SELECT due.wake_id, due.claim_id, due.comment_id FROM due JOIN chosen USING (wake_id)
       ORDER BY chosen.called, due.wake_id, due.written_at, due.seq`,
    )
    .bind(at, roundDay(at), limit)
    .all<{ wake_id: string; claim_id: string; comment_id: string }>();
  const byWake = new Map<string, WakeFollowUp[]>();
  for (const row of results) {
    const list = byWake.get(row.wake_id) ?? [];
    list.push({ claimId: row.claim_id, followUpId: row.comment_id });
    byWake.set(row.wake_id, list);
  }
  return [...byWake].map(([wakeId, followUps]) => ({ wakeId, followUps }));
}

/** A call the PR job may make now: the trigger's harness, URL, sealed key, and when it was saved. */
export interface TriggerCall {
  wakeId: string;
  harness: TriggerHarnessName;
  url: string;
  sealedKey: string;
  savedAt: number;
}

/**
 * Takes the wake's next call at `now`, in one statement, while its trigger
 * may be called, as listTriggersDue says: records the call, and counts it
 * on the UTC day. So two passes at once never both call one trigger. Null
 * when it may not be called now.
 */
export async function takeTriggerCall(db: D1Database, wakeId: string, now: number): Promise<TriggerCall | null> {
  const at = checkTime(now);
  const row = await db
    .prepare(
      `UPDATE wakes AS w SET trigger_called_at = ?1,
         trigger_calls_on_day = iif(trigger_day IS ?2, trigger_calls_on_day + 1, 1), trigger_day = ?2
       WHERE w.id = ?3 AND ${CALLABLE}
       RETURNING harness, trigger_url, trigger_key, trigger_saved_at`,
    )
    .bind(at, roundDay(at), mustParse(id, wakeId, 'wakeId'))
    .first<{ harness: TriggerHarnessName; trigger_url: string; trigger_key: string; trigger_saved_at: number }>();
  return row === null
    ? null
    : { wakeId, harness: row.harness, url: row.trigger_url, sealedKey: row.trigger_key, savedAt: row.trigger_saved_at };
}

/**
 * What a call's answer said: `fired`, a run started; `timeout`, no answer
 * in time, though the run may have started; `failed`, a 5xx, a redirect,
 * no answer, or any other answer; `held`, a 429; `key`, the key is wrong;
 * or `gone`, the trigger is gone, or its URL no longer fits its harness.
 */
export type TriggerOutcome = 'fired' | 'timeout' | 'failed' | 'held' | 'key' | 'gone';

/**
 * Records a call's outcome at `now`, on the trigger the call was made for,
 * by when it was saved, so a trigger the donor saved again meanwhile keeps
 * its own. A run that started records the follow-ups the call was for, and
 * ends the failures in a row. A failure, or a 429, counts one more, and a
 * 429 holds the wake's calls for an hour. A timeout counts one more too,
 * and records the follow-ups as called, since the harness may have started
 * the run, and its routines take no key to tell a second call from the
 * first. The third in a row turns the trigger off, keeping its key. A
 * wrong key, or a trigger that is gone, turns it off and drops its key,
 * which can start nothing now. Gives whether the call turned the trigger
 * off.
 */
export async function recordTriggerCall(
  db: D1Database,
  call: Pick<TriggerCall, 'wakeId' | 'savedAt'>,
  outcome: TriggerOutcome,
  followUps: readonly WakeFollowUp[],
  now: number,
): Promise<{ turnedOff: boolean }> {
  const at = checkTime(now);
  const wake = mustParse(id, call.wakeId, 'wakeId');
  const which = 'WHERE id = ?1 AND trigger_saved_at = ?2';
  const keys = JSON.stringify(followUps.map((key) => [mustParse(id, key.claimId, 'claimId'), key.followUpId]));
  const called = db
    .prepare(
      `INSERT INTO trigger_follow_ups (wake_id, claim_id, comment_id, called_at)
       SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), ?3 FROM json_each(?4)
       WHERE EXISTS (SELECT 1 FROM wakes WHERE id = ?1 AND trigger_saved_at = ?2)
       ON CONFLICT DO NOTHING`,
    )
    .bind(wake, call.savedAt, at, keys);
  if (outcome === 'fired') {
    await db.batch([db.prepare(`UPDATE wakes SET trigger_fired_at = ?3, trigger_failures = 0 ${which}`).bind(wake, call.savedAt, at), called]);
    return { turnedOff: false };
  }
  if (outcome === 'key' || outcome === 'gone') {
    const off = await db
      .prepare(`UPDATE wakes SET trigger_on = 0, trigger_off = ?3, trigger_key = NULL, trigger_held_until = NULL ${which} RETURNING id`)
      .bind(wake, call.savedAt, outcome)
      .first();
    return { turnedOff: off !== null };
  }
  // SQLite reads every SET from the row before the update.
  const failed = db
    .prepare(
      `UPDATE wakes SET trigger_failures = trigger_failures + 1,
         trigger_held_until = iif(?3, ?4 + ${String(TRIGGER_HOLD_MS)}, trigger_held_until),
         trigger_on = iif(trigger_failures + 1 >= ${String(TRIGGER_FAILURES_OFF)}, 0, trigger_on),
         trigger_off = iif(trigger_failures + 1 >= ${String(TRIGGER_FAILURES_OFF)}, 'failures', trigger_off)
       ${which} RETURNING trigger_on`,
    )
    .bind(wake, call.savedAt, outcome === 'held' ? 1 : 0, at);
  const [counted] = await db.batch<{ trigger_on: number }>(outcome === 'timeout' ? [failed, called] : [failed]);
  return { turnedOff: counted?.results[0]?.trigger_on === 0 };
}
