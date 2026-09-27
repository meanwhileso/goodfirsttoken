import { describe, expect, test } from 'vitest';
import { budgetLeft, validate, sessionRecordSchema, type Budget } from '../src/index';

// A donor's session budget: what the server counts against it, and when it
// allows no new claim.

const MINUTE = 60_000;
const startedAt = Date.UTC(2026, 8, 27, 12, 0, 0);

const session = (budget: Budget, issuesClaimed = 0) => ({ budget, startedAt, issuesClaimed });

describe('the session budget', () => {
  test('a budget of issues is spent once that many issues were claimed in the session', () => {
    const three: Budget = { kind: 'issues', count: 3 };

    expect(budgetLeft(session(three, 2), startedAt)).toEqual({ spent: false, issuesLeft: 1, endsAt: null });
    expect(budgetLeft(session(three, 3), startedAt)).toEqual({ spent: true, issuesLeft: 0, endsAt: null });
  });

  test('a budget of time is spent once its minutes have passed since the session started, whatever was claimed', () => {
    const hour: Budget = { kind: 'time', minutes: 60 };
    const endsAt = startedAt + 60 * MINUTE;

    expect(budgetLeft(session(hour, 40), endsAt - 1)).toEqual({ spent: false, issuesLeft: null, endsAt });
    expect(budgetLeft(session(hour), endsAt)).toEqual({ spent: true, issuesLeft: null, endsAt });
  });

  test('until the limit is never spent: the session runs until the harness stops', () => {
    expect(budgetLeft(session({ kind: 'until_limit' }, 100), startedAt + 30 * 24 * 60 * MINUTE).spent).toBe(false);
  });

  test("a session's queue holds at most 20 picks", () => {
    const record = (queue: string[]) =>
      validate(sessionRecordSchema, { ...session({ kind: 'until_limit' }), id: 's_1', githubId: 1001, agent: 'codex', queue });
    const picks = (n: number) => Array.from({ length: n }, (_, i) => `sample-owner/sample-app#${String(i + 1)}`);

    expect(record(picks(20)).ok).toBe(true);
    expect(record(picks(21)).ok).toBe(false);
  });
});
