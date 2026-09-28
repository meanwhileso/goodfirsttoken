import type { PrMode } from '@goodfirsttoken/core';

// The projects list's filter and search, which run in the page. They import
// only types, so the server and the page could run them alike.

/** The filter chips, in order. `all` shows every PR mode. */
export const PR_FILTERS = ['all', 'automatic PRs', 'reviewed PRs'] as const;
export type PrFilter = (typeof PR_FILTERS)[number];

const MODE_OF: Record<PrFilter, PrMode | null> = {
  all: null,
  'automatic PRs': 'automatic',
  'reviewed PRs': 'reviewed',
};

/**
 * The projects the filter and the search leave, in the order given. A
 * project passes the filter when its PR mode is the one chosen, or any with
 * `all`. It matches the search when its repo, or one of its tags, holds
 * the words searched for, ignoring case and the spaces around them. An
 * empty search matches every project.
 */
export function filterProjects<T extends { repo: string; tags: readonly string[]; prMode: PrMode }>(
  projects: readonly T[],
  filter: PrFilter,
  search: string,
): T[] {
  const mode = MODE_OF[filter];
  const words = search.trim().toLowerCase();
  return projects.filter(
    (project) =>
      (mode === null || project.prMode === mode) &&
      (words === '' ||
        project.repo.toLowerCase().includes(words) ||
        project.tags.some((tag) => tag.toLowerCase().includes(words))),
  );
}
