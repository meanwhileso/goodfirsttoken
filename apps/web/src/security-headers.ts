import { env } from 'cloudflare:workers';

// The headers every page goes out with, set in src/server.ts on each
// text/html answer, each only where the answer didn't set its own, like the
// page where a person approves an agent. They tell the browser not to guess
// a content type, not to show the page in any frame, what to send as the
// referrer, and that the page uses no camera, microphone, or location.
//
// The policy leaves out form-action, which would stop the approval page's
// redirect to an agent on this computer, and to GitHub, and script-src,
// since TanStack Start writes its hydration scripts inline. Nonces for them
// can come later. docs/architecture.md says more, under Threat model.

/**
 * The Content-Security-Policy every page gets. A page that sets its own,
 * like the page to approve an agent, sends this one, so none is weaker.
 */
export const PAGE_CSP = "frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'content-security-policy': PAGE_CSP,
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

// A year, for this host alone. No includeSubDomains, since other hosts
// under the domain aren't ours to promise for, and no preload.
const HSTS = 'max-age=31536000';

/**
 * `response` with the page headers when it is a page, and HSTS when it
 * answers https on the primary domain. A WebSocket's answer goes as it is.
 */
export function withSecurityHeaders(request: Request, response: Response): Response {
  if (response.status === 101 || response.webSocket) return response;
  const url = new URL(request.url);
  const primary = env.PRIMARY_DOMAIN.trim().toLowerCase();
  const hsts = primary !== '' && url.protocol === 'https:' && url.hostname === primary;
  const page = /^text\/html\b/i.test(response.headers.get('content-type') ?? '');
  if (!hsts && !page) return response;
  // The answer's headers can be immutable, as a fetched answer's are.
  const answer = new Response(response.body, response);
  if (page) {
    for (const [name, value] of Object.entries(PAGE_HEADERS)) {
      if (!answer.headers.has(name)) answer.headers.set(name, value);
    }
  }
  if (hsts && !answer.headers.has('strict-transport-security')) answer.headers.set('strict-transport-security', HSTS);
  return answer;
}
