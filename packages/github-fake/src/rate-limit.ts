// GitHub's primary rate limits. Every call counts against its caller's
// budget for one resource, and every answer says how much of the budget is
// left, in the x-ratelimit headers. A person's calls share one budget,
// whichever of their tokens made them. Past the limit, REST answers 403 and
// GraphQL answers 200 with a RATE_LIMITED error, both with nothing left.
//
// https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
// https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api

import type { FakeState } from './state.ts';

export type RateResource = 'core' | 'graphql' | 'search';

export interface RateWindow {
  limit: number;
  used: number;
  // When the budget starts over, as an ISO time.
  resetAt: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// What a caller gets for each resource, signed in or not. GraphQL needs a
// token, so it has no budget for anyone else.
const RULES: Record<RateResource, { signedIn: number; anonymous: number; period: number }> = {
  core: { signedIn: 5000, anonymous: 60, period: HOUR },
  graphql: { signedIn: 5000, anonymous: 0, period: HOUR },
  search: { signedIn: 30, anonymous: 10, period: MINUTE },
};

function knownResource(resource: string): RateResource | null {
  switch (resource) {
    case 'core':
      return 'core';
    case 'graphql':
      return 'graphql';
    case 'search':
      return 'search';
    default:
      return null;
  }
}

// The resource a call counts against.
export function resourceOf(path: string): RateResource {
  if (path === '/graphql') return 'graphql';
  return path.startsWith('/search/') ? 'search' : 'core';
}

// The caller's budget for the resource, started over when its time is up.
// `who` is a person's login, an OAuth app as `app:<client ID>`, or null for
// a call with no credentials.
export function rateWindow(state: FakeState, who: string | null, resource: RateResource, now: Date): RateWindow {
  const key = who === null ? 'anonymous' : who.toLowerCase();
  // The caller and the resource name keys in plain objects, where a key like
  // __proto__ would reach Object.prototype. No GitHub login is named like
  // that, and only the three resources are known.
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    throw new Error(`No GitHub caller is named ${key}`);
  }
  const known = knownResource(resource);
  if (!known) throw new Error(`No rate limit is named ${resource}`);
  const windows = ((state.rateLimits ??= {})[key] ??= {});
  const current = windows[known];
  if (current && Date.parse(current.resetAt) > now.getTime()) return current;
  const rule = RULES[known];
  const fresh = {
    limit: who === null ? rule.anonymous : rule.signedIn,
    used: 0,
    resetAt: new Date(now.getTime() + rule.period).toISOString(),
  };
  windows[known] = fresh;
  return fresh;
}

export function rateHeaders(window: RateWindow, resource: RateResource): Record<string, string> {
  return {
    'x-ratelimit-limit': String(window.limit),
    'x-ratelimit-remaining': String(Math.max(0, window.limit - window.used)),
    'x-ratelimit-used': String(window.used),
    'x-ratelimit-reset': String(Math.floor(Date.parse(window.resetAt) / 1000)),
    'x-ratelimit-resource': resource,
  };
}
