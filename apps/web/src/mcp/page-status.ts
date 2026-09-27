import { PAGE_STATUS_HEADER } from './paths';

/** The statuses a page can name for itself, besides 200. */
const PAGE_STATUSES = new Set([400, 429, 503]);

/**
 * TanStack Start renders every page with 200. The page where a person
 * approves an agent, and an issue page that can't be read, name their own
 * status in PAGE_STATUS_HEADER, and this sets it, when it is one of these.
 * The header never leaves the Worker.
 */
export function withPageStatus(response: Response): Response {
  if (!response.headers.has(PAGE_STATUS_HEADER)) return response;
  const named = Number(response.headers.get(PAGE_STATUS_HEADER));
  const headers = new Headers(response.headers);
  headers.delete(PAGE_STATUS_HEADER);
  const status = PAGE_STATUSES.has(named) ? named : response.status;
  return new Response(response.body, { status, statusText: '', headers });
}
