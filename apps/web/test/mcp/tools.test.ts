import { createGitHubFake, type GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { emptyDatabase } from '../db/helpers';
import { APP, inOneLimitWindow, startGitHub } from '../auth/helpers';
import {
  MemoryOAuthClient,
  appTokens,
  callMcp,
  connectAgent,
  emptyKv,
  mcpMessage,
  startSession,
  tokensFor,
} from './helpers';

// The MCP server's tool endpoint: its rate limit, and what happens when
// GitHub stops accepting a connection's token.

let github: GitHubFake;

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function connections(): Promise<number> {
  return (await env.DB.prepare('SELECT COUNT(*) AS n FROM connected_agents').first<number>('n')) ?? 0;
}

test("a tools/list answers with the donor's tools and the maintainer's tools, each with its input and output schemas", async () => {
  const { accessToken } = await tokensFor(github, 'priya');

  const response = await callMcp(accessToken);
  const body = await mcpMessage<{
    result: { tools: { name: string; description: string; inputSchema: unknown; outputSchema: unknown }[] };
  }>(response);
  const tool = (name: string) => body.result.tools.find((t) => t.name === name);

  expect(response.status).toBe(200);
  expect(body.result.tools.map((t) => t.name)).toEqual([
    'start_session',
    'set_interests',
    'suggest_issues',
    'claim_issue',
    'post_update',
    'release_claim',
    'submit_work',
    'open_pr',
    'my_work',
    'register_project',
    'update_project',
    'project_status',
    'pause_project',
    'request_removal',
  ]);
  expect(tool('start_session')?.inputSchema).toMatchObject({ required: ['agent', 'budget'] });
  expect(tool('start_session')?.outputSchema).toMatchObject({ required: expect.arrayContaining(['sessionId', 'login']) as string[] });
  expect(tool('claim_issue')?.inputSchema).toMatchObject({ required: ['sessionId'] });
  expect(tool('submit_work')?.inputSchema).toMatchObject({
    required: ['claimId', 'files', 'summary', 'checks', 'agent', 'model'],
  });
  expect(tool('open_pr')?.inputSchema).toMatchObject({ required: ['claimId'] });
  expect(tool('register_project')?.inputSchema).toMatchObject({ required: ['repo'] });
  expect(tool('update_project')?.outputSchema).toMatchObject({ required: expect.arrayContaining(['changed', 'createdLabels']) as string[] });
  expect(tool('pause_project')?.description).toContain('resume it with paused: false');
});

test("each person gets 120 calls a minute to the MCP server, across all their agents, and the next gets a 429 that leaves other people's agents working", async () => {
  // People no other test in this file calls as, since the limit counts
  // across the file's tests.
  const laptop = await tokensFor(github, 'arjun');
  const phone = await tokensFor(github, 'arjun');
  const someoneElse = await tokensFor(github, 'ines');
  // Arjun's 121 calls must fall in one minute of the wall clock. They took
  // about 2 seconds on an idle machine and up to 6 on a loaded one, so they
  // start with at least 20 seconds of the minute left.
  await inOneLimitWindow(20_000);
  const answers: number[] = [];
  for (let i = 0; i < 60; i++) answers.push((await callMcp(laptop.accessToken)).status);
  for (let i = 0; i < 60; i++) answers.push((await callMcp(phone.accessToken)).status);

  const over = await callMcp(laptop.accessToken);
  const others = await callMcp(someoneElse.accessToken);

  expect(answers).toEqual(Array<number>(120).fill(200));
  expect(over.status).toBe(429);
  expect(over.headers.get('retry-after')).toBe('60');
  expect(others.status).toBe(200);
}, 60_000);

test('when GitHub no longer accepts the grant\'s token, start_session disconnects the agent without revoking anything, and its next call gets a 401', async () => {
  const agent = await connectAgent(github, 'lena');
  const [token = ''] = appTokens(github);
  // The person revoked the app on GitHub, or GitHub dropped the token.
  Reflect.deleteProperty(github.state.tokens, token);

  const result = await startSession(agent);
  const next = await callMcp(agent.oauth.saved?.access_token ?? '');

  expect(result.isError).toBe(true);
  expect(result.content).toEqual([
    {
      type: 'text',
      text: "GitHub no longer accepts this connection's token, so Good First Token disconnected it. Reconnect the MCP server to sign in again.",
    },
  ]);
  expect(next.status).toBe(401);
  expect(await connections()).toBe(0);
  expect(github.calls.some((call) => call.method === 'DELETE')).toBe(false);
});

// The fake's clock moves a second each time it is read, so every token has
// its own creation and last-use time, as on GitHub.
function gitHubWithClock(): GitHubFake {
  let time = Date.UTC(2026, 8, 1, 12, 0, 0);
  const fake = createGitHubFake({
    apiUrl: env.GH_API_URL,
    webUrl: env.GH_WEB_URL,
    now: () => new Date((time += 1000)),
  });
  fake.state.oauthApps[APP.clientId] = { ...APP };
  vi.stubGlobal('fetch', fake.fetch);
  return fake;
}

test("at GitHub's cap of 10 tokens per person, the eleventh sign-in costs the least recently used agent its token, and that agent is disconnected at its next start_session", async () => {
  github = gitHubWithClock();
  const agents = [];
  for (let i = 0; i < 10; i++) {
    agents.push(await connectAgent(github, 'sam', { oauth: new MemoryOAuthClient(`Agent ${String(i)}`) }));
  }
  for (const agent of agents.slice(1)) await startSession(agent);

  const eleventh = await connectAgent(github, 'sam', { oauth: new MemoryOAuthClient('Agent 10') });
  const [oldest, second] = agents;

  expect(appTokens(github)).toHaveLength(10);
  expect((await startSession(eleventh)).structuredContent).toMatchObject({ login: 'sam' });
  expect((await startSession({ client: second?.client ?? eleventh.client })).isError).toBeFalsy();
  expect((await startSession({ client: oldest?.client ?? eleventh.client })).isError).toBe(true);
  expect((await callMcp(oldest?.oauth.saved?.access_token ?? '')).status).toBe(401);
  expect(await connections()).toBe(10);
});

test("an error inside a tool is logged, and the agent gets a plain answer that says nothing of the database", async () => {
  const agent = await connectAgent(github, 'priya');
  const logged: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => void logged.push(parts.map(String).join(' ')));
  await env.DB.prepare('ALTER TABLE donor_sessions RENAME TO donor_sessions_gone').run();
  let result;
  try {
    result = await startSession(agent);
  } finally {
    await env.DB.prepare('ALTER TABLE donor_sessions_gone RENAME TO donor_sessions').run();
  }
  const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

  expect(result.isError).toBe(true);
  expect(text).toBe("Something went wrong on Good First Token's side. Try again in a moment.");
  expect(text).not.toMatch(/D1_|SQLITE|donor_sessions/);
  expect(logged.some((line) => line.includes('donor_sessions'))).toBe(true);
});
