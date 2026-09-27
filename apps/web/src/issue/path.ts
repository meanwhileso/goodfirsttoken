import { issueRef, repoName, validate } from '@goodfirsttoken/core';

// Which issue or project a page's path names, for the server and the page alike.

/**
 * Owners whose paths belong to the site: sign-in and the MCP server. The
 * Worker answers them before any page, and the page answers 404 for them too.
 */
const RESERVED_OWNERS = new Set(['auth', 'mcp', 'oauth']);

/**
 * Owners with pages of the site's own under them, like /dev/seed, which
 * TanStack Router matches ahead of a project's page. They belong to the site
 * the same way. docs/architecture.md, under The site's own paths, says why
 * each one is here.
 */
const SITE_PAGE_OWNERS = new Set(['dev']);

/** Whether an owner's paths belong to the site, so no project or issue has a page under it. */
function ownedBySite(owner: string): boolean {
  const name = owner.toLowerCase();
  return RESERVED_OWNERS.has(name) || SITE_PAGE_OWNERS.has(name);
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
