import handler from '@tanstack/react-start/server-entry';
import { handleAuthRequest, isAuthPath } from './auth/routes';
import { siteOrigin } from './auth/settings';
import { answerConsent, limitAgentSignIn, refuseAuthorizeRequest } from './mcp/authorize';
import { AUTHORIZE_PATH } from './mcp/paths';
import { mcpProvider } from './mcp/provider';
import { redirectToPrimaryDomain } from './redirect';

// The Worker's entry point. A request to a redirect domain is answered here,
// and so is an agent's sign-in over the sign-in limit. Everything else goes
// through the MCP server's OAuth provider (src/mcp/provider.ts), which
// answers /mcp and the OAuth routes, and hands the rest to the site below.
// Queue consumers, cron jobs, and Durable Objects are exported from here as
// they arrive.

// The site: sign-in under /auth (src/auth/routes.ts), the page where a person
// approves an agent (src/mcp/authorize.ts), and TanStack Start for every
// page.
const site: ExportedHandler<Env> = {
  fetch: async (request) => {
    if (isAuthPath(request)) return handleAuthRequest(request);
    const { pathname } = new URL(request.url);
    if (pathname === AUTHORIZE_PATH) {
      if (request.method === 'POST') return answerConsent(request);
      // A request the page can't show goes back to the agent, or gets an
      // error with its own status, which a rendered page can't have.
      const refused = await refuseAuthorizeRequest(request);
      if (refused) return refused;
    }
    return handler.fetch(request);
  },
};

export { IssueRoom } from './rooms/issue-room';

export default {
  fetch: async (request, env, ctx) =>
    redirectToPrimaryDomain(request, env) ??
    (await limitAgentSignIn(request)) ??
    mcpProvider(siteOrigin(request), site).fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;
