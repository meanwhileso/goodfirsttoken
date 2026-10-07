import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

// The leaderboard, with the sample work from the dev-only POST /dev/seed:
// PRs merged and closed this week and weeks ago, across donors, agents, and
// projects, one maintainer's work on their own project, and a blocked donor,
// rowan. These tests run in the `board` project (playwright.config.ts), once
// the homepage's tests have seeded the same work, and before any test adds
// claims or PRs of its own, so the numbers hold still for the screenshots.
// Every person, repo, and number here is made up.

const WIDTHS = [390, 1280];

async function seed(request: APIRequestContext) {
  const res = await request.post('/dev/seed');
  expect(res.status(), await res.text()).toBe(200);
}

async function openBoard(page: Page) {
  await page.goto('/leaderboard');
  await expect(tab(page, 'this week')).toHaveAttribute('aria-selected', 'true');
}

function tab(page: Page, name: string): Locator {
  return page.getByRole('tablist', { name: 'Leaderboard view' }).getByRole('tab', { name });
}

/** Picks a view. A click before the page's script has run does nothing, so it clicks until the view shows. */
async function choose(page: Page, name: string) {
  await expect(async () => {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true', { timeout: 500 });
  }).toPass();
}

function panel(page: Page): Locator {
  return page.getByRole('tabpanel');
}

/** A person's row in the view shown, by their login. */
function person(page: Page, login: string): Locator {
  return panel(page).locator('.board-ranks > li').filter({ has: page.getByRole('link', { name: `@${login}`, exact: true }) });
}

async function scrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}

test.beforeEach(async ({ request }) => {
  await seed(request);
});

test('this week ranks people by PRs merged, with the merge rate from merged and closed PRs, and the own-project column apart', async ({
  page,
}) => {
  await openBoard(page);

  await expect(tab(page, 'this week')).toHaveAttribute('aria-selected', 'true');
  // kenji merged two this week. priya merged one and had one closed.
  await expect(person(page, 'kenji').locator('.board-score')).toHaveText('2merged');
  await expect(person(page, 'kenji').locator('.ranks__n')).toHaveText('1');
  await expect(person(page, 'priya').locator('.board-score')).toHaveText('1merged');
  await expect(person(page, 'priya').locator('.board-detail')).toContainText('merge rate 50%');
  // ines had a PR closed and none merged.
  await expect(person(page, 'ines').locator('.board-detail')).toContainText('merge rate 0%');
  // sample-maintainer's merge was on their own project, so it ranks nothing.
  await expect(person(page, 'sample-maintainer').locator('.board-score')).toHaveText('0merged');
  await expect(person(page, 'sample-maintainer').locator('.board-own')).toHaveText('1own project');
  await expect(panel(page)).toContainText('The week starts Monday at 00:00 UTC.');
  // rowan is blocked, and merged two this week.
  await expect(page.getByText('@rowan')).toHaveCount(0);
});

test('all time counts the earlier work too, and a person links to their page', async ({ page }) => {
  await openBoard(page);

  await choose(page, 'all time');

  await expect(person(page, 'kenji').locator('.board-score')).toHaveText('3merged');
  await expect(person(page, 'priya').locator('.board-score')).toHaveText('2merged');
  await expect(person(page, 'priya').locator('.board-detail')).toContainText('1.9M tokens est.');
  await expect(person(page, 'arjun').locator('.board-score')).toHaveText('2merged');
  await expect(person(page, 'sample-maintainer').locator('.board-own')).toHaveText('2own project');
  await expect(page.getByText('@rowan')).toHaveCount(0);
  await expect(person(page, 'priya').getByRole('link', { name: '@priya' })).toHaveAttribute('href', '/@priya');
});

test('by agent shows Claude Code, Codex, OpenCode, Grok Bot, and Cursor side by side, with their merge rates', async ({ page }) => {
  await openBoard(page);

  // The arrow keys move between the views, as for any tabs.
  await choose(page, 'all time');
  await page.keyboard.press('ArrowRight');

  await expect(tab(page, 'by agent')).toHaveAttribute('aria-selected', 'true');
  const names = await panel(page).locator('.board-bar__name').allTextContents();
  expect(names.sort()).toEqual(['claude-code', 'codex', 'cursor', 'grok', 'opencode']);
  const bar = (agent: string) => panel(page).locator('.board-bar').filter({ hasText: agent });
  // codex: kenji's three merged and one closed. rowan's two are hidden.
  await expect(bar('codex').locator('.board-bar__value')).toHaveText('75% · 3 merged');
  await expect(bar('cursor').locator('.board-bar__value')).toHaveText('100% · 2 merged');
});

test('by project shows each project with a page, the people who helped, and its own maintainers apart', async ({ page }) => {
  await openBoard(page);

  await choose(page, 'by project');

  const project = (repo: string) =>
    panel(page).locator('.board-ranks > li').filter({ has: page.getByRole('link', { name: repo, exact: true }) });
  await expect(project('sample-owner/sample-app').getByRole('link', { name: 'sample-owner/sample-app' })).toHaveAttribute(
    'href',
    '/sample-owner/sample-app',
  );
  await expect(project('sample-owner/sample-app').locator('.board-own')).toHaveText('1own project');
  await expect(project('sample-owner/sample-desktop').locator('.board-own')).toHaveText('1own project');
  // A project waiting for an admin has no page, and no row.
  await expect(project('sample-owner/sample-harbor')).toHaveCount(0);
});

for (const width of WIDTHS) {
  test(`fits the screen at ${String(width)}px, and matches its screenshot`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 900 });
    await openBoard(page);
    await page.evaluate(() => document.fonts.ready);

    expect(await scrollsSideways(page)).toBe(false);
    for (const view of ['all time', 'by agent', 'by project']) {
      await choose(page, view);
      expect(await scrollsSideways(page), view).toBe(false);
    }
    await choose(page, 'this week');

    // As for the homepage: up to 2% of pixels may differ, for antialiasing.
    await expect(page).toHaveScreenshot(`leaderboard-${String(width)}.png`, {
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.02,
    });
  });
}
