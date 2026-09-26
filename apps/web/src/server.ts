import handler from '@tanstack/react-start/server-entry';
import { redirectToPrimaryDomain } from './redirect';

// The Worker's entry point. A request to a redirect domain is answered here.
// Every other request goes through TanStack Start. Queue consumers, cron
// jobs, and Durable Objects are exported from here as they arrive.
export default {
  fetch: (request, env) => redirectToPrimaryDomain(request, env) ?? handler.fetch(request),
} satisfies ExportedHandler<Env>;
