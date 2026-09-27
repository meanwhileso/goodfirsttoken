import handler from '@tanstack/react-start/server-entry';
import { handleAuthRequest, isAuthPath } from './auth/routes';
import { redirectToPrimaryDomain } from './redirect';

// The Worker's entry point. A request to a redirect domain is answered here.
// Sign-in, under /auth, goes to src/auth/routes.ts. Every other request goes
// through TanStack Start. Queue consumers, cron jobs, and Durable Objects are
// exported from here as they arrive.
export default {
  fetch: (request, env) =>
    redirectToPrimaryDomain(request, env) ?? (isAuthPath(request) ? handleAuthRequest(request) : handler.fetch(request)),
} satisfies ExportedHandler<Env>;
