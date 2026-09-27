import handler from '@tanstack/react-start/server-entry';
import { handleAuthRequest, isAuthPath } from './auth/routes';
import { siteOrigin } from './auth/settings';
import { answerConsent, limitAgentSignIn } from './mcp/authorize';
import { endRevokedConnection, revocationToken } from './mcp/connections';
import { AUTHORIZE_PATH, PAGE_STATUS_HEADER } from './mcp/paths';
import { mcpProvider } from './mcp/provider';
import { redirectToPrimaryDomain } from './redirect';

// The Worker's entry point. A request to a redirect domain is answered here,
// and so is an agent's sign-in over the sign-in limit. Everything else goes
// through the MCP server's OAuth provider (src/mcp/provider.ts), which
// answers /mcp and the OAuth routes, and hands the rest to the site below.
// When an agent revokes its grant at the token endpoint, its connection ends
// here too. Queue consumers, cron jobs, and Durable Objects are exported from
// here as they arrive.

// TanStack Start renders every page with 200. The page where a person
// approves an agent names its own status in a header, and this sets it.
function withPageStatus(response: Response): Response {
  const status = Number(response.headers.get(PAGE_STATUS_HEADER));
  if (!status) return response;
  const headers = new Headers(response.headers);
  headers.delete(PAGE_STATUS_HEADER);
  return new Response(response.body, { status, headers });
}

// The site: sign-in under /auth (src/auth/routes.ts), the form on the page
// where a person approves an agent (src/mcp/authorize.ts), and TanStack Start
// for every page.
const site: ExportedHandler<Env> = {
  fetch: async (request) => {
    if (isAuthPath(request)) return handleAuthRequest(request);
    if (new URL(request.url).pathname === AUTHORIZE_PATH && request.method === 'POST') return answerConsent(request);
    return withPageStatus(await handler.fetch(request));
  },
};

export { IssueRoom } from './rooms/issue-room';

export default {
  fetch: async (request, env, ctx) => {
    const early = redirectToPrimaryDomain(request, env) ?? (await limitAgentSignIn(request));
    if (early) return early;
    const origin = siteOrigin(request);
    const revoking = await revocationToken(request);
    const response = await mcpProvider(origin, site).fetch(request, env, ctx);
    if (revoking !== null && response.ok) await endRevokedConnection(origin, revoking);
    return response;
  },
} satisfies ExportedHandler<Env>;
