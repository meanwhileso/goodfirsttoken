import { createServerFn } from '@tanstack/react-start';
import { getRequest, getResponseHeaders } from '@tanstack/react-start/server';
import { openConsent } from './authorize';
import { PAGE_STATUS_HEADER } from './paths';

// Runs on the server for the page where a person approves an agent
// (src/routes/oauth/authorize.tsx), with the query string the agent sent.
// It checks the agent's request and starts the consent, or says why there is
// none. It also answers on its own URL under /_serverFn/, which anyone can
// call, so openConsent counts each call toward the sign-in limit. A call the
// browser's Sec-Fetch headers say another site's page made gets 400. The headers
// it sends set the cookie that ties the form to this browser, and keep the
// page out of frames. TanStack Start renders every page with 200, so the
// page's status goes in PAGE_STATUS_HEADER, and src/server.ts sets it.
export const loadConsent = createServerFn({ method: 'GET' })
  .validator((search: unknown) => (typeof search === 'string' ? search : ''))
  .handler(async ({ data: search }) => {
    const outcome = await openConsent(getRequest(), search);
    const headers = getResponseHeaders();
    for (const [name, value] of outcome.headers) {
      if (name === 'set-cookie') headers.append(name, value);
      else headers.set(name, value);
    }
    if (outcome.status !== 200) headers.set(PAGE_STATUS_HEADER, String(outcome.status));
    return outcome.page;
  });
