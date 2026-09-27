import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { emptyDatabase } from '../db/helpers';
import { Browser, location, signIn, startGitHub, storedToken } from '../auth/helpers';
import { MemoryOAuthClient, appTokens, callMcp, connectAgent, emptyKv, startSession } from './helpers';

// /me lists the agents a person connected, and Disconnect cuts one off: its
// next tool call gets a 401, and its GitHub token is revoked.

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

async function gitHubUser(token: string) {
  return github.fetch(`${github.apiUrl}/user`, {
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'mcp-tests' },
  });
}

/** The agents /me lists: each one's name and the ID its Disconnect form sends. */
async function listedAgents(browser: Browser): Promise<{ name: string; id: string }[]> {
  const html = await (await browser.fetch('/me')).text();
  return [...html.matchAll(/<li class="account__agent"><span><span class="strong">([^<]*)<\/span>.*?name="agent" value="([^"]+)"/g)].map(
    (match) => ({ name: match[1] ?? '', id: match[2] ?? '' }),
  );
}

test('after Disconnect on /me, the agent is gone from the list, its next tool call gets a 401, and its GitHub token is revoked', async () => {
  const browser = new Browser();
  await signIn(browser, github, 'priya');
  const webToken = await storedToken();
  const agent = await connectAgent(github, 'priya', { oauth: new MemoryOAuthClient('Claude Code') });
  await startSession(agent);
  const agentToken = appTokens(github).find((token) => token !== webToken) ?? '';
  const [listed] = await listedAgents(browser);

  const out = await browser.post('/auth/agents/disconnect', { agent: listed?.id ?? '' });

  expect(listed?.name).toBe('Claude Code');
  expect(out.status).toBe(303);
  expect(location(out).pathname).toBe('/me');
  expect(await listedAgents(browser)).toEqual([]);
  expect((await callMcp(agent.oauth.saved?.access_token ?? '')).status).toBe(401);
  expect((await gitHubUser(agentToken)).status).toBe(401);
});

test("Disconnect revokes that agent's GitHub token and no other: the site's own and the person's other agents keep working", async () => {
  const browser = new Browser();
  await signIn(browser, github, 'kenji');
  const webToken = (await storedToken()) ?? '';
  const first = await connectAgent(github, 'kenji', { oauth: new MemoryOAuthClient('Claude Code') });
  const second = await connectAgent(github, 'kenji', { oauth: new MemoryOAuthClient('Codex') });
  const [firstToken = '', secondToken = ''] = appTokens(github).filter((token) => token !== webToken);
  const target = (await listedAgents(browser)).find((agent) => agent.name === 'Claude Code');

  await browser.post('/auth/agents/disconnect', { agent: target?.id ?? '' });

  expect(github.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  expect((await gitHubUser(firstToken)).status).toBe(401);
  expect((await gitHubUser(secondToken)).status).toBe(200);
  expect((await gitHubUser(webToken)).status).toBe(200);
  expect(await storedToken()).toBe(webToken);
  expect((await callMcp(first.oauth.saved?.access_token ?? '')).status).toBe(401);
  expect((await startSession(second)).structuredContent).toMatchObject({ login: 'kenji' });
  expect((await listedAgents(browser)).map((agent) => agent.name)).toEqual(['Codex']);
});

test('Disconnect leaves alone a GitHub token the site also holds for the person\'s own sign-in', async () => {
  const browser = new Browser();
  await signIn(browser, github, 'ines');
  const webToken = (await storedToken()) ?? '';
  const agent = await connectAgent(github, 'ines');
  // As if GitHub had given the agent's sign-in the site's own token. Both are
  // encrypted with AUTH_SECRET the same way.
  await env.DB.prepare('UPDATE connected_agents SET github_token = (SELECT access_token FROM account)').run();
  const [listed] = await listedAgents(browser);

  await browser.post('/auth/agents/disconnect', { agent: listed?.id ?? '' });

  expect((await callMcp(agent.oauth.saved?.access_token ?? '')).status).toBe(401);
  expect(github.calls.some((call) => call.method === 'DELETE')).toBe(false);
  expect((await gitHubUser(webToken)).status).toBe(200);
});

test("one person can't disconnect another person's agent", async () => {
  const agent = await connectAgent(github, 'lena');
  const [lenaToken = ''] = appTokens(github);
  const lenas = await env.DB.prepare('SELECT id FROM connected_agents').first<string>('id');
  const someoneElse = new Browser();
  await signIn(someoneElse, github, 'sam');

  const out = await someoneElse.post('/auth/agents/disconnect', { agent: lenas ?? '' });

  expect(location(out).pathname).toBe('/me');
  expect((await startSession(agent)).structuredContent).toMatchObject({ login: 'lena' });
  expect((await gitHubUser(lenaToken)).status).toBe(200);
  expect(github.calls.some((call) => call.method === 'DELETE')).toBe(false);
});

test('a Disconnect form sent from another site is refused, and the agent stays connected', async () => {
  const browser = new Browser();
  await signIn(browser, github, 'ines');
  const agent = await connectAgent(github, 'ines');
  const [listed] = await listedAgents(browser);

  const forged = await browser.post('/auth/agents/disconnect', { agent: listed?.id ?? '' }, 'https://elsewhere.example');

  expect(forged.status).toBe(403);
  expect((await startSession(agent)).isError).toBeFalsy();
});

test('signed out, the Disconnect form sends you to sign in and disconnects nothing', async () => {
  const agent = await connectAgent(github, 'arjun');
  const id = await env.DB.prepare('SELECT id FROM connected_agents').first<string>('id');

  const out = await new Browser().post('/auth/agents/disconnect', { agent: id ?? '' });

  expect(location(out).pathname).toBe('/sign-in');
  expect((await startSession(agent)).isError).toBeFalsy();
});

test("when GitHub can't revoke the token, the agent is still disconnected, and the log names no token", async () => {
  const browser = new Browser();
  await signIn(browser, github, 'sam');
  const agent = await connectAgent(github, 'sam');
  const tokens = appTokens(github);
  const [listed] = await listedAgents(browser);
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    new Request(input, init).method === 'DELETE'
      ? Promise.resolve(Response.json({ message: 'Server Error' }, { status: 502 }))
      : github.fetch(input, init),
  );

  const out = await browser.post('/auth/agents/disconnect', { agent: listed?.id ?? '' });

  expect(location(out).pathname).toBe('/me');
  expect((await callMcp(agent.oauth.saved?.access_token ?? '')).status).toBe(401);
  expect(await listedAgents(browser)).toEqual([]);
  expect(logged).toHaveBeenCalledWith("GitHub didn't revoke a disconnected agent's token: 502 Server Error");
  for (const token of tokens) expect(JSON.stringify(logged.mock.calls)).not.toContain(token);
});

test("when the grant can't be deleted at Disconnect, the agent is still cut off at its next call, and its GitHub token is still revoked", async () => {
  const browser = new Browser();
  await signIn(browser, github, 'arjun');
  const webToken = await storedToken();
  const agent = await connectAgent(github, 'arjun');
  const agentToken = appTokens(github).find((token) => token !== webToken) ?? '';
  const [listed] = await listedAgents(browser);
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  // KV fails as Disconnect looks for the grant, so the grant stays.
  vi.spyOn(env.OAUTH_KV, 'list').mockRejectedValueOnce(new Error('KV is down'));

  await browser.post('/auth/agents/disconnect', { agent: listed?.id ?? '' });

  expect(logged).toHaveBeenCalledWith("A disconnected agent's grant wasn't deleted: Error");
  expect((await callMcp(agent.oauth.saved?.access_token ?? '')).status).toBe(401);
  expect((await gitHubUser(agentToken)).status).toBe(401);
});

test('/me lists only your own agents, each by the name it gave itself, shown as text, with when it connected and when it last called a tool', async () => {
  const browser = new Browser();
  await signIn(browser, github, 'priya');
  const agent = await connectAgent(github, 'priya', { oauth: new MemoryOAuthClient('<b>Helper</b>') });
  await connectAgent(github, 'kenji', { oauth: new MemoryOAuthClient('Not priya') });
  await env.DB.prepare('UPDATE connected_agents SET connected_at = ?1, last_used_at = ?1').bind(Date.UTC(2026, 8, 1, 9, 30)).run();

  const before = await (await browser.fetch('/me')).text();
  await startSession(agent);
  const after = await (await browser.fetch('/me')).text();

  expect(before).toContain('&lt;b&gt;Helper&lt;/b&gt;');
  expect(before).not.toContain('<b>Helper');
  expect(before).not.toContain('Not priya');
  expect(before).toContain('connected <!-- -->2026-09-01 09:30 UTC<!-- --> · last used <!-- -->2026-09-01 09:30 UTC');
  expect(after).toContain('connected <!-- -->2026-09-01 09:30 UTC');
  expect(after).not.toContain('last used <!-- -->2026-09-01 09:30 UTC');
});

test('/me shows an agent\'s name on one line, cut to 60 characters', async () => {
  const browser = new Browser();
  await signIn(browser, github, 'sam');
  await connectAgent(github, 'sam', { oauth: new MemoryOAuthClient(`Helper\n${'x'.repeat(80)}`) });

  const [listed] = await listedAgents(browser);

  expect(listed?.name).toBe(`Helper ${'x'.repeat(50)}...`);
});

test('a person with no agents connected is told so on /me', async () => {
  const browser = new Browser();
  await signIn(browser, github, 'lena');

  expect(await (await browser.fetch('/me')).text()).toContain('No agents connected.');
});
