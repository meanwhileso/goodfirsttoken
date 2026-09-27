import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { emptyDatabase } from '../db/helpers';
import { APP, Browser, location, navLogin, signIn, startGitHub, tokensIssued } from './helpers';

let github: GitHubFake;

beforeEach(async () => {
  await emptyDatabase();
  github = startGitHub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function gitHubUser(token: string) {
  return github.fetch(`${github.apiUrl}/user`, {
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'sign-out-tests' },
  });
}

test("signing out revokes the web session's GitHub token at GitHub, as the app, and forgets it", async () => {
  const browser = new Browser();
  await signIn(browser, github, 'priya');
  const [token = ''] = tokensIssued(github);

  const out = await browser.post('/auth/sign-out');

  expect(out.status).toBe(303);
  expect(location(out).pathname).toBe('/');
  expect(github.calls.filter((call) => call.method === 'DELETE')).toMatchObject([
    { url: `${github.apiUrl}/applications/${APP.clientId}/token`, status: 204 },
  ]);
  expect((await gitHubUser(token)).status).toBe(401);
  expect(await env.DB.prepare('SELECT access_token FROM account').first('access_token')).toBeNull();
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM session').first('n')).toBe(0);
  expect(browser.cookies.size).toBe(0);
  expect(await navLogin(await browser.fetch('/'))).toBeNull();
});

test('signing out ends the sessions in every browser, since they all used the token it revoked', async () => {
  const laptop = new Browser();
  const phone = new Browser();
  await signIn(laptop, github, 'kenji');
  await signIn(phone, github, 'kenji');

  await laptop.post('/auth/sign-out');

  expect(location(await phone.fetch('/me')).pathname).toBe('/sign-in');
});

test("signing out leaves the person's other GitHub tokens from the same app working", async () => {
  const browser = new Browser();
  await signIn(browser, github, 'sam');
  // Like the token an agent holds through the MCP login, from the same app.
  const agents = await github.fetch(`${github.webUrl}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: APP.clientId,
      client_secret: APP.clientSecret,
      code: await codeFor('sam'),
    }),
  });
  const { access_token: agentToken } = await agents.json<{ access_token: string }>();

  await browser.post('/auth/sign-out');

  expect((await gitHubUser(agentToken)).status).toBe(200);
});

async function codeFor(login: string): Promise<string> {
  const response = await github.fetch(`${github.webUrl}/login/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: APP.clientId, scope: 'public_repo', login }),
    redirect: 'manual',
  });
  return new URL(response.headers.get('location') ?? '').searchParams.get('code') ?? '';
}

test("when GitHub can't revoke the token, the person is still signed out and the token forgotten, and no log shows it", async () => {
  const browser = new Browser();
  await signIn(browser, github, 'ines');
  const [token = ''] = tokensIssued(github);
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    new Request(input, init).method === 'DELETE'
      ? Promise.resolve(Response.json({ message: 'Server Error' }, { status: 502 }))
      : github.fetch(input, init),
  );

  const out = await browser.post('/auth/sign-out');

  expect(out.status).toBe(303);
  expect(browser.cookies.size).toBe(0);
  expect(await env.DB.prepare('SELECT access_token FROM account').first('access_token')).toBeNull();
  expect(logged).toHaveBeenCalledWith("GitHub didn't revoke a token at sign-out: 502 Server Error");
  expect(JSON.stringify(logged.mock.calls)).not.toContain(token);
});

test('a sign-out sent from another site is refused, and the person stays signed in', async () => {
  const browser = new Browser();
  await signIn(browser, github, 'lena');

  const out = await browser.post('/auth/sign-out', {}, 'https://elsewhere.example');

  expect(out.status).toBe(403);
  expect(github.calls.some((call) => call.method === 'DELETE')).toBe(false);
  expect(await navLogin(await browser.fetch('/me'))).toBe('@lena');
});
