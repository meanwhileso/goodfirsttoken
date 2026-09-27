import { isDevelopment } from '../auth/settings';

// The gate for the dev-only routes, /dev/seed and /dev/work. Each exists
// only in development, the check the dev sign-in uses (src/auth/settings.ts),
// and only for a request to this machine by a loopback hostname. Neither
// calls GitHub, so a Worker deployed with the local config would pass the
// first check. The second keeps it from answering on a public hostname.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True when a dev-only route may answer this request. */
export function devOnlyRequest(request: Request): boolean {
  return isDevelopment() && LOOPBACK.has(new URL(request.url).hostname);
}
