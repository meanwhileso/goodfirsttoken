import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { emptyDatabase } from '../db/helpers';
import {
  Browser,
  ORIGIN,
  inOneLimitWindow,
  location,
  parseSetCookie,
  pickOnGitHub,
  setEnv,
  signIn,
  startGitHub,
  storedToken,
} from '../auth/helpers';
import {
  MCP_URL,
  MemoryOAuthClient,
  REDIRECT_URI,
  agentFetch,
  appTokens,
  approveInBrowser,
  authorizeUrl,
  callMcp,
  connectAgent,
  consentHandle,
  emptyKv,
  pkce,
  registerClient,
  startSession,
  tokensFor,
  tradeCode,
} from './helpers';

// An agent's sign-in to the MCP server: the OAuth metadata, dynamic client
// registration, the page where the person approves the agent, GitHub, and
// the tokens the agent gets. GitHub is the fake, in-process.

let github: GitHubFake;
let restore: () => void = () => undefined;

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
});

afterEach(() => {
  restore();
  restore = () => undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function gitHubUser(token: string) {
  return github.fetch(`${github.apiUrl}/user`, {
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'mcp-tests' },
  });
}

/** Where each link on a page goes, read back from its HTML. */
function links(html: string): URL[] {
  return [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map(
    (match) => new URL((match[1] ?? '').replaceAll('&amp;', '&'), ORIGIN),
  );
}

/** A page's HTML with the characters React escapes read back. */
function textOf(html: string): string {
  return html
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/**
 * An agent's sign-in for `login` up to GitHub's return: the person approves
 * the agent and picks themselves on GitHub. Returns their browser and where
 * GitHub sends it back to, which the test then follows.
 */
async function upToGitHubsReturn(login: string): Promise<{ browser: Browser; back: URL }> {
  const clientId = await registerClient();
  const { challenge } = await pkce();
  const browser = new Browser();
  const handle = consentHandle(await (await browser.fetch(authorizeUrl(clientId, { challenge }).toString())).text()) ?? '';
  const toGitHub = location(await browser.post('/oauth/authorize', { handle, decision: 'approve' }));
  return { browser, back: await pickOnGitHub(github, toGitHub, login) };
}

const connections = () => env.DB.prepare('SELECT COUNT(*) AS n FROM connected_agents').first<number>('n');

test('an agent registers itself, signs in with PKCE through GitHub, and start_session says who it acts as', async () => {
  const agent = await connectAgent(github, 'priya');

  const result = await startSession(agent);
  const [gitHubToken] = appTokens(github);

  // The SDK registered the agent, and signed in with an S256 PKCE challenge.
  expect(agent.oauth.client?.client_id).toEqual(expect.any(String));
  expect(agent.oauth.authorizationUrl?.searchParams.get('code_challenge_method')).toBe('S256');
  expect(agent.oauth.verifier).not.toBe('');
  expect(agent.oauth.saved?.refresh_token).toEqual(expect.any(String));
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual({ githubId: expect.any(Number) as number, login: 'priya' });
  expect(result.content).toEqual([{ type: 'text', text: 'Signed in as @priya.' }]);
  // start_session read the person from GitHub with the token from the
  // agent's own sign-in.
  expect(github.calls.filter((call) => call.operation === 'GET /user').at(-1)).toMatchObject({
    token: gitHubToken,
    login: 'priya',
    status: 200,
  });
});

test('a call to /mcp with no token gets a 401 that points to the protected-resource metadata, which names this site as the authorization server', async () => {
  const fetch = agentFetch();

  const unauthorized = await fetch(MCP_URL, { method: 'POST', body: '{}' });
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(unauthorized.headers.get('www-authenticate') ?? '')?.[1] ?? '';
  const metadata = await (await fetch(metadataUrl)).json();
  const server = await (await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json();

  expect(unauthorized.status).toBe(401);
  expect(metadataUrl).toBe(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
  expect(metadata).toMatchObject({ resource: MCP_URL, authorization_servers: [ORIGIN] });
  expect(server).toMatchObject({
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/oauth/authorize`,
    token_endpoint: `${ORIGIN}/oauth/token`,
    registration_endpoint: `${ORIGIN}/oauth/register`,
    code_challenge_methods_supported: ['S256'],
  });
});

test('a code traded without its PKCE verifier, or with the wrong one, gets no token', async () => {
  const { challenge } = await pkce();
  const [first, second] = [await registerClient(), await registerClient()];
  const firstBack = await approveInBrowser(new Browser(), github, authorizeUrl(first, { challenge }), 'kenji');
  const secondBack = await approveInBrowser(new Browser(), github, authorizeUrl(second, { challenge }), 'kenji');

  const without = await tradeCode(first, firstBack.searchParams.get('code') ?? '', undefined);
  const wrong = await tradeCode(second, secondBack.searchParams.get('code') ?? '', (await pkce()).verifier);

  expect(without).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
  expect(wrong).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
  expect(without.body).not.toHaveProperty('access_token');
  expect(wrong.body).not.toHaveProperty('access_token');
});

test('an agent that asks without PKCE gets a page that says so, naming where a link back to it goes, and is never redirected', async () => {
  const clientId = await registerClient('Phisher', 'https://phish.example/landing');

  const answer = await new Browser().fetch(authorizeUrl(clientId, { redirectUri: 'https://phish.example/landing' }).toString());
  const html = await answer.text();
  const back = links(html).find((link) => link.origin === 'https://phish.example');

  expect(answer.status).toBe(400);
  expect(answer.headers.get('location')).toBeNull();
  expect(answer.headers.get('set-cookie')).toBeNull();
  expect(textOf(html)).toContain("This agent's request to connect isn't right");
  expect(textOf(html)).toContain('https://phish.example');
  expect(back?.pathname).toBe('/landing');
  expect(back?.searchParams.get('error')).toBe('invalid_request');
  expect(back?.searchParams.get('error_description')).toMatch(/PKCE/);
  expect(textOf(html)).toContain(back?.searchParams.get('error_description') ?? 'a reason');
  expect(back?.searchParams.get('state')).toBe('agent-state');
  expect(github.calls).toEqual([]);
});

test('an agent with a client secret still has to use PKCE, and gets the same page without it', async () => {
  const registered = await agentFetch()(`${ORIGIN}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Confidential agent', redirect_uris: [REDIRECT_URI] }),
  });
  const client = await registered.json<{ client_id: string; client_secret?: string }>();

  const answer = await new Browser().fetch(authorizeUrl(client.client_id, {}).toString());
  const back = links(await answer.text()).find((link) => `${link.origin}${link.pathname}` === REDIRECT_URI);

  expect(client.client_secret).toEqual(expect.any(String));
  expect(answer.status).toBe(400);
  expect(answer.headers.get('location')).toBeNull();
  expect(answer.headers.get('set-cookie')).toBeNull();
  expect(back?.searchParams.get('error')).toBe('invalid_request');
});

test("an unknown client, or a redirect URI the client didn't register, gets an error page with no way out to the agent", async () => {
  const clientId = await registerClient();
  const { challenge } = await pkce();

  const unknown = await new Browser().fetch(authorizeUrl('not-a-client', { challenge }).toString());
  const elsewhere = await new Browser().fetch(
    authorizeUrl(clientId, { challenge, redirectUri: 'https://attacker.example/steal' }).toString(),
  );

  for (const answer of [unknown, elsewhere]) {
    const html = await answer.text();
    expect(answer.status).toBe(400);
    expect(answer.headers.get('location')).toBeNull();
    expect(answer.headers.get('set-cookie')).toBeNull();
    expect(textOf(html)).toContain("This link to connect an agent isn't right.");
    const toAgent = links(html).filter((link) => link.origin === 'https://attacker.example' || link.href.startsWith(REDIRECT_URI));
    expect(toAgent).toEqual([]);
  }
});

test('an agent can register redirect URIs on https, on this computer, or for an app, and no plain http to anywhere else', async () => {
  const register = (uris: string[]) =>
    agentFetch()(`${ORIGIN}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Agent', redirect_uris: uris, token_endpoint_auth_method: 'none' }),
    });
  const allowed = [
    'https://agent.example/callback',
    'http://localhost:9/callback',
    'http://127.0.0.1/callback',
    'http://[::1]:8080/callback',
    'cursor://anysphere.cursor-retrieval/oauth/callback',
  ];
  const refused = [
    ['http://plain.example/callback'],
    ['http://localhost.example/callback'],
    ['http://127.0.0.1.example/callback'],
    ['https://agent.example/callback', 'http://plain.example/callback'],
  ];

  for (const uri of allowed) expect((await register([uri])).status).toBe(201);
  for (const uris of refused) {
    const answer = await register(uris);
    expect(answer.status).toBe(400);
    expect(await answer.json()).toMatchObject({ error: 'invalid_redirect_uri' });
  }
});

test('the consent page names the agent as text, says where its access goes, warns when that is this computer, and cannot be framed', async () => {
  const clientId = await registerClient('<img src=x onerror=alert(1)> Helper');
  const { challenge } = await pkce();

  const page = await new Browser().fetch(authorizeUrl(clientId, { challenge }).toString());
  const html = await page.text();

  expect(page.status).toBe(200);
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; Helper');
  expect(html).not.toContain('<img src=x');
  expect(html).toContain('>http://127.0.0.1:33418<');
  expect(html).toContain('That is an app on your computer.');
  expect(page.headers.get('x-frame-options')).toBe('DENY');
  expect(page.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  expect(page.headers.get('cache-control')).toBe('no-store');
});

test('an agent whose access goes to a web address gets no warning about this computer', async () => {
  const clientId = await registerClient('Grok', 'https://agent.example/oauth/callback');
  const { challenge } = await pkce();

  const html = await (
    await new Browser().fetch(
      authorizeUrl(clientId, { challenge, redirectUri: 'https://agent.example/oauth/callback' }).toString(),
    )
  ).text();

  expect(html).toContain('>https://agent.example<');
  expect(html).not.toContain('That is an app on your computer.');
});

test("an agent whose access goes to an app's own scheme gets the warning about this computer", async () => {
  const clientId = await registerClient('Some app', 'evilapp:/callback');
  const { challenge } = await pkce();

  const html = await (
    await new Browser().fetch(authorizeUrl(clientId, { challenge, redirectUri: 'evilapp:/callback' }).toString())
  ).text();

  expect(html).toContain('>evilapp:<');
  expect(html).toContain('That is an app on your computer.');
});

test("the page shows an agent's name without control, bidi, or zero-width characters", async () => {
  const clientId = await registerClient('Helper\u202Eexe.txt\u200B\u0007 bot');
  const { challenge } = await pkce();

  const html = await (await new Browser().fetch(authorizeUrl(clientId, { challenge }).toString())).text();

  expect(html).toContain('Helperexe.txt bot');
  for (const character of ['\u202E', '\u200B', '\u0007']) expect(html).not.toContain(character);
});

test('Cancel sends the person back to the agent with access_denied and its state, and GitHub never sees them', async () => {
  const clientId = await registerClient();
  const { challenge } = await pkce();
  const browser = new Browser();
  const handle = consentHandle(await (await browser.fetch(authorizeUrl(clientId, { challenge }).toString())).text());

  const cancelled = await browser.post('/oauth/authorize', { handle: handle ?? '', decision: 'deny' });
  const back = location(cancelled);

  expect(cancelled.status).toBe(303);
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
  expect(back.searchParams.get('error')).toBe('access_denied');
  expect(back.searchParams.get('state')).toBe('agent-state');
  expect(back.searchParams.get('code')).toBeNull();
  expect(github.calls).toEqual([]);
});

test('an approval works once, and only in the browser that opened the page', async () => {
  const clientId = await registerClient();
  const { challenge } = await pkce();
  const browser = new Browser();
  const handle = consentHandle(await (await browser.fetch(authorizeUrl(clientId, { challenge }).toString())).text()) ?? '';

  const elsewhere = await new Browser().post('/oauth/authorize', { handle, decision: 'approve' });
  const first = await browser.post('/oauth/authorize', { handle, decision: 'approve' });
  const again = await browser.post('/oauth/authorize', { handle, decision: 'approve' });

  expect(elsewhere.status).toBe(400);
  expect(first.status).toBe(303);
  expect(location(first).origin).toBe(github.webUrl);
  expect(again.status).toBe(400);
  expect(await again.text()).toContain('Connect again from your agent.');
});

test('an approval posted from another site is refused', async () => {
  const clientId = await registerClient();
  const { challenge } = await pkce();
  const browser = new Browser();
  const handle = consentHandle(await (await browser.fetch(authorizeUrl(clientId, { challenge }).toString())).text()) ?? '';

  const forged = await browser.post('/oauth/authorize', { handle, decision: 'approve' }, 'https://elsewhere.example');

  expect(forged.status).toBe(403);
  expect(github.calls).toEqual([]);
});

test('an approval posted with no Origin, or with Origin null, is refused', async () => {
  const clientId = await registerClient();
  const { challenge } = await pkce();
  const browser = new Browser();
  const handle = consentHandle(await (await browser.fetch(authorizeUrl(clientId, { challenge }).toString())).text()) ?? '';

  const none = await browser.post('/oauth/authorize', { handle, decision: 'approve' }, null);
  const opaque = await browser.post('/oauth/authorize', { handle, decision: 'approve' }, 'null');

  expect(none.status).toBe(403);
  expect(opaque.status).toBe(403);
  expect(github.calls).toEqual([]);
});

test('approving sends the person to GitHub for public_repo only, with PKCE, and back to /auth/callback/mcp', async () => {
  const clientId = await registerClient();
  const { challenge } = await pkce();
  const browser = new Browser();
  const handle = consentHandle(await (await browser.fetch(authorizeUrl(clientId, { challenge }).toString())).text()) ?? '';

  const toGitHub = location(await browser.post('/oauth/authorize', { handle, decision: 'approve' }));

  expect(`${toGitHub.origin}${toGitHub.pathname}`).toBe(`${github.webUrl}/login/oauth/authorize`);
  expect(toGitHub.searchParams.get('scope')).toBe('public_repo');
  expect(toGitHub.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback/mcp`);
  expect(toGitHub.searchParams.get('code_challenge_method')).toBe('S256');
  expect(toGitHub.searchParams.get('code_challenge')).not.toBe(challenge);
});

test("GitHub's return in another browser connects nothing", async () => {
  const clientId = await registerClient();
  const { challenge } = await pkce();
  const browser = new Browser();
  const handle = consentHandle(await (await browser.fetch(authorizeUrl(clientId, { challenge }).toString())).text()) ?? '';
  const toGitHub = location(await browser.post('/oauth/authorize', { handle, decision: 'approve' }));
  const back = await pickOnGitHub(github, toGitHub, 'lena');

  const stolen = await new Browser().fetch(back.toString());

  expect(stolen.status).toBe(400);
  expect(stolen.headers.get('location')).toBeNull();
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM connected_agents').first('n')).toBe(0);
});

test('declining on GitHub sends the person back to the agent with access_denied', async () => {
  const clientId = await registerClient();
  const { challenge } = await pkce();
  const browser = new Browser();
  const handle = consentHandle(await (await browser.fetch(authorizeUrl(clientId, { challenge }).toString())).text()) ?? '';
  const toGitHub = location(await browser.post('/oauth/authorize', { handle, decision: 'approve' }));
  const fields = new URLSearchParams(toGitHub.searchParams);
  fields.set('decision', 'deny');
  const declined = await github.fetch(`${toGitHub.origin}${toGitHub.pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: fields,
    redirect: 'manual',
  });

  const back = location(await browser.fetch(location(declined).toString()));

  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
  expect(back.searchParams.get('error')).toBe('access_denied');
  expect(back.searchParams.get('state')).toBe('agent-state');
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM connected_agents').first('n')).toBe(0);
});

test('every cookie an agent sign-in sets is host-only, with the __Host- prefix, Secure, Path=/, and HttpOnly', async () => {
  const browser = new Browser();
  await connectAgent(github, 'sam', { browser });

  const cookies = browser.setCookies.map((cookie) => parseSetCookie(cookie.header));
  expect(cookies.length).toBeGreaterThanOrEqual(4);
  for (const cookie of cookies) {
    expect(cookie.name).toMatch(/^__Host-gft\.oauth-/);
    expect(cookie.attributes).toEqual(expect.arrayContaining(['Secure', 'Path=/', 'HttpOnly', 'SameSite=Lax']));
    expect(cookie.attributes.some((attribute) => /^domain=/i.test(attribute))).toBe(false);
  }
  // Each step's cookie is cleared by the next, so none is left behind.
  expect(browser.cookies.size).toBe(0);
});

test("an agent's sign-in never touches the site's own sign-in: its token stays stored and working", async () => {
  const browser = new Browser();
  await signIn(browser, github, 'priya');
  const webToken = await storedToken();

  const agent = await connectAgent(github, 'priya', { browser });
  await startSession(agent);

  expect(await storedToken()).toBe(webToken);
  expect((await gitHubUser(webToken ?? '')).status).toBe(200);
  expect(appTokens(github)).toHaveLength(2);
  expect(github.calls.some((call) => call.method === 'DELETE')).toBe(false);
});

test("signing the same agent in again replaces its connection: the earlier grant and GitHub token stop working, and the person's other agents keep theirs", async () => {
  const oauth = new MemoryOAuthClient('Claude Code');
  await connectAgent(github, 'kenji', { oauth });
  const other = await connectAgent(github, 'kenji', { oauth: new MemoryOAuthClient('Codex') });
  const [firstGitHubToken, otherGitHubToken] = appTokens(github);
  const firstAccessToken = oauth.saved?.access_token ?? '';

  oauth.saved = undefined;
  const again = await connectAgent(github, 'kenji', { oauth });

  expect((await callMcp(firstAccessToken)).status).toBe(401);
  expect((await gitHubUser(firstGitHubToken ?? '')).status).toBe(401);
  expect((await gitHubUser(otherGitHubToken ?? '')).status).toBe(200);
  expect((await startSession(again)).structuredContent).toMatchObject({ login: 'kenji' });
  expect((await startSession(other)).structuredContent).toMatchObject({ login: 'kenji' });
  expect(
    await env.DB.prepare('SELECT client_name FROM connected_agents ORDER BY client_name').all(),
  ).toMatchObject({ results: [{ client_name: 'Claude Code' }, { client_name: 'Codex' }] });
});

test('two agents of one person each hold their own GitHub token', async () => {
  const first = await tokensFor(github, 'lena');
  const second = await tokensFor(github, 'lena');

  expect(first.accessToken).not.toBe(second.accessToken);
  expect(new Set(appTokens(github)).size).toBe(2);
});

test('registering an agent and opening the page to approve it count toward the sign-in limit of 20 requests a minute from each address', async () => {
  await inOneLimitWindow();
  const fetch = agentFetch();
  const clientId = await registerClient('Busy agent', REDIRECT_URI, fetch);
  const { challenge } = await pkce();
  const answers: number[] = [];
  for (let i = 0; i < 9; i++) answers.push((await fetch(authorizeUrl(clientId, { challenge }))).status);
  for (let i = 0; i < 10; i++) {
    const registered = await fetch(`${ORIGIN}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Busy agent', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' }),
    });
    answers.push(registered.status);
  }

  const page = await fetch(authorizeUrl(clientId, { challenge }));
  const registration = await fetch(`${ORIGIN}/oauth/register`, { method: 'POST', body: '{}' });

  expect(answers).toEqual([...Array<number>(9).fill(200), ...Array<number>(10).fill(201)]);
  expect(page.status).toBe(429);
  expect(registration.status).toBe(429);
  expect(registration.headers.get('retry-after')).toBe('60');
});

test("approving an agent counts toward the sign-in limit of 20 requests a minute from each address", async () => {
  await inOneLimitWindow();
  const clientId = await registerClient();
  const { challenge } = await pkce();
  const browser = new Browser();
  const handle = consentHandle(await (await browser.fetch(authorizeUrl(clientId, { challenge }).toString())).text()) ?? '';
  for (let i = 0; i < 20; i++) await browser.post('/auth/sign-in');

  const over = await browser.post('/oauth/authorize', { handle, decision: 'approve' });

  expect(over.status).toBe(429);
  expect(over.headers.get('retry-after')).toBe('60');
});

test('trading a code or refreshing tokens counts toward the sign-in limit of 20 requests a minute from each address', async () => {
  await inOneLimitWindow();
  const fetch = agentFetch();
  const refresh = () =>
    fetch(`${ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'a:b:c', client_id: 'nobody' }),
    });
  const answers: number[] = [];
  for (let i = 0; i < 20; i++) answers.push((await refresh()).status);

  const over = await refresh();

  expect(answers).not.toContain(429);
  expect(over.status).toBe(429);
  expect(over.headers.get('retry-after')).toBe('60');
});

test("when GitHub won't say whose the new token is, the agent's sign-in stops, and that token is revoked", async () => {
  const { browser, back } = await upToGitHubsReturn('priya');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return request.method === 'GET' && new URL(request.url).pathname.endsWith('/user')
      ? Promise.resolve(Response.json({ message: 'Server Error' }, { status: 502 }))
      : github.fetch(input, init);
  });

  const answer = await browser.fetch(back.toString());

  expect(location(answer).searchParams.get('error')).toBe('server_error');
  expect(github.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  expect(appTokens(github)).toEqual([]);
  expect(await connections()).toBe(0);
});

test("when the agent's grant can't be stored, its connection is removed, and its GitHub token is revoked", async () => {
  const { browser, back } = await upToGitHubsReturn('kenji');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(env.OAUTH_KV, 'put').mockRejectedValueOnce(new Error('KV is down'));

  const answer = await browser.fetch(back.toString());

  expect(location(answer).searchParams.get('error')).toBe('server_error');
  expect(github.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  expect(appTokens(github)).toEqual([]);
  expect(await connections()).toBe(0);
});

test("when an agent's sign-in fails with the token the site holds for the person's own sign-in, that token is left alone", async () => {
  await signIn(new Browser(), github, 'ines');
  const webToken = (await storedToken()) ?? '';
  const { browser, back } = await upToGitHubsReturn('ines');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  // As if GitHub gave the agent's sign-in the site's own token. Then the
  // grant can't be stored.
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    new URL(new Request(input, init).url).pathname.endsWith('/login/oauth/access_token')
      ? Promise.resolve(Response.json({ access_token: webToken, token_type: 'bearer', scope: 'public_repo' }))
      : github.fetch(input, init),
  );
  vi.spyOn(env.OAUTH_KV, 'put').mockRejectedValueOnce(new Error('KV is down'));

  const answer = await browser.fetch(back.toString());

  expect(location(answer).searchParams.get('error')).toBe('server_error');
  expect(await connections()).toBe(0);
  expect(github.calls.some((call) => call.method === 'DELETE')).toBe(false);
  expect((await gitHubUser(webToken)).status).toBe(200);
});

test.each(['OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET', 'AUTH_SECRET'] as const)(
  "with %s missing, an agent's sign-in stops with 503 at the page and at the approval, before GitHub",
  async (name) => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const browser = new Browser();
    const handle = consentHandle(await (await browser.fetch(authorizeUrl(clientId, { challenge }).toString())).text()) ?? '';
    restore = setEnv({ [name]: undefined });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const page = await new Browser().fetch(authorizeUrl(clientId, { challenge }).toString());
    const approval = await browser.post('/oauth/authorize', { handle, decision: 'approve' });

    expect(page.status).toBe(503);
    expect(approval.status).toBe(503);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(name));
    expect(github.calls).toEqual([]);
  },
);
