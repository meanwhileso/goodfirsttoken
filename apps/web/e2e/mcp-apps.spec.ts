import type { Client } from '@modelcontextprotocol/client';
import type { FeedEvent } from '@goodfirsttoken/core';
import { connectAgent, runAddress } from '../scripts/skill-run';
import { openView, readViews, sent, type View, type ViewName } from './apps-host';
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
          text: `I picked ${ISSUE} in the Good First Token card, which claimed it as claim c_e2eclaim1. Call claim_issue with sessionId s_e2e1 and issue ${ISSUE} to get the claim, then work it.`,
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
  expect(sent(messages, 'ui/notifications/size-changed').length).toBeGreaterThan(0);
  await expect(view.frame.locator('html')).toHaveAttribute('data-theme', 'dark');
  // The card takes the prompt box's surface, code-surface, in the dark.
  await expect(view.frame.locator('.view')).toHaveCSS('background-color', 'rgb(22, 27, 34)');
  await expect(view.frame.locator('.view-issue__title')).toHaveCSS('color', 'rgb(230, 237, 243)');
});
