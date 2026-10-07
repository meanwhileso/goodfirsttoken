import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

// The projects list and a project's page. The sample projects come from the
// dev-only POST /dev/seed, and live work from POST /dev/work, through real
// issue rooms, so each line reaches the project's feed and its page over the
// real live socket. Seeding lists projects on the homepage, and the work
// reaches the homepage's feed, so these tests run after the rest
// (playwright.config.ts), beside the issue page's. Other tests may add
// projects meanwhile, so these look only at the ones they know. Every
// person, repo, and line here is made up.

const APP = 'sample-owner/sample-app';
const DESKTOP = 'sample-owner/sample-desktop';
const BUNDLER = 'sample-owner/sample-bundler';
const TOOLS = 'sample-owner/sample-tools';
const PENDING = 'sample-owner/sample-harbor';

async function seed(request: APIRequestContext) {
  const res = await request.post('/dev/seed');
  expect(res.status(), await res.text()).toBe(200);
}

/** Works an issue as a sample person, through its room. */
async function work(request: APIRequestContext, issue: string, login: string, doing: Record<string, string>) {
  const res = await request.post('/dev/work', { data: { issue, login, ...doing } });
  expect(res.status(), await res.text()).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true });
}

/** An issue in a sample project's repo that no earlier run has touched. */
function freshIssue(repo: string): { issue: string; number: number } {
  const number = 1_000_000_000 + Math.floor(Math.random() * 8_000_000_000);
  return { issue: `${repo}#${String(number)}`, number };
}

/** A project's row on the list, found by its repo. */
function row(page: Page, repo: string): Locator {
  return page.locator('.project-row').filter({ has: page.locator('.project-row__title', { hasText: new RegExp(`^${repo}$`) }) });
}

/** Opens the list once its filter and search work, which is once the page's script has run. */
async function openList(page: Page) {
  await page.goto('/projects');
  await expect(page.getByRole('searchbox', { name: 'Search projects' })).toBeEnabled();
}

test('the list filters by PR mode and searches by repo and by tag', async ({ page, request }) => {
  await seed(request);
  await openList(page);
  const chip = (name: string) => page.getByRole('group', { name: 'Filter by PR mode' }).getByRole('button', { name });
  const search = page.getByRole('searchbox', { name: 'Search projects' });
  const shown = async (repos: string[], hidden: string[]) => {
    for (const repo of repos) await expect(row(page, repo), repo).toHaveCount(1);
    for (const repo of hidden) await expect(row(page, repo), repo).toHaveCount(0);
  };

  // Every approved project, and not the one waiting for an admin.
  await expect(chip('all')).toHaveAttribute('aria-pressed', 'true');
  await shown([APP, DESKTOP, BUNDLER, TOOLS], [PENDING]);

  await chip('automatic PRs').click();
  await expect(chip('automatic PRs')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip('all')).toHaveAttribute('aria-pressed', 'false');
  await shown([APP, TOOLS], [DESKTOP, BUNDLER]);
  for (const mode of await page.locator('.project-row .badge__value').allTextContents()) expect(mode).toBe('automatic');

  await chip('reviewed PRs').click();
  await shown([DESKTOP, BUNDLER], [APP, TOOLS]);
  for (const mode of await page.locator('.project-row .badge__value').allTextContents()) expect(mode).toBe('reviewed');

  // The search holds a repo's words, whatever their case, or a tag's.
  await chip('all').click();
  await search.fill('  BUNDLER ');
  await expect(page.locator('.project-row__title')).toHaveText([BUNDLER]);
  await expect(page.getByRole('status')).toHaveText(/^1 of \d+ projects$/);
  await search.fill('ready');
  await expect(page.locator('.project-row__title')).toHaveText([DESKTOP]);

  // Both at once. sample-desktop's PRs are reviewed.
  await chip('automatic PRs').click();
  await expect(page.locator('.project-row')).toHaveCount(0);
  await expect(page.getByText('No projects match your search.')).toBeVisible();

  await search.fill('');
  await shown([APP, TOOLS], [DESKTOP, BUNDLER]);
});

test('a project listed from its policy says so on the list, and its page quotes the policy, links its file, and offers a takeover', async ({
  page,
  request,
}) => {
  await seed(request);
  await openList(page);
  await expect(row(page, BUNDLER).locator('.project-row__source')).toHaveText('listed from its AI policy');
  await expect(row(page, APP).locator('.project-row__source')).toHaveText('registered by its maintainers');

  await row(page, BUNDLER).click();

  await expect(page).toHaveURL(new RegExp(`/${BUNDLER}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(BUNDLER);
  const policy = page.locator('.project-policy');
  await expect(policy.locator('.quote')).toContainText('“AI help is fine. Write the PR description yourself.”');
  await expect(policy.getByRole('link', { name: /CONTRIBUTING\.md/ })).toHaveAttribute(
    'href',
    `https://github.com/${BUNDLER}/blob/main/CONTRIBUTING.md`,
  );
  await expect(policy).toContainText('listed from its AI policy');
  await expect(policy.getByRole('link', { name: 'take it over or remove it' })).toHaveAttribute('href', '/maintainers');
  await expect(page.getByText('registered by')).toHaveCount(0);
  // Its rules, as the policy set them: a person reads the diff and writes the description.
  const badge = (rule: string) => page.locator('.badge').filter({ has: page.locator('.badge__rule', { hasText: new RegExp(`^${rule}$`) }) });
  await expect(badge('PRs').locator('.badge__value')).toHaveText('reviewed');
  await expect(badge('description').locator('.badge__value')).toHaveText('person writes');
});

test("a live event arriving on a project's page goes on top of its wall, and its issue shows the slot the claim took", async ({
  page,
  request,
}) => {
  await seed(request);
  const { issue, number } = freshIssue(TOOLS);
  await work(request, issue, 'kenji', { action: 'claim', agent: 'codex', title: 'Sort the tools by name' });

  const socket = page.waitForEvent('websocket', (ws) => ws.url().includes(`/${TOOLS}/live.ndjson`));
  await page.goto(`/${TOOLS}`);
  await socket;
  const wall = page.locator('.project-aside .wall-line');
  // The claim's own line, loaded with the page or sent live.
  await expect(wall.filter({ hasText: 'claimed the issue' }).filter({ hasText: issue })).toHaveCount(1);
  const tagged = page.locator('.project-issue').filter({ hasText: 'Sort the tools by name' });
  await expect(tagged).toHaveAttribute('href', `/${TOOLS}/issues/${String(number)}`);
  await expect(tagged.locator('.slots')).toHaveAttribute('aria-label', '1 of 3 taken');
  await expect(tagged).toContainText('1 working');

  await work(request, issue, 'kenji', { action: 'post', text: 'sorted the tools list by name (src/tools.ts)' });

  const newest = wall.first();
  await expect(newest.locator('.wall-line__text')).toHaveText('sorted the tools list by name (src/tools.ts)');
  await expect(newest).toHaveClass(/wall-line--new/);
  await expect(newest.getByRole('link', { name: '@kenji' })).toHaveAttribute('href', '/@kenji');
  await expect(newest.getByRole('link', { name: issue })).toHaveAttribute('href', `/${TOOLS}/issues/${String(number)}`);
});

test('the list and a project page fit the screen from 360 to 1280px', async ({ page, request }) => {
  await seed(request);
  for (const width of [360, 390, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/projects', `/${BUNDLER}`, `/${APP}`]) {
      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);
      const [scrollWidth, clientWidth] = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]);
      expect(scrollWidth, `${path} at ${String(width)}px`).toBeLessThanOrEqual(clientWidth);
    }
  }
});
