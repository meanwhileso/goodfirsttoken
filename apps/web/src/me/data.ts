import { createServerFn } from '@tanstack/react-start';
import { getRequest, getResponseHeaders } from '@tanstack/react-start/server';
import { noticeParams, type NoticeParams } from '../auth/notice-params';
import { loadMePage, type MePageResult } from './page';

export type { MePage, MePageResult, Queue } from './page';

// Runs on the server when /me loads. It answers on its own URL under
// /_serverFn/ too, which anyone can call, so loadMePage reads the session
// first, reads nothing for someone signed out, and reads only the signed-in
// person's own agents, queue, and interests. Any cookie Better Auth set
// while it checked the session goes back with the response.
export const getMePage = createServerFn({ method: 'GET' })
  .validator((params: unknown): NoticeParams => noticeParams(params))
  .handler(async ({ data }): Promise<MePageResult> => {
    const { result, setCookies } = await loadMePage(getRequest(), data);
    for (const cookie of setCookies) getResponseHeaders().append('set-cookie', cookie);
    // The page holds the signed-in person's own data, so no browser or cache
    // keeps it, and it is gone after sign-out.
    getResponseHeaders().set('cache-control', 'no-store');
    return result;
  });
