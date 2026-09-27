import handler from '@tanstack/react-start/server-entry';
import { handleAuthRequest, isAuthPath } from './auth/routes';
import { siteOrigin } from './auth/settings';
import { deliverFeedBatch } from './feed/queue';
import { handleStream, isStreamPath } from './feed/streams';
import { answerConsent, limitAgentSignIn } from './mcp/authorize';
import { endRevokedConnection, revocationToken } from './mcp/connections';
import { withPageStatus } from './mcp/page-status';
import { AUTHORIZE_PATH } from './mcp/paths';
import { mcpProvider } from './mcp/provider';
import { redirectToPrimaryDomain } from './redirect';

// The Worker's entry point. A request to a redirect domain is answered here,
// and so is an agent's sign-in over its limit. Everything else goes through
// the MCP server's OAuth provider (src/mcp/provider.ts), which answers /mcp
// and the OAuth routes, and hands the rest to the site below. When an agent
// revokes its grant at the token endpoint, its connection ends here too. The
// feed queue's consumer is src/feed/queue.ts. Cron jobs and Durable Objects
// are exported from here as they arrive.

// The site: sign-in under /auth (src/auth/routes.ts), the live text streams,
// like /live.txt (src/feed/streams.ts), the form on the page where a person
// approves an agent (src/mcp/authorize.ts), and TanStack Start for every
// page.
const site: ExportedHandler<Env> = {
  fetch: async (request) => {
    if (isAuthPath(request)) return handleAuthRequest(request);
    if (isStreamPath(request)) return handleStream(request);
    if (new URL(request.url).pathname === AUTHORIZE_PATH && request.method === 'POST') return answerConsent(request);
    return withPageStatus(await handler.fetch(request));
  },
};

export { Feed } from './rooms/feed';
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
  queue: (batch, env) => deliverFeedBatch(batch, env),
} satisfies ExportedHandler<Env>;
