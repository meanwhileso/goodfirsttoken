import handler from '@tanstack/react-start/server-entry';

// The Worker's entry point. Every request goes through TanStack Start. Queue
// consumers, cron jobs, and Durable Objects are exported from here as they
// arrive.
export default {
  fetch: (request) => handler.fetch(request),
} satisfies ExportedHandler<Env>;
