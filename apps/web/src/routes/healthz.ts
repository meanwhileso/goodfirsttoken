import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';

// Reads nothing but the environment name, so it answers even when storage or
// GitHub is down, and a deploy's smoke test can tell which environment it hit.
export const Route = createFileRoute('/healthz')({
  server: {
    handlers: {
      GET: () =>
        Response.json(
          { ok: true, environment: env.ENVIRONMENT },
          { headers: { 'cache-control': 'no-store' } },
        ),
    },
  },
});
