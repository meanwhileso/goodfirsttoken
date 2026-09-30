import { z } from 'zod';
import { untrustedLine } from './characters';
import {
  agentName,
  commitSha,
  count,
  epochMs,
  githubId,
  githubLogin,
  id,
  issueRef,
  prRefSchema,
  repoName,
  trimmedText,
} from './primitives';
import type { Refusal } from './refusals';
import { describeProblems, validate, type FieldProblem } from './validation';

// One claim's life (spec section 6), as a pure state machine. Time is always
// passed in as whole milliseconds since the epoch, so the same inputs give
// the same answer, and a Durable Object alarm can run it with its own clock.
//
// This covers what one claim can decide from its own facts. Rules that need
// the whole issue, like the claim cap or a PR already open on the issue, and
// rules about who is asking, like "only the claim's owner posts", belong to
// the issue room that holds every claim on the issue.
//
// The machine has no fact about whether a claim's PR is still open. It lets
// a `pr_opened` claim take updates and review fixes, and `pr_opened` stays
// the claim's state once its PR merges or closes, since that is a fact about
// the PR. The issue room, which the PR job tells, refuses those with
// `pr_closed` from then on.

export const claimStates = [
  'active',
  'paused',
  'awaiting_review',
  'pr_opened',
  'released',
  'expired',
] as const;
export const claimStateSchema = z.enum(claimStates);
export type ClaimState = z.infer<typeof claimStateSchema>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** An active claim with no update for this long is paused. */
export const PAUSE_AFTER_MS = 30 * MINUTE;
/** A claim not submitted this long after it was made expires. */
export const CLAIM_LIFETIME_MS = 24 * HOUR;
/** Work awaiting review this long after its first submit expires. */
export const REVIEW_WINDOW_MS = 7 * DAY;

/** The longest public reason for giving up a claim. */
export const MAX_RELEASE_REASON = 200;
/** Why the claimant gave up. It reaches the public feeds, so it folds the way a posted line does. */
export const releaseReason = untrustedLine(MAX_RELEASE_REASON);

// The facts about one claim that its state depends on.
const timelineShape = {
  state: claimStateSchema,
  /** When the claim was made. */
  claimedAt: epochMs,
  /** When the claim last had an update. A new claim counts as its first. */
  lastUpdateAt: epochMs,
  /** When the work was first submitted, or null before that. */
  submittedAt: epochMs.nullable(),
  /**
   * The public reason, for a released claim. Null in every other state. A
   * release folds it by releaseReason, and a claim stored before reasons
   * were folded keeps its reason as it was given, so it is checked the way
   * it was then.
   */
  releaseReason: trimmedText(MAX_RELEASE_REASON).nullable(),
  /** The PR, once one is open for the claim. Null before that. */
  pr: prRefSchema.nullable(),
};

type Timeline = z.output<z.ZodObject<typeof timelineShape>>;

// What must hold between a claim's state and its other facts, so a stored
// claim that breaks one is rejected with the field named.
function checkTimeline(claim: Timeline, ctx: z.RefinementCtx): void {
  const problem = (field: keyof Timeline, message: string) => {
    ctx.addIssue({ code: 'custom', path: [field], message });
  };
  if (claim.lastUpdateAt < claim.claimedAt) problem('lastUpdateAt', 'must not be before claimedAt');

  const submitted = claim.state === 'awaiting_review' || claim.state === 'pr_opened';
  const working = claim.state === 'active' || claim.state === 'paused';
  if (claim.submittedAt === null) {
    if (submitted) problem('submittedAt', `is required for a claim that is ${claim.state}`);
  } else if (working) {
    problem('submittedAt', `must be null for a claim that is ${claim.state}`);
  } else if (claim.submittedAt < claim.claimedAt) {
    problem('submittedAt', 'must not be before claimedAt');
  }

  if (claim.state === 'released' && claim.releaseReason === null) {
    problem('releaseReason', 'is required for a released claim');
  }
  if (claim.state !== 'released' && claim.releaseReason !== null) {
    problem('releaseReason', 'must be null unless the claim is released');
  }
  if (claim.state === 'pr_opened' && claim.pr === null) {
    problem('pr', 'is required for a claim with an open PR');
  }
  if (claim.state !== 'pr_opened' && claim.pr !== null) {
    problem('pr', 'must be null unless the claim has an open PR');
  }
}

/** The facts `nextClaimState` works on. */
export const claimTimelineSchema = z.object(timelineShape).superRefine(checkTimeline);
export type ClaimTimeline = z.infer<typeof claimTimelineSchema>;

/**
 * A stored claim: who holds which issue, the commit the work starts from, and
 * the timeline. `submit_work` sends files relative to `startCommit`, so the
 * submit itself doesn't repeat it.
 */
export const claimRecordSchema = z
  .object({
    id,
    issue: issueRef,
    /** The project's code repo. It differs from the issue's repo when the project keeps issues elsewhere. */
    project: repoName,
    /** The claimant's numeric GitHub ID, which stays the same when their login changes. */
    githubId,
    /** The claimant's login when they claimed. */
    login: githubLogin,
    agent: agentName,
    /** The claimant was an admin or maintainer of the project when they claimed. */
    ownProject: z.boolean(),
    startCommit: commitSha,
    /** The tokens the work took, as the harness estimated them, or null when it gave no estimate. */
    tokenEstimate: count.nullable(),
    ...timelineShape,
  })
  .superRefine(checkTimeline);
export type ClaimRecord = z.infer<typeof claimRecordSchema>;

/**
 * What can happen to a claim.
 *
 * - `tick`: time passed, as when a timer fires. Never refused.
 * - `update`: the claimant posted an update, which is also a check-in.
 * - `submit`: the work was committed with `submit_work`.
 * - `open_pr`: a PR was opened for the submitted work.
 * - `release`: the claimant gave up, with a public reason.
 */
export const claimEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tick') }),
  z.object({ kind: z.literal('update') }),
  z.object({ kind: z.literal('submit') }),
  z.object({ kind: z.literal('open_pr'), pr: prRefSchema }),
  z.object({ kind: z.literal('release'), reason: releaseReason }),
]);
export type ClaimEvent = z.infer<typeof claimEventSchema>;
export const claimEventKinds = ['tick', 'update', 'submit', 'open_pr', 'release'] as const;

export type ClaimTransition<T extends ClaimTimeline> =
  | { ok: true; claim: T }
  | { ok: false; claim: T; refusal: Refusal };

/** A new claim, made at `now`. */
export function newClaim(now: number): ClaimTimeline {
  return assertValid({
    state: 'active',
    claimedAt: now,
    lastUpdateAt: now,
    submittedAt: null,
    releaseReason: null,
    pr: null,
  });
}

/**
 * When the claim's state changes next if nothing happens: the time it pauses,
 * the time it expires, or null for a claim that no longer changes with time.
 * A timer set for the earlier of the two keeps a stored claim current.
 * Throws on a malformed claim, which has no deadline to give.
 */
export function claimDeadlines(claim: ClaimTimeline): {
  pausesAt: number | null;
  expiresAt: number | null;
} {
  return deadlines(assertValid(claim));
}

/**
 * Whether the claim holds one of the issue's slots at `now`. A claim past a
 * deadline frees its slot even when no timer has run yet. Throws on a
 * malformed claim or time, so a bad row never counts as a slot quietly.
 */
export function holdsSlot(claim: ClaimTimeline, now: number): boolean {
  assertValid(claim);
  assertTime(now);
  const { state } = advance(claim, now);
  return state === 'active' || state === 'paused' || state === 'awaiting_review';
}

/**
 * The claim after `event` at `now`, or the reason it can't happen.
 *
 * Time is applied first: a claim past its deadline is expired before the
 * event is looked at, so a late update is refused. Either way the result
 * carries the claim as of `now`, which is the one to store. A malformed
 * claim, event, or time is refused as `invalid_input`, and the claim comes
 * back as it was.
 */
export function nextClaimState<T extends ClaimTimeline>(
  claim: T,
  event: ClaimEvent,
  now: number,
): ClaimTransition<T> {
  const problems = [
    ...problemsIn(claimTimelineSchema, claim, 'claim'),
    ...problemsIn(claimEventSchema, event, 'event'),
    ...problemsIn(epochMs, now, 'now'),
  ];
  if (problems.length === 0 && now < claim.claimedAt) {
    problems.push({ field: 'now', message: 'must not be before claim.claimedAt' });
  }
  if (problems.length > 0) {
    return {
      ok: false,
      claim,
      refusal: { code: 'invalid_input', message: `Nothing changed.\n${describeProblems(problems)}` },
    };
  }

  const current = advance(claim, now);
  const state: ClaimState = current.state;
  const ok = (next: T): ClaimTransition<T> => ({ ok: true, claim: next });
  const refuse = (refusal: Refusal): ClaimTransition<T> => ({ ok: false, claim: current, refusal });

  if (event.kind === 'tick') return ok(current);

  // An ended claim takes no more events.
  if (state === 'released') {
    return refuse({
      code: 'claim_released',
      message: 'This claim was released. Claim the issue again to keep working on it.',
    });
  }
  if (state === 'expired') {
    return refuse({
      code: 'claim_expired',
      message:
        current.submittedAt === null
          ? 'This claim expired 24 hours after it was made, with no submit. Claim the issue again to keep working on it.'
          : 'This claim expired 7 days after its work was submitted, with no PR opened.',
    });
  }

  const working = state === 'active' || state === 'paused';
  switch (event.kind) {
    case 'update':
      // An update is a check-in, so it wakes a paused claim. A clock that
      // runs behind never moves the last update back.
      return ok({
        ...current,
        state: working ? 'active' : state,
        lastUpdateAt: Math.max(current.lastUpdateAt, now),
      });
    case 'submit':
      // Submitting again, while awaiting review or after the PR opened, adds
      // new work to the same branch. The 7 days still count from the first
      // submit, so submitting again never extends a slot.
      if (working) return ok({ ...current, state: 'awaiting_review', submittedAt: now });
      return ok(current);
    case 'open_pr':
      if (state === 'awaiting_review') return ok({ ...current, state: 'pr_opened', pr: event.pr });
      if (state === 'pr_opened') {
        return refuse({ code: 'pr_already_opened', message: 'A PR is already open for this claim.' });
      }
      return refuse({
        code: 'not_submitted',
        message: 'Submit the work with submit_work before opening a PR.',
      });
    case 'release':
      if (state === 'pr_opened') {
        return refuse({
          code: 'pr_already_opened',
          message:
            'A PR is already open for this claim, so it holds no slot to release. Close the PR on GitHub to withdraw the work.',
        });
      }
      return ok({ ...current, state: 'released', releaseReason: event.reason.trim() });
  }
}

function deadlines(claim: ClaimTimeline): { pausesAt: number | null; expiresAt: number | null } {
  switch (claim.state) {
    case 'active':
      return {
        pausesAt: claim.lastUpdateAt + PAUSE_AFTER_MS,
        expiresAt: claim.claimedAt + CLAIM_LIFETIME_MS,
      };
    case 'paused':
      return { pausesAt: null, expiresAt: claim.claimedAt + CLAIM_LIFETIME_MS };
    case 'awaiting_review':
      // The timeline schema requires a submit time here. The fallback only
      // keeps the types whole, and can only free the slot sooner.
      return { pausesAt: null, expiresAt: (claim.submittedAt ?? claim.claimedAt) + REVIEW_WINDOW_MS };
    case 'pr_opened':
    case 'released':
    case 'expired':
      return { pausesAt: null, expiresAt: null };
  }
}

/** The claim with every deadline up to `now` applied. */
function advance<T extends ClaimTimeline>(claim: T, now: number): T {
  const { pausesAt, expiresAt } = deadlines(claim);
  if (expiresAt !== null && now >= expiresAt) return { ...claim, state: 'expired' };
  if (pausesAt !== null && now >= pausesAt) return { ...claim, state: 'paused' };
  return claim;
}

/** The problems with `value`, with fields named from `name`, like `claim.lastUpdateAt`. */
function problemsIn(schema: z.ZodType, value: unknown, name: string): FieldProblem[] {
  const result = validate(schema, value, name);
  if (result.ok) return [];
  return result.problems.map((p) => (p.field === name ? p : { ...p, field: `${name}.${p.field}` }));
}

function assertValid<T extends ClaimTimeline>(claim: T): T {
  const problems = problemsIn(claimTimelineSchema, claim, 'claim');
  if (problems.length > 0) throw new TypeError(`Malformed claim.\n${describeProblems(problems)}`);
  return claim;
}

function assertTime(now: number): void {
  const problems = problemsIn(epochMs, now, 'now');
  if (problems.length > 0) throw new TypeError(`Malformed time.\n${describeProblems(problems)}`);
}
