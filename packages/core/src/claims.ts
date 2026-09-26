import { z } from 'zod';
import type { Refusal } from './refusals';

// One claim's life (spec section 6), as a pure state machine. Time is always
// passed in as milliseconds since the epoch, so the same inputs give the same
// answer, and a Durable Object alarm can run it with its own clock.
//
// This covers what one claim can decide from its own facts. Rules that need
// the whole issue, like the claim cap or a PR already open on the issue, and
// rules about who is asking, like "only the claim's owner posts", belong to
// the issue room that holds every claim on the issue.

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

/** The facts about one claim that its state depends on. */
export interface ClaimTimeline {
  state: ClaimState;
  /** When the claim was made. */
  claimedAt: number;
  /** When the claim last had an update. A new claim counts as its first. */
  lastUpdateAt: number;
  /** When the work was first submitted, or null before that. */
  submittedAt: number | null;
}

/**
 * What can happen to a claim.
 *
 * - `tick`: time passed, as when a timer fires. Never refused.
 * - `update`: the claimant posted an update, which is also a check-in.
 * - `submit`: the work was committed with `submit_work`.
 * - `open_pr`: a PR was opened for the submitted work.
 * - `release`: the claimant gave up.
 */
export const claimEvents = ['tick', 'update', 'submit', 'open_pr', 'release'] as const;
export type ClaimEvent = (typeof claimEvents)[number];

export type ClaimTransition<T extends ClaimTimeline> =
  | { ok: true; claim: T }
  | { ok: false; claim: T; refusal: Refusal };

/** A new claim, made at `now`. */
export function newClaim(now: number): ClaimTimeline {
  return { state: 'active', claimedAt: now, lastUpdateAt: now, submittedAt: null };
}

/**
 * When the claim's state changes next if nothing happens: the time it pauses,
 * the time it expires, or null for a claim that no longer changes with time.
 * A timer set for the earlier of the two keeps a stored claim current.
 */
export function claimDeadlines(claim: ClaimTimeline): {
  pausesAt: number | null;
  expiresAt: number | null;
} {
  switch (claim.state) {
    case 'active':
      return {
        pausesAt: claim.lastUpdateAt + PAUSE_AFTER_MS,
        expiresAt: claim.claimedAt + CLAIM_LIFETIME_MS,
      };
    case 'paused':
      return { pausesAt: null, expiresAt: claim.claimedAt + CLAIM_LIFETIME_MS };
    case 'awaiting_review':
      // A stored claim awaiting review always has a submit time. Falling back
      // to the claim time can only free the slot sooner.
      return { pausesAt: null, expiresAt: (claim.submittedAt ?? claim.claimedAt) + REVIEW_WINDOW_MS };
    case 'pr_opened':
    case 'released':
    case 'expired':
      return { pausesAt: null, expiresAt: null };
  }
}

/**
 * Whether the claim holds one of the issue's slots at `now`. A claim past a
 * deadline frees its slot even when no timer has run yet.
 */
export function holdsSlot(claim: ClaimTimeline, now: number): boolean {
  const { state } = advance(claim, now);
  return state === 'active' || state === 'paused' || state === 'awaiting_review';
}

/**
 * The claim after `event` at `now`, or the reason it can't happen.
 *
 * Time is applied first: a claim past its deadline is expired before the
 * event is looked at, so a late update is refused. Either way the result
 * carries the claim as of `now`, which is the one to store.
 */
export function nextClaimState<T extends ClaimTimeline>(
  claim: T,
  event: ClaimEvent,
  now: number,
): ClaimTransition<T> {
  const current = advance(claim, now);
  const state: ClaimState = current.state;
  const ok = (next: T): ClaimTransition<T> => ({ ok: true, claim: next });
  const refuse = (refusal: Refusal): ClaimTransition<T> => ({ ok: false, claim: current, refusal });

  if (event === 'tick') return ok(current);

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
  switch (event) {
    case 'update':
      // An update is a check-in, so it wakes a paused claim.
      return ok({ ...current, state: working ? 'active' : state, lastUpdateAt: now });
    case 'submit':
      // Submitting again, while awaiting review or after the PR opened, adds
      // new work to the same branch. The 7 days still count from the first
      // submit, so submitting again never extends a slot.
      if (working) return ok({ ...current, state: 'awaiting_review', submittedAt: now });
      return ok(current);
    case 'open_pr':
      if (state === 'awaiting_review') return ok({ ...current, state: 'pr_opened' });
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
      return ok({ ...current, state: 'released' });
  }
}

/** The claim with every deadline up to `now` applied. */
function advance<T extends ClaimTimeline>(claim: T, now: number): T {
  const { pausesAt, expiresAt } = claimDeadlines(claim);
  if (expiresAt !== null && now >= expiresAt) return { ...claim, state: 'expired' };
  if (pausesAt !== null && now >= pausesAt) return { ...claim, state: 'paused' };
  return claim;
}
