import { describe, expect, test } from 'vitest';
import {
  claimDeadlines,
  claimEvents,
  holdsSlot,
  newClaim,
  nextClaimState,
  type ClaimEvent,
  type ClaimTimeline,
} from '../src/index';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const claimedAt = Date.UTC(2026, 8, 26, 12, 0, 0);

/** Applies an event that must succeed, and returns the claim after it. */
function apply(claim: ClaimTimeline, event: ClaimEvent, now: number): ClaimTimeline {
  const result = nextClaimState(claim, event, now);
  if (!result.ok) throw new Error(`${event} was refused: ${result.refusal.message}`);
  return result.claim;
}

function stateAt(claim: ClaimTimeline, now: number) {
  return apply(claim, 'tick', now).state;
}

/** A claim submitted two hours after it was made. */
function submitted() {
  const submittedAt = claimedAt + 2 * HOUR;
  return { claim: apply(newClaim(claimedAt), 'submit', submittedAt), submittedAt };
}

describe('working on a claim', () => {
  test('a new claim is active and holds a slot', () => {
    const claim = newClaim(claimedAt);
    expect(claim.state).toBe('active');
    expect(holdsSlot(claim, claimedAt)).toBe(true);
  });

  test('a claim with no update for 30 minutes is paused', () => {
    const claim = newClaim(claimedAt);
    expect(stateAt(claim, claimedAt + 30 * MINUTE - 1)).toBe('active');
    expect(stateAt(claim, claimedAt + 30 * MINUTE)).toBe('paused');
  });

  test('an update restarts the 30 minutes', () => {
    const claim = apply(newClaim(claimedAt), 'update', claimedAt + 20 * MINUTE);
    expect(stateAt(claim, claimedAt + 49 * MINUTE)).toBe('active');
    expect(stateAt(claim, claimedAt + 50 * MINUTE)).toBe('paused');
  });

  test('a paused claim still holds its slot', () => {
    const claim = newClaim(claimedAt);
    expect(holdsSlot(claim, claimedAt + 45 * MINUTE)).toBe(true);
  });

  test('an update wakes a paused claim', () => {
    const paused = apply(newClaim(claimedAt), 'tick', claimedAt + HOUR);
    expect(paused.state).toBe('paused');
    const resumed = apply(paused, 'update', claimedAt + 2 * HOUR);
    expect(resumed.state).toBe('active');
    expect(stateAt(resumed, claimedAt + 2 * HOUR + 29 * MINUTE)).toBe('active');
  });
});

describe('the 24 hours', () => {
  test('a claim expires 24 hours after it was made, even with steady updates', () => {
    let claim = newClaim(claimedAt);
    for (let at = claimedAt + 10 * MINUTE; at < claimedAt + DAY; at += 10 * MINUTE) {
      claim = apply(claim, 'update', at);
    }
    expect(stateAt(claim, claimedAt + DAY - 1)).toBe('active');
    expect(stateAt(claim, claimedAt + DAY)).toBe('expired');
    expect(holdsSlot(claim, claimedAt + DAY)).toBe(false);
  });

  test('a paused claim expires 24 hours after it was made', () => {
    const paused = apply(newClaim(claimedAt), 'tick', claimedAt + HOUR);
    expect(stateAt(paused, claimedAt + DAY - 1)).toBe('paused');
    expect(stateAt(paused, claimedAt + DAY)).toBe('expired');
  });

  test('an update after 24 hours is refused, and the claim to store is expired', () => {
    const result = nextClaimState(newClaim(claimedAt), 'update', claimedAt + DAY + MINUTE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('claim_expired');
    expect(result.refusal.message).toContain('24 hours');
    expect(result.claim.state).toBe('expired');
  });

  test('a submit after 24 hours is refused', () => {
    const result = nextClaimState(newClaim(claimedAt), 'submit', claimedAt + DAY);
    expect(result.ok ? result.claim.state : result.refusal.code).toBe('claim_expired');
  });

  test('a claim past its deadline frees its slot before any timer runs', () => {
    // Stored as active, because no timer has fired since it was made.
    const stored = newClaim(claimedAt);
    expect(holdsSlot(stored, claimedAt + DAY + HOUR)).toBe(false);
  });
});

describe('submitting and review', () => {
  test('a submitted claim awaits review and keeps its slot', () => {
    const { claim, submittedAt } = submitted();
    expect(claim.state).toBe('awaiting_review');
    expect(holdsSlot(claim, submittedAt + DAY)).toBe(true);
  });

  test('a paused claim can still be submitted', () => {
    const paused = apply(newClaim(claimedAt), 'tick', claimedAt + HOUR);
    expect(apply(paused, 'submit', claimedAt + 2 * HOUR).state).toBe('awaiting_review');
  });

  test('a claim awaiting review neither pauses nor expires at 24 hours', () => {
    const { claim } = submitted();
    expect(stateAt(claim, claimedAt + 3 * DAY)).toBe('awaiting_review');
  });

  test('an awaiting_review claim expires 7 days after submit', () => {
    const { claim, submittedAt } = submitted();
    expect(stateAt(claim, submittedAt + 7 * DAY - 1)).toBe('awaiting_review');
    expect(stateAt(claim, submittedAt + 7 * DAY)).toBe('expired');
    expect(holdsSlot(claim, submittedAt + 7 * DAY)).toBe(false);
  });

  test('a PR for work that waited 7 days is refused', () => {
    const { claim, submittedAt } = submitted();
    const result = nextClaimState(claim, 'open_pr', submittedAt + 7 * DAY);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('claim_expired');
    expect(result.refusal.message).toContain('7 days');
  });

  test('submitting again while awaiting review keeps the first 7 days', () => {
    const { claim, submittedAt } = submitted();
    const again = apply(claim, 'submit', submittedAt + 6 * DAY);
    expect(again.state).toBe('awaiting_review');
    expect(stateAt(again, submittedAt + 7 * DAY)).toBe('expired');
  });

  test('opening the PR frees the slot', () => {
    const { claim, submittedAt } = submitted();
    const opened = apply(claim, 'open_pr', submittedAt + HOUR);
    expect(opened.state).toBe('pr_opened');
    expect(holdsSlot(opened, submittedAt + HOUR)).toBe(false);
  });

  test('a PR can not open before the work is submitted', () => {
    const result = nextClaimState(newClaim(claimedAt), 'open_pr', claimedAt + HOUR);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('not_submitted');
    expect(result.claim.state).toBe('paused');
  });

  test('a PR opens once per claim', () => {
    const { claim, submittedAt } = submitted();
    const opened = apply(claim, 'open_pr', submittedAt + HOUR);
    const again = nextClaimState(opened, 'open_pr', submittedAt + 2 * HOUR);
    expect(again.ok ? 'opened twice' : again.refusal.code).toBe('pr_already_opened');
  });

  test('a claim with an open PR takes updates and review fixes, and never expires', () => {
    const { claim, submittedAt } = submitted();
    let opened = apply(claim, 'open_pr', submittedAt + HOUR);
    opened = apply(opened, 'update', submittedAt + 30 * DAY);
    opened = apply(opened, 'submit', submittedAt + 30 * DAY + MINUTE);
    expect(opened.state).toBe('pr_opened');
  });
});

describe('releasing', () => {
  test('a released claim frees its slot', () => {
    const released = apply(newClaim(claimedAt), 'release', claimedAt + HOUR);
    expect(released.state).toBe('released');
    expect(holdsSlot(released, claimedAt + HOUR)).toBe(false);
  });

  test('work awaiting review can be released', () => {
    const { claim, submittedAt } = submitted();
    expect(apply(claim, 'release', submittedAt + DAY).state).toBe('released');
  });

  test('a claim with an open PR can not be released', () => {
    const { claim, submittedAt } = submitted();
    const opened = apply(claim, 'open_pr', submittedAt + HOUR);
    const result = nextClaimState(opened, 'release', submittedAt + 2 * HOUR);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('pr_already_opened');
    expect(result.claim.state).toBe('pr_opened');
  });
});

describe('ended claims', () => {
  const released = apply(newClaim(claimedAt), 'release', claimedAt + HOUR);
  const expired = apply(newClaim(claimedAt), 'tick', claimedAt + DAY);
  const acting = claimEvents.filter((event) => event !== 'tick');

  test.each(acting)('a released claim refuses %s', (event) => {
    const result = nextClaimState(released, event, claimedAt + 2 * HOUR);
    expect(result.ok ? result.claim.state : result.refusal.code).toBe('claim_released');
  });

  test.each(acting)('an expired claim refuses %s', (event) => {
    const result = nextClaimState(expired, event, claimedAt + 2 * DAY);
    expect(result.ok ? result.claim.state : result.refusal.code).toBe('claim_expired');
  });
});

describe('timers', () => {
  const { claim: awaiting, submittedAt } = submitted();
  const cases: [string, ClaimTimeline][] = [
    ['an active claim', apply(newClaim(claimedAt), 'update', claimedAt + 5 * MINUTE)],
    ['an active claim updated late on its first day', apply(newClaim(claimedAt), 'update', claimedAt + DAY - 10 * MINUTE)],
    ['a paused claim', apply(newClaim(claimedAt), 'tick', claimedAt + HOUR)],
    ['a claim awaiting review', awaiting],
  ];

  test.each(cases)('a timer at the next deadline of %s fires exactly when its state changes', (_, claim) => {
    const { pausesAt, expiresAt } = claimDeadlines(claim);
    const deadlines = [pausesAt, expiresAt].filter((at): at is number => at !== null);
    const next = Math.min(...deadlines);
    expect(Number.isFinite(next)).toBe(true);
    expect(stateAt(claim, next - 1)).toBe(claim.state);
    expect(stateAt(claim, next)).not.toBe(claim.state);
  });

  test('a claim that is done changing needs no timer', () => {
    const opened = apply(awaiting, 'open_pr', submittedAt + HOUR);
    const released = apply(newClaim(claimedAt), 'release', claimedAt + HOUR);
    expect(claimDeadlines(opened)).toEqual({ pausesAt: null, expiresAt: null });
    expect(claimDeadlines(released)).toEqual({ pausesAt: null, expiresAt: null });
  });
});
