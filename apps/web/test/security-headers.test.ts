import { beforeEach, expect, test } from 'vitest';
import { emptyDatabase } from './db/helpers';
import { authorizeUrl, emptyKv, pkce, registerClient } from './mcp/helpers';
import { Browser, startGitHub } from './auth/helpers';
import { workerFetch } from './worker';

// The headers every page is sent with, which tell the browser not to guess
// a content type, not to show the page in another site's frame, what to send
// as the referrer, and which device features the page never uses. On the
// primary domain over https, pages also say to use https from then on.

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  startGitHub();
});

const PAGE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
const HSTS = 'max-age=31536000';

function headersOf(res: Response, names: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(names.map((name) => [name, res.headers.get(name)]));
}

test.each(['/', '/sign-in', '/leaderboard', '/projects', '/live', '/maintainers', '/no-such-page'])(
  'the page at %s is sent with every security header, and with HSTS on the primary domain over https',
  async (path) => {
    const res = await workerFetch(`https://primary.example${path}`);

    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(headersOf(res, Object.keys(PAGE_HEADERS))).toEqual(PAGE_HEADERS);
    expect(res.headers.get('strict-transport-security')).toBe(HSTS);
  },
);

test('HSTS goes only with https answers from the primary domain, and never asks for subdomains or preload', async () => {
  const plain = await workerFetch('http://primary.example/');
  const elsewhere = await workerFetch('https://localhost/');
  const json = await workerFetch('https://primary.example/healthz');

  expect(plain.headers.get('strict-transport-security')).toBeNull();
  expect(elsewhere.headers.get('strict-transport-security')).toBeNull();
  expect(json.headers.get('strict-transport-security')).toBe(HSTS);
});

test('an answer that is not a page keeps its own headers, with no page policy added', async () => {
  const json = await workerFetch('https://primary.example/healthz');
  const stream = await workerFetch('https://primary.example/live.txt', { method: 'HEAD' });

  for (const res of [json, stream]) {
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('x-frame-options')).toBeNull();
  }
  expect(stream.headers.get('x-content-type-options')).toBe('nosniff');
});

test('the page to approve an agent, and its error page, get the full policy every page gets, and keep their own caching', async () => {
  const clientId = await registerClient();
  const { challenge } = await pkce();

  const res = await new Browser().fetch(authorizeUrl(clientId, { challenge }).toString());
  const error = await new Browser().fetch('/oauth/authorize?client_id=nope');

  expect(error.status).toBe(400);
  expect(headersOf(error, Object.keys(PAGE_HEADERS))).toEqual(PAGE_HEADERS);
  expect(error.headers.get('cache-control')).toBe('no-store');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-security-policy')).toBe(PAGE_HEADERS['content-security-policy']);
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  expect(res.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
});
