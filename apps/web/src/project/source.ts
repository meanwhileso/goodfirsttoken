import type { ProjectSource } from '@goodfirsttoken/core';

/**
 * How a project got in, in words, for its row on the projects list and its
 * markdown: registered, listed from its docs' AI policy, or listed from a
 * maintainer's post on X.
 */
export function sourceWords(source: ProjectSource, fromPost = false): string {
  if (source === 'registered') return 'registered by its maintainers';
  return fromPost ? "listed from a maintainer's post" : 'listed from its AI policy';
}
