import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { symmetricDecrypt } from 'better-auth/crypto';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getPerson } from '../../src/db';
import { emptyDatabase } from '../db/helpers';
import {
  APP,
  Browser,
  ORIGIN,
  location,
  navLogin,
  pickOnGitHub,
  signIn,
  startGitHub,
  tokensIssued,
  wholeDatabase,
} from './helpers';

let github: GitHubFake;

beforeEach(async () => {
  await emptyDatabase();
  github = startGitHub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('sign-in sends the person to GitHub asking for public_repo only, with PKCE, back to /auth/callback/github', async () => {
  const start = await new Browser().post('/auth/sign-in');

  const authorize = location(start);
  expect(start.status).toBe(303);
  expect(`${authorize.origin}${authorize.pathname}`).toBe(`${env.GH_WEB_URL}/login/oauth/authorize`);
  expect(authorize.searchParams.get('client_id')).toBe(APP.clientId);
  expect(authorize.searchParams.get('scope')).toBe('public_repo');
  expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback/github`);
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorize.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
});

test('a person who signs in is recorded by numeric GitHub ID and lands on /me with their login in the nav', async () => {
  const browser = new Browser();

  const back = await signIn(browser, github, 'priya');
  const me = await browser.fetch('/me');

  expect(back.status).toBe(302);
  expect(location(back).toString()).toBe(`${ORIGIN}/me`);
  expect(await getPerson(env.DB, 1001)).toMatchObject({ githubId: 1001, login: 'priya' });
  expect(me.status).toBe(200);
  expect(await navLogin(me)).toBe('@priya');
  expect(await navLogin(await new Browser().fetch('/'))).toBeNull();
});

test('a renamed GitHub account signs in as the same person, under its new login', async () => {
  await signIn(new Browser(), github, 'priya');
  const account = github.state.accounts.priya;
  if (!account) throw new Error('the fake has no priya');
  Reflect.deleteProperty(github.state.accounts, 'priya');
  github.state.accounts['priya-renamed'] = { ...account, login: 'priya-renamed' };

  const browser = new Browser();
  await signIn(browser, github, 'priya-renamed');

  expect(await getPerson(env.DB, 1001)).toMatchObject({ login: 'priya-renamed' });
  expect(await navLogin(await browser.fetch('/me'))).toBe('@priya-renamed');
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "user"').first('n')).toBe(1);
});

test('the GitHub token from sign-in is stored encrypted, and nowhere in the database in the clear', async () => {
  await signIn(new Browser(), github, 'kenji');
  const [token] = tokensIssued(github);
  const stored = await env.DB.prepare('SELECT access_token FROM account').first<{ access_token: string }>();

  expect(token).toMatch(/^gho_/);
  expect(await wholeDatabase()).not.toContain(token);
  expect(stored?.access_token).not.toContain(token);
  expect(await symmetricDecrypt({ key: env.AUTH_SECRET, data: stored?.access_token ?? '' })).toBe(token);
});

test('every cookie sign-in sets is host-only, with the __Host- prefix, Secure, and Path=/', async () => {
  const browser = new Browser();
  await signIn(browser, github, 'sam');
  await browser.post('/auth/sign-out');

  expect(browser.setCookies.length).toBeGreaterThan(0);
  for (const cookie of browser.setCookies) {
    expect(cookie.name, cookie.header).toMatch(/^__Host-/);
    expect(cookie.attributes, cookie.header).toContain('Secure');
    expect(cookie.attributes, cookie.header).toContain('Path=/');
    expect(cookie.attributes.some((a) => /^domain=/i.test(a)), cookie.header).toBe(false);
  }
});

test('a sign-in started from another site is refused before it reaches GitHub', async () => {
  const start = await new Browser().post('/auth/sign-in', {}, 'https://elsewhere.example');

  expect(start.status).toBe(403);
  expect(github.calls).toEqual([]);
});

test('GitHub sending back a sign-in this browser never started signs no one in', async () => {
  const mine = new Browser();
  const theirs = new Browser();
  const back = await pickOnGitHub(github, location(await theirs.post('/auth/sign-in')), 'lena');

  const answer = await mine.fetch(back.toString());
  const page = await (await mine.fetch(location(answer).toString())).text();

  expect(location(answer).pathname).toBe('/sign-in');
  expect(location(answer).searchParams.get('error')).toBeTruthy();
  expect(page).toMatch(/Sign-in didn(&#x27;|')t finish\. Try again\./);
  expect(await getPerson(env.DB, 1006)).toBeNull();
  expect(tokensIssued(github)).toEqual([]);
  expect(location(await mine.fetch('/me')).pathname).toBe('/sign-in');
});

test('a session lasts 7 days, and a page view a day or more after its last extension extends it to 7 days from then', async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const browser = new Browser();
  await signIn(browser, github, 'priya');
  const setAtSignIn = browser.setCookies.find((cookie) => cookie.name === '__Host-gft.session_token');
  const expires = async () => Date.parse((await env.DB.prepare('SELECT expires_at FROM session').first<string>('expires_at')) ?? '');

  const fresh = await browser.fetch('/');
  const fiveDaysLeft = new Date(Date.now() + 5 * DAY).toISOString();
  await env.DB.prepare('UPDATE session SET expires_at = ?').bind(fiveDaysLeft).run();
  const later = await browser.fetch('/');

  expect(setAtSignIn?.attributes).toContain('Max-Age=604800');
  expect(fresh.headers.getSetCookie()).toEqual([]);
  expect(later.headers.getSetCookie()).toEqual([expect.stringMatching(/^__Host-gft\.session_token=.*Max-Age=604800/)]);
  expect(await expires()).toBeGreaterThan(Date.now() + 7 * DAY - 60_000);
  expect(await navLogin(later)).toBe('@priya');
});

test('signed out, /me sends the person to sign in, and signed in, /sign-in sends them to /me', async () => {
  const browser = new Browser();
  const signedOut = await browser.fetch('/me');
  await signIn(browser, github, 'arjun');
  const signedIn = await browser.fetch('/sign-in');

  expect(location(signedOut).pathname).toBe('/sign-in');
  expect(location(signedIn).pathname).toBe('/me');
});

test('under /auth, only the sign-in routes answer, so none of Better Auth\'s other endpoints can be reached', async () => {
  const browser = new Browser();
  await signIn(browser, github, 'priya');

  for (const [method, path] of [
    ['POST', '/auth/sign-up/email'],
    ['POST', '/auth/sign-in/social'],
    ['GET', '/auth/get-session'],
    ['POST', '/auth/get-access-token'],
    ['POST', '/auth/update-user'],
    ['GET', '/auth/list-accounts'],
    ['GET', '/auth/sign-in'],
    ['GET', '/auth/sign-out'],
  ] as const) {
    const answer = await browser.fetch(path, {
      method,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ providerId: 'github', name: 'x' }) } : {}),
    });
    expect(answer.status, `${method} ${path}`).toBe(404);
  }
});
