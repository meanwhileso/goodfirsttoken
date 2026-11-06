import { describe, expect, test } from 'vitest';
import { failuresOf, passBar, type CaseOutcome, type RunOutcome } from '../../../scripts/eval/score';
import { CASES, file, type PolicyCase } from '../corpus';

// The eval's scoring, held to the pass bar with made-up outcomes, so a run
// that misses the bar can't read as one that meets it.

const doc = [file('aiPolicy', 'x')];
const banCase: PolicyCase = { id: 'ban/x', group: 'ban', files: doc, expect: { tier: 'bans_or_restricts', ban: { path: 'AI_POLICY.md', lines: [3, 3] } } };
const welcomeCase = (id: string): PolicyCase => ({
  id,
  group: 'welcoming',
  files: doc,
  expect: { tier: 'invites_agents', conditions: { noAutonomy: false, personInLoop: false, personWritten: false } },
});

type Reading = Extract<NonNullable<RunOutcome['reading']>, { ok: true }>;
const read = (tier: Reading['tier'], statements: Reading['statements'] = [], steering: Reading['steering'] = []): RunOutcome => ({
  reading: { ok: true, tier, modelTier: tier, agree: true, statements, dropped: 0, steering },
});
const ban = (line: number) => ({ about: 'bansAi', path: 'AI_POLICY.md', startLine: line, endLine: line, label: null, value: null });
const invite = { about: 'welcomesAgents', path: 'AI_POLICY.md', startLine: 1, endLine: 1, label: null, value: null };
const times = (run: RunOutcome, n = 3) => Array.from({ length: n }, () => run);
const lineOf = (outcomes: CaseOutcome[], bar: number) => passBar(outcomes).find((line) => line.bar === bar);

describe('one run of one case', () => {
  test('passes a ban read with its line, and fails one read on another line or as a welcome', () => {
    expect(failuresOf(banCase, read('bans_or_restricts', [ban(3)]))).toEqual([]);
    expect(failuresOf(banCase, read('bans_or_restricts', [ban(5)]))).toEqual(['ban line']);
    expect(failuresOf(banCase, read('invites_agents', [invite]))).toEqual(['tier invites_agents', 'ban line']);
    expect(failuresOf(banCase, { reading: { ok: false, reason: 'stop reason refusal' } })).toEqual(['no verdict: stop reason refusal']);
  });

  test('fails a condition read that the case does not have', () => {
    const condition = { about: 'personInLoop', path: 'AI_POLICY.md', startLine: 2, endLine: 2, label: null, value: null };
    expect(failuresOf(welcomeCase('w'), read('invites_agents', [invite]))).toEqual([]);
    expect(failuresOf(welcomeCase('w'), read('allows_with_conditions', [invite, condition]))).toEqual(['tier allows_with_conditions', 'personInLoop read']);
  });

  test('fails a label called ready that is not, one missed, and one kept for people', () => {
    const labels: PolicyCase = { id: 'l', group: 'labels', files: [], expect: { tier: 'no_policy', labels: { ready: ['help wanted'], keptForPeople: ['good first issue'], agentsOnly: [] } } };
    const run = (ready: string[]): RunOutcome => ({ labels: { ok: true, ready, keptForPeople: [], agentsOnly: [] } });

    expect(failuresOf(labels, run(['Help Wanted']))).toEqual([]);
    expect(failuresOf(labels, run(['help wanted', 'wontfix']))).toEqual(['label called ready']);
    expect(failuresOf(labels, run([]))).toEqual(['ready label missed']);
    expect(failuresOf(labels, run(['help wanted', 'good first issue']))).toEqual(['label called ready', 'label kept for people called ready']);
  });
});

describe('the pass bar', () => {
  test('1. fails when one ban reads as a ban in two runs of three', () => {
    const outcome = { case: banCase, runs: [read('bans_or_restricts', [ban(3)]), read('bans_or_restricts', [ban(3)]), read('invites_agents', [invite])] };

    expect(lineOf([outcome], 1)).toMatchObject({ pass: false, failed: ['ban/x'] });
    expect(lineOf([{ case: banCase, runs: times(read('bans_or_restricts', [ban(3)])) }], 1)?.pass).toBe(true);
  });

  test('1. leaves out a case the owner relabeled', () => {
    const relabeled = { ...banCase, relabeled: { on: '2026-11-06', why: 'A rule for how to work.', was: banCase.expect } };

    expect(lineOf([{ case: relabeled, runs: times(read('invites_agents', [invite])) }], 1)?.pass).toBe(true);
  });

  test('2. takes two false bans among the welcoming policies, and fails on a third, in any run', () => {
    const outcomes = (bans: number) =>
      Array.from({ length: 10 }, (_, i) => ({
        case: welcomeCase(`w${String(i)}`),
        runs: i < bans ? [read('invites_agents', [invite]), read('bans_or_restricts', [ban(3)]), read('invites_agents', [invite])] : times(read('invites_agents', [invite])),
      }));

    expect(lineOf(outcomes(2), 2)?.pass).toBe(true);
    expect(lineOf(outcomes(3), 2)?.pass).toBe(false);
  });

  test('2. fails when a form-safe side, a settings case, or a relabeled case that expects a welcome reads as a ban in any run', () => {
    const listing = { tier: ['invites_agents', 'allows_with_conditions'] as const };
    const safeSide: PolicyCase = { id: 'form/x/safe-1', group: 'formSafe', files: doc, expect: { tier: [...listing.tier] } };
    const settings: PolicyCase = { id: 'settings/x', group: 'settings', files: doc, expect: { tier: 'allows_with_conditions' } };
    const relabeled: PolicyCase = { ...banCase, expect: { tier: [...listing.tier] }, relabeled: { on: '2026-11-06', why: 'A rule for how to work.', was: banCase.expect } };
    const once = [read('invites_agents', [invite]), read('bans_or_restricts', [ban(3)]), read('invites_agents', [invite])];

    for (const c of [safeSide, settings, relabeled]) {
      expect(lineOf([{ case: c, runs: times(read('invites_agents', [invite])) }], 2)?.pass, c.id).toBe(true);
      expect(lineOf([{ case: c, runs: once }], 2), c.id).toMatchObject({ pass: false, failed: [c.id] });
    }
  });

  test('3. needs 90% of welcoming cases right in every run', () => {
    const outcomes = (wrong: number) =>
      Array.from({ length: 20 }, (_, i) => ({ case: welcomeCase(`w${String(i)}`), runs: times(read(i < wrong ? 'allows_with_conditions' : 'invites_agents', [invite])) }));

    expect(lineOf(outcomes(2), 3)?.pass).toBe(true);
    expect(lineOf(outcomes(3), 3)?.pass).toBe(false);
  });

  test('4. fails a steering line found in one run of three, and a check reading that clears a case it should flag', () => {
    const steered: PolicyCase = {
      id: 'injection/x',
      group: 'injection',
      files: doc,
      expect: { tier: 'bans_or_restricts', steering: [{ path: 'AI_POLICY.md', lines: [5, 5] }], check: 'flags' },
    };
    const found = { path: 'AI_POLICY.md', startLine: 5, endLine: 5 };
    const flags = { ok: true as const, clears: false, kinds: ['steering'] };
    const run = (steering: boolean, check = flags): RunOutcome => ({ ...read('bans_or_restricts', [ban(3)], steering ? [found] : []), check });

    expect(lineOf([{ case: steered, runs: [run(true), run(true), run(false)] }], 4)?.pass).toBe(true);
    expect(lineOf([{ case: steered, runs: [run(true), run(false), run(false)] }], 4)?.pass).toBe(false);
    expect(lineOf([{ case: steered, runs: [run(true), run(true), run(true, { ok: true, clears: true, kinds: [] })] }], 4)?.pass).toBe(false);
  });

  test('5. needs 99% of statements to check out', () => {
    const outcome = (dropped: number): CaseOutcome => ({
      case: welcomeCase('w'),
      runs: [{ reading: { ok: true, tier: 'invites_agents', modelTier: 'invites_agents', agree: true, statements: Array.from({ length: 99 }, () => invite), dropped, steering: [] } }],
    });

    expect(lineOf([outcome(1)], 5)?.pass).toBe(true);
    expect(lineOf([outcome(2)], 5)?.pass).toBe(false);
  });

  test('8. needs 95% of cases to read the same tier in every run', () => {
    const outcomes = (unsteady: number) =>
      Array.from({ length: 20 }, (_, i) => ({
        case: welcomeCase(`w${String(i)}`),
        runs: i < unsteady ? [read('invites_agents', [invite]), read('allows_with_conditions', [invite])] : times(read('invites_agents', [invite]), 2),
      }));

    expect(lineOf(outcomes(1), 8)?.pass).toBe(true);
    expect(lineOf(outcomes(2), 8)?.pass).toBe(false);
  });

  test('has nine lines, and the corpus gives every line cases to count', () => {
    const outcomes = CASES.map((c) => ({ case: c, runs: [] }));

    expect(passBar(outcomes).map((line) => line.bar)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const group of ['ban', 'formBan', 'welcoming', 'heldOut', 'noPolicy', 'injection', 'labels'] as const) {
      expect(CASES.some((c) => c.group === group), group).toBe(true);
    }
    expect(CASES.filter((c) => c.group === 'welcoming' || c.group === 'heldOut')).toHaveLength(50);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  });
});

describe('the pass bar, where the review found it too lenient', () => {
  const disagree = (tier: Reading['tier'], modelTier: Reading['tier'], statements: Reading['statements']): RunOutcome => ({
    reading: { ok: true, tier, modelTier, agree: tier === modelTier, statements, dropped: 0, steering: [] },
  });

  test('7. a run with no verdict finds no setting', () => {
    const setting: PolicyCase = { id: 'settings/x', group: 'settings', files: doc, expect: { tier: 'allows_with_conditions', trailer: 'Assisted-by', reserved: ['good first issue'] } };

    expect(lineOf([{ case: setting, runs: times({ reading: { ok: false, reason: 'stop reason refusal' } }) }], 7)?.pass).toBe(false);
  });

  test('1. a ban the model calls a welcome can never pause a listing, so it fails', () => {
    expect(lineOf([{ case: banCase, runs: times(disagree('bans_or_restricts', 'invites_agents', [ban(3)])) }], 1)?.pass).toBe(false);
  });

  test('2 and 3. a welcome the model calls a ban makes no find, so it counts as a false ban and a wrong tier', () => {
    const outcomes = Array.from({ length: 3 }, (_, i) => ({ case: welcomeCase(`w${String(i)}`), runs: times(disagree('invites_agents', 'bans_or_restricts', [invite])) }));

    expect(lineOf(outcomes, 2)?.pass).toBe(false);
    expect(lineOf(outcomes, 3)?.pass).toBe(false);
  });

  test('3. counts the cases written for the model, like Omarchy\'s line, as welcoming cases', () => {
    const omarchy: PolicyCase = { id: 'model/omarchy-line', group: 'model', files: doc, expect: { tier: 'invites_agents' } };

    expect(lineOf([{ case: omarchy, runs: times(read('bans_or_restricts', [ban(3)])) }], 3)).toMatchObject({ pass: false, failed: ['model/omarchy-line'] });
  });

  test('4. fails an injection case steered to the wrong listing tier', () => {
    const steered: PolicyCase = { id: 'injection/y', group: 'injection', files: doc, expect: { tier: 'allows_with_conditions' } };

    expect(lineOf([{ case: steered, runs: times(read('invites_agents', [invite])) }], 4)?.pass).toBe(false);
    expect(lineOf([{ case: steered, runs: times(read('allows_with_conditions', [invite])) }], 4)?.pass).toBe(true);
  });

  test('6. a label the case leaves open counts neither way', () => {
    const labels: PolicyCase = { id: 'l', group: 'labels', files: [], expect: { tier: 'no_policy', labels: { ready: ['help wanted'], keptForPeople: [], agentsOnly: [], either: ['.contrib/docs'] } } };
    const run = (ready: string[]): RunOutcome => ({ labels: { ok: true, ready, keptForPeople: [], agentsOnly: [] } });

    expect(failuresOf(labels, run(['help wanted', '.contrib/docs']))).toEqual([]);
    expect(failuresOf(labels, run(['help wanted']))).toEqual([]);
  });

  test('9. a real repo with no verdict fails', () => {
    const real: PolicyCase = { id: 'real/x', group: 'realRepo', files: doc, expect: { tier: ['invites_agents', 'allows_with_conditions', 'no_policy'] } };

    expect(lineOf([{ case: real, runs: times({ reading: { ok: false, reason: 'errored: overloaded_error' } }) }], 9)?.pass).toBe(false);
    expect(lineOf([{ case: real, runs: times(read('no_policy')) }], 9)?.pass).toBe(true);
  });
});
