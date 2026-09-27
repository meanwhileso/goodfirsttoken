import { redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, getResponseHeaders } from '@tanstack/react-start/server';
import { siteOrigin } from '../auth/settings';
import { openConsent } from './authorize';
import { AUTHORIZE_PATH } from './paths';

// Runs on the server for the page where a person approves an agent
// (src/routes/oauth/authorize.tsx), with the query string the agent sent.
// It checks the agent's request and starts the consent. The headers it sends
// set the cookie that ties the form to this browser, and keep the page out of
// frames. The Worker answers a bad request before the page renders
// (src/server.ts), so the redirect and the error here are only for a request
// that changed in between, like a client deleted meanwhile.
export const loadConsent = createServerFn({ method: 'GET' })
  .validator((search: unknown) => (typeof search === 'string' ? search : ''))
  .handler(async ({ data: search }) => {
    const outcome = await openConsent(new URL(`${AUTHORIZE_PATH}${search}`, siteOrigin(getRequest())).toString());
    if ('redirect' in outcome) throw redirect({ href: outcome.redirect, statusCode: 302 });
    const headers = getResponseHeaders();
    for (const [name, value] of outcome.headers) {
      if (name === 'set-cookie') headers.append(name, value);
      else headers.set(name, value);
    }
    return outcome.page;
  });
