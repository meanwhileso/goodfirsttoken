import handler from '@tanstack/react-start/server-entry';
import { handleAuthRequest, isAuthPath } from './auth/routes';
import { siteOrigin } from './auth/settings';
import { answerCard, isCardPath } from './cards/route';
import { isCrawlQueue, readCrawlBatch } from './crawl/queue';
import { deliverFeedBatch } from './feed/queue';
import { handleStream, isStreamPath } from './feed/streams';
import { answerConsent, limitAgentSignIn } from './mcp/authorize';
import { endRevokedConnection, revocationToken } from './mcp/connections';
import { withPageStatus } from './mcp/page-status';
import { AUTHORIZE_PATH } from './mcp/paths';
import { mcpProvider } from './mcp/provider';
import { handleReadable, readableRoute } from './readable/routes';
import { redirectToPrimaryDomain } from './redirect';
import { handleStart, isStartPath } from './start/start';
import { runScheduled } from './sync/scheduled';

// The Worker's entry point. A request to a redirect domain is answered here,
// and so is an agent's sign-in over its limit. Everything else goes through
// the MCP server's OAuth provider (src/mcp/provider.ts), which answers /mcp
// and the OAuth routes, and hands the rest to the site below. When an agent
// revokes its grant at the token endpoint, its connection ends here too. The
// feed queue's consumer is src/feed/queue.ts, and the crawl queue's is
// src/crawl/queue.ts. The cron triggers' jobs, which read GitHub with the
// service token, are in src/sync/ and src/crawl/. The Durable Objects are
// exported from here.

// The site: sign-in under /auth (src/auth/routes.ts), the live text streams,
// like /live.txt (src/feed/streams.ts), /start.md (src/start/start.ts), the
// share cards, like /card.png (src/cards/route.ts), the form on the page
// where a person approves an agent (src/mcp/authorize.ts), the pages'
// markdown versions, /llms.txt, /robots.txt, /sitemap.xml, and the JSON data
// (src/readable/routes.ts), and TanStack Start for every page.
const site: ExportedHandler<Env> = {
  fetch: async (request) => {
    if (isAuthPath(request)) return handleAuthRequest(request);
    if (isStreamPath(request)) return handleStream(request);
    if (isStartPath(request)) return handleStart(request);
    if (isCardPath(request)) return answerCard(request);
    if (new URL(request.url).pathname === AUTHORIZE_PATH && request.method === 'POST') return answerConsent(request);
    const readable = readableRoute(request);
    const answered = readable && (await handleReadable(request, readable));
    if (answered) return answered;
    return varyByAccept(withPageStatus(await handler.fetch(request)));
  },
};

/**
 * A page's HTML shares its URL with its markdown version, which a request
 * gets with `Accept: text/markdown`, so a cache keeps the two apart.
 */
function varyByAccept(response: Response): Response {
  if (!response.headers.get('content-type')?.startsWith('text/html')) return response;
  const headers = new Headers(response.headers);
  headers.append('vary', 'Accept');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

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
  queue: async (batch, env) => {
    if (isCrawlQueue(batch.queue)) await readCrawlBatch(batch, env);
    else await deliverFeedBatch(batch, env);
  },
  scheduled: (controller, env) => runScheduled(controller.cron, env),
} satisfies ExportedHandler<Env>;
