import { issueRef, validate } from '@goodfirsttoken/core';

// Which issue a page's path names, for the server and the page alike.

/**
 * Owners whose paths belong to the site: sign-in and the MCP server. The
 * Worker answers them before any page, and the page answers 404 for them too.
 */
const RESERVED_OWNERS = new Set(['auth', 'mcp', 'oauth']);

/**
 * The issue a page's path names, like `owner/name#12`, or null when it names
 * none: an owner, repo, or number GitHub couldn't have, or an owner whose
 * paths belong to the site.
 */
export function issueFromPath(owner: string, repo: string, number: string): string | null {
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  const issue = `${owner}/${repo}#${number}`;
  return validate(issueRef, issue).ok ? issue : null;
}
