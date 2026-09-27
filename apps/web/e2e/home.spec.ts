import type { FeedEvent } from '@goodfirsttoken/core';
import type { Page, WebSocketRoute } from '@playwright/test';
import { expect, test } from './fixtures';
import { SITE, STATIC_HOST } from './hosts';

// The homepage. Its live wall and token field follow the home feed over the
// WebSocket on /live.ndjson. These tests stand in for the feed with
// Playwright's routeWebSocket, and hand the page events of their own. The
// Worker's side of the socket is tested in test/feed/streams.test.ts, with
// real feeds. Every person, repo, and line here is made up.

const PROMPT = `Read ${SITE}/start.md, then spend some of my tokens on open source.`;

let made = 0;

/** A feed event with a fresh ID, happening now unless `time` says otherwise. */
function liveEvent(text: string, changes: Partial<FeedEvent> = {}): FeedEvent {
  made += 1;
  return {
    id: `e_e2e${String(Date.now())}${String(made).padStart(4, '0')}`,
    time: new Date().toISOString(),
    user: 'priya',
    agent: 'claude-code',
    issue: 'sample-owner/sample-app#311',
    claim: 'c_e2e0000000000000001',
    kind: 'update',
    job: null,
    text,
    ...changes,
  };
}

/**
 * Opens the homepage with its live socket routed to the test. The page has
 * hydrated once it opens the socket, so its buttons respond from there.
 */
async function openHome(page: Page) {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/live\.ndjson/, (socket) => {
    sockets.push(socket);
  });
  await page.goto('/');
  await expect.poll(() => sockets.length).toBe(1);
  return {
    sockets,
    /** Sends events down the socket the page has open now. */
    send(...events: FeedEvent[]) {
      const socket = sockets.at(-1);
      if (!socket) throw new Error('The page has no live socket.');
      for (const event of events) socket.send(JSON.stringify(event));
    },
  };
}

test('the homepage says what it is in one line, with open source as its label', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('Good First Token: spend your spare tokens on open source');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Spend your spare tokens on open source');
  await expect(page.locator('h1 .inline-label')).toHaveText('open source');
});

test('the homepage sets no cookie for a visitor who is not signed in', async ({ page, context }) => {
  const response = await page.goto('/');

  expect(await response?.headerValue('set-cookie')).toBeNull();
  expect(await context.cookies()).toEqual([]);
});

test.describe('the prompt', () => {
  test("its copy button puts the prompt, which names this site's start.md, on the clipboard", async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openHome(page);
    const button = page.getByRole('button', { name: 'Copy prompt', exact: true });

    await button.click();

    await expect(button).toHaveText('copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PROMPT);
    await expect(page.locator('.home-start .prompt__text').first()).toHaveText(PROMPT);
  });

  test('each open-in link opens its harness with the prompt filled in, by the link in spec section 9', async ({ page }) => {
    await openHome(page);
    // Each link's name ends in its arrow, drawn by the stylesheet.
    const href = (name: string) =>
      page.locator('.open-in').getByRole('link', { name: new RegExp(`^${name}\\W*$`) }).getAttribute('href');
    const prompt = encodeURIComponent(PROMPT);

    expect(await href('claude code')).toBe(`claude://code/new?q=${prompt}`);
    expect(await href('codex')).toBe(`codex://new?prompt=${prompt}`);
    expect(await href('cursor')).toBe(`cursor://anysphere.cursor-deeplink/prompt?text=${prompt}`);
    // OpenCode and Grok Bot have no link. T3 Code's is a button.
    await expect(page.locator('.open-in').getByRole('link')).toHaveCount(3);
  });

  test('the t3 code button copies the prompt first, then opens T3 Code, which takes no prompt', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // Paused, so the test says when the 0.6 seconds pass.
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 1000);
    await openHome(page);
    const opened: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith('t3code:')) opened.push(request.url());
    });

    await page.locator('.open-in').getByRole('button', { name: 't3 code' }).click();

    await expect(page.locator('.open-in').getByRole('status')).toHaveText('Prompt copied. Opening T3 Code, paste it in.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PROMPT);
    expect(opened).toEqual([]);
    const request = page.waitForRequest((r) => r.url().startsWith('t3code:'));
    await page.clock.runFor(600);
    expect((await request).url()).toBe('t3code://');
  });

  test('the setup, agent by agent, stays shut until opened, and copies the Claude Code commands', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openHome(page);
    const setup = page.locator('.home-setup');
    await expect(setup.locator('dt').first()).toBeHidden();

    await setup.getByText('setup, agent by agent').click();

    await expect(setup.locator('dt')).toHaveText(['claude code', 'codex', 'opencode', 'cursor', 'grok bot', 't3 code']);
    await setup.getByRole('button', { name: 'Copy the Claude Code marketplace command' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('/plugin marketplace add meanwhileso/goodfirsttoken');
    await setup.getByRole('button', { name: 'Copy the Claude Code install command' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('/plugin install goodfirsttoken@goodfirsttoken');
  });
});

test.describe('the live wall', () => {
  test('takes a live event: the line goes on top, a square lights, and the count for today goes up', async ({ page }) => {
    const home = await openHome(page);
    const count = page.locator('.home-legend b');
    const before = Number((await count.textContent())?.replaceAll(',', ''));
    const event = liveEvent('wrote a failing test: a rewrite from /docs/ keeps its slash');

    home.send(event);

    const newest = page.locator('.wall-line').first();
    await expect(newest.locator('.wall-line__text')).toHaveText(event.text);
    await expect(newest.getByRole('link', { name: '@priya' })).toHaveAttribute('href', '/@priya');
    await expect(newest.getByRole('link', { name: 'sample-owner/sample-app#311' })).toHaveAttribute(
      'href',
      '/sample-owner/sample-app/issues/311',
    );
    await expect(count).toHaveText((before + 1).toLocaleString('en-US'));
    // Which square an event picks is tested in test/home/home.test.ts.
    const square = page.locator('.token-field__square--flash');
    await expect(square).toHaveCount(1);
    await expect(square).not.toHaveAttribute('data-level', '0');
  });

  test('counts only the events of the day it shows', async ({ page }) => {
    const home = await openHome(page);
    const count = page.locator('.home-legend b');
    const before = await count.textContent();

    home.send(liveEvent('an event from yesterday, delivered late', { time: new Date(Date.now() - 86_400_000).toISOString() }));

    await expect(page.locator('.wall-line').first()).toContainText('delivered late');
    await expect(count).toHaveText(before ?? '');
  });

  test('after the socket drops, reconnects from the last event it got, and shows an event sent twice once', async ({ page }) => {
    const home = await openHome(page);
    const first = liveEvent('before the drop');
    home.send(first);
    await expect(page.locator('.wall-line').first()).toContainText('before the drop');

    await home.sockets[0]?.close();

    await expect.poll(() => home.sockets.length).toBe(2);
    expect(new URL(home.sockets[1]?.url() ?? '').searchParams.get('since')).toBe(first.id);
    home.send(first, liveEvent('after the drop'));
    await expect(page.locator('.wall-line').first()).toContainText('after the drop');
    await expect(page.locator('.wall-line', { hasText: 'before the drop' })).toHaveCount(1);
  });

  test('keeps the six newest lines', async ({ page }) => {
    const home = await openHome(page);

    home.send(...Array.from({ length: 8 }, (_, i) => liveEvent(`line ${String(i)}`)));

    await expect(page.locator('.wall-line').first()).toContainText('line 7');
    await expect(page.locator('.wall-line')).toHaveCount(6);
    await expect(page.locator('.wall-line').last()).toContainText('line 2');
  });

  test('under reduced motion, shows a live line in full at once, and nothing on the page moves', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const home = await openHome(page);
    const event = liveEvent('added the NDJSON formatter (apps/web/src/feed/format.ts)');

    home.send(event);

    const newest = page.locator('.wall-line').first();
    await expect(newest.locator('.wall-line__text')).toHaveText(event.text);
    await expect(newest.locator('.cursor')).toHaveCount(0);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  });
});

test('the launch video shows its poster from the static host, and loads none of the video before a click', async ({ page }) => {
  const videos: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('.mp4')) videos.push(request.url());
  });
  await openHome(page);
  const video = page.locator('video.home-video');

  await expect(video).toHaveAttribute('preload', 'none');
  await expect(video).not.toHaveAttribute('autoplay');
  expect(await video.getAttribute('poster')).toMatch(new RegExp(`^${STATIC_HOST}/assets/launch-poster-.+\\.webp$`));
  expect(await video.locator('source').getAttribute('src')).toMatch(
    new RegExp(`^${STATIC_HOST}/assets/good-first-token-launch-.+\\.mp4$`),
  );
  await page.waitForLoadState('networkidle');
  expect(videos).toEqual([]);
});

test.describe('the homepage at each width', () => {
  // The same lines every time, on a day long gone, so the count and the
  // wall's times never change the picture.
  const lines = [
    { text: 'read AGENTS.md and CONTRIBUTING', user: 'arjun', agent: 'cursor' },
    {
      text: 'found where plugins claim file types (src/plugins/resolve-file-types-for-every-registered-plugin.ts)',
      user: 'sam',
      agent: 'opencode',
      issue: 'sample-owner/sample-bundler#120',
    },
    { text: 'wrote a failing test: a rewrite from /docs/ keeps its slash', user: 'priya', agent: 'claude-code' },
  ].map((line, i) =>
    liveEvent(line.text, { ...line, id: `e_e2eWidth${String(i).padStart(12, '0')}`, time: `2026-09-01T14:02:${String(10 + i * 17)}.000Z` }),
  );

  for (const width of [360, 390, 768, 1024, 1280]) {
    test(`fits the screen at ${String(width)}px with its setup open, and matches its screenshot`, async ({ page }) => {
      // Nothing moves, so the picture holds still.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width, height: 900 });
      const home = await openHome(page);
      home.send(...lines);
      await expect(page.locator('.wall-line').first()).toContainText('a rewrite from /docs/');
      await page.locator('.home-setup summary').click();
      await page.evaluate(() => document.fonts.ready);

      const [scrollWidth, clientWidth] = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

      // As for /design: up to 2% of pixels may differ, for antialiasing, and
      // a change in page height always fails. The video is masked, since
      // each Chromium draws its own controls, and may draw a spinner.
      await expect(page).toHaveScreenshot(`home-${String(width)}.png`, {
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
        mask: [page.locator('video.home-video')],
        maxDiffPixelRatio: 0.02,
      });
    });
  }
});
