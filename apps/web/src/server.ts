import handler from '@tanstack/react-start/server-entry';
import { handleAuthRequest, isAuthPath } from './auth/routes';
import { deliverFeedBatch } from './feed/queue';
import { handleStream, isStreamPath } from './feed/streams';
import { redirectToPrimaryDomain } from './redirect';

// The Worker's entry point. A request to a redirect domain is answered here.
// Sign-in, under /auth, goes to src/auth/routes.ts, and the live text
// streams, like /live.txt, to src/feed/streams.ts. Every other request goes
// through TanStack Start. The feed queue's consumer is src/feed/queue.ts.
// Cron jobs and Durable Objects are exported from here as they arrive.
export { Feed } from './rooms/feed';
export { IssueRoom } from './rooms/issue-room';

export default {
  fetch: (request, env) =>
    redirectToPrimaryDomain(request, env) ??
    (isAuthPath(request)
      ? handleAuthRequest(request)
      : isStreamPath(request)
        ? handleStream(request)
        : handler.fetch(request)),
  queue: (batch, env) => deliverFeedBatch(batch, env),
} satisfies ExportedHandler<Env>;
