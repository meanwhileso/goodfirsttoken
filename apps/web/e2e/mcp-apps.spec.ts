import type { Client } from '@modelcontextprotocol/client';
import type { FeedEvent } from '@goodfirsttoken/core';
import { connectAgent, runAddress } from '../scripts/skill-run';
import { contrastOf, openView, readViews, sent, type View, type ViewName } from './apps-host';
import { expect, test } from './fixtures';
import { SITE } from './hosts';

// The views hosts with MCP Apps show, drawn in a browser from answers of
// the tools' own shapes: the issue cards with Pick, the live feed, and the
// review queue with Open PR. Each loads in a stand-in host (./apps-host.ts)
// under the policy its resource declares, and the test answers the tool
// calls its buttons make. The views are read from the MCP server, as a host
// reads them. Every repo, person, and line here is made up.
// mcp-apps-flow.spec.ts runs a Pick and an Open PR against the MCP server
// itself.

// A title, a label, and a line with markup in them, which a view shows as the characters they are.
const TITLE = `<img src=x onerror="parent.postMessage('owned','*')">Fix the <b>parser</b>`;
const LABEL = '<i>help wanted</i>';
const LINE = '<script>parent.postMessage("owned","*")</script>wrote a failing test (src/parse.ts)';
const ISSUE = 'sample-owner/sample-app#7';
const LIVE = `${SITE}/sample-owner/sample-app/issues/7`;

let views: Record<ViewName, View>;

test.beforeAll(async () => {
  const agent: Client = await connectAgent(SITE, runAddress(), 'sample-maintainer');
  views = await readViews(agent);
  await agent.close();
});

function text(value: string) {
  return [{ type: 'text', text: value }];
}

const suggestion = {
  issue: ISSUE,
  title: TITLE,
  url: 'https://github.example/sample-owner/sample-app/issues/7',
  liveUrl: LIVE,
  project: 'sample-owner/sample-app',
  tag: LABEL,
  prMode: 'reviewed',
  claUrl: null,
  claimants: [{ login: 'kenji', agent: 'codex', state: 'active' }],
  slotsTaken: 1,
  slots: 3,
  timesClaimed: 4,
  tough: true,
};

const second = {
  ...suggestion,
  issue: 'sample-owner/sample-desktop#12',
  title: 'Suspend fails on the second resume',
  project: 'sample-owner/sample-desktop',
  tag: 'ready',
  prMode: 'automatic',
  claUrl: 'https://cla.example/sample-desktop',
  claimants: [],
  slotsTaken: 0,
  timesClaimed: 0,
  tough: false,
};

const suggested = {
  content: text('Issues maintainers tagged for outside help (2):'),
  structuredContent: { suggestions: [suggestion, second] },
};

function claimed(issue: string, title: string, claimId = 'c_e2eclaim1') {
  const liveUrl = `${SITE}/${issue.replace('#', '/issues/')}`;
  return {
    content: text(`Claimed ${issue} as claim ${claimId} · 2 of 3 slots taken`),
    structuredContent: {
      claim: {
        claimId,
        issue,
        title,
        url: `https://github.example/${issue.replace('#', '/issues/')}`,
        liveUrl,
        state: 'active',
        agent: 'claude-code',
        claimedAt: '2026-09-29T10:00:00.000Z',
        expiresAt: '2026-09-30T10:00:00.000Z',
      },
      resumed: false,
      slotsTaken: 2,
      slots: 3,
      body: 'The parser breaks.',
      skipped: [],
      queued: [],
      budget: { issuesLeft: null, endsAt: null },
    },
  };
}

function event(text: string, id: string, user = 'priya'): FeedEvent {
  return { id, time: '2026-09-29T10:02:51.000Z', user, agent: 'claude-code', issue: ISSUE, claim: 'c_e2eclaim1', kind: 'update', job: null, text };
}

test('the issue cards show each suggestion with its tag, slots, and PR mode, and a title or label with markup shows as its text', async ({ page }) => {
  const view = await openView(page, views['issue-cards'], { input: { sessionId: 's_e2e1' }, result: suggested });
  const cards = view.frame.locator('.view-pick');

  await expect(cards).toHaveCount(2);
  await expect(view.frame.getByText(TITLE, { exact: true })).toBeVisible();
  await expect(cards.first().locator('.tag')).toHaveText(LABEL);
  await expect(view.frame.locator('img, b, i:not(.slots__slot)')).toHaveCount(0);
  await expect(cards.first().getByRole('img', { name: '1 of 3 taken' })).toBeVisible();
  await expect(cards.first()).toContainText('tough: claimed 4 times');
  await expect(cards.first()).toContainText('1 of 3 slots taken: @kenji (codex)');
  await expect(cards.first().locator('.badge')).toHaveText('PRsreviewed');
  await expect(cards.nth(1)).toContainText('nobody on it');
  await expect(view.frame.getByRole('button', { name: 'Pick' })).toHaveCount(2);
  await expect(view.frame.locator('.view__title')).toHaveText('2 issues tagged for outside help');
  expect(JSON.stringify(await view.messages())).not.toContain('owned');
  expect(view.violations).toEqual([]);
});

test("Pick claims the issue through the host with the call's session, the card turns live, and the agent is told to take the claim up", async ({ page }) => {
  const sockets: { send: (message: string) => void }[] = [];
  await page.routeWebSocket(/\/live\.ndjson/, (socket) => {
    sockets.push(socket);
  });
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const view = await openView(page, views['issue-cards'], {
    input: { sessionId: 's_e2e1' },
    result: suggested,
    callTool: (name, args) => {
      calls.push({ name, args });
      return Promise.resolve(claimed(ISSUE, TITLE));
    },
  });
  const card = view.frame.locator('.view-pick').first();

  await card.getByRole('button', { name: 'Pick' }).click();

  await expect(card).toContainText('Claimed as claim c_e2eclaim1 · 2 of 3 slots taken · expires 2026-09-30 10:00 UTC');
  expect(calls).toEqual([{ name: 'claim_issue', args: { sessionId: 's_e2e1', issue: ISSUE } }]);
  await expect(card.getByRole('img', { name: /taken$/ })).toHaveAccessibleName('2 of 3 taken');
  await expect(card.getByRole('button', { name: 'Pick' })).toHaveCount(0);
  await expect(view.frame.locator('.view-pick').nth(1).getByRole('button', { name: 'Pick' })).toBeDisabled();
  await expect(card.getByText('No lines yet.')).toBeVisible();
  // The card follows the issue's socket on the site, the one the issue page follows.
  await expect.poll(() => sockets.length).toBe(1);
  sockets[0]?.send(JSON.stringify(event(LINE, 'e_e2eline0001')));
  sockets[0]?.send('not an event');
  sockets[0]?.send(JSON.stringify(event('ran the parser tests: 3 failing', 'e_e2eline0002', 'kenji')));
  await expect(card.locator('.wall-line')).toHaveCount(2);
  await expect(card.locator('.wall-line').first()).toContainText('@kenji');
  await expect(card.getByText(LINE, { exact: true })).toBeVisible();
  await expect(view.frame.locator('script')).toHaveCount(1);
  const messages = await view.messages();
  expect(sent(messages, 'ui/message').map((m) => m.params)).toEqual([
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `I picked ${ISSUE} in the Good First Token card, which claimed it as claim c_e2eclaim1. Call claim_issue with sessionId s_e2e1 and issue ${ISSUE} to get the claim, ask me "Any special instructions for this one?", then work it.`,
        },
      ],
    },
  ]);
  expect(JSON.stringify(messages)).not.toContain('owned');
  expect(view.violations).toEqual([]);
});

test("a refused Pick shows the refusal's own text, and every Pick works again", async ({ page }) => {
  const refusal = `Refused (issue_full): ${ISSUE} has no open slot: 3 of 3 are taken. Pick another issue.`;
  const view = await openView(page, views['issue-cards'], {
    input: { sessionId: 's_e2e1' },
    result: suggested,
    callTool: () => Promise.resolve({ content: text(refusal), isError: true }),
  });
  const card = view.frame.locator('.view-pick').first();

  await card.getByRole('button', { name: 'Pick' }).click();

  await expect(card.getByRole('alert')).toHaveText(refusal);
  await expect(view.frame.getByRole('button', { name: 'Pick' })).toHaveCount(2);
  for (const pick of await view.frame.getByRole('button', { name: 'Pick' }).all()) await expect(pick).toBeEnabled();
  expect(sent(await view.messages(), 'ui/message')).toEqual([]);
});

test("a card for a project with a CLA sends the link with the claim only once the donor ticks that they signed it", async ({ page }) => {
  const calls: Record<string, unknown>[] = [];
  const view = await openView(page, views['issue-cards'], {
    input: { sessionId: 's_e2e1' },
    result: suggested,
    callTool: (_name, args) => {
      calls.push(args);
      return Promise.resolve(
        calls.length === 1
          ? { content: text('Refused (cla_required): Confirm the CLA at https://cla.example/sample-desktop.'), isError: true }
          : claimed(second.issue, second.title, 'c_e2eclaim2'),
      );
    },
  });
  const card = view.frame.locator('.view-pick').nth(1);

  await card.getByRole('button', { name: 'Pick' }).click();
  await expect(card.getByRole('alert')).toContainText('Refused (cla_required)');
  await card.getByRole('checkbox', { name: /I signed the project's CLA/ }).check();
  await card.getByRole('button', { name: 'Pick' }).click();

  await expect(card).toContainText('Claimed as claim c_e2eclaim2');
  expect(calls).toEqual([
    { sessionId: 's_e2e1', issue: second.issue },
    { sessionId: 's_e2e1', issue: second.issue, claConfirmed: 'https://cla.example/sample-desktop' },
  ]);
});

const ready = {
  claimId: 'c_e2eclaim3',
  issue: ISSUE,
  title: TITLE,
  url: 'https://github.example/sample-owner/sample-app/issues/7',
  liveUrl: LIVE,
  diffUrl: 'https://github.example/sample-owner/sample-app/compare/main...priya:goodfirsttoken/issue-7-c_e2eclaim3',
  additions: 12,
  deletions: 3,
  agent: 'claude-code',
  model: 'claude-opus-5-5',
  summary: 'Fixes the <em>parser</em> on empty input.',
  checks: 'pnpm test: 214 passing',
  reviewReason: 'reviewed_mode',
  prOnIssue: null,
  expiresAt: '2026-10-06T10:00:00.000Z',
  personWrittenDescription: false,
  openable: true,
  reason: null,
};

function work(readyToOpen: unknown[]) {
  return {
    content: text(`Ready to open as a PR (${String(readyToOpen.length)}).`),
    structuredContent: { followUps: [], readyToOpen, working: [] },
  };
}

test('the review queue shows each piece of work with its notes and diff, and Open PR calls open_pr with its claim', async ({ page }) => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const view = await openView(page, views['review-queue'], {
    input: {},
    result: work([ready, { ...ready, claimId: 'c_e2eclaim4', issue: 'sample-owner/sample-app#8', title: 'Paused project', openable: false, reason: 'sample-owner/sample-app is paused. Wait for it, or release the claim with release_claim.' }]),
    callTool: (name, args) => {
      calls.push({ name, args });
      return Promise.resolve({
        content: text(`Opened PR #41 on sample-owner/sample-app for ${ISSUE}, claim c_e2eclaim3: https://github.example/sample-owner/sample-app/pull/41`),
        structuredContent: {
          claimId: 'c_e2eclaim3',
          issue: ISSUE,
          state: 'pr_opened',
          pr: { repo: 'sample-owner/sample-app', number: 41, url: 'https://github.example/sample-owner/sample-app/pull/41' },
          prOnIssue: null,
        },
      });
    },
  });
  const [first, paused] = [view.frame.locator('.view-ready').first(), view.frame.locator('.view-ready').nth(1)];

  await expect(view.frame.getByText(TITLE, { exact: true })).toBeVisible();
  await expect(first).toContainText('claim c_e2eclaim3 · +12 -3 · claude-code (claude-opus-5-5) · expires 2026-10-06 10:00 UTC');
  await expect(first.locator('.view-summary')).toHaveText(ready.summary);
  await expect(view.frame.locator('em')).toHaveCount(0);
  // A link asks the host to open it, since the view's sandbox can't.
  await first.getByRole('button', { name: 'Read the diff' }).click();
  await expect(paused.getByRole('button', { name: 'Open PR' })).toBeDisabled();
  await expect(paused).toContainText("Can't open it now: sample-owner/sample-app is paused.");

  await first.getByRole('button', { name: 'Open PR' }).click();

  await expect(first.getByRole('status')).toContainText('Opened PR #41: https://github.example/sample-owner/sample-app/pull/41');
  await expect(first.getByRole('button', { name: 'Open PR' })).toHaveCount(0);
  // The host told the agent, so the donor needn't.
  await expect.poll(async () => sent(await view.messages(), 'ui/update-model-context').length).toBe(1);
  await expect(first.getByText(/Tell your agent/)).toHaveCount(0);
  expect(calls).toEqual([{ name: 'open_pr', args: { claimId: 'c_e2eclaim3' } }]);
  // The agent hears of the PR at its next turn.
  expect(sent(await view.messages(), 'ui/update-model-context').map((m) => m.params)).toEqual([
    { content: text(`Opened PR #41 on sample-owner/sample-app for ${ISSUE}, claim c_e2eclaim3: https://github.example/sample-owner/sample-app/pull/41`) },
  ]);
  await first.getByRole('button', { name: 'https://github.example/sample-owner/sample-app/pull/41' }).click();
  await expect.poll(async () => sent(await view.messages(), 'ui/open-link').map((m) => m.params)).toEqual([
    { url: ready.diffUrl },
    { url: 'https://github.example/sample-owner/sample-app/pull/41' },
  ]);
  expect(view.violations).toEqual([]);
});

test("for a project that wants a person-written description, the box starts empty and Open PR sends what the donor wrote, and a refusal shows its own text", async ({ page }) => {
  const refusal = 'Refused (description_required): sample-owner/sample-app asks the donor to write the PR description. Ask them for it, and pass it word for word.';
  const calls: Record<string, unknown>[] = [];
  const view = await openView(page, views['review-queue'], {
    input: {},
    result: work([{ ...ready, personWrittenDescription: true, prOnIssue: { repo: 'sample-owner/sample-app', number: 40, url: 'https://github.example/sample-owner/sample-app/pull/40' } }]),
    callTool: (_name, args) => {
      calls.push(args);
      return Promise.resolve({ content: text(refusal), isError: true });
    },
  });
  const item = view.frame.locator('.view-ready');
  const box = item.getByRole('textbox', { name: 'Your PR description, in your own words' });

  await expect(box).toHaveValue('');
  await expect(item).toContainText('A PR is already open on the issue: https://github.example/sample-owner/sample-app/pull/40. Open this one if a second PR helps.');
  await item.getByRole('button', { name: 'Open PR' }).click();
  await expect(item.getByRole('alert')).toHaveText(refusal);
  await box.fill('Handles empty input in the parser.');
  await item.getByRole('button', { name: 'Open PR' }).click();

  await expect.poll(() => calls.length).toBe(2);
  expect(calls).toEqual([{ claimId: 'c_e2eclaim3' }, { claimId: 'c_e2eclaim3', description: 'Handles empty input in the parser.' }]);
});

test("with nothing to show, a view shows the tool's own text, and a refused call shows the refusal", async ({ page }) => {
  const none = 'No eligible issues right now.';
  let view = await openView(page, views['issue-cards'], {
    input: { sessionId: 's_e2e1' },
    result: { content: text(none), structuredContent: { suggestions: [] } },
  });
  await expect(view.frame.locator('.view')).toContainText(none);
  await expect(view.frame.getByRole('button')).toHaveCount(0);

  const nothing = 'Nothing waiting: no follow-ups, no work to open, and no claims in progress.';
  view = await openView(await page.context().newPage(), views['review-queue'], {
    input: {},
    result: { content: text(nothing), structuredContent: { followUps: [], readyToOpen: [], working: [] } },
  });
  await expect(view.frame.locator('.view')).toContainText(nothing);
  await expect(view.frame.getByRole('button')).toHaveCount(0);

  const spent = 'Refused (budget_spent): Session s_e2e1 has spent its budget: 3 of 3 issues claimed.';
  view = await openView(await page.context().newPage(), views['issue-cards'], { input: { sessionId: 's_e2e1' }, result: { content: text(spent), isError: true } });
  await expect(view.frame.getByRole('alert')).toHaveText(spent);
});

test("the live feed view shows claim_issue's claim, and its issue's lines as they arrive over the site's socket", async ({ page }) => {
  const sockets: { send: (message: string) => void; url: () => string }[] = [];
  await page.routeWebSocket(/\/live\.ndjson/, (socket) => {
    sockets.push(socket);
  });
  const view = await openView(page, views['live-feed'], { input: { sessionId: 's_e2e1', issue: ISSUE }, result: claimed(ISSUE, TITLE) });

  await expect(view.frame.getByText(TITLE, { exact: true })).toBeVisible();
  await expect(view.frame.locator('.view-claim')).toContainText('Claimed as claim c_e2eclaim1 · 2 of 3 slots taken');
  await expect.poll(() => sockets.length).toBe(1);
  expect(sockets[0]?.url()).toBe(`${LIVE.replace('http:', 'ws:')}/live.ndjson`);
  for (let i = 1; i <= 22; i++) sockets[0]?.send(JSON.stringify(event(`line ${String(i)}`, `e_e2eline1${String(i).padStart(3, '0')}`)));

  // The newest 20 lines, newest first.
  await expect(view.frame.locator('.wall-line')).toHaveCount(20);
  await expect(view.frame.locator('.wall-line').first()).toContainText('line 22');
  await expect(view.frame.locator('.wall-line').last()).toContainText('line 3');
  expect(view.violations).toEqual([]);
});

test('a view talks to its host as the extension says: ui/initialize with its version, then initialized, then its size, and is dark when the host is', async ({ page }) => {
  const view = await openView(page, views['review-queue'], { input: {}, result: work([ready]), theme: 'dark' });
  await expect(view.frame.locator('.view-ready')).toHaveCount(1);

  const messages = await view.messages();
  expect(messages[0]).toMatchObject({
    jsonrpc: '2.0',
    method: 'ui/initialize',
    params: { protocolVersion: '2026-01-26', appInfo: { name: 'Good First Token' }, appCapabilities: { availableDisplayModes: ['inline'] } },
  });
  expect(messages[1]).toEqual({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  // The view measures itself in the next animation frame, which can come
  // after the page shows its content.
  await expect.poll(async () => sent(await view.messages(), 'ui/notifications/size-changed').length).toBeGreaterThan(0);
  await expect(view.frame.locator('html')).toHaveAttribute('data-theme', 'dark');
  // Light text on a dark card, with the contrast to read it.
  const title = await contrastOf(view.frame, '.view-issue__title');
  const [r = 0, g = 0, b = 0] = title.background.split(',').map(Number);
  expect(r + g + b).toBeLessThan(3 * 80);
  expect(title.ratio).toBeGreaterThanOrEqual(4.5);
});

test('functional links use blue on paper and readable light blue in a dark host', async ({ page }) => {
  const view = await openView(page, views['review-queue'], {
    input: {},
    result: work([{ ...ready, prOnIssue: { repo: 'sample-owner/sample-app', number: 41, url: 'https://github.example/sample-owner/sample-app/pull/41' } }]),
    theme: 'light',
  });
  const link = view.frame.locator('.view-link').first();
  await expect(link).toHaveCSS('color', 'rgb(9, 105, 218)');
  await view.send({ method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } });
  await expect(link).toHaveCSS('color', 'rgb(165, 214, 255)');
  expect((await contrastOf(view.frame, '.view-link')).ratio).toBeGreaterThanOrEqual(4.5);
});

test('opening a PR shows a blue notice that remains readable when the host turns dark', async ({ page }) => {
  const view = await openView(page, views['review-queue'], {
    input: {},
    result: work([ready]),
    theme: 'light',
    callTool: () => Promise.resolve({
      content: text('Opened PR #41.'),
      structuredContent: { claimId: ready.claimId, issue: ISSUE, state: 'pr_opened', pr: { repo: 'sample-owner/sample-app', number: 41, url: 'https://github.example/sample-owner/sample-app/pull/41' }, prOnIssue: null },
    }),
  });
  await view.frame.getByRole('button', { name: 'Open PR', exact: true }).click();
  const notice = view.frame.getByRole('status').filter({ hasText: 'Opened PR #41' });
  await expect(notice).toHaveCSS('background-color', 'rgb(221, 244, 255)');
  await view.send({ method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } });
  await expect(notice).toHaveCSS('background-color', 'color(srgb 0.0740392 0.179294 0.30651)');
  expect((await contrastOf(view.frame, '.view-notice--done')).ratio).toBeGreaterThanOrEqual(4.5);
  expect((await contrastOf(view.frame, '.view-notice--done .view-link')).ratio).toBeGreaterThanOrEqual(4.5);
});

test('in the dark, a refusal and the tough badge keep colors of their own, with the contrast to read them', async ({ page }) => {
  const refusal = `Refused (issue_full): ${ISSUE} has no open slot: 3 of 3 are taken. Pick another issue.`;
  const view = await openView(page, views['issue-cards'], {
    input: { sessionId: 's_e2e1' },
    result: suggested,
    theme: 'dark',
    callTool: () => Promise.resolve({ content: text(refusal), isError: true }),
  });
  await view.frame.locator('.view-pick').first().getByRole('button', { name: 'Pick' }).click();
  await expect(view.frame.getByRole('alert')).toHaveText(refusal);

  const body = await contrastOf(view.frame, '.view-issue__title');
  for (const selector of ['.view-notice--refused', '.chip--tough']) {
    const part = await contrastOf(view.frame, selector);
    expect(part.text, `${selector} has a color of its own`).not.toBe(body.text);
    expect(part.background, `${selector} sits on a tint of its own`).not.toBe(body.background);
    expect(part.ratio, `${selector} reads at 4.5:1 or more`).toBeGreaterThanOrEqual(4.5);
  }
});

test("a view keeps the host's theme when the host sends a change of something else, and follows a change of theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const view = await openView(page, views['review-queue'], { input: {}, result: work([ready]), theme: 'dark' });
  await expect(view.frame.locator('html')).toHaveAttribute('data-theme', 'dark');

  // basic-host sends the frame's size each time it changes.
  await view.send({ method: 'ui/notifications/host-context-changed', params: { containerDimensions: { width: 600, maxHeight: 6000 } } });
  await view.send({ method: 'ui/notifications/host-context-changed', params: { displayMode: 'inline' } });
  await expect.poll(async () => sent(await view.messages(), 'ui/notifications/size-changed').length).toBeGreaterThan(0);
  await expect(view.frame.locator('html')).toHaveAttribute('data-theme', 'dark');

  await view.send({ method: 'ui/notifications/host-context-changed', params: { theme: 'light' } });
  await expect(view.frame.locator('html')).toHaveAttribute('data-theme', 'light');
});

for (const refusal of ['isError', 'error'] as const) {
  test(`when the host refuses the message about a Pick, with ${refusal === 'isError' ? 'a result that says isError' : 'an error'}, the card says to tell the agent`, async ({ page }) => {
    const view = await openView(page, views['issue-cards'], {
      input: { sessionId: 's_e2e1' },
      result: suggested,
      refuse: { 'ui/message': refusal },
      callTool: () => Promise.resolve(claimed(ISSUE, TITLE)),
    });
    const card = view.frame.locator('.view-pick').first();

    await card.getByRole('button', { name: 'Pick' }).click();

    await expect(card.getByRole('status').filter({ hasText: 'Tell your agent' })).toHaveText(`Tell your agent to work ${ISSUE}, claim c_e2eclaim1.`);
  });

  test(`when the host won't open a link, with ${refusal === 'isError' ? 'a result that says isError' : 'an error'}, the page's address shows beside it`, async ({ page }) => {
    const view = await openView(page, views['issue-cards'], { input: { sessionId: 's_e2e1' }, result: suggested, refuse: { 'ui/open-link': refusal } });
    const card = view.frame.locator('.view-pick').first();
    await expect(card.getByText(suggestion.url, { exact: true })).toHaveCount(0);

    await card.getByRole('button', { name: 'Read it' }).click();

    await expect(card.getByText(suggestion.url, { exact: true })).toBeVisible();
  });

  test(`when the host won't tell the agent of an Open PR, with ${refusal === 'isError' ? 'a result that says isError' : 'an error'}, the queue says to tell it`, async ({ page }) => {
    const view = await openView(page, views['review-queue'], {
      input: {},
      result: work([ready]),
      refuse: { 'ui/update-model-context': refusal },
      callTool: () =>
        Promise.resolve({
          content: text(`Opened PR #41 on sample-owner/sample-app for ${ISSUE}, claim c_e2eclaim3.`),
          structuredContent: { claimId: 'c_e2eclaim3', issue: ISSUE, state: 'pr_opened', pr: { repo: 'sample-owner/sample-app', number: 41, url: 'https://github.example/sample-owner/sample-app/pull/41' }, prOnIssue: null },
        }),
    });
    const item = view.frame.locator('.view-ready');

    await item.getByRole('button', { name: 'Open PR' }).click();

    await expect(item.getByRole('status').filter({ hasText: 'Tell your agent' })).toHaveText('Tell your agent you opened PR #41 for claim c_e2eclaim3.');
    expect(sent(await view.messages(), 'ui/update-model-context')).toHaveLength(1);
  });
}

test("a view ignores messages from any frame but its host's, like a forged answer to its Pick or a forged theme", async ({ page }) => {
  const refusal = `Refused (issue_full): ${ISSUE} has no open slot: 3 of 3 are taken. Pick another issue.`;
  let answer: (result: unknown) => void = () => undefined;
  const view = await openView(page, views['issue-cards'], {
    input: { sessionId: 's_e2e1' },
    result: suggested,
    callTool: () => new Promise((resolve) => { answer = resolve; }),
  });
  const card = view.frame.locator('.view-pick').first();
  await card.getByRole('button', { name: 'Pick' }).click();
  await expect.poll(async () => sent(await view.messages(), 'tools/call').length).toBe(1);
  const [call] = sent(await view.messages(), 'tools/call');

  // Another frame on the page answers the Pick first, with a claim, and asks for the dark.
  await view.forge({ id: call?.id, result: claimed(ISSUE, TITLE) });
  await view.forge({ method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } });
  await expect.poll(() => page.locator('iframe').count()).toBe(3);
  await page.waitForTimeout(300);
  answer({ content: text(refusal), isError: true });

  await expect(card.getByRole('alert')).toHaveText(refusal);
  await expect(card).not.toContainText('Claimed as claim');
  await expect(view.frame.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('a view opens only an https page, or an http one on this machine, and shows any other address as text', async ({ page }) => {
  const cards = [
    { ...suggestion, issue: 'sample-owner/sample-app#21', title: 'Script link', url: 'javascript:parent.postMessage("owned","*")' },
    { ...suggestion, issue: 'sample-owner/sample-app#22', title: 'Data link', url: 'data:text/html,<script>parent.postMessage("owned","*")</script>' },
    { ...suggestion, issue: 'sample-owner/sample-app#23', title: 'Plain http elsewhere', url: 'http://github.example/sample-owner/sample-app/issues/23' },
    { ...suggestion, issue: 'sample-owner/sample-app#24', title: 'Local http', url: 'http://127.0.0.1:8944/sample-owner/sample-app/issues/24' },
  ];
  const view = await openView(page, views['issue-cards'], {
    input: { sessionId: 's_e2e1' },
    result: { content: text('Issues maintainers tagged for outside help (4):'), structuredContent: { suggestions: cards } },
  });
  const card = (n: number) => view.frame.locator('.view-pick').nth(n);
  await expect(view.frame.locator('.view-pick')).toHaveCount(4);

  for (const n of [0, 1, 2]) {
    await expect(card(n).getByRole('button', { name: 'Read it' })).toHaveCount(0);
    await card(n).getByText('Read it', { exact: true }).click();
  }
  await card(3).getByRole('button', { name: 'Read it' }).click();

  await expect.poll(async () => sent(await view.messages(), 'ui/open-link').map((m) => m.params)).toEqual([
    { url: 'http://127.0.0.1:8944/sample-owner/sample-app/issues/24' },
  ]);
  expect(JSON.stringify(await view.messages())).not.toContain('owned');
});

test("a view draws the first answer the host sends, and keeps it when the host sends the answers of the view's own calls", async ({ page }) => {
  const calls: Record<string, unknown>[] = [];
  const view = await openView(page, views['issue-cards'], {
    input: { sessionId: 's_e2e1' },
    result: suggested,
    callTool: (_name, args) => {
      calls.push(args);
      return Promise.resolve(claimed(second.issue, second.title, 'c_e2eclaim2'));
    },
  });
  await expect(view.frame.locator('.view-pick')).toHaveCount(2);

  // After a tools/call a view made, a host may send that call's input and answer too.
  await view.send({ method: 'ui/notifications/tool-input', params: { arguments: { sessionId: 's_other', issue: ISSUE } } });
  await view.send({ method: 'ui/notifications/tool-result', params: claimed(ISSUE, TITLE) });
  await page.waitForTimeout(300);
  await expect(view.frame.locator('.view-pick')).toHaveCount(2);
  await view.frame.locator('.view-pick').nth(1).getByRole('button', { name: 'Pick' }).click();
  await expect(view.frame.locator('.view-pick').nth(1)).toContainText('Claimed as claim c_e2eclaim2');
  expect(calls).toEqual([{ sessionId: 's_e2e1', issue: second.issue }]);

  const queue = await openView(await page.context().newPage(), views['review-queue'], { input: {}, result: work([ready]) });
  await expect(queue.frame.getByRole('button', { name: 'Open PR' })).toBeVisible();
  await queue.send({
    method: 'ui/notifications/tool-result',
    params: {
      content: text('Opened PR #41.'),
      structuredContent: { claimId: 'c_e2eclaim3', issue: ISSUE, state: 'pr_opened', pr: { repo: 'sample-owner/sample-app', number: 41, url: 'https://github.example/sample-owner/sample-app/pull/41' }, prOnIssue: null },
    },
  });
  await page.waitForTimeout(300);
  await expect(queue.frame.getByRole('button', { name: 'Open PR' })).toBeVisible();
});

test('each Open PR tells the agent every PR the queue opened so far, since a context update takes the place of the last', async ({ page }) => {
  const opened = (claimId: string, number: number) => ({
    content: text(`Opened PR #${String(number)} on sample-owner/sample-app for ${ISSUE}, claim ${claimId}.`),
    structuredContent: { claimId, issue: ISSUE, state: 'pr_opened', pr: { repo: 'sample-owner/sample-app', number, url: `https://github.example/sample-owner/sample-app/pull/${String(number)}` }, prOnIssue: null },
  });
  const view = await openView(page, views['review-queue'], {
    input: {},
    result: work([ready, { ...ready, claimId: 'c_e2eclaim4', issue: 'sample-owner/sample-app#8' }]),
    callTool: (_name, args) => Promise.resolve(args.claimId === 'c_e2eclaim3' ? opened('c_e2eclaim3', 41) : opened('c_e2eclaim4', 42)),
  });
  const items = view.frame.locator('.view-ready');

  await items.first().getByRole('button', { name: 'Open PR' }).click();
  await expect(items.first().getByRole('status')).toContainText('Opened PR #41');
  await items.nth(1).getByRole('button', { name: 'Open PR' }).click();
  await expect(items.nth(1).getByRole('status')).toContainText('Opened PR #42');

  await expect.poll(async () => sent(await view.messages(), 'ui/update-model-context').map((m) => m.params)).toEqual([
    { content: text(`Opened PR #41 on sample-owner/sample-app for ${ISSUE}, claim c_e2eclaim3.`) },
    {
      content: text(
        `Opened PR #41 on sample-owner/sample-app for ${ISSUE}, claim c_e2eclaim3.\nOpened PR #42 on sample-owner/sample-app for ${ISSUE}, claim c_e2eclaim4.`,
      ),
    },
  ]);
});

test('when the host takes the view down, the view closes its socket to the site', async ({ page }) => {
  let closed = false;
  const sockets: { send: (message: string) => void }[] = [];
  await page.routeWebSocket(/\/live\.ndjson/, (socket) => {
    sockets.push(socket);
    socket.onClose(() => { closed = true; });
  });
  const view = await openView(page, views['live-feed'], { input: { sessionId: 's_e2e1', issue: ISSUE }, result: claimed(ISSUE, TITLE) });
  await expect.poll(() => sockets.length).toBe(1);

  await view.send({ id: 99, method: 'ui/resource-teardown', params: {} });

  await expect.poll(async () => (await view.messages()).some((m) => m.id === 99 && 'result' in m)).toBe(true);
  await expect.poll(() => closed).toBe(true);
});

test("when the host won't start the view, it says so", async ({ page }) => {
  const view = await openView(page, views['issue-cards'], { input: { sessionId: 's_e2e1' }, result: suggested, refuse: { 'ui/initialize': 'error' } });

  await expect(view.frame.getByRole('alert')).toHaveText("The host didn't start the view: The host refused ui/initialize.");
  await expect(view.frame.getByText('Waiting for the answer.')).toHaveCount(0);
});
