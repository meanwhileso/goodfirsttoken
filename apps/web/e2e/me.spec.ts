import type { APIRequestContext, Page } from '@playwright/test';
import { LOCAL_API_URL, LOCAL_WEB_URL } from '@goodfirsttoken/github-fake/local';
import type { Client } from '@modelcontextprotocol/client';
import { connectAgent, runAddress } from '../scripts/skill-run';
import { expect, test } from './fixtures';
import { SITE } from './hosts';

// /me and /maintainers in the browser, against the MCP server, the issue
// rooms, and the GitHub fake. priya's own agent, connected through the MCP
// client SDK the way a harness connects, claims two of the sample issues.
// It submits work with files to one. For the other, it pushes the claim's
// branch to her fork, as her own git would, and submits the branch. Both
// projects review agent PRs, so the work waits in her review queue, and one
// of them asks her to write the PR description. Signed in on the site, she
// clears the pushed work from /me, which links GitHub's form for its PR,
// opens the other PR, and disconnects the agent. The sample work gives the
// site its sample projects, and this opens a PR on them, so it runs last,
// in the `me` project, once the other tests are done. The projects, people,
// and files are made up.

const DESKTOP = 'sample-owner/sample-desktop#1431';
const BUNDLER = 'sample-owner/sample-bundler#120';
const AGENT = 'Good First Token skill run (priya)';
const SUMMARY = 'Adds a note on the second resume.';
const WIDTHS = [390, 1280];
const PULLS = 'POST /repos/{owner}/{repo}/pulls';

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

interface FakeCall {
  operation: string;
  url: string;
  token: string | null;
  login: string | null;
}

async function fakeCalls(request: APIRequestContext): Promise<FakeCall[]> {
  return (await (await request.get(`${LOCAL_WEB_URL}/_fake/calls`)).json()) as FakeCall[];
}

/**
 * Pushes the claim's branch to priya's fork of the repo on the GitHub fake,
 * as her own git would: a fork, made when she has none, the branch from the
 * start commit, and one commit on it with the project's trailer. It uses
 * the GitHub token her agent's commits ran with. Returns the fork and the
 * branch's head.
 */
async function push(request: APIRequestContext, repo: string, branch: string, start: string): Promise<{ fork: string; head: string }> {
  const token = (await fakeCalls(request)).find((c) => c.operation.startsWith('mutation createCommitOnBranch') && c.login === 'priya')?.token;
  if (!token) throw new Error("no GitHub token of priya's agent in the fake's calls");
  const headers = { authorization: `Bearer ${token}` };
  const forked = await request.post(`${LOCAL_API_URL}/repos/${repo}/forks`, { headers, data: {} });
  expect(forked.ok(), await forked.text()).toBe(true);
  const fork = ((await forked.json()) as { full_name: string }).full_name;
  // GitHub makes a new fork in the background, and its git data answers 409 until it's ready.
  await expect
    .poll(async () => (await request.post(`${LOCAL_API_URL}/repos/${fork}/git/refs`, { headers, data: { ref: `refs/heads/${branch}`, sha: start } })).status(), {
      timeout: 10_000,
    })
    .toBe(201);
  const query = `mutation ($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }`;
  const input = {
    branch: { repositoryNameWithOwner: fork, branchName: branch },
    expectedHeadOid: start,
    message: { headline: 'Read the layout before the session restores it', body: 'Assisted-by: claude-code (e2e-model)' },
    fileChanges: { additions: [{ path: 'docs/e2e-lock.md', contents: Buffer.from('A note from the browser test of /me.\n').toString('base64') }] },
  };
  const answer = (await (await request.post(`${LOCAL_API_URL}/graphql`, { headers, data: { query, variables: { input } } })).json()) as {
    data?: { createCommitOnBranch?: { commit?: { oid?: string } } };
    errors?: unknown;
  };
  const oid = answer.data?.createCommitOnBranch?.commit?.oid;
  if (!oid) throw new Error(`the push failed: ${JSON.stringify(answer.errors)}`);
  return { fork, head: oid };
}

test.beforeAll(async ({ request }) => {
  expect((await request.post('/dev/seed')).status()).toBe(200);
  agent = await connectAgent(SITE, runAddress(), 'priya');
  const { sessionId } = await call('start_session', { agent: 'claude-code', budget: { kind: 'until_limit' } });
  const bundler = await call('claim_issue', { sessionId, issue: BUNDLER });
  claims.set(BUNDLER, (bundler.claim as { claimId: string }).claimId);
  const files = await call('submit_work', {
    claimId: claims.get(BUNDLER),
    files: [{ path: 'docs/e2e-note.md', content: 'A note from the browser test of /me.\n' }],
    summary: 'Warns when two plugins claim a file type.',
    checks: 'Read it twice.',
    agent: 'claude-code',
    model: 'e2e-model',
  });
  expect(files.reviewReason).toBe('reviewed_mode');

  const desktop = await call('claim_issue', { sessionId, issue: DESKTOP });
  const { claimId } = desktop.claim as { claimId: string };
  const branch = (desktop.branch as { name: string }).name;
  claims.set(DESKTOP, claimId);
  const { fork, head } = await push(request, 'sample-owner/sample-desktop', branch, (desktop.clone as { commit: string }).commit);
  const pushed = await call('submit_work', {
    claimId,
    branch: { repo: fork, name: branch, head },
    summary: SUMMARY,
    checks: 'Suspended and resumed twice.',
    agent: 'claude-code',
    model: 'e2e-model',
  });
  expect(pushed).toMatchObject({ source: 'branch', reviewReason: 'reviewed_mode', toOpen: null });
});

test.afterAll(async () => {
  await agent.close();
});

test("Open PR on /me clears the pushed work, opens nothing on GitHub, and links GitHub's form for its PR", async ({ page, request }) => {
  await devSignIn(page, 'priya');
  const work = item(page, DESKTOP);
  await expect(work.getByText(SUMMARY)).toBeVisible();
  const before = (await fakeCalls(request)).length;

  await work.getByRole('button', { name: `Open PR for ${DESKTOP}` }).click();

  await expect(page.getByRole('status')).toContainText(`The PR for ${DESKTOP} is ready to open. Open it on GitHub from your queue.`);
  const open = item(page, DESKTOP).getByRole('link', { name: `Open the PR for ${DESKTOP} on GitHub` });
  const href = (await open.getAttribute('href')) ?? '';
  const form = new URL(href);
  const branch = `goodfirsttoken/issue-1431-${claims.get(DESKTOP) ?? ''}`;
  expect(`${form.origin}${form.pathname}`).toBe(`${LOCAL_WEB_URL}/sample-owner/sample-desktop/compare/main...priya:${branch}`);
  expect(form.searchParams.get('quick_pull')).toBe('1');
  expect(form.searchParams.get('body')).toContain(SUMMARY);
  expect(form.searchParams.get('body')).toContain('Closes #1431');
  await expect(item(page, DESKTOP)).toContainText('Good First Token records the PR once it is open.');
  await expect(item(page, DESKTOP).getByRole('button', { name: `Open PR for ${DESKTOP}` })).toHaveCount(0);
  // The donor opens the PR on GitHub. The server opened none, and wrote nothing.
  const made = (await fakeCalls(request)).slice(before);
  expect(made.filter((c) => c.operation === PULLS || c.operation.startsWith('mutation'))).toEqual([]);
  // The link stays when the page loads again.
  await page.goto('/me');
  await expect(item(page, DESKTOP).getByRole('link', { name: `Open the PR for ${DESKTOP} on GitHub` })).toHaveAttribute('href', href);
});

for (const width of WIDTHS) {
  test(`/me fits the screen at ${String(width)}px with cleared work and work to open in the queue, and an agent connected, and matches its screenshot`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 900 });
    await devSignIn(page, 'priya');
    await expect(page.locator('.queue-item')).toHaveCount(2);
    await expect(item(page, DESKTOP).getByRole('link', { name: `Open the PR for ${DESKTOP} on GitHub` })).toBeVisible();
    await expect(item(page, BUNDLER).getByLabel('your PR description')).toBeVisible();
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

test("a project that asks for the donor's own description starts the form empty, refuses it empty, and opens the PR with exactly her words, as her, with the token from her sign-in on the site", async ({
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
  await expect(item(page, DESKTOP)).toHaveCount(1);
  const pr = await pullOf('sample-owner/sample-bundler', number, request);
  expect(pr).toMatchObject({ state: 'open', user: { login: 'priya' }, head: { ref: `goodfirsttoken/issue-120-${claims.get(BUNDLER) ?? ''}` } });
  expect(pr.body).toBe(`${words}\n\nCloses #120\n\nWritten with a coding agent through Good First Token.`);
  // The PR opened with the token from priya's sign-in on the site, and her
  // agent's own token made the commit. The fake's log is the whole run's,
  // so it holds other tests' PRs too. This test's is priya's.
  const calls = await fakeCalls(request);
  const opened = calls.filter((c) => c.operation === PULLS && c.url.includes('/sample-bundler/') && c.login === 'priya');
  const committed = calls.filter((c) => c.operation.startsWith('mutation createCommitOnBranch') && c.login === 'priya');
  expect(opened).toHaveLength(1);
  expect(committed.length).toBeGreaterThan(0);
  expect(committed.map((c) => c.token)).not.toContain(opened[0]?.token);
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
