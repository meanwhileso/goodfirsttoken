import { describe, expect, test } from 'vitest';
import { followThroughOf, nextCheck, validate, runIdSchema, type CheckFacts, type PrFacts, type RunContext } from '../src/index';

// When a donor's PR is due for a follow-through run, on a fake clock: the
// schedule of its next check, its round limits, its lease, and when it is
// stalled (docs/specs/follow-through.md, under Waking up, Limits, and Two
// agents at once).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The agent's last push, at noon UTC. */
const PUSH = Date.UTC(2026, 10, 8, 12, 0, 0);

const facts = (checkedAt: number | null, more: Partial<CheckFacts> = {}): CheckFacts => ({
  openedAt: PUSH - DAY,
  lastPushAt: PUSH,
  newestFollowUpAt: null,
  lastReviewerAt: null,
  checkedAt,
  ...more,
});

const pr = (more: Partial<PrFacts> = {}): PrFacts => ({
  ...facts(PUSH),
  claimId: 'c_1',
  mode: 'go_ahead',
  open: 0,
  waitingDonor: 0,
  oldestOpenAt: null,
  lease: null,
  rounds: { total: 0, day: null, onDay: 0, bots: 0 },
  waitingToldAt: null,
  reviewAskedAt: null,
  ...more,
});

const session: RunContext = { level: null, newForWake: new Set() };

describe('the next check', () => {
  test('comes every 15 minutes for 2 hours after the agent\'s last push', () => {
    expect(nextCheck(facts(PUSH))).toEqual({ at: PUSH + 15 * MINUTE, schedule: 'every_15_minutes' });
    expect(nextCheck(facts(PUSH + 20 * MINUTE))).toEqual({ at: PUSH + 30 * MINUTE, schedule: 'every_15_minutes' });
    expect(nextCheck(facts(PUSH + 119 * MINUTE))).toEqual({ at: PUSH + 2 * HOUR, schedule: 'every_15_minutes' });
  });

  test('then every hour until 24 hours have passed', () => {
    expect(nextCheck(facts(PUSH + 2 * HOUR))).toEqual({ at: PUSH + 3 * HOUR, schedule: 'hourly' });
    expect(nextCheck(facts(PUSH + 23 * HOUR + 30 * MINUTE))).toEqual({ at: PUSH + DAY, schedule: 'hourly' });
  });

  test('then every 4 hours until 7 days', () => {
    expect(nextCheck(facts(PUSH + DAY))).toEqual({ at: PUSH + DAY + 4 * HOUR, schedule: 'every_4_hours' });
    expect(nextCheck(facts(PUSH + 7 * DAY - MINUTE))).toEqual({ at: PUSH + 7 * DAY, schedule: 'every_4_hours' });
  });

  test('then once a day, until 30 days pass with no reviewer activity, and then on no schedule', () => {
    const reviewed = { lastReviewerAt: PUSH, newestFollowUpAt: PUSH };

    expect(nextCheck(facts(PUSH + 7 * DAY, reviewed))).toEqual({ at: PUSH + 8 * DAY, schedule: 'daily' });
    expect(nextCheck(facts(PUSH + 29 * DAY + HOUR, reviewed))).toEqual({ at: PUSH + 30 * DAY, schedule: 'daily' });
    expect(nextCheck(facts(PUSH + 30 * DAY, reviewed))).toEqual({ at: null, schedule: 'stopped' });
  });

  test('a PR no reviewer wrote on is checked for 30 days after it opened', () => {
    expect(nextCheck(facts(PUSH + 28 * DAY)).at).toBe(PUSH + 29 * DAY);
    expect(nextCheck(facts(PUSH + 29 * DAY))).toEqual({ at: null, schedule: 'stopped' });
  });

  test("a reviewer's activity keeps the checks going for 30 days after it", () => {
    const reviewed = { lastReviewerAt: PUSH + 10 * DAY, newestFollowUpAt: PUSH + 10 * DAY };

    expect(nextCheck(facts(PUSH + 39 * DAY, reviewed))).toEqual({ at: PUSH + 40 * DAY, schedule: 'daily' });
    expect(nextCheck(facts(PUSH + 40 * DAY, reviewed))).toEqual({ at: null, schedule: 'stopped' });
  });

  test("a push, or checks or a conflict GitHub shows, starts the 15-minute checks again but doesn't put off the stop 30 days after the last reviewer activity", () => {
    const opened = PUSH - DAY;
    const conflict = opened + 25 * DAY;
    const quiet = { lastReviewerAt: null, newestFollowUpAt: conflict, lastPushAt: conflict + HOUR };

    expect(nextCheck(facts(conflict + HOUR, quiet))).toEqual({ at: conflict + HOUR + 15 * MINUTE, schedule: 'every_15_minutes' });
    // Its checks every 4 hours fall at 3 hours before the stop, then after it.
    expect(nextCheck(facts(opened + 30 * DAY - 6 * HOUR, quiet))).toEqual({ at: opened + 30 * DAY - 3 * HOUR, schedule: 'every_4_hours' });
    expect(nextCheck(facts(opened + 30 * DAY - 3 * HOUR, quiet))).toEqual({ at: null, schedule: 'stopped' });
  });

  test('a new follow-up starts the 15-minute checks again, and so does a push', () => {
    const later = PUSH + 3 * DAY;

    expect(nextCheck(facts(PUSH + 3 * DAY - HOUR, { newestFollowUpAt: later }))).toEqual({ at: later + 15 * MINUTE, schedule: 'every_15_minutes' });
    expect(nextCheck(facts(later + 5 * MINUTE, { newestFollowUpAt: later }))).toEqual({ at: later + 15 * MINUTE, schedule: 'every_15_minutes' });
    expect(nextCheck(facts(PUSH + 3 * DAY - HOUR, { lastPushAt: later }))).toEqual({ at: later + 15 * MINUTE, schedule: 'every_15_minutes' });
  });

  test('a PR no run checked yet counts from when it opened or the last push, and one no run checked for days is due at its first missed check', () => {
    expect(nextCheck(facts(null, { lastPushAt: null, openedAt: PUSH }))).toEqual({ at: PUSH + 15 * MINUTE, schedule: 'every_15_minutes' });
    expect(nextCheck(facts(PUSH + 10 * MINUTE)).at).toBe(PUSH + 15 * MINUTE);
    expect(followThroughOf([pr({ checkedAt: PUSH + 10 * MINUTE })], session, PUSH + 3 * DAY).prs[0]).toMatchObject({
      due: true,
      nextCheckAt: PUSH + 15 * MINUTE,
    });
  });
});

describe('a PR is due', () => {
  test('when it has an open follow-up, before its next check comes', () => {
    const ft = followThroughOf([pr({ open: 1, oldestOpenAt: PUSH + MINUTE })], session, PUSH + 2 * MINUTE);

    expect(ft.dueNow).toBe(true);
    expect(ft.prs[0]).toMatchObject({ claimId: 'c_1', due: true, state: 'agent_on_it', nextCheckAt: PUSH + 15 * MINUTE });
  });

  test('when its next check comes, and not before', () => {
    expect(followThroughOf([pr()], session, PUSH + 15 * MINUTE - 1)).toMatchObject({ dueNow: false, nextCheckAt: PUSH + 15 * MINUTE });
    expect(followThroughOf([pr()], session, PUSH + 15 * MINUTE)).toMatchObject({
      dueNow: true,
      prs: [{ due: true, state: 'waiting_reviewer' }],
    });
  });

  test('never while its follow-ups all wait for the donor, or once the donor stopped following it', () => {
    const waits = followThroughOf([pr({ waitingDonor: 2 })], session, PUSH + DAY);
    const off = followThroughOf([pr({ mode: 'off', open: 1, oldestOpenAt: PUSH })], session, PUSH + DAY);

    expect(waits).toMatchObject({ dueNow: false, nextCheckAt: null, prs: [{ due: false, state: 'waiting_donor', nextCheckAt: null }] });
    expect(off).toMatchObject({ dueNow: false, nextCheckAt: null, prs: [{ due: false, state: 'off', nextCheckAt: null }] });
  });

  test('an open follow-up makes it due even when others wait for the donor', () => {
    expect(followThroughOf([pr({ waitingDonor: 1, open: 1, oldestOpenAt: PUSH })], session, PUSH + MINUTE).dueNow).toBe(true);
  });

  test('the earliest check to come across the donor\'s PRs is nextCheckAt, leaving out one that is due now', () => {
    const soon = pr({ claimId: 'c_2', checkedAt: PUSH + 20 * MINUTE });
    const later = pr({ claimId: 'c_3', lastPushAt: PUSH - 3 * HOUR, checkedAt: PUSH });
    const due = pr({ claimId: 'c_4', checkedAt: PUSH - HOUR });

    expect(followThroughOf([later, soon, due], session, PUSH + 21 * MINUTE)).toMatchObject({ dueNow: true, nextCheckAt: PUSH + 30 * MINUTE });
  });
});

describe('the round limits', () => {
  const NOW = PUSH + 3 * HOUR;
  const TODAY = Math.floor(NOW / DAY);

  test('3 rounds in a UTC day hold the PR for the donor until the next day, and the answer says so', () => {
    const ft = followThroughOf([pr({ open: 1, oldestOpenAt: NOW, rounds: { total: 3, day: TODAY, onDay: 3, bots: 0 } })], session, NOW);

    expect(ft.dueNow).toBe(false);
    expect(ft.prs[0]).toMatchObject({
      due: false,
      state: 'waiting_donor',
      roundLimit: 'day',
      rounds: { today: 3, total: 3, bots: 0 },
      nextCheckAt: (TODAY + 1) * DAY,
    });
  });

  test("rounds on an earlier day don't count toward today's", () => {
    const ft = followThroughOf([pr({ open: 1, oldestOpenAt: NOW, rounds: { total: 3, day: TODAY - 1, onDay: 3, bots: 0 } })], session, NOW);

    expect(ft.prs[0]).toMatchObject({ due: true, roundLimit: null, rounds: { today: 0, total: 3 } });
  });

  test('10 rounds in all hold the PR for the donor, with no next check', () => {
    const ft = followThroughOf([pr({ open: 1, oldestOpenAt: NOW, rounds: { total: 10, day: TODAY - 2, onDay: 1, bots: 0 } })], session, NOW);

    expect(ft).toMatchObject({ dueNow: false, prs: [{ due: false, state: 'waiting_donor', roundLimit: 'total', nextCheckAt: null }] });
  });

  test('past 3 rounds that answered bots, the PR is still due, and the answer says its bot follow-ups settle no_change', () => {
    const at = (bots: number) =>
      followThroughOf([pr({ open: 1, oldestOpenAt: NOW, rounds: { total: 4, day: TODAY, onDay: 1, bots } })], session, NOW).prs[0];

    expect(at(2)).toMatchObject({ due: true, botLimit: false });
    expect(at(3)).toMatchObject({ due: true, botLimit: true });
  });
});

describe('a lease', () => {
  const NOW = PUSH + 3 * HOUR;
  const open = { open: 1, oldestOpenAt: NOW - MINUTE };

  test("another run's lease holds the PR: it isn't due, the agent is on it, and the lease shows when it ends", () => {
    const lease = { runId: 'run-a', until: NOW + 10 * MINUTE };
    const ft = followThroughOf([pr({ ...open, lease })], { ...session, runId: 'run-b' }, NOW);

    expect(ft).toMatchObject({ dueNow: false, prs: [{ due: false, state: 'agent_on_it', lease }] });
  });

  test("the run's own lease leaves the PR due for it", () => {
    const lease = { runId: 'run-a', until: NOW + 10 * MINUTE };

    expect(followThroughOf([pr({ ...open, lease })], { ...session, runId: 'run-a' }, NOW).dueNow).toBe(true);
  });

  test('a lease that ended holds nothing and shows as none', () => {
    const ft = followThroughOf([pr({ ...open, lease: { runId: 'run-a', until: NOW } })], { ...session, runId: 'run-b' }, NOW);

    expect(ft.prs[0]).toMatchObject({ due: true, lease: null });
  });

  test("a run's ID is a short ID it makes up, of letters, digits, hyphens, and underscores", () => {
    expect(validate(runIdSchema, 'run-2026-11-08T12-00_a1').ok).toBe(true);
    expect(validate(runIdSchema, 'has space').ok).toBe(false);
    expect(validate(runIdSchema, 'x'.repeat(65)).ok).toBe(false);
  });
});

describe('a run that only reports', () => {
  const NOW = PUSH + 15 * MINUTE;
  const goAhead = pr({ claimId: 'c_1', open: 1, oldestOpenAt: NOW });
  const askFirst = pr({ claimId: 'c_2', mode: 'ask_first', open: 1, oldestOpenAt: NOW });

  test('a notify wake is due only for follow-ups it was not given, whatever the schedule', () => {
    const none = followThroughOf([goAhead, askFirst], { level: 'notify', newForWake: new Set() }, NOW);
    const one = followThroughOf([goAhead, askFirst], { level: 'notify', newForWake: new Set(['c_2']) }, NOW);

    expect(none).toMatchObject({ dueNow: false, nextCheckAt: null, prs: [{ due: false, reportOnly: true }, { due: false, reportOnly: true }] });
    expect(one).toMatchObject({ dueNow: true, prs: [{ due: false }, { claimId: 'c_2', due: true }] });
  });

  test('a full wake reports on an ask_first PR the same way, and follows a go_ahead PR in full', () => {
    const ft = followThroughOf([goAhead, askFirst], { level: 'full', newForWake: new Set() }, NOW);

    expect(ft).toMatchObject({ dueNow: true, prs: [{ due: true, reportOnly: false }, { due: false, reportOnly: true }] });
  });

  test("a session wake's run, a loop in a session, reports on an ask_first PR as a full wake's does", () => {
    expect(followThroughOf([askFirst], { level: 'session', newForWake: new Set() }, NOW).prs[0]).toMatchObject({
      due: false,
      reportOnly: true,
    });
  });

  test('in a session the donor is in, an ask_first PR is followed in full', () => {
    expect(followThroughOf([askFirst], session, NOW).prs[0]).toMatchObject({ due: true, reportOnly: false });
  });
});

describe('a stalled PR', () => {
  test('has an open follow-up no run sorted for 24 hours, and lists first', () => {
    const NOW = PUSH + 2 * DAY;
    const fresh = pr({ claimId: 'c_1', open: 1, oldestOpenAt: NOW - 23 * HOUR });
    const stalled = pr({ claimId: 'c_2', open: 2, oldestOpenAt: NOW - DAY });

    const ft = followThroughOf([fresh, stalled], session, NOW);

    expect(ft.prs.map((one) => [one.claimId, one.state, one.stalledSince])).toEqual([
      ['c_2', 'stalled', NOW],
      ['c_1', 'agent_on_it', null],
    ]);
  });

  test("isn't stalled while a run holds its lease", () => {
    const NOW = PUSH + 2 * DAY;
    const held = pr({ open: 1, oldestOpenAt: NOW - 2 * DAY, lease: { runId: 'run-a', until: NOW + MINUTE } });

    expect(followThroughOf([held], session, NOW).prs[0]).toMatchObject({ state: 'agent_on_it', stalledSince: null });
  });
});

describe('a PR that waits for its reviewers', () => {
  const at = (more: Partial<PrFacts>, now: number) => followThroughOf([pr(more)], session, now).prs[0]?.tellDonorWaiting;

  test("says to tell the donor once it waited 14 days after the agent's last push with no reviewer activity, until a run told them", () => {
    expect(at({}, PUSH + 14 * DAY - 1)).toBe(false);
    expect(at({}, PUSH + 14 * DAY)).toBe(true);
    expect(at({ waitingToldAt: PUSH + 14 * DAY }, PUSH + 15 * DAY)).toBe(false);
  });

  test('says nothing after reviewer activity since the push, and again after a new push since the donor was told', () => {
    expect(at({ lastReviewerAt: PUSH + HOUR }, PUSH + 20 * DAY)).toBe(false);
    expect(at({ lastReviewerAt: PUSH - HOUR }, PUSH + 20 * DAY)).toBe(true);
    expect(at({ waitingToldAt: PUSH - DAY }, PUSH + 14 * DAY)).toBe(true);
    expect(at({ mode: 'off' }, PUSH + 20 * DAY)).toBe(false);
  });
});
