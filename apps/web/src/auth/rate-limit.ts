import { env } from 'cloudflare:workers';

// Cloudflare rate limiting on the sign-in endpoints: the site's sign-in, and
// an agent's sign-in to the MCP server. Both count against SIGN_IN_LIMITER,
// per client address. An agent's registration counts on the same limiter
// under a key of its own, so registrations can't use up an address's sign-ins
// on the site. Requests to the MCP server's token endpoint count against
// TOKEN_LIMITER, per client address too, with a limit of their own, since one
// host can refresh tokens for many people's agents. Opening a live text
// stream or a page's live socket counts against STREAM_LIMITER, per client
// address.

const DOTTED_TAIL = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// The eight 16-bit groups of an IPv6 address, or null when it isn't one. An
// IPv4 address at its end, as in ::ffff:198.51.100.7, becomes its last two
// groups.
function ipv6Groups(address: string): number[] | null {
  let hex = address;
  const dotted = DOTTED_TAIL.exec(address);
  if (dotted) {
    const [a = 256, b = 256, c = 256, d = 256] = dotted.slice(1).map(Number);
    if ([a, b, c, d].some((byte) => byte > 255)) return null;
    hex = `${address.slice(0, dotted.index)}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
  }
  const halves = hex.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const left = parse(halves[0] ?? '');
  const right = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const missing = 8 - left.length - right.length;
  // A :: stands for at least one group of zeros, and without one there are eight.
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

/**
 * Whom the rate limiter counts a request against: an IPv4 address, or the
 * /64 an IPv6 address is in, since one IPv6 client can pick any address in
 * its /64. An IPv4 address written as IPv6, in any form, counts as the IPv4
 * address. Cloudflare sets cf-connecting-ip on every request that reaches
 * the Worker.
 */
export function limiterKey(address: string | null): string {
  if (!address) return 'unknown';
  const lower = address.trim().toLowerCase();
  if (!lower.includes(':')) return lower;
  const groups = ipv6Groups(lower);
  // An address that can't be read counts on its own.
  if (!groups) return lower;
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = groups;
  if ([g0, g1, g2, g3, g4].every((group) => group === 0) && g5 === 0xffff) {
    return [g6 >> 8, g6 & 255, g7 >> 8, g7 & 255].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

/** True while the request's client is under the sign-in limit, counting this request. */
export async function underSignInLimit(request: Request): Promise<boolean> {
  const { success } = await env.SIGN_IN_LIMITER.limit({ key: limiterKey(request.headers.get('cf-connecting-ip')) });
  return success;
}

/**
 * True while the request's client is under its limit on registering agents,
 * counting this request. It is the sign-in limit's number, counted apart.
 */
export async function underRegisterLimit(request: Request): Promise<boolean> {
  const { success } = await env.SIGN_IN_LIMITER.limit({
    key: `register:${limiterKey(request.headers.get('cf-connecting-ip'))}`,
  });
  return success;
}

/** True while the request's client is under the limit on opening streams and live sockets, counting this request. */
export async function underStreamLimit(request: Request): Promise<boolean> {
  const { success } = await env.STREAM_LIMITER.limit({ key: limiterKey(request.headers.get('cf-connecting-ip')) });
  return success;
}

/** True while the request's client is under the limit on the MCP server's token endpoint, counting this request. */
export async function underTokenLimit(request: Request): Promise<boolean> {
  const { success } = await env.TOKEN_LIMITER.limit({ key: limiterKey(request.headers.get('cf-connecting-ip')) });
  return success;
}

/** The answer to a sign-in request over the limit. */
export function tooManySignIns(): Response {
  return new Response('Too many sign-ins from here. Try again in a minute.\n', {
    status: 429,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '60' },
  });
}
