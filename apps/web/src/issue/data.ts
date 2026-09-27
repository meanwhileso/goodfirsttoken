import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { PAGE_STATUS_HEADER } from '../mcp/paths';
import { loadIssue, type IssuePageResult } from './load';

export type { IssuePage, IssuePageResult } from './load';

export interface IssuePath {
  owner: string;
  repo: string;
  number: string;
}

function isIssuePath(value: unknown): value is IssuePath {
  if (typeof value !== 'object' || value === null) return false;
  const path = value as Record<string, unknown>;
  return ['owner', 'repo', 'number'].every((key) => typeof path[key] === 'string');
}

// Runs on the server when an issue page loads, and when someone navigates to
// one. It reads no cookie and sets none. When the database or the room can't
// answer, the page says so with 503, which src/server.ts sets from
// PAGE_STATUS_HEADER. The route answers a page that doesn't exist with 404.
export const getIssuePage = createServerFn({ method: 'GET' })
  .validator((path: unknown): IssuePath => (isIssuePath(path) ? path : { owner: '', repo: '', number: '' }))
  .handler(async ({ data }): Promise<IssuePageResult> => {
    const page = await loadIssue(getRequest(), data.owner, data.repo, data.number);
    if (page.state === 'unavailable') setResponseHeader(PAGE_STATUS_HEADER, '503');
    return page;
  });
