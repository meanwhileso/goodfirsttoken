import type { CrawlPriorityInput } from '@goodfirsttoken/core';

/** Made-up public sources for tests. The Worker must never fetch them. */
export function priorityEvidence(now = Date.now(), changes: Partial<CrawlPriorityInput> = {}): CrawlPriorityInput {
  const at = new Date(now).toISOString();
  return {
    stars: 10000, public: true, archived: false, pushedAt: at, metadataCheckedAt: at,
    maintainerGitHubLogin: 'sample-maintainer', role: 'maintainer',
    roleSourceUrl: 'https://github.com/sample-owner/sample-app/blob/main/MAINTAINERS.md',
    identitySourceUrl: 'https://github.com/sample-maintainer', xHandle: 'sample_person',
    postUrl: 'https://x.com/sample_person/status/123', publishedAt: at, timePrecision: 'exact',
    postKind: 'authored', evidenceCheckedAt: at, ...changes,
  };
}
