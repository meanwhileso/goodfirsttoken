import type { FeedEvent } from '@goodfirsttoken/core';
import type { APIRequestContext, Page, WebSocketRoute } from '@playwright/test';
import { expect, test } from './fixtures';
import { SITE, STATIC_HOST } from './hosts';

// The homepage. Its live wall and token field follow the home feed over the
// WebSocket on /live.ndjson. These tests stand in for the feed with
// Playwright's routeWebSocket, and hand the page events of their own. The
// Worker's side of the socket is tested in test/feed/streams.test.ts, with
// real feeds. Every person, repo, and line here is made up.
//
// The preview starts with nothing in it (playwright.config.ts), and the
// tests in a file run in order. The first test checks the empty page. The
// last ones seed the sample work, through the dev-only POST /dev/seed, and
// check the page with ranks and projects on it.

const PROMPT = `Read ${SITE}/start.md, then spend some of my tokens on open source.`;
const WIDTHS = [360, 390, 768, 1024, 1280];

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

/** Whether the page scrolls sideways. */
async function scrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}

test('with nothing on it yet, the homepage says so plainly, and fits the screen at every width', async ({ page }) => {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.locator('.home-setup summary').click();

    await expect(page.getByText('Quiet right now.')).toBeVisible();
    await expect(page.getByText('No PRs merged this week yet.')).toBeVisible();
    await expect(page.getByText('No projects yet.')).toBeVisible();
    expect(await scrollsSideways(page), `${String(width)}px`).toBe(false);
  }
});

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

    await expect(page.locator('.open-in').getByRole('status')).toHaveText('Prompt copied. Paste it into T3 Code when it opens.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PROMPT);
    expect(opened).toEqual([]);
    const request = page.waitForRequest((r) => r.url().startsWith('t3code:'));
    await page.clock.runFor(600);
    expect((await request).url()).toBe('t3code://');
  });

  test('the agent setup stays shut until opened, and copies the Claude Code commands', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openHome(page);
    const setup = page.locator('.home-setup');
    await expect(setup.locator('dt').first()).toBeHidden();

    await setup.getByText('set up your agent').click();

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

  test('puts an event from an earlier day on the wall, but lights no square for it and adds nothing to the count', async ({
    page,
  }) => {
    const home = await openHome(page);
    const count = page.locator('.home-legend b');
    const before = await count.textContent();
    const lit = page.locator('.token-field__square:not([data-level="0"])');
    const litBefore = await lit.count();

    home.send(liveEvent('an event from yesterday, delivered late', { time: new Date(Date.now() - 86_400_000).toISOString() }));

    await expect(page.locator('.wall-line').first()).toContainText('delivered late');
    await expect(count).toHaveText(before ?? '');
    await expect(lit).toHaveCount(litBefore);
    await expect(page.locator('.token-field__square--flash')).toHaveCount(0);
  });

  test('when the UTC day turns, clears the token field and starts the count again at one', async ({ page }) => {
    const home = await openHome(page);
    home.send(liveEvent('a line from today'));
    await expect(page.locator('.wall-line').first()).toContainText('a line from today');
    const now = new Date();
    const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 1);

    home.send(liveEvent('the first line of the next day', { time: new Date(tomorrow).toISOString() }));

    await expect(page.locator('.wall-line').first()).toContainText('the first line of the next day');
    await expect(page.locator('.home-legend b')).toHaveText('1');
    const lit = page.locator('.token-field__square:not([data-level="0"])');
    await expect(lit).toHaveCount(1);
    await expect(lit).toHaveAttribute('data-level', '1');
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

test.describe("the wall's socket", () => {
  // The homepage with its clock paused, and a feed that takes each socket,
  // so the page sees it open, then closes it, unless `keepOpen` says to keep
  // it. The page's clock stands still meanwhile.
  async function pausedHome(page: Page, keepOpen: (n: number) => boolean) {
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 1000);
    const sockets: WebSocketRoute[] = [];
    // One for each socket the feed has closed, settled once it has.
    const closings: Promise<void>[] = [];
    await page.routeWebSocket(/\/live\.ndjson/, (socket) => {
      sockets.push(socket);
      if (keepOpen(sockets.length)) return;
      closings.push(
        new Promise((resolve) => {
          setTimeout(() => {
            void socket.close().then(resolve);
          }, 100);
        }),
      );
    });
    await page.goto('/');
    await expect.poll(() => sockets.length).toBe(1);

    // How long the page waited before each of its next `count` sockets, by
    // its clock, which moves 100 ms at a time once the socket before is shut.
    async function waits(count: number): Promise<number[]> {
      const gaps: number[] = [];
      while (gaps.length < count) {
        const had = sockets.length;
        await closings[had - 1];
        await page.evaluate(() => undefined);
        let waited = 0;
        while (sockets.length === had) {
          await page.clock.runFor(100);
          waited += 100;
          if (waited > 40_000) throw new Error(`No socket came after socket ${String(had)} in 40 seconds.`);
        }
        gaps.push(waited);
      }
      return gaps;
    }
    return { sockets, closings, waits };
  }

  test('backs off: about a second, then twice as long each time, even when the feed takes each socket first', async ({
    page,
  }) => {
    const { waits } = await pausedHome(page, () => false);

    const [first, second, third, fourth] = await waits(4);

    // Each wait is between half and all of its step, and the clock moves in
    // steps of 100 ms.
    expect(first).toBeGreaterThanOrEqual(500);
    expect(first).toBeLessThanOrEqual(1200);
    expect(second).toBeGreaterThanOrEqual(1000);
    expect(second).toBeLessThanOrEqual(2200);
    expect(third).toBeGreaterThanOrEqual(2000);
    expect(third).toBeLessThanOrEqual(4200);
    expect(fourth).toBeGreaterThanOrEqual(4000);
    expect(fourth).toBeLessThanOrEqual(8200);
  });

  test('starts the waits over once a socket has stayed open for 10 seconds', async ({ page }) => {
    // The fourth socket stays open.
    const { sockets, closings, waits } = await pausedHome(page, (n) => n === 4);
    await waits(3);

    await page.clock.runFor(10_000);
    closings.push(sockets[3]?.close() ?? Promise.resolve());
    const [after = Infinity] = await waits(1);

    expect(after).toBeLessThanOrEqual(1200);
  });

  test('closes when the page moves on, and opens no other', async ({ page }) => {
    const home = await openHome(page);
    const socket = home.sockets[0];
    let closed = false;
    // The feed answers the close, as a real one does, so the page sees its
    // socket close.
    socket?.onClose((code, reason) => {
      closed = true;
      void socket.close({ code, reason });
    });

    // Moves to /design inside the page, so the homepage unmounts and the
    // document stays.
    await page.evaluate(async () => {
      const router = (window as unknown as { __TSR_ROUTER__: { navigate: (to: { to: string }) => Promise<void> } })
        .__TSR_ROUTER__;
      await router.navigate({ to: '/design' });
    });
    await expect(page.locator('.ds-main')).toBeVisible();

    await expect.poll(() => closed, { timeout: 5000 }).toBe(true);
    // Longer than the first reconnect could wait.
    await page.waitForTimeout(1500);
    expect(home.sockets).toHaveLength(1);
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

test.describe('the homepage with the sample work on it', () => {
  // Seeded once for the worker. Seeding again adds nothing these tests look at.
  let seeded = false;
  async function seed(request: APIRequestContext) {
    if (seeded) return;
    const res = await request.post('/dev/seed');
    expect(res.status(), await res.text()).toBe(200);
    seeded = true;
  }

  // Six lines, always the same, on a day long gone. They push the seeded
  // lines, whose times change, off the wall, and light nothing.
  const lines = [
    { text: 'read AGENTS.md and CONTRIBUTING', user: 'arjun', agent: 'cursor' },
    {
      text: 'the lock screen reads the layout before the session restores it',
      user: 'ines',
      agent: 'grok',
      issue: 'sample-owner/sample-desktop#1440',
    },
    {
      text: 'found where plugins claim file types (src/plugins/resolve-file-types-for-every-registered-plugin.ts)',
      user: 'sam',
      agent: 'opencode',
      issue: 'sample-owner/sample-bundler#120',
    },
    {
      text: 'reproduced the black screen on the second resume',
      user: 'kenji',
      agent: 'codex',
      issue: 'sample-owner/sample-desktop#1431',
    },
    { text: 'tests: 212 passing', user: 'kenji', agent: 'codex', issue: 'sample-owner/sample-desktop#1431' },
    { text: 'wrote a failing test: a rewrite from /docs/ keeps its slash', user: 'priya', agent: 'claude-code' },
  ].map((line, i) =>
    liveEvent(line.text, {
      ...line,
      id: `e_e2eWidth${String(i).padStart(12, '0')}`,
      time: `2026-09-01T14:02:${String(10 + i * 9)}.000Z`,
    }),
  );

  for (const width of WIDTHS) {
    test(`fits the screen at ${String(width)}px with ranks, projects, and the setup open, and matches its screenshot`, async ({
      page,
      request,
    }) => {
      await seed(request);
      // Nothing moves, so the picture holds still.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width, height: 900 });
      const home = await openHome(page);
      home.send(...lines);
      await expect(page.locator('.wall-line').first()).toContainText('a rewrite from /docs/');
      await expect(page.locator('.wall-line')).toHaveCount(6);
      await expect(page.locator('.ranks > li')).toHaveText([/@kenji.*2$/, /@priya.*1$/, /@lena.*1$/, /@sam.*1$/]);
      await expect(page.locator('.project-rows > li')).toHaveCount(4);
      await page.locator('.home-setup summary').click();
      await page.evaluate(() => document.fonts.ready);

      expect(await scrollsSideways(page)).toBe(false);

      // As for /design: up to 2% of pixels may differ, for antialiasing, and
      // a change in page height always fails. The video is masked, since
      // each Chromium draws its own controls, and may draw a spinner. So are
      // the token field and today's count, which the seeded work lights with
      // IDs and times that change each run. The masks are drawn in the
      // brand's hairline gray.
      await expect(page).toHaveScreenshot(`home-${String(width)}.png`, {
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
        mask: [page.locator('video.home-video'), page.locator('.token-field'), page.locator('.home-legend b')],
        maskColor: '#D8DEE4',
        maxDiffPixelRatio: 0.02,
      });
    });
  }
});
