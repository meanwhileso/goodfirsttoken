import { expect, test } from './fixtures';
import { SITE } from './hosts';

// The forms agents read, from the production build: a page's markdown
// version by path and by Accept, /llms.txt, /robots.txt, /sitemap.xml, and
// /projects.json. The fixtures check every Set-Cookie header they carry.

test('the production build serves each page as markdown, at its path plus .md and to Accept: text/markdown', async ({ request }) => {
  for (const path of ['/', '/projects', '/leaderboard', '/live', '/maintainers']) {
    const byPath = await request.get(path === '/' ? '/index.md' : `${path}.md`);
    const byAccept = await request.get(path, { headers: { accept: 'text/markdown' } });

    expect(byPath.status(), path).toBe(200);
    expect(byPath.headers()['content-type'], path).toBe('text/markdown; charset=utf-8');
    expect(await byAccept.text(), path).toBe(await byPath.text());
  }
});

test('a page names its canonical URL and its markdown version in its head', async ({ page }) => {
  await page.goto('/projects');

  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${SITE}/projects`);
  await expect(page.locator('link[rel="alternate"][type="text/markdown"]')).toHaveAttribute('href', `${SITE}/projects.md`);
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', `${SITE}/projects`);
});

test('llms.txt, robots.txt, the sitemap, and the JSON data answer from the production build', async ({ request }) => {
  const llms = await request.get('/llms.txt');
  expect(llms.status()).toBe(200);
  expect(await llms.text()).toContain(`${SITE}/start.md`);

  expect(await (await request.get('/robots.txt')).text()).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  expect(await (await request.get('/sitemap.xml')).text()).toContain(`<loc>${SITE}/projects</loc>`);

  const data = await request.get('/projects.json');
  expect(data.status()).toBe(200);
  expect(((await data.json()) as { license: string }).license).toBe('CC0-1.0');
});
