import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getPerson } from '../../src/db';
import { emptyDatabase } from '../db/helpers';
import { Browser, location, navLogin, startGitHub, tokensIssued } from './helpers';

// vitest.config.ts runs the Worker as staging. These tests set ENVIRONMENT
// themselves and put it back.
let github: GitHubFake;
const configured = env.ENVIRONMENT;

beforeEach(async () => {
  await emptyDatabase();
  github = startGitHub();
});

afterEach(() => {
  env.ENVIRONMENT = configured;
  vi.unstubAllGlobals();
});

test.each(['staging', 'production'])(
  'outside development, as in %s, the dev sign-in does not exist and signs no one in',
  async (environment) => {
    env.ENVIRONMENT = environment;
    const browser = new Browser();

    const answer = await browser.post('/auth/dev/sign-in', { login: 'priya' });

    expect(answer.status).toBe(404);
    expect(answer.headers.getSetCookie()).toEqual([]);
    expect(github.calls).toEqual([]);
    expect(await getPerson(env.DB, 1001)).toBeNull();
    expect(location(await browser.fetch('/me')).pathname).toBe('/sign-in');
  },
);

test('in development, the dev sign-in signs in as a sample person through the GitHub fake, with their own token', async () => {
  env.ENVIRONMENT = 'development';
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
  env.ENVIRONMENT = 'development';
  const browser = new Browser();

  const answer = await browser.post('/auth/dev/sign-in', { login: 'nobody-here' });

  expect(answer.status).toBe(422);
  expect(tokensIssued(github)).toEqual([]);
  expect(location(await browser.fetch('/me')).pathname).toBe('/sign-in');
});

test('the dev sign-in refuses a form sent from another site', async () => {
  env.ENVIRONMENT = 'development';

  const answer = await new Browser().post('/auth/dev/sign-in', { login: 'priya' }, 'https://elsewhere.example');

  expect(answer.status).toBe(403);
  expect(github.calls).toEqual([]);
});

test("outside development, a missing secret stops sign-in before it reaches GitHub, where development's stand-in would not", async () => {
  const secret = env.AUTH_SECRET;
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  Reflect.deleteProperty(env, 'AUTH_SECRET');
  try {
    const staging = await new Browser().post('/auth/sign-in');
    env.ENVIRONMENT = 'development';
    const development = await new Browser().post('/auth/sign-in');

    expect(staging.status).toBe(503);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('The AUTH_SECRET secret is not set.'));
    expect(development.status).toBe(303);
    expect(github.calls).toEqual([]);
  } finally {
    env.AUTH_SECRET = secret;
    logged.mockRestore();
  }
});
