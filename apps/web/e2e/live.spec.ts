import type { FeedEvent } from '@goodfirsttoken/core';
import type { Page, WebSocketRoute } from '@playwright/test';
import { expect, test } from './fixtures';
import { SITE } from './hosts';

// /live, every line from everyone. It follows the homepage's feed over the
// WebSocket on /live.ndjson, and these tests stand in for the feed with
// Playwright's routeWebSocket, as the homepage's tests do. They run in the
// `board` project (playwright.config.ts), so the feed they load with holds
// the sample work the homepage's tests seeded. Every person, repo, and line
// here is made up.

const WIDTHS = [390, 1280];
const PEOPLE = [
  ['priya', 'claude-code', 'sample-owner/sample-app#311'],
  ['kenji', 'codex', 'sample-owner/sample-desktop#1431'],
  ['sam', 'opencode', 'sample-owner/sample-bundler#120'],
  ['ines', 'grok', 'sample-owner/sample-desktop#1440'],
  ['arjun', 'cursor', 'sample-owner/sample-app#311'],
] as const;

/** Twenty lines, always the same, on a day long gone, so they push every seeded line off the wall. */
function fixedLines(): FeedEvent[] {
  return Array.from({ length: 20 }, (_, i) => {
    const [user, agent, issue] = PEOPLE[i % PEOPLE.length] ?? PEOPLE[0];
    return {
      id: `e_e2eLive${String(i).padStart(11, '0')}`,
      time: `2026-09-01T14:${String(10 + i).padStart(2, '0')}:05.000Z`,
      user,
      agent,
      issue,
      claim: `c_e2elive${String(i % PEOPLE.length).padStart(10, '0')}`,
      kind: 'update',
      job: null,
      text: `step ${String(i + 1)}: read the failing test and the code under it`,
    };
  });
}

async function openLive(page: Page) {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/live\.ndjson/, (socket) => {
    sockets.push(socket);
  });
  await page.goto('/live');
  await expect.poll(() => sockets.length).toBe(1);
  return {
    sockets,
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

test.beforeAll(async ({ request }) => {
  const res = await request.post('/dev/seed');
  expect(res.status(), await res.text()).toBe(200);
});

test("loads with the site's newest lines, follows the feed, and puts each new line on top, keeping twenty", async ({ page }) => {
  // The page asks from after the newest line it loaded with.
  const live = await openLive(page);
  await expect(page.locator('.wall-line').first()).toBeVisible();
  expect(new URL(live.sockets[0]?.url() ?? '').searchParams.get('since')).toMatch(/^e_/);

  live.send(...fixedLines());

  await expect(page.locator('.wall-line').first()).toContainText('step 20:');
  await expect(page.locator('.wall-line')).toHaveCount(20);
  await expect(page.locator('.wall-line').last()).toContainText('step 1:');
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'live' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('copies the command that streams every line as text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openLive(page);

  await page.getByRole('button', { name: 'Copy the stream command' }).click();

  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`curl -N ${SITE}/live.txt`);
});

for (const width of WIDTHS) {
  test(`fits the screen at ${String(width)}px, and matches its screenshot`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 900 });
    const live = await openLive(page);
    live.send(...fixedLines());
    await expect(page.locator('.wall-line').first()).toContainText('step 20:');
    await expect(page.locator('.wall-line').last()).toContainText('step 1:');
    await page.evaluate(() => document.fonts.ready);

    expect(await scrollsSideways(page)).toBe(false);

    await expect(page).toHaveScreenshot(`live-${String(width)}.png`, {
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.02,
    });
  });
}
