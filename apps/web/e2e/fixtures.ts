import {
  test as base,
  expect,
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Cookie,
} from '@playwright/test';
import { SITE, STATIC_HOST } from './hosts';

// Every test imports `test` from here, and a lint rule holds the spec files
// to it. Its fixtures read each Set-Cookie header on every response the tests
// see, from every browser context and from the `request` fixture, and the
// cookie jars those keep. A cookie from the site has to be host-only with the
// __Host- prefix, so a browser never sends it to the static host. The static
// host sets none. Any other cookie fails the test that saw it. Responses from
// other origins, like the GitHub fake, are GitHub's, and not checked.
export { expect };

// `setCookies` is null when the browser could not give the headers.
export type SeenResponse = { url: string; setCookies: string[] | null; contextClosed?: () => boolean };

// The origins of the site and the static host, as the cookie check knows
// them. Every test uses the ones in hosts.ts but one in cookies.spec.ts,
// which serves bad cookies from servers of its own.
export type CookieHosts = { site: string; staticHost: string };
const HOSTS: CookieHosts = { site: SITE, staticHost: STATIC_HOST };

// What is wrong with one Set-Cookie header from the given origin.
export function cookieProblems(origin: string, setCookie: string, hosts: CookieHosts = HOSTS): string[] {
  if (origin === hosts.staticHost) return [`the static host set a cookie: ${setCookie}`];
  if (origin !== hosts.site) return [];
  const [pair = '', ...attributes] = setCookie.split(';').map((part) => part.trim());
  const name = pair.split('=')[0]?.trim() ?? '';
  const attribute = (key: string) =>
    attributes.map((part) => part.split('=')).find(([k]) => k?.trim().toLowerCase() === key);
  const problems = [];
  if (!name.startsWith('__Host-')) problems.push(`the site set ${name} without the __Host- prefix`);
  if (attribute('domain')) problems.push(`the site set ${name} with a Domain, so it is not host-only`);
  if (!attribute('secure')) problems.push(`the site set ${name} without Secure`);
  if (attribute('path')?.[1]?.trim() !== '/') problems.push(`the site set ${name} without Path=/`);
  return problems;
}

// What is wrong with the cookies a jar holds for the site's host.
function jarProblems(cookies: Cookie[], jar: string, hosts: CookieHosts): string[] {
  const site = new URL(hosts.site).hostname;
  return cookies
    .filter((cookie) => cookie.domain.replace(/^\./, '') === site)
    .filter(
      (cookie) =>
        !cookie.name.startsWith('__Host-') || !cookie.secure || cookie.path !== '/' || cookie.domain.startsWith('.'),
    )
    .map((cookie) => `${jar} holds ${cookie.name} from the site, which is not a host-only __Host- cookie`);
}

// The responses seen in the current test. A worker runs one test at a time.
let seen: Promise<SeenResponse>[] = [];

const setCookies = (headers: { name: string; value: string }[]) =>
  headers.filter((header) => header.name.toLowerCase() === 'set-cookie').map((header) => header.value);

function watchContext(context: BrowserContext) {
  let closed = false;
  context.on('close', () => {
    closed = true;
  });
  context.on('response', (response) => {
    seen.push(
      response.headersArray().then(
        (headers) => ({ url: response.url(), setCookies: setCookies(headers) }),
        () => ({ url: response.url(), setCookies: null, contextClosed: () => closed }),
      ),
    );
  });
}

// Wraps each method of a request context that answers with a response. It
// follows redirects, so the Set-Cookie headers of a redirect are read from
// its cookie jar at the end of the test.
function watchRequests(request: APIRequestContext) {
  const recorded = new WeakSet<APIResponse>();
  for (const method of ['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head'] as const) {
    const send = request[method].bind(request) as (...args: unknown[]) => Promise<APIResponse>;
    Object.assign(request, {
      [method]: async (...args: unknown[]) => {
        const response = await send(...args);
        if (!recorded.has(response)) {
          recorded.add(response);
          seen.push(Promise.resolve({ url: response.url(), setCookies: setCookies(response.headersArray()) }));
        }
        return response;
      },
    });
  }
  return request;
}

type TestFixtures = {
  // The responses the current test has seen so far.
  responses: () => Promise<SeenResponse[]>;
  // What the cookie check has to find after the test, in any order. Every
  // test expects nothing. Only the test in cookies.spec.ts that serves bad
  // cookies sets it and cookieHosts, to show the check reports them.
  expectedCookieProblems: string[];
  cookieHosts: CookieHosts;
};

export const test = base.extend<TestFixtures, { watchContexts: undefined }>({
  // Every browser context in the worker, the page fixture's and any a test
  // makes itself.
  watchContexts: [
    async ({ browser }, use) => {
      browser.on('context', watchContext);
      browser.contexts().forEach(watchContext);
      await use(undefined);
      browser.off('context', watchContext);
    },
    { scope: 'worker', auto: true },
  ],

  request: async ({ request }, use) => {
    await use(watchRequests(request));
  },

  expectedCookieProblems: [[], { option: true }],
  cookieHosts: [HOSTS, { option: true }],

  // Checks the cookies after each test. It depends on the context and the
  // request fixture, so it finishes while both are open and their cookie
  // jars can be read.
  responses: [
    async ({ context, request, expectedCookieProblems, cookieHosts }, use) => {
      seen = [];
      await use(() => Promise.all(seen));
      const problems = (await Promise.all(seen)).flatMap(({ url, setCookies, contextClosed }) => {
        const origin = new URL(url).origin;
        if (setCookies) return setCookies.flatMap((header) => cookieProblems(origin, header, cookieHosts));
        // A context a test closed while a response was on its way takes the
        // headers with it, and nothing can send that cookie anywhere after.
        // Otherwise a response whose headers can't be read can't pass.
        if (contextClosed?.()) return [];
        const known = origin === cookieHosts.site || origin === cookieHosts.staticHost;
        return known ? [`the headers of ${url} could not be read`] : [];
      });
      // A cookie set from a script, or on a redirect, has no Set-Cookie
      // header here, so the cookie jars are read too.
      for (const open of context.browser()?.contexts() ?? [context]) {
        problems.push(...jarProblems(await open.cookies(), "a browser's cookie jar", cookieHosts));
      }
      const requestJar = (await request.storageState()).cookies;
      problems.push(...jarProblems(requestJar, "the request fixture's cookie jar", cookieHosts));
      expect(
        problems.toSorted(),
        'every cookie from the site is a host-only __Host- cookie, and the static host sets none',
      ).toEqual(expectedCookieProblems.toSorted());
    },
    { auto: true },
  ],
});
