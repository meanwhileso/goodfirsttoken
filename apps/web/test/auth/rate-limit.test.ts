import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { emptyDatabase } from '../db/helpers';
import {
  Browser,
  inOneLimitWindow,
  location,
  pickOnGitHub,
  randomAddress,
  runAsDevelopment,
  startGitHub,
} from './helpers';

// wrangler.jsonc gives the sign-in limiter 20 requests a minute for each
// client. The Workers runtime counts them in the tests too.
const LIMIT = 20;

let github: GitHubFake;
let restore: () => void = () => undefined;

beforeEach(async () => {
  await emptyDatabase();
  github = startGitHub();
  await inOneLimitWindow();
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

test.each([
  ['::ffff:198.51.100.7', '198.51.100.7'],
  ['0:0:0:0:0:ffff:198.51.100.17', '198.51.100.17'],
  ['0000:0000:0000:0000:0000:FFFF:198.51.100.27', '198.51.100.27'],
  ['::ffff:c633:6425', '198.51.100.37'],
])('an IPv4 address written as the IPv6 address %s counts as %s', async (mapped, address) => {
  const ipv4 = new Browser(address);
  for (let i = 0; i < LIMIT; i++) await ipv4.post('/auth/sign-in');

  const asIPv6 = await new Browser(mapped).post('/auth/sign-in');
  const neighbor = await new Browser('198.51.100.200').post('/auth/sign-in');

  expect(asIPv6.status).toBe(429);
  expect(neighbor.status).toBe(303);
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

// What a browser says about a request another site's page makes it send,
// like an image, or a page in a frame. Neither carries a SameSite=Lax cookie.
const FROM_ANOTHER_SITE = {
  image: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
  frame: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
};

test("registrations another site's page sends don't count toward sign-in, so a page elsewhere can't use up someone's sign-ins", async () => {
  const person = new Browser();
  for (let i = 0; i < LIMIT + 5; i++) {
    await person.fetch('/oauth/register', {
      method: 'POST',
      headers: { origin: 'https://elsewhere.example', 'content-type': 'text/plain' },
      body: 'x',
    });
  }

  const own = await person.post('/auth/sign-in');

  expect(own.status).toBe(303);
});

test("the page to approve an agent, loaded as another site's image or frame, is refused before it counts", async () => {
  const person = new Browser();
  const answers = new Set<number>();
  for (let i = 0; i < LIMIT + 5; i++) {
    answers.add((await person.fetch('/oauth/authorize?client_id=nope', { headers: FROM_ANOTHER_SITE.image })).status);
    answers.add((await person.fetch('/oauth/authorize?client_id=nope', { headers: FROM_ANOTHER_SITE.frame })).status);
  }

  const own = await person.post('/auth/sign-in');

  expect([...answers]).toEqual([400]);
  expect(own.status).toBe(303);
});

test("GitHub's return with no sign-in in progress in this browser is refused before it counts, so a page elsewhere can't use up someone's sign-ins", async () => {
  const person = new Browser();
  const site = new Set<string>();
  const agent = new Set<number>();
  for (let i = 0; i < LIMIT + 5; i++) {
    const back = await person.fetch('/auth/callback/github?code=x&state=y', { headers: FROM_ANOTHER_SITE.image });
    site.add(`${String(back.status)} ${location(back).pathname}`);
    agent.add((await person.fetch('/auth/callback/mcp?code=x&state=y', { headers: FROM_ANOTHER_SITE.image })).status);
  }

  const own = await person.post('/auth/sign-in');

  // Each goes back to /sign-in, as a sign-in that didn't finish does.
  expect([...site]).toEqual(['303 /sign-in']);
  expect([...agent]).toEqual([400]);
  expect(own.status).toBe(303);
  expect(github.calls).toEqual([]);
});
