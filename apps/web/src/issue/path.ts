import { issueRef, repoName, validate } from '@goodfirsttoken/core';

// Which issue or project a page's path names, for the server and the page alike.

/**
 * Owners whose paths belong to the site: sign-in, the MCP server and its
 * OAuth routes, the admin pages, and the dev routes. No project and no issue
 * has a page under them, and both pages answer 404 for them.
 * docs/architecture.md, under The site's own paths, says why each one is
 * here.
 */
const RESERVED_OWNERS = new Set(['admin', 'auth', 'dev', 'mcp', 'oauth']);

/** Whether an owner's paths belong to the site, so no project or issue has a page under it. */
export function ownedBySite(owner: string): boolean {
  return RESERVED_OWNERS.has(owner.toLowerCase());
}

/**
 * The issue a page's path names, like `owner/name#12`, or null when it names
 * none: an owner, repo, or number GitHub couldn't have, or an owner whose
 * paths belong to the site.
 */
export function issueFromPath(owner: string, repo: string, number: string): string | null {
  if (ownedBySite(owner)) return null;
  const issue = `${owner}/${repo}#${number}`;
  return validate(issueRef, issue).ok ? issue : null;
}

/**
 * The repo a project page's path names, like `owner/name`, or null when it
 * names none, by the same rule as issueFromPath.
 */
export function repoFromPath(owner: string, repo: string): string | null {
  if (ownedBySite(owner)) return null;
  const name = `${owner}/${repo}`;
  return validate(repoName, name).ok ? name : null;
}
