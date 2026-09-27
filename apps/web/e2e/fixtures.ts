import { test as base, expect, type APIRequestContext, type APIResponse, type BrowserContext } from '@playwright/test';
import { SITE, STATIC_HOST } from './hosts';

// Every test imports `test` from here, and a lint rule holds the spec files
// to it. Its fixtures read each Set-Cookie header on every response the tests
// see, from every browser context and from the `request` fixture. A cookie
// from the site has to be host-only with the __Host- prefix, so a browser
// never sends it to the static host. The static host sets none. Any other
// cookie fails the test that saw it. Responses from other origins, like the
// GitHub fake, are GitHub's, and not checked.
export { expect };

// `setCookies` is null when the browser could not give the headers.
export type SeenResponse = { url: string; setCookies: string[] | null };

// What is wrong with one Set-Cookie header from the given origin.
export function cookieProblems(origin: string, setCookie: string): string[] {
  if (origin === STATIC_HOST) return [`the static host set a cookie: ${setCookie}`];
  if (origin !== SITE) return [];
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

// The responses seen in the current test. A worker runs one test at a time.
let seen: Promise<SeenResponse>[] = [];

const setCookies = (headers: { name: string; value: string }[]) =>
  headers.filter((header) => header.name.toLowerCase() === 'set-cookie').map((header) => header.value);

function watchContext(context: BrowserContext) {
  context.on('response', (response) => {
    seen.push(
      response.headersArray().then(
        (headers) => ({ url: response.url(), setCookies: setCookies(headers) }),
        () => ({ url: response.url(), setCookies: null }),
      ),
    );
  });
}

// Wraps each method of a request context that answers with a response.
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

  // Checks the cookies after each test. It depends on the context, so it
  // finishes while the context is still open and its cookies can be read.
  responses: [
    async ({ context }, use) => {
      seen = [];
      await use(() => Promise.all(seen));
      const problems = (await Promise.all(seen)).flatMap(({ url, setCookies }) => {
        const origin = new URL(url).origin;
        if (setCookies) return setCookies.flatMap((header) => cookieProblems(origin, header));
        // A response whose headers can't be read can't pass the check.
        return origin === SITE || origin === STATIC_HOST ? [`the headers of ${url} could not be read`] : [];
      });
      // A cookie set from a script has no Set-Cookie header, so the cookie
      // jars are read too.
      const site = new URL(SITE).hostname;
      for (const open of context.browser()?.contexts() ?? [context]) {
        for (const cookie of await open.cookies()) {
          if (cookie.domain.replace(/^\./, '') !== site) continue;
          const bad =
            !cookie.name.startsWith('__Host-') || !cookie.secure || cookie.path !== '/' || cookie.domain.startsWith('.');
          if (bad) problems.push(`the site's cookie jar holds ${cookie.name}, which is not a host-only __Host- cookie`);
        }
      }
      expect(problems, 'every cookie from the site is a host-only __Host- cookie, and the static host sets none').toEqual(
        [],
      );
    },
    { auto: true },
  ],
});
