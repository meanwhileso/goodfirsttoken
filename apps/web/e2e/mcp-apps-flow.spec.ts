import type { CallToolResult } from '@modelcontextprotocol/client';
import { LOCAL_API_URL } from '@goodfirsttoken/github-fake/local';
import { connectAgent, runAddress } from '../scripts/skill-run';
import { openView, readViews, sent } from './apps-host';
import { expect, test } from './fixtures';
import { SITE } from './hosts';

// A donor's agent in a host with MCP Apps, against the MCP server itself,
// the issue rooms, and the GitHub fake. The host passes each tool call a
// view makes to the server with the donor's own agent, as a host does. The
// sample work gives the site its sample projects, and this claims and opens
// a PR on one, so it runs last, in the `apps` project, once the other
// tests are done. The sample projects and people are made up.

const PROJECT = 'sample-owner/sample-desktop';

interface Suggestion {
  issue: string;
  prMode: string;
}

test("a Pick in the issue cards claims with the donor's own agent and follows the issue live, and Open PR in the review queue opens the PR on GitHub", async ({ page, context, request }) => {
  expect((await request.post('/dev/seed')).status()).toBe(200);
  const donor = await connectAgent(SITE, runAddress(), 'lena');
  const views = await readViews(donor);
  const call = (name: string, args: Record<string, unknown>) => donor.callTool({ name, arguments: args });
  const data = (result: CallToolResult): Record<string, unknown> => {
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    return (result.structuredContent ?? {}) as Record<string, unknown>;
  };
  const suggestionsOf = (result: CallToolResult) => data(result).suggestions as Suggestion[];
  const sessionId = String(data(await call('start_session', { agent: 'claude-code', budget: { kind: 'until_limit' } })).sessionId);
  data(await call('set_interests', { languages: [], projects: [PROJECT], kinds: [] }));

  // The project reviews agent PRs, so the work waits for the donor to open it.
  let suggested = await call('suggest_issues', { sessionId });
  const shown: string[] = [];
  for (let tries = 0; tries < 5 && !suggestionsOf(suggested).some((s) => s.issue.startsWith(`${PROJECT}#`)); tries++) {
    shown.push(...suggestionsOf(suggested).map((s) => s.issue));
    suggested = await call('suggest_issues', { sessionId, exclude: shown });
  }
  const pick = suggestionsOf(suggested).find((s) => s.issue.startsWith(`${PROJECT}#`));
  if (!pick) throw new Error(`No issue of ${PROJECT} was suggested.`);
  expect(pick.prMode).toBe('reviewed');

  const cards = await openView(page, views['issue-cards'], {
    input: { sessionId, exclude: shown },
    result: suggested,
    callTool: (name, args) => donor.callTool({ name, arguments: args }),
  });
  const card = cards.frame.locator('.view-pick').filter({ hasText: pick.issue });
  await card.getByRole('button', { name: 'Pick' }).click();

  await expect(card).toContainText('Claimed as claim');
  // The room's own event comes over the issue's socket on the site.
  await expect(card.locator('.wall-line').filter({ hasText: '@lena' }).filter({ hasText: 'claimed the issue' })).toHaveCount(1);
  const [told] = sent(await cards.messages(), 'ui/message');
  const claimId = /claim (c_\w+)/.exec(JSON.stringify(told?.params))?.[1] ?? '';
  expect(claimId).not.toBe('');
  // The agent takes the claim up, as the card told it to, and posts as it works.
  expect(data(await call('claim_issue', { sessionId, issue: pick.issue })).resumed).toBe(true);
  const line = `read AGENTS.md and CONTRIBUTING for ${pick.issue} <b>in e2e</b>`;
  data(await call('post_update', { claimId, text: line }));
  await expect(card.getByText(line, { exact: true })).toBeVisible();
  expect(cards.violations).toEqual([]);

  const submitted = data(
    await call('submit_work', {
      claimId,
      files: [{ path: 'docs/e2e-note.md', content: 'A note from the MCP Apps browser test.\n' }],
      summary: 'Adds a note.',
      checks: 'Read it twice.',
      agent: 'claude-code',
      model: 'e2e-model',
    }),
  );
  expect(submitted.reviewReason).toBe('reviewed_mode');

  const queue = await openView(await context.newPage(), views['review-queue'], {
    input: {},
    result: await call('my_work', {}),
    callTool: (name, args) => donor.callTool({ name, arguments: args }),
  });
  const item = queue.frame.locator('.view-ready').filter({ hasText: pick.issue });
  await item.getByRole('button', { name: 'Open PR' }).click();

  await expect(item.getByRole('status')).toContainText('Opened PR #');
  const number = Number(/Opened PR #(\d+)/.exec((await item.getByRole('status').textContent()) ?? '')?.[1]);
  const pr = (await (await request.get(`${LOCAL_API_URL}/repos/${PROJECT}/pulls/${String(number)}`)).json()) as {
    state: string;
    user: { login: string };
    body: string;
    head: { ref: string };
  };
  expect(pr).toMatchObject({ state: 'open', user: { login: 'lena' }, head: { ref: `goodfirsttoken/issue-${pick.issue.split('#')[1] ?? ''}-${claimId}` } });
  expect(pr.body).toContain(`Closes #${pick.issue.split('#')[1] ?? ''}`);
  expect(queue.violations).toEqual([]);
  await donor.close();
});
