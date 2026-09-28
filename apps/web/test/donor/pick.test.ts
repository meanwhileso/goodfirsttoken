import { describe, expect, test } from 'vitest';
import { POOL, rankIssues, weightedOrder, type Candidate } from '../../src/donor/pick';

// How suggest_issues orders the issues waiting for an agent. Every project
// and issue here is made up.

function candidate(issue: string, rest: Partial<Candidate> = {}): Candidate {
  return {
    issue,
    project: issue.slice(0, issue.indexOf('#')),
    title: 'Fix a thing',
    labels: ['help wanted'],
    language: null,
    holding: 0,
    ...rest,
  };
}

describe('ranking against interests', () => {
  test("issues in a project the donor named come first, then ones in their language, then ones matching kinds of work they like", () => {
    const issues = [
      candidate('sample-owner/sample-app#1'),
      candidate('sample-owner/sample-docs#2', { title: 'Documentation for the rewrite rules' }),
      candidate('sample-owner/sample-harbor#3', { language: 'Go' }),
      candidate('sample-owner/sample-bundler#4'),
    ];

    const ranked = rankIssues(issues, { projects: ['sample-bundler'], languages: ['go'], kinds: ['docs'] });

    expect(ranked.map((c) => c.issue)).toEqual([
      'sample-owner/sample-bundler#4',
      'sample-owner/sample-harbor#3',
      'sample-owner/sample-docs#2',
      'sample-owner/sample-app#1',
    ]);
  });

  test('a project is named by owner/name, by its name alone, or by its issue repo, and a language can be a label', () => {
    const inIssueRepo = candidate('sample-owner/sample-issues#1', { project: 'sample-owner/sample-app' });
    const labelled = candidate('sample-owner/sample-tools#2', { labels: ['help wanted', 'rust'] });
    const other = candidate('sample-owner/sample-desktop#3');

    expect(rankIssues([other, inIssueRepo], { projects: ['Sample-Owner/Sample-Issues'], languages: [], kinds: [] })[0]).toBe(inIssueRepo);
    expect(rankIssues([other, inIssueRepo], { projects: ['sample-app'], languages: [], kinds: [] })[0]).toBe(inIssueRepo);
    expect(rankIssues([other, labelled], { projects: [], languages: ['Rust'], kinds: [] })[0]).toBe(labelled);
  });

  test('a kind of work of several words matches those words in a row, in the title or a label', () => {
    const inTitle = candidate('sample-owner/sample-app#1', { title: 'Better error handling in rewrites' });
    const inLabel = candidate('sample-owner/sample-app#2', { labels: ['help wanted', 'error-handling'] });
    const apart = candidate('sample-owner/sample-app#3', { title: 'Log the error when handling a rewrite' });
    const interests = { projects: [], languages: [], kinds: ['Error Handling'] };

    const ranked = rankIssues([apart, inTitle, inLabel], interests);

    expect(ranked).toEqual([inTitle, inLabel, apart]);
  });

  test('among equal matches, the issue with fewer claims holding a slot comes first, then the order given', () => {
    const busy = candidate('sample-owner/sample-app#1', { holding: 2 });
    const quiet = candidate('sample-owner/sample-app#2');
    const alsoQuiet = candidate('sample-owner/sample-app#3');

    expect(rankIssues([busy, quiet, alsoQuiet], null)).toEqual([quiet, alsoQuiet, busy]);
  });
});

describe('the random order', () => {
  const ranked = Array.from({ length: POOL + 3 }, (_, rank) => `rank ${String(rank)}`);

  /** Which issue leads the order for each of `draws` first draws spread evenly from 0 up to 1. */
  function leaders(draws: number): Map<string, number> {
    const led = new Map<string, number>();
    for (let i = 0; i < draws; i++) {
      let first = true;
      const random = () => {
        const value = first ? (i + 0.5) / draws : 0;
        first = false;
        return value;
      };
      const [leader = ''] = weightedOrder(ranked, random);
      led.set(leader, (led.get(leader) ?? 0) + 1);
    }
    return led;
  }

  test('the order holds every issue in the ranking once, so a pick that fails gives way to the rest of the ranking', () => {
    const order = weightedOrder(ranked, Math.random);

    expect([...order].sort()).toEqual([...ranked].sort());
  });

  test('an issue below the top 12 is drawn only as the ones above it are placed', () => {
    // A draw at the top of its range places the last of the 12 issues
    // in the draw, and each place lets the next issue down join them.
    const order = weightedOrder(ranked, () => 0.999_999);

    expect(order.slice(0, 4)).toEqual(['rank 11', 'rank 12', 'rank 13', 'rank 14']);
    expect(weightedOrder(ranked, () => 0)).toEqual(ranked);
  });

  test('every issue at the top can lead, and the higher an issue ranks, the more often it leads', () => {
    const led = leaders(1000);
    const counts = ranked.slice(0, POOL).map((issue) => led.get(issue) ?? 0);

    expect(ranked.slice(POOL).some((issue) => led.has(issue))).toBe(false);
    expect(counts.every((n) => n > 0)).toBe(true);
    for (let rank = 1; rank < counts.length; rank++) {
      expect(counts[rank], `rank ${String(rank)}`).toBeLessThan(counts[rank - 1] ?? 0);
    }
  });

  test('two donors with different draws get different orders, so they spread out', () => {
    const draws = (seed: number) => {
      let state = seed;
      return () => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        return state / 2_147_483_648;
      };
    };

    expect(weightedOrder(ranked, draws(1)).slice(0, 3)).not.toEqual(weightedOrder(ranked, draws(2)).slice(0, 3));
  });
});
