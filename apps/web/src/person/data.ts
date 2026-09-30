import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { PAGE_STATUS_HEADER } from '../mcp/paths';
import { loadPerson, type PersonPageResult } from './load';

export type { PersonPage, PersonPageResult, WorkRow, WorkStatus } from './load';

// Runs on the server when a person's page loads, and when someone navigates
// to it. It reads no cookie and sets none. When the database can't answer,
// the page says so with 503, which src/server.ts sets from
// PAGE_STATUS_HEADER. The route answers a page that doesn't exist with 404.
export const getPersonPage = createServerFn({ method: 'GET' })
  .validator((login: unknown): string => (typeof login === 'string' ? login : ''))
  .handler(async ({ data }): Promise<PersonPageResult> => {
    const page = await loadPerson(getRequest(), data);
    if (page.state === 'unavailable') setResponseHeader(PAGE_STATUS_HEADER, '503');
    return page;
  });
