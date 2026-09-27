import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cookieProblems, expect, test } from './fixtures';
import { SITE, STATIC_HOST } from './hosts';

// The cookie check in fixtures.ts runs after every test. The site sets no
// cookies yet, so these tests show that it sees the responses and that a bad
// cookie fails the test that saw it.

test('the cookie check reads the responses of every page and request, from the site and the static host', async ({
  page,
  request,
  responses,
}) => {
  await page.goto('/design');
  await page.evaluate(() => document.fonts.ready);
  await request.get('/healthz');

  const origins = new Set((await responses()).map(({ url }) => new URL(url).origin));
  expect([...origins]).toEqual(expect.arrayContaining([SITE, STATIC_HOST]));
  const urls = (await responses()).map(({ url }) => url);
  expect(urls).toContain(`${SITE}/healthz`);
});

type Answer = { status?: number; headers: Record<string, string>; body?: string };

// A server on this machine that answers each path with its answer, and any
// other path with the answer for '*'.
async function probe(host: string, answers: Record<string, Answer>) {
  const server = createServer((req, res) => {
    const answer = answers[req.url ?? ''] ?? answers['*'] ?? { status: 404, headers: {} };
    res.writeHead(answer.status ?? 200, answer.headers);
    res.end(answer.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://${host}:${String(port)}`, close: () => server.close() };
}

test.describe('a page whose site and static host answer with bad cookies', () => {
  // Chromium doesn't report the Set-Cookie of an answer a route makes up, so
  // the bad cookies come over the network, from two servers this test runs.
  // The check takes the first as the site and the second as the static host.
  // They are on two hosts, as the site and the static host are.
  test.use({
    // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures a function needs from this pattern.
    cookieHosts: async ({}, use) => {
      const staticHost = await probe('127.0.0.1', {
        '*': {
          headers: {
            'content-type': 'text/css',
            'access-control-allow-origin': '*',
            'set-cookie': '__cf_bm=abc; Path=/; Secure; HttpOnly',
          },
          body: 'p { color: rgb(1, 2, 3); }',
        },
      });
      const site = await probe('localhost', {
        '/': {
          headers: { 'content-type': 'text/html', 'set-cookie': 'session=abc; Path=/' },
          body: `<!doctype html><link rel="stylesheet" href="${staticHost.origin}/assets/probe.css"><p>probe</p>`,
        },
        // The request fixture follows a redirect, so only its cookie jar
        // keeps the cookie this one sets.
        '/redirect': { status: 302, headers: { location: '/landed', 'set-cookie': 'redirected=1; Path=/' } },
        '/landed': { headers: { 'content-type': 'text/plain' }, body: 'landed' },
      });
      await use({ site: site.origin, staticHost: staticHost.origin });
      site.close();
      staticHost.close();
    },
    // The check after this test compares what it found with this list, where
    // every other test expects nothing. So the test fails unless the check
    // reports each bad cookie.
    expectedCookieProblems: [
      'the site set session without the __Host- prefix',
      'the site set session without Secure',
      'the static host set a cookie: __cf_bm=abc; Path=/; Secure; HttpOnly',
      "a browser's cookie jar holds session from the site, which is not a host-only __Host- cookie",
      "the request fixture's cookie jar holds redirected from the site, which is not a host-only __Host- cookie",
    ],
  });

  test('fails the check that runs after it', async ({ page, request, cookieHosts }) => {
    await page.goto(`${cookieHosts.site}/`);
    const landed = await request.get(`${cookieHosts.site}/redirect`);

    // The stylesheet applied, so both of the page's answers reached it, and
    // the request followed the redirect.
    await expect(page.locator('p')).toHaveCSS('color', 'rgb(1, 2, 3)');
    expect(await landed.text()).toBe('landed');
  });
});

test('a cookie from the site without the __Host- prefix, Secure, or Path=/, or with a Domain, fails the check', () => {
  expect(cookieProblems(SITE, '__Host-session=abc; Path=/; Secure; HttpOnly; SameSite=Lax')).toEqual([]);

  for (const bad of [
    'session=abc; Path=/; Secure; HttpOnly',
    '__Host-session=abc; Path=/; HttpOnly',
    '__Host-session=abc; Secure; HttpOnly',
    '__Host-session=abc; Path=/app; Secure',
    '__Host-session=abc; Path=/; Secure; Domain=localhost',
  ]) {
    expect(cookieProblems(SITE, bad), bad).not.toEqual([]);
  }
  expect(cookieProblems(STATIC_HOST, '__Host-session=abc; Path=/; Secure')).not.toEqual([]);
});
