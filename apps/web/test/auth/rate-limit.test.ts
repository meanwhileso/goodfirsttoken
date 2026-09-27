import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { emptyDatabase } from '../db/helpers';
import { Browser, location, pickOnGitHub, startGitHub } from './helpers';

// wrangler.jsonc gives the sign-in limiter 20 requests a minute for each
// client address. The Workers runtime counts them in the tests too.
const LIMIT = 20;

let github: GitHubFake;

beforeEach(async () => {
  await emptyDatabase();
  github = startGitHub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('one address gets 20 sign-in requests a minute, and the next is refused without holding up another address', async () => {
  const busy = new Browser();
  const answers: number[] = [];
  for (let i = 0; i < LIMIT; i++) answers.push((await busy.post('/auth/sign-in')).status);

  const over = await busy.post('/auth/sign-in');
  const elsewhere = await new Browser().post('/auth/sign-in');

  expect(answers).toEqual(Array<number>(LIMIT).fill(303));
  expect(over.status).toBe(429);
  expect(over.headers.get('retry-after')).toBe('60');
  expect(elsewhere.status).toBe(303);
});

test("GitHub's redirect back counts toward the same limit", async () => {
  const busy = new Browser();
  const other = new Browser();
  const back = await pickOnGitHub(github, location(await other.post('/auth/sign-in')), 'arjun');
  for (let i = 0; i < LIMIT; i++) await busy.post('/auth/sign-in');

  const callback = await busy.fetch(back.toString());

  expect(callback.status).toBe(429);
  expect(github.calls.some((call) => call.operation === 'POST /login/oauth/access_token')).toBe(false);
});
