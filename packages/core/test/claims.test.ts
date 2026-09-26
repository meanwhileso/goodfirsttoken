import { describe, expect, test } from 'vitest';
import {
  claimDeadlines,
  claimEventKinds,
  claimRecordSchema,
  claimTimelineSchema,
  holdsSlot,
  newClaim,
  nextClaimState,
  validate,
  type ClaimEvent,
  type ClaimTimeline,
  type Validated,
} from '../src/index';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const claimedAt = Date.UTC(2026, 8, 26, 12, 0, 0);
const pr = { repo: 'meanwhileso/goodfirsttoken', number: 57, url: 'https://github.com/meanwhileso/goodfirsttoken/pull/57' };

const tick: ClaimEvent = { kind: 'tick' };
const update: ClaimEvent = { kind: 'update' };
const submit: ClaimEvent = { kind: 'submit' };
const openPr: ClaimEvent = { kind: 'open_pr', pr };
const release: ClaimEvent = { kind: 'release', reason: 'stuck on the lock screen tests' };
const eventOf = { tick, update, submit, open_pr: openPr, release };

/** Applies an event that must succeed, and returns the claim after it. */
function apply(claim: ClaimTimeline, event: ClaimEvent, now: number): ClaimTimeline {
  const result = nextClaimState(claim, event, now);
  if (!result.ok) throw new Error(`${event.kind} was refused: ${result.refusal.message}`);
  return result.claim;
}

function problemFieldsOf(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.problems.map((p) => p.field);
}

function stateAt(claim: ClaimTimeline, now: number) {
  return apply(claim, tick, now).state;
}

/** A claim submitted two hours after it was made. */
function submitted() {
  const submittedAt = claimedAt + 2 * HOUR;
  return { claim: apply(newClaim(claimedAt), submit, submittedAt), submittedAt };
}

describe('working on a claim', () => {
  test('a new claim is active and holds a slot', () => {
    const claim = newClaim(claimedAt);
    expect(claim.state).toBe('active');
    expect(holdsSlot(claim, claimedAt)).toBe(true);
  });

  test('a claim with no update for 30 minutes is paused', () => {
    expect(stateAt(newClaim(claimedAt), claimedAt + 30 * MINUTE)).toBe('paused');
  });

  test('a claim updated 1 ms under 30 minutes ago stays active', () => {
    const claim = apply(newClaim(claimedAt), update, claimedAt + 5 * MINUTE);
    expect(stateAt(claim, claimedAt + 35 * MINUTE - 1)).toBe('active');
  });

  test('an update restarts the 30 minutes', () => {
    const claim = apply(newClaim(claimedAt), update, claimedAt + 20 * MINUTE);
    expect(stateAt(claim, claimedAt + 49 * MINUTE)).toBe('active');
    expect(stateAt(claim, claimedAt + 50 * MINUTE)).toBe('paused');
  });

  test('an update stamped earlier than the last one keeps the later 30 minutes', () => {
    const claim = apply(newClaim(claimedAt), update, claimedAt + 20 * MINUTE);
    const late = apply(claim, update, claimedAt + 10 * MINUTE);
    expect(stateAt(late, claimedAt + 49 * MINUTE)).toBe('active');
  });

  test('a paused claim still holds its slot', () => {
    const claim = newClaim(claimedAt);
    expect(holdsSlot(claim, claimedAt + 45 * MINUTE)).toBe(true);
  });

  test('an update wakes a paused claim', () => {
    const paused = apply(newClaim(claimedAt), tick, claimedAt + HOUR);
    expect(paused.state).toBe('paused');
    const resumed = apply(paused, update, claimedAt + 2 * HOUR);
    expect(resumed.state).toBe('active');
    expect(stateAt(resumed, claimedAt + 2 * HOUR + 29 * MINUTE)).toBe('active');
  });
});

describe('the 24 hours', () => {
  test('a claim expires 24 hours after it was made, even with steady updates', () => {
    let claim = newClaim(claimedAt);
    for (let at = claimedAt + 10 * MINUTE; at < claimedAt + DAY; at += 10 * MINUTE) {
      claim = apply(claim, update, at);
    }
    expect(stateAt(claim, claimedAt + DAY - 1)).toBe('active');
    expect(stateAt(claim, claimedAt + DAY)).toBe('expired');
    expect(holdsSlot(claim, claimedAt + DAY)).toBe(false);
  });

  test('a paused claim expires 24 hours after it was made', () => {
    const paused = apply(newClaim(claimedAt), tick, claimedAt + HOUR);
    expect(stateAt(paused, claimedAt + DAY - 1)).toBe('paused');
    expect(stateAt(paused, claimedAt + DAY)).toBe('expired');
  });

  test('an update after 24 hours is refused, and the claim to store is expired', () => {
    const result = nextClaimState(newClaim(claimedAt), update, claimedAt + DAY + MINUTE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('claim_expired');
    expect(result.refusal.message).toContain('24 hours');
    expect(result.claim.state).toBe('expired');
  });

  test('a submit after 24 hours is refused', () => {
    const result = nextClaimState(newClaim(claimedAt), submit, claimedAt + DAY);
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
    const paused = apply(newClaim(claimedAt), tick, claimedAt + HOUR);
    expect(apply(paused, submit, claimedAt + 2 * HOUR).state).toBe('awaiting_review');
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
    const result = nextClaimState(claim, openPr, submittedAt + 7 * DAY);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('claim_expired');
    expect(result.refusal.message).toContain('7 days');
  });

  test('submitting again while awaiting review keeps the first 7 days', () => {
    const { claim, submittedAt } = submitted();
    const again = apply(claim, submit, submittedAt + 6 * DAY);
    expect(again.state).toBe('awaiting_review');
    expect(stateAt(again, submittedAt + 7 * DAY)).toBe('expired');
  });

  test('opening the PR records its link and frees the slot', () => {
    const { claim, submittedAt } = submitted();
    const opened = apply(claim, openPr, submittedAt + HOUR);
    expect(opened.state).toBe('pr_opened');
    expect(opened.pr).toEqual(pr);
    expect(holdsSlot(opened, submittedAt + HOUR)).toBe(false);
  });

  test('a PR can not open before the work is submitted', () => {
    const result = nextClaimState(newClaim(claimedAt), openPr, claimedAt + HOUR);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('not_submitted');
    expect(result.claim.state).toBe('paused');
  });

  test('a PR opens once per claim', () => {
    const { claim, submittedAt } = submitted();
    const opened = apply(claim, openPr, submittedAt + HOUR);
    const again = nextClaimState(opened, openPr, submittedAt + 2 * HOUR);
    expect(again.ok ? 'opened twice' : again.refusal.code).toBe('pr_already_opened');
  });

  test('a claim with an open PR takes updates and review fixes, and stays pr_opened for good', () => {
    const { claim, submittedAt } = submitted();
    let opened = apply(claim, openPr, submittedAt + HOUR);
    opened = apply(opened, update, submittedAt + 30 * DAY);
    opened = apply(opened, submit, submittedAt + 30 * DAY + MINUTE);
    expect(opened.state).toBe('pr_opened');
    expect(stateAt(opened, submittedAt + 365 * DAY)).toBe('pr_opened');
  });
});

describe('releasing', () => {
  test('a released claim records its public reason and frees its slot', () => {
    const released = apply(newClaim(claimedAt), release, claimedAt + HOUR);
    expect(released.state).toBe('released');
    expect(released.releaseReason).toBe('stuck on the lock screen tests');
    expect(holdsSlot(released, claimedAt + HOUR)).toBe(false);
  });

  test('work awaiting review can be released', () => {
    const { claim, submittedAt } = submitted();
    expect(apply(claim, release, submittedAt + DAY).state).toBe('released');
  });

  test('a claim with an open PR can not be released', () => {
    const { claim, submittedAt } = submitted();
    const opened = apply(claim, openPr, submittedAt + HOUR);
    const result = nextClaimState(opened, release, submittedAt + 2 * HOUR);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('pr_already_opened');
    expect(result.claim.state).toBe('pr_opened');
  });
});

describe('ended claims', () => {
  const released = apply(newClaim(claimedAt), release, claimedAt + HOUR);
  const expired = apply(newClaim(claimedAt), tick, claimedAt + DAY);
  const acting = claimEventKinds.filter((kind) => kind !== 'tick');

  test.each(acting)('a released claim refuses %s', (kind) => {
    const result = nextClaimState(released, eventOf[kind], claimedAt + 2 * HOUR);
    expect(result.ok ? result.claim.state : result.refusal.code).toBe('claim_released');
  });

  test.each(acting)('an expired claim refuses %s', (kind) => {
    const result = nextClaimState(expired, eventOf[kind], claimedAt + 2 * DAY);
    expect(result.ok ? result.claim.state : result.refusal.code).toBe('claim_expired');
  });
});

describe('timers', () => {
  const { claim: awaiting, submittedAt } = submitted();
  const cases: [string, ClaimTimeline][] = [
    ['an active claim', apply(newClaim(claimedAt), update, claimedAt + 5 * MINUTE)],
    ['an active claim updated late on its first day', apply(newClaim(claimedAt), update, claimedAt + DAY - 10 * MINUTE)],
    ['a paused claim', apply(newClaim(claimedAt), tick, claimedAt + HOUR)],
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
    const opened = apply(awaiting, openPr, submittedAt + HOUR);
    const released = apply(newClaim(claimedAt), release, claimedAt + HOUR);
    expect(claimDeadlines(opened)).toEqual({ pausesAt: null, expiresAt: null });
    expect(claimDeadlines(released)).toEqual({ pausesAt: null, expiresAt: null });
  });
});

describe('stored claims', () => {
  const record = {
    id: 'c_1',
    issue: 'meanwhileso/goodfirsttoken#18',
    project: 'meanwhileso/goodfirsttoken',
    githubId: 1001,
    login: 'priya',
    agent: 'claude-code',
    ownProject: false,
    startCommit: '4f2a91c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6',
    tokenEstimate: null,
    ...newClaim(claimedAt),
  };

  test('a stored claim records the commit its work starts from', () => {
    const withoutStart: Partial<typeof record> = { ...record };
    delete withoutStart.startCommit;
    expect(problemFieldsOf(validate(claimRecordSchema, withoutStart))).toEqual(['startCommit']);
    expect(problemFieldsOf(validate(claimRecordSchema, { ...record, startCommit: 'main' }))).toEqual([
      'startCommit',
    ]);
  });

  test('a new claim is a valid stored claim', () => {
    expect(validate(claimRecordSchema, record).ok).toBe(true);
  });

  test.each([
    ['lastUpdateAt', { lastUpdateAt: claimedAt - 1 }],
    ['lastUpdateAt', { lastUpdateAt: Number.NaN }],
    ['claimedAt', { claimedAt: '2026-09-26T12:00:00Z' }],
    ['submittedAt', { state: 'awaiting_review' }],
    ['submittedAt', { state: 'pr_opened', pr }],
    ['submittedAt', { submittedAt: claimedAt + HOUR }],
    ['submittedAt', { state: 'expired', submittedAt: claimedAt - HOUR }],
    ['releaseReason', { state: 'released' }],
    ['releaseReason', { state: 'released', releaseReason: '   ' }],
    ['releaseReason', { releaseReason: 'gave up' }],
    ['pr', { state: 'pr_opened', submittedAt: claimedAt + HOUR }],
    ['pr', { state: 'awaiting_review', submittedAt: claimedAt + HOUR, pr }],
    ['login', { login: 'not a login' }],
    ['githubId', { githubId: 'priya' }],
    ['githubId', { githubId: 0 }],
    ['state', { state: 'done' }],
  ])('a stored claim with a bad %s is rejected, naming the field', (field, bad) => {
    const result = validate(claimRecordSchema, { ...record, ...bad });
    expect(result.ok ? [] : result.problems.map((p) => p.field)).toEqual([field]);
  });

  // Every claim reachable from a new one, by each event in turn.
  const reachable: ClaimTimeline[] = [
    newClaim(claimedAt),
    apply(newClaim(claimedAt), tick, claimedAt + HOUR),
    submitted().claim,
    apply(submitted().claim, openPr, claimedAt + 3 * HOUR),
    apply(newClaim(claimedAt), release, claimedAt + HOUR),
    apply(newClaim(claimedAt), tick, claimedAt + DAY),
    apply(submitted().claim, tick, claimedAt + 8 * DAY),
  ];

  test('every answer the machine gives from a valid claim is itself a valid claim', () => {
    for (const claim of reachable) {
      for (const kind of claimEventKinds) {
        for (const later of [MINUTE, HOUR, 2 * DAY, 10 * DAY]) {
          const result = nextClaimState(claim, eventOf[kind], claim.lastUpdateAt + later);
          const check = validate(claimTimelineSchema, result.claim);
          expect(check, `${claim.state} + ${kind}`).toEqual({ ok: true, value: result.claim });
        }
      }
    }
  });
});

describe('bad input', () => {
  test('a claim with a malformed time is refused as invalid input', () => {
    const broken = { ...newClaim(claimedAt), lastUpdateAt: Number.NaN };
    const result = nextClaimState(broken, tick, claimedAt + HOUR);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('invalid_input');
    expect(result.refusal.message).toContain('claim.lastUpdateAt: ');
    expect(result.claim).toBe(broken);
  });

  test('a malformed clock is refused', () => {
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, claimedAt + 0.5, claimedAt - 1]) {
      const result = nextClaimState(newClaim(claimedAt), update, now);
      expect(result.ok ? 'accepted' : result.refusal.message, String(now)).toMatch(/\nnow: /);
    }
  });

  test('a release with an empty reason is refused', () => {
    const result = nextClaimState(newClaim(claimedAt), { kind: 'release', reason: ' ' }, claimedAt + HOUR);
    expect(result.ok ? 'released' : result.refusal.message).toContain('event.reason: ');
  });

  test('a malformed claim never quietly holds a slot or sets a timer', () => {
    const broken = { ...newClaim(claimedAt), claimedAt: Number.NaN };
    expect(() => holdsSlot(broken, claimedAt)).toThrow(/claim\.claimedAt/);
    expect(() => claimDeadlines(broken)).toThrow(/claim\.claimedAt/);
    expect(() => holdsSlot(newClaim(claimedAt), Number.NaN)).toThrow(/now/);
  });
});
