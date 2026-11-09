import { describe, expect, test } from 'vitest';
import type { FollowedPr } from '../../src/me/follow';
import { everyText, nextCheckText, stepFor, stoppedCheck } from '../../src/me/follow-words';

// The words /me and /me.md give a followed PR's next check and the step to
// take, and a wake's interval, at the edges of followThroughOf's answers.

const now = Date.UTC(2026, 10, 8, 12, 0);

function pr(over: Partial<FollowedPr>): FollowedPr {
  return {
    claimId: 'c_1',
    issue: 'sample-owner/sample-app#57',
    pr: { repo: 'sample-owner/sample-app', number: 58, url: 'https://github.com/sample-owner/sample-app/pull/58' },
    followMode: 'go_ahead',
    ownMode: false,
    state: 'waiting_reviewer',
    leased: false,
    due: false,
    lastSubmit: null,
    stalledSince: null,
    roundLimit: null,
    open: 0,
    waitingDonor: 0,
    nextCheckAt: now + 15 * 60_000,
    schedule: 'every_15_minutes',
    questions: [],
    latest: [],
    ...over,
  };
}

describe("a followed PR's next check", () => {
  test('is its time, or due at the next run once a run has work on it, whatever its schedule says', () => {
    expect(nextCheckText(pr({}), now)).toBe('checked next 2026-11-08 12:15 UTC');
    expect(nextCheckText(pr({ due: true, open: 1, state: 'agent_on_it' }), now)).toBe("due at your agent's next run");
    expect(nextCheckText(pr({ due: true, open: 1, nextCheckAt: null, schedule: 'stopped' }), now)).toBe("due at your agent's next run");
  });

  test('waits for the donor at the round limit in all, or when every follow-up waits for them, and is none once they stop following', () => {
    expect(nextCheckText(pr({ roundLimit: 'total', nextCheckAt: null, state: 'waiting_donor' }), now)).toBe('checked again once you choose Go on');
    expect(nextCheckText(pr({ waitingDonor: 1, nextCheckAt: null, state: 'waiting_donor' }), now)).toBe('checked again once you answer');
    expect(nextCheckText(pr({ followMode: 'off', state: 'off', nextCheckAt: null }), now)).toBeNull();
  });

  test('says so after 30 days with no reviewer activity', () => {
    expect(nextCheckText(pr({ nextCheckAt: null, schedule: 'stopped' }), now)).toBe('no reviewer activity for 30 days, so no checks on a schedule');
  });
});

describe('the step to take on a followed PR', () => {
  test('names the round limit it reached, and nothing waits for a PR with a reviewer', () => {
    expect(stepFor(pr({ roundLimit: 'day', state: 'waiting_donor' }))).toContain('3 rounds on this PR today');
    expect(stepFor(pr({ roundLimit: 'total', state: 'waiting_donor' }))).toContain('10 rounds on this PR, the most in all');
    expect(stepFor(pr({}))).toBeNull();
  });
});

describe('a wake', () => {
  test('runs every so many minutes, hours, or a day', () => {
    expect([15, 1, 60, 120, 90, 1440].map(everyText)).toEqual([
      'every 15 minutes',
      'every minute',
      'every hour',
      'every 2 hours',
      'every 90 minutes',
      'every day',
    ]);
  });

  test("that stopped says to check the app is open on the donor's machine, or its schedule in a cloud harness", () => {
    expect(stoppedCheck('claude-code-desktop')).toBe('Check that Claude Code desktop app is open and its schedule is on.');
    expect(stoppedCheck('cursor-automations')).toBe('Check that its schedule is still on in Cursor Automations.');
  });
});
