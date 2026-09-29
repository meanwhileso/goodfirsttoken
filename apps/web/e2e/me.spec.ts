import type { APIRequestContext, Page } from '@playwright/test';
import { LOCAL_API_URL, LOCAL_WEB_URL } from '@goodfirsttoken/github-fake/local';
import type { Client } from '@modelcontextprotocol/client';
import { connectAgent, runAddress } from '../scripts/skill-run';
import { expect, test } from './fixtures';
import { SITE } from './hosts';

// /me and /maintainers in the browser, against the MCP server, the issue
// rooms, and the GitHub fake. priya's own agent, connected through the MCP
// client SDK the way a harness connects, claims two of the sample issues and
// submits work to each. Both projects review agent PRs, so the work waits in
// her review queue, and one of them asks her to write the PR description.
// Then she opens both PRs from /me, signed in on the site, and disconnects
// the agent. The sample work gives the site its sample projects, and this
// opens PRs on them, so it runs last, in the `me` project, once the other
// tests are done. The projects, people, and files are made up.

const DESKTOP = 'sample-owner/sample-desktop#1431';
const BUNDLER = 'sample-owner/sample-bundler#120';
const AGENT = 'Good First Token skill run (priya)';
const SUMMARY = 'Adds a note on the second resume.';
const WIDTHS = [390, 1280];

test.describe.configure({ mode: 'serial' });

let agent: Client;
const claims = new Map<string, string>();

// The site counts sign-ins by client address, and the other specs' browser
// sign-ins all come from one, some within the same minute as these. So this
// file's come from an address of its own. Only the sign-in carries it: a
// header on every request would make the browser ask the static host first
// for each font, which it refuses.
const ADDRESS = runAddress();

async function devSignIn(page: Page, login: string) {
  // The sign-ins this route gave the file's own address, so the test knows
  // the sign-in didn't come from the address the other specs share.
  let routed = 0;
  await page.route(`${SITE}/auth/dev/sign-in`, (route) => {
    if (route.request().method() === 'POST') routed++;
    return route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': ADDRESS } });
  });
  await page.goto('/');
  await page.evaluate((person) => {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = '/auth/dev/sign-in';
    const field = document.createElement('input');
    field.name = 'login';
    field.value = person;
    form.append(field);
    document.body.append(form);
    form.submit();
  }, login);
  await page.waitForURL((url) => url.pathname === '/me');
  expect(routed, 'the sign-in went through the route that gives it its own address').toBe(1);
}

async function scrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}

/** The structured answer of a tool call, which has to succeed. */
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await agent.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[]).map((part) => part.text ?? '').join('\n');
  expect(result.isError, text).toBeFalsy();
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

interface Pull {
  number: number;
  state: string;
  body: string;
  user: { login: string };
  head: { ref: string };
}

/** The PR on the GitHub fake, read as anyone reads a public repo. */
async function pullOf(repo: string, number: number, request: APIRequestContext): Promise<Pull> {
  return (await (await request.get(`${LOCAL_API_URL}/repos/${repo}/pulls/${String(number)}`)).json()) as Pull;
}

/** The queue item for an issue on /me. */
function item(page: Page, issue: string) {
  return page.locator('.queue-item').filter({ hasText: issue });
}

test.beforeAll(async ({ request }) => {
  expect((await request.post('/dev/seed')).status()).toBe(200);
  agent = await connectAgent(SITE, runAddress(), 'priya');
  const { sessionId } = await call('start_session', { agent: 'claude-code', budget: { kind: 'until_limit' } });
  for (const issue of [DESKTOP, BUNDLER]) {
    const claimed = await call('claim_issue', { sessionId, issue });
    const claimId = (claimed.claim as { claimId: string }).claimId;
    claims.set(issue, claimId);
    const submitted = await call('submit_work', {
      claimId,
      files: [{ path: 'docs/e2e-note.md', content: 'A note from the browser test of /me.\n' }],
      summary: SUMMARY,
      checks: 'Read it twice.',
      agent: 'claude-code',
      model: 'e2e-model',
    });
    expect(submitted.reviewReason).toBe('reviewed_mode');
  }
});

test.afterAll(async () => {
  await agent.close();
});

for (const width of WIDTHS) {
  test(`/me fits the screen at ${String(width)}px with work in the queue and an agent connected, and matches its screenshot`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 900 });
    await devSignIn(page, 'priya');
    await expect(page.locator('.queue-item')).toHaveCount(2);
    await expect(page.getByRole('button', { name: `Disconnect ${AGENT}` })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    expect(await scrollsSideways(page)).toBe(false);

    // As for the homepage: up to 2% of pixels may differ, for antialiasing,
    // and a change in page height always fails. When the agent connected and
    // last called a tool changes each run, so it is masked in the brand's
    // hairline gray.
    await expect(page).toHaveScreenshot(`me-${String(width)}.png`, {
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
      mask: [page.locator('.account__agent .mono')],
      maskColor: '#D8DEE4',
      maxDiffPixelRatio: 0.02,
    });
  });

  test(`/maintainers fits the screen at ${String(width)}px and matches its screenshot`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/maintainers');
    await page.evaluate(() => document.fonts.ready);

    expect(await scrollsSideways(page)).toBe(false);
    await expect(page).toHaveScreenshot(`maintainers-${String(width)}.png`, {
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.02,
    });
  });
}

test('Open PR on /me opens the PR on GitHub as the donor, with the token from her sign-in on the site, and the work leaves the queue', async ({
  page,
  request,
}) => {
  await devSignIn(page, 'priya');
  const work = item(page, DESKTOP);
  await expect(work.getByText(SUMMARY)).toBeVisible();

  await work.getByRole('button', { name: `Open PR for ${DESKTOP}` }).click();

  const notice = page.getByRole('status').filter({ hasText: 'Opened PR #' });
  await expect(notice).toContainText(`on sample-owner/sample-desktop for ${DESKTOP}`);
  const number = Number(/Opened PR #(\d+)/.exec((await notice.textContent()) ?? '')?.[1]);
  await expect(item(page, DESKTOP)).toHaveCount(0);
  await expect(item(page, BUNDLER)).toHaveCount(1);
  const pr = await pullOf('sample-owner/sample-desktop', number, request);
  expect(pr).toMatchObject({ state: 'open', user: { login: 'priya' }, head: { ref: `goodfirsttoken/issue-1431-${claims.get(DESKTOP) ?? ''}` } });
  expect(pr.body).toContain(SUMMARY);
  // The PR opened with the token from priya's sign-in on the site, and her
  // agent's own token made the commit.
  const calls = (await (await request.get(`${LOCAL_WEB_URL}/_fake/calls`)).json()) as {
    operation: string;
    url: string;
    token: string | null;
    login: string | null;
  }[];
  // The fake's log is the whole run's, so it holds other tests' PRs too,
  // like the one mcp-apps-flow.spec.ts opens as lena. This test's is priya's.
  const opened = calls.filter(
    (c) => c.operation === 'POST /repos/{owner}/{repo}/pulls' && c.url.includes('/sample-desktop/') && c.login === 'priya',
  );
  const committed = calls.filter((c) => c.operation.startsWith('mutation createCommitOnBranch') && c.login === 'priya');
  expect(opened).toHaveLength(1);
  expect(committed.length).toBeGreaterThan(0);
  expect(committed.map((c) => c.token)).not.toContain(opened[0]?.token);
});

test("a project that asks for the donor's own description starts the form empty, refuses it empty, and opens the PR with exactly her words", async ({
  page,
  request,
}) => {
  await devSignIn(page, 'priya');
  const work = item(page, BUNDLER);
  const description = work.getByLabel('your PR description');
  await expect(description).toHaveValue('');
  const open = work.getByRole('button', { name: `Open PR for ${BUNDLER}` });

  // The browser won't send it empty.
  await open.click();
  expect(await description.evaluate((field: HTMLTextAreaElement) => field.validity.valueMissing)).toBe(true);
  await expect(page).toHaveURL(`${SITE}/me`);
  // Sent empty all the same, the server refuses it.
  await work.locator('form').evaluate((form: HTMLFormElement) => {
    form.noValidate = true;
  });
  await open.click();
  await expect(page.getByRole('status')).toContainText(
    'No PR opened. This project asks you to write the PR description yourself.',
  );
  await expect(item(page, BUNDLER).getByLabel('your PR description')).toHaveValue('');

  const words = 'Two plugins that claim .md files now get a warning.\nI read the diff <b>twice</b>, and ran the tests.';
  await item(page, BUNDLER).getByLabel('your PR description').fill(words);
  await item(page, BUNDLER).getByRole('button', { name: `Open PR for ${BUNDLER}` }).click();

  const notice = page.getByRole('status').filter({ hasText: 'Opened PR #' });
  await expect(notice).toContainText(`for ${BUNDLER}`);
  const number = Number(/Opened PR #(\d+)/.exec((await notice.textContent()) ?? '')?.[1]);
  await expect(item(page, BUNDLER)).toHaveCount(0);
  const pr = await pullOf('sample-owner/sample-bundler', number, request);
  expect(pr.user.login).toBe('priya');
  expect(pr.body).toBe(`${words}\n\nCloses #120\n\nWritten with a coding agent through Good First Token.`);
});

test('Disconnect on /me cuts the agent off, and its next tool call fails', async ({ page }) => {
  await devSignIn(page, 'priya');
  const disconnect = page.getByRole('button', { name: `Disconnect ${AGENT}` });
  await expect(disconnect).toBeVisible();

  await disconnect.click();

  await page.waitForURL((url) => url.pathname === '/me');
  await expect(page.getByRole('button', { name: `Disconnect ${AGENT}` })).toHaveCount(0);
  await expect(agent.callTool({ name: 'my_work', arguments: {} })).rejects.toThrow();
});
