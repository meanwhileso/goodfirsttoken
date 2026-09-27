import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { emptyDatabase } from '../db/helpers';
import { Browser, location, pickOnGitHub, randomAddress, runAsDevelopment, startGitHub } from './helpers';

// wrangler.jsonc gives the sign-in limiter 20 requests a minute for each
// client. The Workers runtime counts them in the tests too.
const LIMIT = 20;

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

test('an IPv6 client counts by its /64, so changing addresses within it gets no more sign-ins', async () => {
  const prefix = '2001:db8:4b1d:7';
  for (let i = 0; i < LIMIT; i++) await new Browser(randomAddress(prefix)).post('/auth/sign-in');

  // The same /64, written out in full, with capitals and leading zeros.
  const sameNetwork = await new Browser('2001:0DB8:4B1D:0007:0000:0000:0000:0009').post('/auth/sign-in');
  const written = await env.DB.prepare('SELECT COUNT(*) AS n FROM verification').first('n');

  expect(sameNetwork.status).toBe(429);
  expect(written).toBe(LIMIT);
});

test("a form another site sends is refused before it counts, so a page elsewhere can't use up someone's sign-ins", async () => {
  const person = new Browser();
  for (let i = 0; i < LIMIT + 5; i++) {
    expect((await person.post('/auth/sign-in', {}, 'https://elsewhere.example')).status).toBe(403);
  }

  const own = await person.post('/auth/sign-in');

  expect(own.status).toBe(303);
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

test('in development, the dev sign-in counts toward the same limit', async () => {
  restore = runAsDevelopment();
  github = startGitHub();
  const busy = new Browser();
  for (let i = 0; i < LIMIT; i++) await busy.post('/auth/sign-in');

  const devSignIn = await busy.post('/auth/dev/sign-in', { login: 'priya' });

  expect(devSignIn.status).toBe(429);
  expect(github.calls).toEqual([]);
});
