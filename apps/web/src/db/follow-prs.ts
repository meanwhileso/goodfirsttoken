import { githubId, id, LEASE_MS, mustParse, runIdSchema, roundDay, type PrFacts } from '@goodfirsttoken/core';
import { OPEN_PRS_LISTED } from './prs';
import { checkTime } from './shared';
import { SHOWN } from './shown';
import { ASKING_FOR_HELP } from './waiting';

// Follow-through on the prs table (docs/specs/follow-through.md): each
// open PR's lease, which keeps two runs off one PR, its rounds, and when a
// run last checked it. The rules are in docs/how-it-works.md, under The
// donor's tools.

/** A run's lease on a PR, by the ID the run made up, and until when. */
export interface Lease {
  runId: string;
  until: number;
}

interface LeaseRow {
  lease_run: string | null;
  lease_until: number | null;
}

function leaseOf(row: LeaseRow): Lease | null {
  return row.lease_run === null || row.lease_until === null ? null : { runId: row.lease_run, until: row.lease_until };
}

/**
 * Takes the claim's PR's lease for the run at `now`, or renews it when the
 * run holds it, for 30 minutes, in one statement, and records the check.
 * A lease another run holds is taken only once its time passed. A new
 * holder starts with no round. `taken` is false when another run holds it,
 * with that run's lease. Null when the claim has no open PR.
 */
export async function takeLease(
  db: D1Database,
  claimId: string,
  runId: string,
  now: number,
): Promise<{ taken: boolean; lease: Lease | null } | null> {
  const claim = mustParse(id, claimId, 'claimId');
  const run = mustParse(runIdSchema, runId, 'runId');
  const at = checkTime(now);
  const taken = await db
    .prepare(
      `UPDATE prs SET lease_run = ?2, lease_until = ?3 + ?4, checked_at = max(COALESCE(checked_at, ?3), ?3),
         lease_round = iif(lease_run IS ?2, lease_round, 0), lease_pushed = iif(lease_run IS ?2, lease_pushed, 0),
         lease_bot = iif(lease_run IS ?2, lease_bot, 0)
       WHERE claim_id = ?1 AND state = 'open' AND (lease_run IS NULL OR lease_run = ?2 OR lease_until <= ?3)
       RETURNING lease_run, lease_until`,
    )
    .bind(claim, run, at, LEASE_MS)
    .first<LeaseRow>();
  if (taken !== null) return { taken: true, lease: leaseOf(taken) };
  const held = await db
    .prepare(`SELECT lease_run, lease_until FROM prs WHERE claim_id = ? AND state = 'open'`)
    .bind(claim)
    .first<LeaseRow>();
  return held === null ? null : { taken: false, lease: leaseOf(held) };
}

/**
 * Gives back the claim's PR's lease when the run holds it, whether or not
 * its time passed. Gives the lease after: none once given back, or another
 * run's, which stays.
 */
export async function giveBackLease(db: D1Database, claimId: string, runId: string): Promise<{ given: boolean; lease: Lease | null }> {
  const claim = mustParse(id, claimId, 'claimId');
  const given = await db
    .prepare(
      `UPDATE prs SET lease_run = NULL, lease_until = NULL, lease_round = 0, lease_pushed = 0, lease_bot = 0
       WHERE claim_id = ?1 AND lease_run = ?2 RETURNING claim_id`,
    )
    .bind(claim, mustParse(runIdSchema, runId, 'runId'))
    .first<{ claim_id: string }>();
  if (given !== null) return { given: true, lease: null };
  const held = await db.prepare('SELECT lease_run, lease_until FROM prs WHERE claim_id = ?').bind(claim).first<LeaseRow>();
  return { given: false, lease: held === null ? null : leaseOf(held) };
}

/**
 * Renews the claim's PR's lease for 30 minutes from `now` when the run
 * holds it, as check_pr, post_update, and submit_work do for the run that
 * names it. With `check`, as from check_pr, it records the check too. A
 * lease whose time passed is renewed while no other run took it. Returns
 * whether it renewed.
 */
export async function renewLease(db: D1Database, claimId: string, runId: string, now: number, check: boolean): Promise<boolean> {
  const at = checkTime(now);
  const row = await db
    .prepare(
      `UPDATE prs SET lease_until = ?3 + ?4, checked_at = iif(?5, max(COALESCE(checked_at, ?3), ?3), checked_at)
       WHERE claim_id = ?1 AND state = 'open' AND lease_run = ?2 RETURNING claim_id`,
    )
    .bind(mustParse(id, claimId, 'claimId'), mustParse(runIdSchema, runId, 'runId'), at, LEASE_MS, check ? 1 : 0)
    .first<{ claim_id: string }>();
  return row !== null;
}

/**
 * Counts a round on the claim's open PR at `now`, for what the run did
 * while it holds a live lease on it: a submit that landed (`push`), or a
 * reply it recorded, which answered a review bot (`bot`) or not. A round
 * is what one run does on one PR, at most one push and one set of
 * replies. So the lease's first push or reply counts a round, and a push
 * after that round's push counts another. A reply after it is the same
 * round's. A round that answers a bot counts as a bot round once. A push
 * or reply from a run that holds no live lease on it, as another run's,
 * counts no round. One statement, so two at once count each once. Returns
 * whether it counted.
 */
export async function countRound(
  db: D1Database,
  claimId: string,
  runId: string,
  act: { push: boolean; bot: boolean },
  now: number,
): Promise<boolean> {
  const at = checkTime(now);
  // SQLite reads every SET from the row before the update.
  const fresh = '(lease_round = 0 OR (?2 AND lease_pushed = 1))';
  const row = await db
    .prepare(
      `UPDATE prs SET
         rounds = rounds + ${fresh},
         rounds_on_day = iif(${fresh}, iif(rounds_day IS ?5, rounds_on_day + 1, 1), rounds_on_day),
         rounds_day = iif(${fresh}, ?5, rounds_day),
         bot_rounds = bot_rounds + iif(?3 AND (${fresh} OR lease_bot = 0), 1, 0),
         lease_bot = iif(${fresh}, ?3, max(lease_bot, ?3)),
         lease_pushed = iif(${fresh}, ?2, max(lease_pushed, ?2)),
         lease_round = 1
       WHERE claim_id = ?1 AND state = 'open' AND lease_run = ?6 AND lease_until > ?4
       RETURNING rounds`,
    )
    .bind(mustParse(id, claimId, 'claimId'), act.push ? 1 : 0, act.bot ? 1 : 0, at, roundDay(at), mustParse(runIdSchema, runId, 'runId'))
    .first<{ rounds: number }>();
  return row !== null;
}

interface FactsRow {
  claim_id: string;
  opened_at: number;
  pushed_at: number | null;
  checked_at: number | null;
  lease_run: string | null;
  lease_until: number | null;
  rounds: number;
  rounds_day: number | null;
  rounds_on_day: number;
  bot_rounds: number;
  newest_read: number | null;
  reviewer_at: number | null;
  open: number;
  oldest_open: number | null;
  waiting_donor: number;
  asking: number;
  waiting_told_at: number | null;
  review_asked_at: number | null;
}

/** What followThroughOf reads of a PR, but its mode, which the donor's choices give. */
export type FollowFacts = Omit<PrFacts, 'mode'>;

/**
 * What follow-through reads of each of the person's PRs the prs table has
 * open, as listOpenPrsOf lists them, in its order, up to 50: when it
 * opened, the agent's last push, which is when its last submit landed,
 * when a run last checked it, its lease and rounds, when the PR job read
 * its newest follow-up, the last reviewer activity, which is when a
 * maintainer or a bot wrote its newest follow-up, and how many of its
 * follow-ups are open and wait for the donor, with when the oldest open
 * one was read. Those count only while its project asks for help, as for
 * the follow-ups start_session and my_work list.
 */
export async function listFollowFacts(db: D1Database, person: number): Promise<FollowFacts[]> {
  const { results } = await db
    .prepare(
      `SELECT p.claim_id, p.opened_at, s.submitted_at AS pushed_at, p.checked_at, p.lease_run, p.lease_until, p.rounds,
         p.rounds_day, p.rounds_on_day, p.bot_rounds, p.waiting_told_at, p.review_asked_at,
         (SELECT MAX(f.read_at) FROM follow_ups f WHERE f.claim_id = p.claim_id) AS newest_read,
         (SELECT MAX(f.written_at) FROM follow_ups f WHERE f.claim_id = p.claim_id AND f.author_kind IS NOT NULL) AS reviewer_at,
         (SELECT COUNT(*) FROM follow_ups f WHERE f.claim_id = p.claim_id AND f.state = 'open') AS open,
         (SELECT MIN(f.read_at) FROM follow_ups f WHERE f.claim_id = p.claim_id AND f.state = 'open') AS oldest_open,
         (SELECT COUNT(*) FROM follow_ups f WHERE f.claim_id = p.claim_id AND f.state = 'waiting_donor') AS waiting_donor,
         EXISTS (SELECT 1 FROM projects p WHERE p.repo = c.project AND ${ASKING_FOR_HELP}) AS asking
       FROM prs p JOIN claims c ON c.id = p.claim_id LEFT JOIN submissions s ON s.claim_id = p.claim_id
       WHERE c.github_id = ?1 AND p.state = 'open' AND ${SHOWN}
         AND NOT EXISTS (SELECT 1 FROM issue_syncs u WHERE u.project = c.project AND u.delisted IS NOT NULL)
       ORDER BY p.opened_at, p.claim_id LIMIT ?2`,
    )
    .bind(mustParse(githubId, person, 'githubId'), OPEN_PRS_LISTED)
    .all<FactsRow>();
  return results.map((row) => {
    const asking = row.asking === 1;
    return {
      claimId: mustParse(id, row.claim_id, 'claimId'),
      openedAt: row.opened_at,
      lastPushAt: row.pushed_at,
      newestFollowUpAt: row.newest_read,
      lastReviewerAt: row.reviewer_at,
      checkedAt: row.checked_at,
      open: asking ? row.open : 0,
      waitingDonor: asking ? row.waiting_donor : 0,
      oldestOpenAt: asking ? row.oldest_open : null,
      lease: leaseOf(row),
      rounds: { total: row.rounds, day: row.rounds_day, onDay: row.rounds_on_day, bots: row.bot_rounds },
      waitingToldAt: row.waiting_told_at,
      reviewAskedAt: row.review_asked_at,
    };
  });
}

/** What a run did once for a PR, as follow_pr notes it. */
export type FollowNote = 'told_waiting' | 'asked_review';

/**
 * Records at `now` what a run did once for the claim's open PR, so no
 * later run does it again: it told the donor the PR waited 14 days with no
 * reviewer activity, or it asked a maintainer to review it again.
 */
export async function noteFollowThrough(db: D1Database, claimId: string, noted: readonly FollowNote[], now: number): Promise<void> {
  if (noted.length === 0) return;
  await db
    .prepare(
      `UPDATE prs SET waiting_told_at = iif(?2, ?4, waiting_told_at), review_asked_at = iif(?3, ?4, review_asked_at)
       WHERE claim_id = ?1 AND state = 'open'`,
    )
    .bind(mustParse(id, claimId, 'claimId'), noted.includes('told_waiting') ? 1 : 0, noted.includes('asked_review') ? 1 : 0, checkTime(now))
    .run();
}
