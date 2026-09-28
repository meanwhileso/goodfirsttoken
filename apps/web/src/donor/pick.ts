import type { Interests } from '@goodfirsttoken/core';

// How suggest_issues orders the issues waiting for an agent: ranked against
// the donor's interests, then drawn at random with weight toward the top, so
// donors asking at the same moment spread out across issues. The rules are
// in docs/how-it-works.md, under The donor's tools.

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

/** How many of the issues not placed yet each place in the random order is drawn from. */
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
 * Whether the issue's title or one of its labels has the kind of work named,
 * without case: words in a row, each starting with a word of the kind less a
 * plural s. So tests matches test and testing, docs matches documentation,
 * and error handling matches error-handling.
 */
function namesKind(interest: string, candidate: Candidate): boolean {
  const stems = words(interest)
    .map((word) => word.replace(/s$/, ''))
    .filter((stem) => stem !== '');
  if (stems.length === 0) return false;
  return [candidate.title, ...candidate.labels].some((text) => {
    const found = words(text);
    return found.some((_, at) => stems.every((stem, i) => found[at + i]?.startsWith(stem) ?? false));
  });
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
 * The ranking in a random order with weight toward the top, one issue at a
 * time. Each issue is drawn when the caller asks for the next one, from the
 * first POOL issues not placed yet, each weighted by how many places are
 * left from it to the bottom of those: of 12, the first has weight 12 and
 * the twelfth 1. An issue lower down joins the draw as the ones above it
 * are placed, so a caller that passes over an issue comes to the rest of
 * the ranking in turn. A caller that stops after a few issues makes a draw
 * for each of them alone. `random` gives a number from 0 up to 1, like
 * Math.random.
 */
export function* weightedOrder<T>(ranked: readonly T[], random: () => number): Generator<T, void, undefined> {
  const pool = ranked.slice(0, POOL);
  let below = pool.length;
  while (pool.length > 0) {
    const size = pool.length;
    let draw = random() * ((size * (size + 1)) / 2);
    let at = size - 1;
    for (let place = 0; place < size; place++) {
      draw -= size - place;
      if (draw < 0) {
        at = place;
        break;
      }
    }
    const placed = pool.splice(at, 1);
    // The next issue down joins the draw.
    pool.push(...ranked.slice(below, below + 1));
    below += 1;
    yield* placed;
  }
}
