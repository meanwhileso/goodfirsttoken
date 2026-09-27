import { createHash } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { createGitHubFake, type GitHubFake } from '../src/index.ts';
import { localOAuthApp } from '../src/sample-data.ts';
import { rest } from './call.ts';

let fake: GitHubFake;

beforeEach(() => {
  fake = createGitHubFake();
});

const APP_URL = 'http://localhost:5173/auth/github/callback';

// What the browser sends when the person picks someone on the sign-in page.
async function signIn(login: string, extra: Record<string, string> = {}) {
  const response = await fake.fetch(`${fake.webUrl}/login/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: localOAuthApp.clientId,
      redirect_uri: APP_URL,
      scope: 'public_repo',
      state: 'xyz',
      login,
      ...extra,
    }),
  });
  return { status: response.status, location: new URL(response.headers.get('location') ?? 'about:blank') };
}

async function exchange(fields: Record<string, string>, accept = 'application/json') {
  const response = await fake.fetch(`${fake.webUrl}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: localOAuthApp.clientId, client_secret: localOAuthApp.clientSecret, ...fields }),
  });
  return { status: response.status, text: await response.text() };
}

test('the sign-in page offers every sample person and no organization', async () => {
  const params = new URLSearchParams({ client_id: localOAuthApp.clientId, redirect_uri: APP_URL, state: 'xyz' });

  const page = await (await fake.fetch(`${fake.webUrl}/login/oauth/authorize?${params.toString()}`)).text();

  expect(page).toContain('value="priya"');
  expect(page).toContain('value="octo-maintainer"');
  expect(page).not.toContain('value="meanwhileso"');
});

test('signing in as a sample person gives a code that trades once for their token', async () => {
  const back = await signIn('priya');
  const code = back.location.searchParams.get('code') ?? '';

  const first = await exchange({ code, redirect_uri: APP_URL }, '*/*');
  const again = await exchange({ code });
  const token = new URLSearchParams(first.text).get('access_token') ?? '';
  const me = await rest(fake, 'GET', '/user', { token });

  expect(back.status).toBe(302);
  expect(`${back.location.origin}${back.location.pathname}`).toBe(APP_URL);
  expect(back.location.searchParams.get('state')).toBe('xyz');
  expect(new URLSearchParams(first.text).get('scope')).toBe('public_repo');
  expect(token).toMatch(/^gho_[A-Za-z0-9]{36}$/);
  expect(me.body).toMatchObject({ login: 'priya' });
  expect(me.headers.get('x-oauth-scopes')).toBe('public_repo');
  expect(JSON.parse(again.text)).toMatchObject({ error: 'bad_verification_code' });
});

test('the token exchange checks the client secret', async () => {
  const code = (await signIn('kenji')).location.searchParams.get('code') ?? '';

  const reply = await exchange({ code, client_secret: 'wrong' });

  expect(JSON.parse(reply.text)).toMatchObject({ error: 'incorrect_client_credentials' });
});

test('with PKCE, only the matching code_verifier gets the token', async () => {
  const verifier = 'a-verifier-that-is-long-enough-for-pkce-0123456789';
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const pkce = { code_challenge: challenge, code_challenge_method: 'S256' };
  const wrongCode = (await signIn('lena', pkce)).location.searchParams.get('code') ?? '';
  const rightCode = (await signIn('lena', pkce)).location.searchParams.get('code') ?? '';

  const wrong = await exchange({ code: wrongCode, code_verifier: 'not-the-verifier' });
  const right = await exchange({ code: rightCode, code_verifier: verifier });

  expect(JSON.parse(wrong.text)).toMatchObject({ error: 'bad_verification_code' });
  expect(JSON.parse(right.text)).toMatchObject({ token_type: 'bearer', scope: 'public_repo' });
});

test("sign-in sends people back only to the app's callback URL or a path under it", async () => {
  const elsewhere = await signIn('priya', { redirect_uri: 'https://attacker.example/steal' });
  const otherPort = await signIn('priya', { redirect_uri: 'http://localhost:4173/auth/github/callback' });

  expect(elsewhere.location.origin).toBe('http://localhost');
  expect(elsewhere.location.searchParams.get('error')).toBe('redirect_uri_mismatch');
  expect(elsewhere.location.searchParams.get('code')).toBeNull();
  expect(otherPort.location.origin).toBe('http://localhost:4173');
  expect(otherPort.location.searchParams.get('code')).not.toBeNull();
});

// What the app sends to revoke a token: its own client ID and secret with
// Basic authentication, and the token in the body.
async function revoke(token: string | undefined, app = localOAuthApp) {
  const response = await fake.fetch(`${fake.apiUrl}/applications/${app.clientId}/token`, {
    method: 'DELETE',
    headers: {
      'user-agent': 'github-fake-tests',
      authorization: `Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(token === undefined ? {} : { access_token: token }),
  });
  return { status: response.status, body: response.status === 204 ? null : ((await response.json()) as unknown) };
}

async function tokenFromSignIn(login: string): Promise<string> {
  const code = (await signIn(login)).location.searchParams.get('code') ?? '';
  return (JSON.parse((await exchange({ code })).text) as { access_token: string }).access_token;
}

test("revoking a token with the app's client ID and secret ends that token and no other", async () => {
  const revoked = await tokenFromSignIn('priya');
  const kept = await tokenFromSignIn('priya');

  const reply = await revoke(revoked);

  expect(reply.status).toBe(204);
  expect((await rest(fake, 'GET', '/user', { token: revoked })).status).toBe(401);
  expect((await rest(fake, 'GET', '/user', { token: kept })).body).toMatchObject({ login: 'priya' });
  expect(fake.calls.filter((call) => call.method === 'DELETE')).toMatchObject([
    { operation: 'DELETE /applications/{client_id}/token', status: 204 },
  ]);
});

test("revoking needs the app's own secret, and the token keeps working without it", async () => {
  const token = await tokenFromSignIn('kenji');

  const reply = await revoke(token, { ...localOAuthApp, clientSecret: 'wrong' });

  expect(reply.status).toBe(404);
  expect((await rest(fake, 'GET', '/user', { token })).body).toMatchObject({ login: 'kenji' });
});

test('an app can revoke only the tokens it issued', async () => {
  const other = fake.tokenFor('lena');

  const reply = await revoke(other);

  expect(reply.status).toBe(404);
  expect((await rest(fake, 'GET', '/user', { token: other })).body).toMatchObject({ login: 'lena' });
});

test('revoking with no token names the missing field', async () => {
  const reply = await revoke(undefined);

  expect(reply).toMatchObject({
    status: 422,
    body: { errors: [{ code: 'missing_field', field: 'access_token' }] },
  });
});

test('cancelling sign-in sends the person back with access_denied and no code', async () => {
  const back = await signIn('priya', { decision: 'deny' });

  expect(back.location.searchParams.get('error')).toBe('access_denied');
  expect(back.location.searchParams.get('state')).toBe('xyz');
  expect(back.location.searchParams.get('code')).toBeNull();
});

// GitHub's cap: 10 tokens per app, person, and scopes. The fake's clock is
// moved by hand.
function fakeWithClock() {
  let time = Date.UTC(2026, 8, 1, 12, 0, 0);
  const clocked = createGitHubFake({ now: () => new Date(time) });
  return {
    clocked,
    tick: (ms: number) => {
      time += ms;
    },
  };
}

async function tokenFrom(target: GitHubFake, login: string, scope = 'public_repo'): Promise<string> {
  const back = await target.fetch(`${target.webUrl}/login/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: localOAuthApp.clientId, scope, login }),
  });
  const code = new URL(back.headers.get('location') ?? '').searchParams.get('code') ?? '';
  const reply = await target.fetch(`${target.webUrl}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: localOAuthApp.clientId, client_secret: localOAuthApp.clientSecret, code }),
  });
  return ((await reply.json()) as { access_token: string }).access_token;
}

async function works(target: GitHubFake, token: string): Promise<boolean> {
  return (await rest(target, 'GET', '/user', { token })).status === 200;
}

test('an eleventh token for the same app, person, and scopes revokes the least recently used one', async () => {
  const { clocked, tick } = fakeWithClock();
  const tokens: string[] = [];
  for (let i = 0; i < 10; i++) {
    tokens.push(await tokenFrom(clocked, 'priya'));
    tick(1000);
  }
  // Every token gets used, the first one last, so the second is the least
  // recently used.
  for (const token of [...tokens.slice(1), tokens[0] ?? '']) {
    await works(clocked, token);
    tick(1000);
  }

  const eleventh = await tokenFrom(clocked, 'priya');

  expect(await works(clocked, tokens[1] ?? '')).toBe(false);
  for (const token of [tokens[0] ?? '', ...tokens.slice(2), eleventh]) expect(await works(clocked, token)).toBe(true);
});

test('past the cap, a token never used and over a minute old goes before any used one', async () => {
  const { clocked, tick } = fakeWithClock();
  const tokens: string[] = [];
  for (let i = 0; i < 10; i++) tokens.push(await tokenFrom(clocked, 'kenji'));
  for (const token of tokens.filter((_, i) => i !== 4)) await works(clocked, token);
  tick(61_000);

  await tokenFrom(clocked, 'kenji');

  expect(await works(clocked, tokens[4] ?? '')).toBe(false);
  for (const token of tokens.filter((_, i) => i !== 4)) expect(await works(clocked, token)).toBe(true);
});

test('the cap counts each person, app, and set of scopes apart', async () => {
  const { clocked } = fakeWithClock();
  const first = await tokenFrom(clocked, 'lena');
  for (let i = 0; i < 9; i++) await tokenFrom(clocked, 'lena');
  const others = [
    await tokenFrom(clocked, 'lena', 'public_repo read:org'),
    await tokenFrom(clocked, 'priya'),
    clocked.tokenFor('lena'),
  ];

  for (const token of [first, ...others]) expect(await works(clocked, token)).toBe(true);
});
