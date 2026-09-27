import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cookieProblems, expect, test } from './fixtures';
import { SITE, STATIC_HOST } from './hosts';

// Pages load every built file from the static host, which serves the files a
// deploy uploads. Here the host is the stand-in in scripts/static-host.mjs,
// which sends each file with the headers the upload stores for it. What only
// a real deployment can show, like a Cloudflare feature adding a cookie, is
// in docs/self-hosting.md.
const BUILT = fileURLToPath(new URL('../dist/client/assets/', import.meta.url));
const setCookies = (headers: { name: string; value: string }[]) =>
  headers.filter((header) => header.name.toLowerCase() === 'set-cookie');

test('a page loads its scripts, styles, and fonts from the static host, and none from the site', async ({ page }) => {
  const files: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    const file = ['script', 'stylesheet', 'font', 'image', 'media'].includes(request.resourceType());
    if (url.protocol !== 'data:' && file) files.push(url.href);
  });
  await page.goto('/design');
  // The swatches fill in once the page's scripts run.
  await expect(page.locator('.swatch').first()).toContainText('#');
  await page.evaluate(() => document.fonts.ready);

  const kinds = new Set(files.map((url) => path.extname(new URL(url).pathname)));
  expect([...kinds]).toEqual(expect.arrayContaining(['.css', '.js', '.woff2']));
  expect(files.filter((url) => new URL(url).origin !== STATIC_HOST)).toEqual([]);
});

test('every kind of file the build writes comes from the static host with no cookie and a year of caching', async ({
  request,
}) => {
  const names = await readdir(BUILT);
  const types: Record<string, RegExp> = {
    '.css': /^text\/css/,
    '.js': /^text\/javascript/,
    '.woff2': /^font\/woff2$/,
    '.svg': /^image\/svg\+xml$/,
    '.webp': /^image\/webp$/,
    '.mp4': /^video\/mp4$/,
  };
  // The launch video, its poster, the mark, the fonts, and the scripts and
  // styles are all in the build.
  expect([...new Set(names.map((name) => path.extname(name)))].sort()).toEqual(Object.keys(types).sort());

  for (const name of names) {
    const response = await request.get(`${STATIC_HOST}/assets/${name}`);
    expect(response.status(), name).toBe(200);
    expect(setCookies(response.headersArray()), name).toEqual([]);
    expect(response.headers()['cache-control'], name).toBe('public, max-age=31536000, immutable');
    expect(response.headers()['content-type'], name).toMatch(types[path.extname(name)] ?? /^$/);
    expect(Buffer.compare(await response.body(), await readFile(path.join(BUILT, name))), name).toBe(0);
  }
});

test('the launch video and its poster answer byte ranges, which Safari needs to play video', async ({ request }) => {
  const names = (await readdir(BUILT)).filter((name) => /^(good-first-token-launch|launch-poster)-.+\.(mp4|webp)$/.test(name));
  expect(names).toHaveLength(2);

  for (const name of names) {
    const file = await readFile(path.join(BUILT, name));
    const response = await request.get(`${STATIC_HOST}/assets/${name}`, { headers: { range: 'bytes=100-199' } });
    expect(response.status(), name).toBe(206);
    expect(response.headers()['content-range'], name).toBe(`bytes 100-199/${String(file.length)}`);
    expect(Buffer.compare(await response.body(), file.subarray(100, 200)), name).toBe(0);
    expect(setCookies(response.headersArray()), name).toEqual([]);
  }
});

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
