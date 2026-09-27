import { inflateSync } from 'node:zlib';
import type { FeedEvent } from '@goodfirsttoken/core';
import type { APIRequestContext, Page, WebSocketRoute } from '@playwright/test';
import { expect, test } from './fixtures';

// The issue page, with real issue rooms. Each test works an issue of its own
// through the dev-only POST /dev/work, as several of the GitHub fake's sample
// people, and the page follows the room over its live socket. A pause takes
// 30 minutes in a room, so that test stands in for the room's socket with
// routeWebSocket and sends a pause shaped exactly like the room's.
//
// Every event these tests make reaches the homepage's feed, so they run
// after the rest (playwright.config.ts), and the homepage's tests see only
// what they expect. Every person, repo, and line here is made up.

const REPO = 'sample-owner/sample-app';

/** An issue in a sample project's repo that no earlier run has touched. */
function freshIssue(): { issue: string; path: string; number: number } {
  const number = 1_000_000_000 + Math.floor(Math.random() * 8_000_000_000);
  return { issue: `${REPO}#${String(number)}`, path: `/${REPO}/issues/${String(number)}`, number };
}

type Work =
  | { action: 'claim'; agent: string }
  | { action: 'post'; text: string; job?: string }
  | { action: 'submit' }
  | { action: 'open_pr'; pr: number }
  | { action: 'release'; reason: string };

/** Works the issue as a sample person, through the room, and gives the room's answer. */
async function work(request: APIRequestContext, issue: string, login: string, doing: Work): Promise<Record<string, unknown>> {
  const res = await request.post('/dev/work', { data: { issue, login, ...doing } });
  expect(res.status(), await res.text()).toBe(200);
  const answer = (await res.json()) as Record<string, unknown>;
  expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true });
  return answer;
}

/** A claimant's lane, found by their login. */
function lane(page: Page, login: string) {
  return page.locator('.issue-lane').filter({ has: page.getByRole('heading', { name: `@${login}` }) });
}

/** Opens the page and waits until its live socket to the room is open. */
async function openIssue(page: Page, path: string) {
  const socket = page.waitForEvent('websocket', (ws) => ws.url().includes('/live.ndjson'));
  await page.goto(path);
  await socket;
}

// The 10 seconds a claim waits between two lines, and a little more.
const NEXT_LINE_MS = 10_500;

test('several claimants posting to one issue at once each get a lane, and their lines show live, in order', async ({ page, request }) => {
  test.setTimeout(60_000);
  const { issue, path } = freshIssue();
  await work(request, issue, 'priya', { action: 'claim', agent: 'claude-code' });
  await openIssue(page, path);
  await expect(page.locator('.issue-lane')).toHaveCount(1);

  await Promise.all([
    work(request, issue, 'kenji', { action: 'claim', agent: 'codex' }),
    work(request, issue, 'sam', { action: 'claim', agent: 'opencode' }),
  ]);
  await expect(page.locator('.issue-lane')).toHaveCount(3);
  await expect(page.locator('.issue-meta__slots')).toHaveText('3 of 3 slots taken');
  await expect(page.locator('.issue-slot')).toHaveCount(0);

  await Promise.all([
    work(request, issue, 'priya', { action: 'post', text: 'read AGENTS.md and CONTRIBUTING' }),
    work(request, issue, 'kenji', { action: 'post', text: 'reproduced the black screen on the second resume' }),
    work(request, issue, 'sam', { action: 'post', text: 'found where plugins claim file types (src/plugins.ts)' }),
  ]);
  await page.waitForTimeout(NEXT_LINE_MS);
  await Promise.all([
    work(request, issue, 'priya', { action: 'post', text: 'wrote failing test: a rewrite from /docs/ keeps its slash' }),
    work(request, issue, 'kenji', { action: 'post', text: 'tests: 212 passing', job: 'tests' }),
    work(request, issue, 'sam', { action: 'post', text: 'warned when two plugins claim .md' }),
  ]);

  await expect(lane(page, 'priya').locator('.issue-line__text')).toHaveText([
    'read AGENTS.md and CONTRIBUTING',
    'wrote failing test: a rewrite from /docs/ keeps its slash',
  ]);
  await expect(lane(page, 'kenji').locator('.issue-line__text')).toHaveText([
    'reproduced the black screen on the second resume',
    'tests: 212 passing',
  ]);
  await expect(lane(page, 'sam').locator('.issue-line__text')).toHaveText([
    'found where plugins claim file types (src/plugins.ts)',
    'warned when two plugins claim .md',
  ]);
  await expect(lane(page, 'kenji').locator('.issue-line__job')).toHaveText(['tests']);
  // One lane per claimant, each with its agent, and the lines that came live rise in.
  await expect(page.locator('.issue-lane__who')).toHaveText(['@priya', '@kenji', '@sam']);
  await expect(lane(page, 'kenji').locator('.chip').first()).toHaveText('codex');
  await expect(page.locator('.issue-line--new')).toHaveCount(6);
  await expect(page.locator('.issue-event__text')).toHaveText(['claimed the issue', 'claimed the issue', 'claimed the issue']);

  // A reload starts from the same lanes.
  await page.reload();
  await expect(lane(page, 'sam').locator('.issue-line__text')).toHaveText([
    'found where plugins claim file types (src/plugins.ts)',
    'warned when two plugins claim .md',
  ]);
});

test('when a PR opens, the slots close, and every lane says so with the PR link', async ({ page, request }) => {
  const { issue, path, number } = freshIssue();
  const pr = number + 1;
  await work(request, issue, 'priya', { action: 'claim', agent: 'claude-code' });
  await work(request, issue, 'kenji', { action: 'claim', agent: 'codex' });
  await openIssue(page, path);
  await expect(page.locator('.issue-slot__title')).toHaveText('Open slot');

  await work(request, issue, 'priya', { action: 'submit' });
  await work(request, issue, 'priya', { action: 'open_pr', pr });

  const link = `https://github.com/${REPO}/pull/${String(pr)}`;
  await expect(page.locator('.issue-meta__slots')).toHaveText('claims closed');
  await expect(page.locator('.slots')).toHaveClass(/slots--closed/);
  await expect(page.locator('.issue-slot__title')).toHaveText('Claims closed');
  await expect(page.locator('.issue-slot--closed').getByRole('link', { name: `PR #${String(pr)}` })).toHaveAttribute('href', link);
  for (const login of ['priya', 'kenji']) {
    await expect(lane(page, login).locator('.issue-lane__pr')).toHaveText(`PR #${String(pr)} is open, so claims are closed.`);
    await expect(lane(page, login).locator('.issue-lane__pr a')).toHaveAttribute('href', link);
  }
  await expect(lane(page, 'priya').getByRole('link', { name: `PR #${String(pr)} opened` })).toHaveAttribute('href', link);
  await expect(page.locator('.issue-event__text').last()).toHaveText(`opened PR #${String(pr)}`);
});

test('a released claim leaves the lanes, frees its slot, and the timeline says why', async ({ page, request }) => {
  const { issue, path } = freshIssue();
  await work(request, issue, 'priya', { action: 'claim', agent: 'claude-code' });
  await work(request, issue, 'kenji', { action: 'claim', agent: 'codex' });
  await openIssue(page, path);
  await expect(page.locator('.issue-lane')).toHaveCount(2);

  await work(request, issue, 'kenji', { action: 'release', reason: "needs a migration I couldn't run locally" });

  await expect(page.locator('.issue-lane__who')).toHaveText(['@priya']);
  await expect(page.locator('.issue-meta__slots')).toHaveText('1 of 3 slots taken');
  await expect(page.locator('.issue-slot__title')).toHaveText('2 open slots');
  await expect(page.locator('.issue-event').last()).toContainText("@kenji codex released: needs a migration I couldn't run locally");
});

test.describe('a paused claim', () => {
  let made = 0;

  /** An event shaped exactly like one the room sends. */
  function roomEvent(claim: { id: string; issue: string; login: string; agent: string }, kind: FeedEvent['kind'], text: string): FeedEvent {
    made += 1;
    return {
      id: `e_e2ePause${String(Date.now()).slice(-7)}${String(made).padStart(4, '0')}`,
      time: new Date().toISOString(),
      user: claim.login,
      agent: claim.agent,
      issue: claim.issue,
      claim: claim.id,
      kind,
      job: null,
      text,
    };
  }

  test('shows as paused, and its next line shows it working again', async ({ page, request }) => {
    const { issue, path } = freshIssue();
    await work(request, issue, 'priya', { action: 'claim', agent: 'claude-code' });
    const answer = await work(request, issue, 'kenji', { action: 'claim', agent: 'codex' });
    const kenji = { id: (answer.claim as { id: string }).id, issue, login: 'kenji', agent: 'codex' };
    await work(request, issue, 'kenji', { action: 'post', text: 'reading the feed Durable Object' });
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket(/\/live\.ndjson/, (socket) => {
      sockets.push(socket);
    });
    await page.goto(path);
    await expect.poll(() => sockets.length).toBe(1);
    await expect(lane(page, 'kenji')).toHaveAttribute('data-state', 'active');
    const lines = lane(page, 'kenji').locator('.issue-lane__lines');
    // text-body while working.
    await expect(lines).toHaveCSS('color', 'rgb(36, 41, 47)');

    sockets[0]?.send(JSON.stringify(roomEvent(kenji, 'paused', 'paused: no update for 30 minutes')));

    await expect(lane(page, 'kenji')).toHaveAttribute('data-state', 'paused');
    await expect(lane(page, 'kenji').locator('.issue-lane__state')).toHaveText('paused');
    // Its lines dim, to text-muted.
    await expect(lane(page, 'kenji')).toHaveClass(/issue-lane--paused/);
    await expect(lines).toHaveCSS('color', 'rgb(87, 96, 106)');
    await expect(lane(page, 'priya').locator('.issue-lane__state')).toHaveText('working');
    await expect(page.locator('.issue-event').last()).toContainText('@kenji codex paused: no update for 30 minutes');
    // A paused claim still holds its slot.
    await expect(page.locator('.issue-meta__slots')).toHaveText('2 of 3 slots taken');

    sockets[0]?.send(JSON.stringify(roomEvent(kenji, 'update', 'back: reading the feed Durable Object')));

    await expect(lane(page, 'kenji').locator('.issue-lane__state')).toHaveText('working');
    await expect(lines).toHaveCSS('color', 'rgb(36, 41, 47)');
    await expect(lane(page, 'kenji').locator('.issue-line__text')).toHaveText([
      'reading the feed Durable Object',
      'back: reading the feed Durable Object',
    ]);
  });
});

test('an issue that is not on the site is not found, and the page sets no cookie for a visitor', async ({ page, context, request }) => {
  const { issue, path } = freshIssue();
  const missing = await page.goto(path);
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not on Good First Token');

  await work(request, issue, 'priya', { action: 'claim', agent: 'claude-code' });
  const found = await page.goto(path);
  expect(found?.status()).toBe(200);
  expect(await found?.headerValue('set-cookie')).toBeNull();
  expect(await context.cookies()).toEqual([]);
});

/** The color of one pixel of the page as the screen shows it, as [r, g, b], from a 1 by 1 PNG screenshot. */
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 }, animations: 'disabled' });
  // The chunks after the 8-byte signature: length, type, data, and a CRC.
  // One pixel is one row: a filter byte, then its channels. With nothing
  // before or above it, every PNG filter leaves the channels as they are.
  const data: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') data.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return [...inflateSync(Buffer.concat(data)).subarray(1, 4)];
}

test('a short page is paper under its footer, down to the bottom of the window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto(freshIssue().path);
  const footer = await page.locator('.site-footer').boundingBox();
  expect((footer?.y ?? 0) + (footer?.height ?? 0)).toBeLessThan(1300);

  // The paper token, #FBFBF9.
  expect(await pixel(page, 640, 1390)).toEqual([0xfb, 0xfb, 0xf9]);
});

test('under reduced motion, a live line shows in full at once, and nothing on the page moves', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { issue, path } = freshIssue();
  await work(request, issue, 'priya', { action: 'claim', agent: 'claude-code' });
  await openIssue(page, path);

  await work(request, issue, 'priya', { action: 'post', text: 'added the NDJSON formatter (apps/web/src/feed/format.ts)' });

  await expect(lane(page, 'priya').locator('.issue-line__text')).toHaveText(['added the NDJSON formatter (apps/web/src/feed/format.ts)']);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});

test('fits the screen from 360 to 1280px, with long lines in every lane', async ({ page, request }) => {
  const { issue, path } = freshIssue();
  const long = `wrote the failing test in ${'src/plugins/resolve-file-types-for-every-registered-plugin/'.repeat(2)}index.test.ts`;
  for (const [login, agent] of [['priya', 'claude-code'], ['kenji', 'codex'], ['sam', 'opencode']] as const) {
    await work(request, issue, login, { action: 'claim', agent });
    await work(request, issue, login, { action: 'post', text: long.slice(0, 200), job: 'a-subagent-with-a-long-job-name' });
  }
  await work(request, issue, 'kenji', { action: 'release', reason: 'x'.repeat(200) });

  for (const width of [360, 390, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(path);
    await expect(page.locator('.issue-lane')).toHaveCount(2);
    await page.evaluate(() => document.fonts.ready);

    const [scrollWidth, clientWidth] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    expect(scrollWidth, `${String(width)}px`).toBeLessThanOrEqual(clientWidth);
  }
});
