import { createServerFn } from '@tanstack/react-start';
import { getRequest, getResponseHeaders } from '@tanstack/react-start/server';
import { loadAdminPage, type AdminPageParams, type AdminPageResult } from './page';

export type { AdminPage, AdminPageResult, BlockedDonor, PageKind, PolicyListing } from './page';

function isParams(value: unknown): value is AdminPageParams {
  if (typeof value !== 'object' || value === null) return false;
  const params = value as Record<string, unknown>;
  return ['notice', 'sig', 'after'].every((key) => params[key] === undefined || typeof params[key] === 'string');
}

// Runs on the server when /admin loads. It answers on its own URL under
// /_serverFn/ too, which anyone can call, so loadAdminPage checks who is
// signed in and their permission before it reads anything, and a caller who
// isn't an admin gets no data.
export const getAdminPage = createServerFn({ method: 'GET' })
  .validator((params: unknown): AdminPageParams => (isParams(params) ? params : {}))
  .handler(async ({ data }): Promise<AdminPageResult> => {
    const { result, setCookies } = await loadAdminPage(getRequest(), data);
    for (const cookie of setCookies) getResponseHeaders().append('set-cookie', cookie);
    // The page holds the signed-in person's own data, so no browser or cache
    // keeps it, and it is gone after sign-out.
    getResponseHeaders().set('cache-control', 'no-store');
    return result;
  });
