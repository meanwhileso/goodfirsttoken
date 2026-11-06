import { describe, expect, test } from 'vitest';
import { DayBudget, docsBytes, docsHash, noUse, policyRequest, reservationOf, utcDay } from '../../../src/crawl/reader';
import type { PolicyFile } from '../../../src/crawl/rules';

// The model reader's day budget and docs hash, with no network. The
// crawler's tests (test/crawl/model-reader.test.ts) run them end to end.

describe('the day budget', () => {
  test("each share but the weekly reads' may spend its part of the day and no more", () => {
    const budget = new DayBudget(20, noUse());

    expect(budget.reserve('seeds', 9.5)).toBe(true);
    expect(budget.reserve('seeds', 0.6)).toBe(false);
    expect(budget.reserve('requests', 4)).toBe(true);
    expect(budget.reserve('requests', 0.1)).toBe(false);
    expect(budget.reserve('register', 2)).toBe(true);
    expect(budget.reserve('register', 0.1)).toBe(false);
  });

  test('weekly reads may spend what the others left unspent, and the day as a whole is the limit', () => {
    const budget = new DayBudget(20, { ...noUse(), seeds: 2 });

    expect(budget.reserve('weekly', 17.5)).toBe(true);
    expect(budget.reserve('weekly', 0.6)).toBe(false);
    // What weekly reads took first, the seeds can't have.
    expect(budget.reserve('seeds', 1)).toBe(false);
  });

  test('what was spent and reserved earlier in the day counts', () => {
    expect(new DayBudget(20, { ...noUse(), seeds: 9.8 }).allows('seeds', 0.3)).toBe(false);
    expect(new DayBudget(20, { ...noUse(), seeds: 10, requests: 4, register: 2, weekly: 3.9 }).allows('weekly', 0.2)).toBe(false);
    expect(new DayBudget(0, noUse()).allows('weekly', 0.01)).toBe(false);
  });

  test("a request reserves the most it could cost: max_tokens at the batch output price, and more for its input", () => {
    const files: PolicyFile[] = [{ path: 'AGENTS.md', kind: 'agents', text: 'Agents may open pull requests.\n'.repeat(300) }];
    const request = policyRequest(files);
    const cost = reservationOf(request, { batch: true });

    expect(cost).toBeGreaterThan((request.max_tokens * 20) / 1_000_000 / 2);
    expect(reservationOf(request, { batch: false })).toBeCloseTo(cost * 2);
  });

  test('a UTC day is the date in UTC', () => {
    expect(utcDay(Date.UTC(2100, 3, 1, 23, 59))).toBe('2100-04-01');
    expect(utcDay(Date.UTC(2100, 3, 2, 0, 0))).toBe('2100-04-02');
  });
});

describe('the docs hash', () => {
  const a: PolicyFile = { path: 'AGENTS.md', kind: 'agents', text: 'Agents welcome.\n' };
  const b: PolicyFile = { path: 'CONTRIBUTING.md', kind: 'contributing', text: 'Run the tests.\n' };

  test('covers each file path and exact text, in no set order, and whether there is a vouch file', async () => {
    const hash = await docsHash([a, b], null);

    expect(hash).toMatch(/^docs-v1:[0-9a-f]{64}$/);
    expect(await docsHash([b, a], null)).toBe(hash);
    expect(await docsHash([a, { ...b, text: 'Run the tests. \n' }], null)).not.toBe(hash);
    expect(await docsHash([a, { ...b, path: 'docs/CONTRIBUTING.md' }], null)).not.toBe(hash);
    expect(await docsHash([a, b], 'VOUCHED.td')).not.toBe(hash);
    expect(await docsHash([a, b], 'OTHER.td')).toBe(await docsHash([a, b], 'VOUCHED.td'));
  });

  test('holds none of the text', async () => {
    expect(await docsHash([a, b], null)).not.toContain('Agents');
  });

  test('counts the text in UTF-8 bytes', () => {
    expect(docsBytes([{ ...a, text: 'é' }])).toBe(2);
  });
});
