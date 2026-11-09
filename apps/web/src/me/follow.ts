import {
  followThroughOf,
  MAX_FOLLOW_UPS,
  type CheckSchedule,
  type FollowMode,
  type FollowUpRecord,
  type PrFollowMode,
  type PrFollowState,
  type PrRef,
  type WakeRecord,
} from '@goodfirsttoken/core';
import {
  getFollowMode,
  getSubmissions,
  listFollowFacts,
  listOpenPrsOf,
  listPrFollowModes,
  listPrFollowUps,
  listStoppedWakes,
  listWakes,
} from '../db';

// Follow-through on /me (docs/specs/follow-through.md, under Status): each
// of the donor's open PRs with where it stands, the follow-ups that wait
// for them and the latest of the rest, and when it is checked next, the
// donor's mode, and their wakes. It reads what start_session and my_work
// read, through listOpenPrsOf, listFollowFacts, and packages/core's
// followThroughOf, for a session the donor is in.

/** The most follow-ups /me shows of a PR besides those that wait for the donor. */
export const LATEST_FOLLOW_UPS = 3;

/** One of the donor's open PRs, as /me shows it. */
export interface FollowedPr {
  claimId: string;
  issue: string;
  pr: PrRef;
  /** How it is followed: its own mode, or else the donor's. */
  followMode: PrFollowMode;
  /** True when the donor set a mode for this PR alone. */
  ownMode: boolean;
  state: PrFollowState;
  /** True while a run holds its lease, so an agent works on it now. */
  leased: boolean;
  /** True when a run of the donor's agent has work on it now. */
  due: boolean;
  /**
   * The summary of the agent's latest submit to the claim, and when it
   * landed: the last round that pushed, or the work the PR opened with.
   * Null with none. Good First Token keeps no other summary of a round.
   */
  lastSubmit: { summary: string; at: number } | null;
  /** When it became stalled, or null when it isn't. */
  stalledSince: number | null;
  /** The round limit it reached, which holds it for the donor, or null. */
  roundLimit: 'day' | 'total' | null;
  /** Its open follow-ups, which no run sorted. */
  open: number;
  /** Its follow-ups that wait for the donor. */
  waitingDonor: number;
  /** When its next check comes, or null when it is checked on no schedule now. */
  nextCheckAt: number | null;
  schedule: CheckSchedule;
  /** The follow-ups that wait for the donor, with the agent's question, oldest first. */
  questions: FollowUpRecord[];
  /** The newest of its other follow-ups, with where each stands. */
  latest: FollowUpRecord[];
}

/** A wake of the donor's, and whether it stopped. */
export interface WakeShown extends WakeRecord {
  /** No run for 24 hours past its interval while a PR of the donor's is open, as listStoppedWakes finds. */
  stopped: boolean;
}

export interface FollowThroughShown {
  /** The donor's mode for all their PRs, and whether they chose it. */
  mode: { mode: FollowMode; chosen: boolean };
  /** The donor's open PRs: the stalled ones first, then those with a question for the donor, then the rest, each oldest first. */
  prs: FollowedPr[];
  /** The donor's wakes, oldest first. */
  wakes: WakeShown[];
}

/** Where a PR goes on the page: stalled first, then one with a question for the donor, since a question stays first until they answer. */
function placeOf(pr: FollowedPr): number {
  if (pr.state === 'stalled') return 0;
  return pr.questions.length > 0 ? 1 : 2;
}

/**
 * What /me shows of the donor's follow-through at `now`. Each PR's state
 * is the one followThroughOf gives a session the donor is in, so it is the
 * same as start_session's.
 */
export async function readFollowThrough(db: D1Database, person: number, now: number): Promise<FollowThroughShown> {
  const [choice, own, open, facts, wakes, stopped] = await Promise.all([
    getFollowMode(db, person),
    listPrFollowModes(db, person),
    listOpenPrsOf(db, person),
    listFollowFacts(db, person),
    listWakes(db, person),
    listStoppedWakes(db, person, now),
  ]);
  const modeOf = (claimId: string) => own.get(claimId) ?? choice.mode;
  const factsOf = new Map(facts.map((pr) => [pr.claimId, pr]));
  const followed = open.flatMap((pr) => {
    const found = factsOf.get(pr.claimId);
    return found === undefined ? [] : [{ pr, facts: found }];
  });
  const byClaim = new Map(followed.map((one) => [one.pr.claimId, one]));
  const claimIds = followed.map((one) => one.pr.claimId);
  const [followUps, submissions] = await Promise.all([
    listPrFollowUps(db, claimIds, { waiting: MAX_FOLLOW_UPS, latest: LATEST_FOLLOW_UPS }),
    getSubmissions(db, claimIds),
  ]);
  const ft = followThroughOf(
    followed.map((one) => ({ ...one.facts, mode: modeOf(one.pr.claimId) })),
    { level: null, newForWake: new Set() },
    now,
  );
  const stoppedIds = new Set(stopped.map((wake) => wake.id));
  const prs = ft.prs.flatMap((pr): FollowedPr[] => {
      const one = byClaim.get(pr.claimId);
      if (one === undefined) return [];
      const shown = followUps.get(pr.claimId);
      const submitted = submissions.get(pr.claimId);
      return [
        {
          claimId: pr.claimId,
          issue: one.pr.issue,
          pr: one.pr.pr,
          followMode: modeOf(pr.claimId),
          ownMode: own.has(pr.claimId),
          state: pr.state,
          leased: pr.lease !== null,
          due: pr.due,
          lastSubmit: submitted === undefined ? null : { summary: submitted.summary, at: submitted.submittedAt },
          stalledSince: pr.stalledSince,
          roundLimit: pr.roundLimit,
          open: one.facts.open,
          waitingDonor: one.facts.waitingDonor,
          nextCheckAt: pr.nextCheckAt,
          schedule: pr.schedule,
          questions: shown?.waiting ?? [],
          latest: shown?.latest ?? [],
        },
      ];
    });
  return {
    mode: choice,
    // A stable sort, so each place keeps followThroughOf's order.
    prs: prs.map((pr, i) => ({ pr, i })).sort((a, b) => placeOf(a.pr) - placeOf(b.pr) || a.i - b.i).map(({ pr }) => pr),
    wakes: wakes.map((wake) => ({ ...wake, stopped: stoppedIds.has(wake.id) })),
  };
}
