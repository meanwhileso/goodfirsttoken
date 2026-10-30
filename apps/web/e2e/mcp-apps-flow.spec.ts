import type { CallToolResult } from '@modelcontextprotocol/client';
import { LOCAL_API_URL, LOCAL_WEB_URL } from '@goodfirsttoken/github-fake/local';
import { connectAgent, runAddress } from '../scripts/skill-run';
import { openView, readViews, sent } from './apps-host';
import { expect, test } from './fixtures';
import { SITE } from './hosts';

// A donor's agent in a host with MCP Apps, against the MCP server itself,
// the issue rooms, and the GitHub fake. The host passes each tool call a
// view makes to the server with the donor's own agent, as a host does. The
// donor's own git pushes the claim's branch, and their own token opens the
// PR on GitHub's form. The sample work gives the site its sample projects,
// and this claims and opens a PR on one, so it runs last, in the `apps`
// project, once the other tests are done. The sample projects and people
// are made up.

const PROJECT = 'sample-owner/sample-desktop';

interface Suggestion {
  issue: string;
  prMode: string;
}

test("a Pick in the issue cards claims with the donor's own agent and follows the issue live, and Open PR in the review queue clears the work and links GitHub's form for its PR", async ({ page, context, request }) => {
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
  // me.spec.ts claims sample-desktop#1431 and clears its pushed branch. This
  // test leaves that issue out, so the PR it opens isn't on that issue, and
  // me.spec.ts's work doesn't wait on another PR.
  const shown: string[] = [`${PROJECT}#1431`];
  let suggested = await call('suggest_issues', { sessionId, exclude: shown });
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
  // A claim ID is base64url, so it can hold - as well as _.
  const claimId = /claim (c_[\w-]+)/.exec(JSON.stringify(told?.params))?.[1] ?? '';
  expect(claimId).not.toBe('');
  // The agent takes the claim up, as the card told it to, and posts as it works.
  expect(data(await call('claim_issue', { sessionId, issue: pick.issue })).resumed).toBe(true);
  const line = `read AGENTS.md and CONTRIBUTING for ${pick.issue} <b>in e2e</b>`;
  data(await call('post_update', { claimId, text: line }));
  await expect(card.getByText(line, { exact: true })).toBeVisible();
  expect(cards.violations).toEqual([]);

  // lena's own git pushes the claim's branch to her fork. The GitHub fake
  // takes no git push, so the commit goes through its API with a token of
  // her own, from no OAuth app.
  const given = await request.post(`${LOCAL_WEB_URL}/_fake/token`, { data: { login: 'lena' } });
  const headers = { authorization: `Bearer ${((await given.json()) as { token: string }).token}` };
  const forked = await request.post(`${LOCAL_API_URL}/repos/${PROJECT}/forks`, { headers, data: {} });
  expect(forked.ok(), await forked.text()).toBe(true);
  const fork = ((await forked.json()) as { full_name: string }).full_name;
  const number = pick.issue.split('#')[1] ?? '';
  const branch = `goodfirsttoken/issue-${number}-${claimId}`;
  const startCommit = (data(await call('claim_issue', { sessionId, issue: pick.issue })).clone as { commit: string }).commit;
  await expect
    .poll(async () => (await request.post(`${LOCAL_API_URL}/repos/${fork}/git/refs`, { headers, data: { ref: `refs/heads/${branch}`, sha: startCommit } })).status(), {
      timeout: 10_000,
    })
    .toBe(201);
  const committed = (await (
    await request.post(`${LOCAL_API_URL}/graphql`, {
      headers,
      data: {
        query: 'mutation ($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }',
        variables: {
          input: {
            branch: { repositoryNameWithOwner: fork, branchName: branch },
            expectedHeadOid: startCommit,
            message: { headline: 'Add a note', body: 'Assisted-by: claude-code (e2e-model)' },
            fileChanges: { additions: [{ path: 'docs/e2e-note.md', contents: Buffer.from('A note from the MCP Apps browser test.\n').toString('base64') }] },
          },
        },
      },
    })
  ).json()) as { data?: { createCommitOnBranch?: { commit?: { oid?: string } } } };
  const head = committed.data?.createCommitOnBranch?.commit?.oid ?? '';
  expect(head).not.toBe('');

  const submitted = data(
    await call('submit_work', {
      claimId,
      branch: { repo: fork, name: branch, head },
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

  // The server cleared the work and opened nothing. The view asks the host
  // to open GitHub's form, since its sandbox can't.
  await item.getByRole('button', { name: 'Open the PR on GitHub' }).click();
  await expect.poll(async () => sent(await queue.messages(), 'ui/open-link').length).toBe(1);
  const [asked] = sent(await queue.messages(), 'ui/open-link');
  const form = new URL((asked?.params as { url?: string } | undefined)?.url ?? '');
  expect(`${form.origin}${form.pathname}`).toBe(`${LOCAL_WEB_URL}/${PROJECT}/compare/main...lena:${branch}`);
  expect(form.searchParams.get('body')).toContain(`Closes #${number}`);
  // lena opens the PR on the form, with her own token, and her agent records it.
  const opened = await request.post(`${LOCAL_API_URL}/repos/${PROJECT}/pulls`, {
    headers,
    data: { title: form.searchParams.get('title'), body: form.searchParams.get('body'), head: `lena:${branch}`, base: 'main' },
  });
  expect(opened.ok(), await opened.text()).toBe(true);
  const { html_url: url, number: prNumber } = (await opened.json()) as { html_url: string; number: number };
  expect(data(await call('record_pr', { claimId, pr: url }))).toMatchObject({ state: 'pr_opened' });
  const pr = (await (await request.get(`${LOCAL_API_URL}/repos/${PROJECT}/pulls/${String(prNumber)}`)).json()) as {
    state: string;
    user: { login: string };
    body: string;
    head: { ref: string };
  };
  expect(pr).toMatchObject({ state: 'open', user: { login: 'lena' }, head: { ref: branch } });
  expect(pr.body).toContain(`Closes #${number}`);
  expect(queue.violations).toEqual([]);
  await donor.close();
});
