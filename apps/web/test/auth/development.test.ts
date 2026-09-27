import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getPerson } from '../../src/db';
import { emptyDatabase } from '../db/helpers';
import {
  Browser,
  LOCAL_FAKE,
  location,
  navLogin,
  runAsDevelopment,
  setEnv,
  signIn,
  startGitHub,
  tokensIssued,
} from './helpers';

// vitest.config.ts runs the Worker as staging, with GitHub under .test and
// both secrets set. These tests change that for themselves and put it back.
let github: GitHubFake;
let restore: () => void = () => undefined;

beforeEach(async () => {
  await emptyDatabase();
  github = startGitHub();
});

afterEach(() => {
  restore();
  restore = () => undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Runs as `pnpm dev` does, with any other settings changed too, and a fake at the local URLs. */
function development(values: Parameters<typeof setEnv>[0] = {}) {
  const back = runAsDevelopment();
  const more = setEnv(values);
  restore = () => {
    more();
    back();
  };
  github = startGitHub();
}

async function refusedDevSignIn(browser: Browser) {
  const answer = await browser.post('/auth/dev/sign-in', { login: 'priya' });

  expect(answer.status).toBe(404);
  expect(answer.headers.getSetCookie()).toEqual([]);
  expect(github.calls).toEqual([]);
  expect(await getPerson(env.DB, 1001)).toBeNull();
  expect(location(await browser.fetch('/me')).pathname).toBe('/sign-in');
}

test.each(['staging', 'production'])(
  'outside development, as in %s, the dev sign-in does not exist and signs no one in, even with GitHub on this machine',
  async (environment) => {
    development({ ENVIRONMENT: environment });

    await refusedDevSignIn(new Browser());
  },
);

test.each([
  ['GitHub itself', ''],
  ['a GitHub elsewhere', 'https://github.test'],
  ['a fake on another machine over http', 'http://192.0.2.10:8944'],
])('in development with %s in GH_WEB_URL, the dev sign-in does not exist', async (_, web) => {
  development({ GH_WEB_URL: web });

  await refusedDevSignIn(new Browser());
});

test('in development, the dev sign-in signs in as a sample person through the GitHub fake, with their own token', async () => {
  development();
  const browser = new Browser();

  const answer = await browser.post('/auth/dev/sign-in', { login: 'kenji' });
  const back = await browser.fetch(location(answer).toString());

  expect(answer.status).toBe(303);
  expect(location(answer).pathname).toBe('/auth/callback/github');
  expect(location(back).pathname).toBe('/me');
  expect(await navLogin(await browser.fetch('/me'))).toBe('@kenji');
  expect(await getPerson(env.DB, 1002)).toMatchObject({ login: 'kenji' });
  expect(tokensIssued(github).map((token) => github.state.tokens[token]?.login)).toEqual(['kenji']);
});

test('the dev sign-in refuses a login the GitHub fake has no sample person for', async () => {
  development();
  const browser = new Browser();

  const answer = await browser.post('/auth/dev/sign-in', { login: 'nobody-here' });

  expect(answer.status).toBe(422);
  expect(tokensIssued(github)).toEqual([]);
  expect(location(await browser.fetch('/me')).pathname).toBe('/sign-in');
});

test('the dev sign-in refuses a form sent from another site', async () => {
  development();

  const answer = await new Browser().post('/auth/dev/sign-in', { login: 'priya' }, 'https://elsewhere.example');

  expect(answer.status).toBe(403);
  expect(github.calls).toEqual([]);
});

test.each(['OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET', 'AUTH_SECRET'] as const)(
  'outside development, a missing %s stops sign-in with 503 before it reaches GitHub',
  async (name) => {
    restore = setEnv({ [name]: undefined });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const start = await new Browser().post('/auth/sign-in');

    expect(start.status).toBe(503);
    expect(start.headers.getSetCookie()).toEqual([]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(name));
    expect(github.calls).toEqual([]);
  },
);

test('with a sign-in setting missing, pages still answer, and treat someone holding a session cookie as signed out', async () => {
  const browser = new Browser();
  await signIn(browser, github, 'priya');
  const forged = new Browser();
  forged.cookies.set('__Host-gft.session_token', 'not-a-real-session.not-a-signature');
  restore = setEnv({ OAUTH_CLIENT_ID: undefined });

  const home = await browser.fetch('/');
  const me = await browser.fetch('/me');
  const forgedHome = await forged.fetch('/');

  expect(home.status).toBe(200);
  expect(await navLogin(home)).toBeNull();
  expect(location(me).pathname).toBe('/sign-in');
  expect(forgedHome.status).toBe(200);
});

test('in development with GitHub the fake on this machine and neither secret set, sign-in uses the stand-ins', async () => {
  development({ OAUTH_CLIENT_SECRET: undefined, AUTH_SECRET: undefined });

  const start = await new Browser().post('/auth/sign-in');

  expect(start.status).toBe(303);
  expect(location(start).origin).toBe(new URL(LOCAL_FAKE.web).origin);
});

test('the stand-ins are all or nothing, so with only the client secret set, a missing AUTH_SECRET stops sign-in in development too', async () => {
  development({ OAUTH_CLIENT_SECRET: 'a-real-client-secret-set-locally', AUTH_SECRET: undefined });
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  const start = await new Browser().post('/auth/sign-in');

  expect(start.status).toBe(503);
  expect(logged).toHaveBeenCalledWith(expect.stringContaining('AUTH_SECRET'));
});

test('in development with GitHub anywhere but the fake on this machine, there are no stand-ins', async () => {
  development({ GH_WEB_URL: 'https://github.test', OAUTH_CLIENT_SECRET: undefined, AUTH_SECRET: undefined });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  const start = await new Browser().post('/auth/sign-in');

  expect(start.status).toBe(503);
});
