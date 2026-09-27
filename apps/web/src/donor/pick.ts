import type { Interests } from '@goodfirsttoken/core';

// How suggest_issues orders the issues waiting for an agent: ranked against
// the donor's interests, then the top of the list in a random order with
// weight toward the top, so donors asking at the same moment spread out
// across issues. The rules are in docs/how-it-works.md, under The donor's
// tools.

/** An issue waiting for an agent, as the ranking sees it. */
export interface Candidate {
  /** The issue, like `owner/name#12`. */
  issue: string;
  /** The project's code repo. */
  project: string;
  title: string;
  labels: readonly string[];
  /** The main language of the project's code repo, or null. */
  language: string | null;
  /** Claims on the issue holding a slot now. */
  holding: number;
}

/** How many issues from the top of the ranking the random order draws from. */
export const POOL = 12;

const lower = (text: string) => text.toLowerCase();

/** The words in a text, in lower case: runs of letters and digits. */
function words(text: string): string[] {
  return lower(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Whether the donor named the project: its code repo or issue repo as
 * owner/name, or the owner or the name alone, without case.
 */
function namesProject(interest: string, candidate: Candidate): boolean {
  const wanted = lower(interest.trim());
  const issueRepo = candidate.issue.slice(0, candidate.issue.lastIndexOf('#'));
  return [candidate.project, issueRepo].some((repo) => {
    const [owner = '', name = ''] = lower(repo).split('/');
    return wanted === lower(repo) || wanted === owner || wanted === name;
  });
}

/** Whether the project's language, or one of the issue's labels, is the language named, without case. */
function namesLanguage(interest: string, candidate: Candidate): boolean {
  const wanted = lower(interest.trim());
  return (candidate.language !== null && lower(candidate.language) === wanted) || candidate.labels.some((l) => lower(l) === wanted);
}

/**
 * Whether a word of the issue's title or labels starts with the kind of work
 * named, less a plural s, without case: tests matches test and testing, and
 * docs matches documentation.
 */
function namesKind(interest: string, candidate: Candidate): boolean {
  const stem = lower(interest.trim()).replace(/s$/, '');
  if (stem === '') return false;
  return [candidate.title, ...candidate.labels].some((text) => words(text).some((word) => word.startsWith(stem)));
}

/**
 * How well the issue matches the donor's interests: 4 when they named its
 * project, 2 when they named its language, and 1 for each kind of work they
 * named that it matches.
 */
export function interestScore(candidate: Candidate, interests: Interests | null): number {
  if (interests === null) return 0;
  const project = interests.projects.some((p) => namesProject(p, candidate)) ? 4 : 0;
  const language = interests.languages.some((l) => namesLanguage(l, candidate)) ? 2 : 0;
  const kinds = interests.kinds.filter((k) => namesKind(k, candidate)).length;
  return project + language + kinds;
}

/**
 * The candidates, best match for the donor's interests first. Among equal
 * matches, the issue with fewer claims holding a slot comes first, then the
 * order they came in: the oldest project first, then by issue.
 */
export function rankIssues<T extends Candidate>(candidates: readonly T[], interests: Interests | null): T[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, score: interestScore(candidate, interests) }))
    .sort((a, b) => b.score - a.score || a.candidate.holding - b.candidate.holding || a.index - b.index)
    .map(({ candidate }) => candidate);
}

/**
 * The top of the ranking, up to POOL issues, in a random order with weight
 * toward the top. Each place is drawn from the issues not placed yet, each
 * with a weight of how many issues are left from it to the bottom of the
 * pool: of 12, the first has weight 12 and the last 1. `random` gives a
 * number from 0 up to 1, like Math.random. Every draw is made before this
 * returns, so calls at the same moment never share one.
 */
export function weightedOrder<T>(ranked: readonly T[], random: () => number): T[] {
  const left = ranked.slice(0, POOL).map((item, rank, pool) => ({ item, weight: pool.length - rank }));
  const order: T[] = [];
  while (left.length > 0) {
    const total = left.reduce((sum, entry) => sum + entry.weight, 0);
    let draw = random() * total;
    let at = left.findIndex((entry) => (draw -= entry.weight) < 0);
    if (at < 0) at = left.length - 1;
    const [taken] = left.splice(at, 1);
    if (taken) order.push(taken.item);
  }
  return order;
}
