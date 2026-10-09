import type { FeedEvent } from '@goodfirsttoken/core';
import type { APIRequestContext, Page, WebSocketRoute } from '@playwright/test';
import { expect, test } from './fixtures';

// A person's page, /@<login>, with the sample work from the dev-only POST
// /dev/seed. Its live wall follows the person's feed over the WebSocket on
// /@<login>/live.ndjson, and these tests stand in for the feed with
// Playwright's routeWebSocket, as the homepage's tests do. They run in the
// `board` project (playwright.config.ts), before any test adds claims or
// PRs of its own. Every person, repo, and line here is made up.

const WIDTHS = [390, 1280];

async function seed(request: APIRequestContext) {
  const res = await request.post('/dev/seed');
  expect(res.status(), await res.text()).toBe(200);
}

/** Opens a person's page with its live socket routed to the test. */
async function openPerson(page: Page, login: string) {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(new RegExp(`/@${login}/live\\.ndjson`), (socket) => {
    sockets.push(socket);
  });
  await page.goto(`/@${login}`);
  await expect.poll(() => sockets.length).toBe(1);
  return {
    send(...events: FeedEvent[]) {
      const socket = sockets.at(-1);
      if (!socket) throw new Error('The page has no live socket.');
      for (const event of events) socket.send(JSON.stringify(event));
    },
  };
}

async function scrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}

// Six lines, always the same, on a day long gone. They push the seeded
// lines, whose times change, off the wall.
const lines: FeedEvent[] = [
  'read AGENTS.md and CONTRIBUTING',
  'reproduced the trailing slash on /docs/',
  'wrote a failing test: a rewrite from /docs/ keeps its slash',
  'kept the slash in rewriteRoute (src/rewrite.ts)',
  'tests: 214 passing',
  'fix ready, running the full suite',
].map((text, i) => ({
  id: `e_e2ePerson${String(i).padStart(10, '0')}`,
  time: `2026-09-01T14:02:${String(10 + i * 9)}.000Z`,
  user: 'priya',
  agent: 'claude-code',
  issue: 'sample-owner/sample-app#311',
  claim: 'c_e2eperson00000001',
  kind: 'update',
  job: null,
  text,
}));

test.beforeEach(async ({ request }) => {
  await seed(request);
});

test('shows what they work on now, their history with how each PR ended, their totals, and the projects they helped', async ({
  page,
}) => {
  await openPerson(page, 'priya');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('@priya');
  const working = page.locator('.person-section').filter({ has: page.getByRole('heading', { name: /^working now/ }) });
  await expect(working.locator('.person-row').filter({ hasText: 'Handle trailing slashes in rewrites' })).toHaveCount(1);
  const history = page.locator('.person-section').filter({ has: page.getByRole('heading', { name: 'history' }) });
  await expect(history.locator('.person-row').filter({ hasText: 'sample-owner/sample-desktop#1301' }).locator('.person-row__side')).toHaveText(
    'merged',
  );
  await expect(history.locator('.person-row').filter({ hasText: 'sample-owner/sample-bundler#101' }).locator('.person-row__side')).toHaveText(
    'PR closed',
  );
  await expect(page.locator('.person-stats')).toContainText('50% merge rate');
  await expect(page.locator('.person-stats')).toContainText('1.9M tokens est.');
  // One merged PR on each. The tie goes to the one she reached first.
  await expect(page.locator('.person-helped').first().getByRole('link')).toHaveText([
    'sample-owner/sample-desktop',
    'sample-owner/sample-app',
  ]);
  await expect(page.locator('.person-activity .token-field .token-field__square')).toHaveCount(7 * 52);
});

test("a maintainer's page lists the projects they registered, and their own-project merges apart", async ({ page }) => {
  await openPerson(page, 'sample-maintainer');

  const maintains = page.locator('.person-section').filter({ has: page.getByRole('heading', { name: 'projects maintained' }) });
  await expect(maintains.getByRole('link', { name: 'sample-owner/sample-app' })).toHaveAttribute('href', '/sample-owner/sample-app');
  await expect(page.locator('.person-stats')).toContainText('2 merged on their own projects');
  await expect(page.locator('.person-row').filter({ hasText: 'own project' })).toHaveCount(2);
});

test('a blocked donor, and a login no one signed in with, have no page', async ({ page }) => {
  for (const login of ['rowan', 'no-one-signed-in']) {
    const response = await page.goto(`/@${login}`);
    expect(response?.status(), login).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not found');
    await expect(page.locator('main')).toContainText(`@${login} has no page on Good First Token.`);
  }
});

test('a live line goes on top of their wall', async ({ page }) => {
  const person = await openPerson(page, 'priya');

  person.send(lines[0] as FeedEvent);

  const newest = page.locator('.person-aside .wall-line').first();
  await expect(newest.locator('.wall-line__text')).toHaveText('read AGENTS.md and CONTRIBUTING');
  await expect(newest.getByRole('link', { name: 'sample-owner/sample-app#311' })).toHaveAttribute('href', '/sample-owner/sample-app/issues/311');
});

for (const width of WIDTHS) {
  test(`fits the screen at ${String(width)}px, and matches its screenshot`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 900 });
    const person = await openPerson(page, 'priya');
    person.send(...lines);
    await expect(page.locator('.person-aside .wall-line').first()).toContainText('fix ready');
    await page.evaluate(() => document.fonts.ready);

    expect(await scrollsSideways(page)).toBe(false);

    // Up to 2% of pixels may differ, for antialiasing. The activity graph
    // and the days are masked, since the sample work is dated from when it
    // was seeded, and so is the month they joined.
    await expect(page).toHaveScreenshot(`person-${String(width)}.png`, {
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
      mask: [page.locator('.person-activity .token-field'), page.locator('main time')],
      maskColor: '#D8DEE4',
      maxDiffPixelRatio: 0.02,
    });
  });
}
