import { beforeEach, expect, test } from 'vitest';
import { createGitHubFake, type GitHubFake } from '../src/index.ts';
import { graphql, rest } from './call.ts';

// GitHub's primary rate limits. Each person has a budget for REST calls and
// one for GraphQL, whichever of their tokens made the calls, and every
// answer says what is left of it.
// https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
// https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api

let fake: GitHubFake;
let clock: Date;
const HOUR = 3_600_000;
const REPO = '/repos/sample-owner/sample-app';

beforeEach(() => {
  clock = new Date('2100-01-04T10:00:00Z');
  fake = createGitHubFake({ now: () => clock });
});

function budget(headers: Headers) {
  return {
    limit: headers.get('x-ratelimit-limit'),
    remaining: headers.get('x-ratelimit-remaining'),
    used: headers.get('x-ratelimit-used'),
    reset: headers.get('x-ratelimit-reset'),
    resource: headers.get('x-ratelimit-resource'),
  };
}

test('every answer says how much of the hour is left, and each call spends one', async () => {
  const token = fake.tokenFor('priya');

  const first = await rest(fake, 'GET', REPO, { token });
  const second = await rest(fake, 'GET', `${REPO}/issues/404`, { token });

  const reset = String((clock.getTime() + HOUR) / 1000);
  expect(budget(first.headers)).toEqual({ limit: '5000', remaining: '4999', used: '1', reset, resource: 'core' });
  // A refusal spends one too.
  expect(second.status).toBe(404);
  expect(budget(second.headers)).toMatchObject({ remaining: '4998', used: '2' });
});

test("a person's tokens share one budget, and another person has their own", async () => {
  fake.spendRateLimit('priya', 'core', 100);

  const other = await rest(fake, 'GET', REPO, { token: fake.tokenFor('priya') });
  const kenji = await rest(fake, 'GET', REPO, { token: fake.tokenFor('kenji') });

  expect(budget(other.headers).remaining).toBe('4899');
  expect(budget(kenji.headers).remaining).toBe('4999');
});

test('past the limit, REST answers 403 with nothing left, and the budget starts over when the hour is up', async () => {
  const token = fake.tokenFor('priya');
  fake.spendRateLimit('priya', 'core', 4999);

  const last = await rest(fake, 'GET', REPO, { token });
  const refused = await rest(fake, 'GET', REPO, { token });
  clock = new Date(clock.getTime() + HOUR);
  const later = await rest(fake, 'GET', REPO, { token });

  expect(last.status).toBe(200);
  expect(budget(last.headers).remaining).toBe('0');
  expect(refused.status).toBe(403);
  expect(refused.body).toMatchObject({ message: 'API rate limit exceeded for user ID 1001.' });
  expect(budget(refused.headers)).toMatchObject({ remaining: '0', used: '5000' });
  expect(later.status).toBe(200);
  expect(budget(later.headers)).toMatchObject({ remaining: '4999', used: '1' });
});

test('GraphQL has a budget of its own, and answers a spent one with 200 and a RATE_LIMITED error', async () => {
  const token = fake.tokenFor('priya');
  fake.spendRateLimit('priya', 'graphql', 5000);

  const query = await graphql(fake, token, '{ repository(owner: "sample-owner", name: "sample-app") { name } }');
  const restCall = await rest(fake, 'GET', REPO, { token });

  expect(query.status).toBe(200);
  expect(query.body.data).toBeUndefined();
  expect(query.body.errors).toEqual([{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1001.' }]);
  expect(budget(query.headers)).toMatchObject({ remaining: '0', resource: 'graphql' });
  expect(restCall.status).toBe(200);
  expect(budget(restCall.headers)).toMatchObject({ remaining: '4999', resource: 'core' });
});

test('a GraphQL query spends one point of its own budget', async () => {
  const token = fake.tokenFor('kenji');

  const query = await graphql(fake, token, '{ repository(owner: "sample-owner", name: "sample-app") { name } }');

  expect(budget(query.headers)).toMatchObject({ limit: '5000', remaining: '4999', resource: 'graphql' });
});

test('a call with no token has the budget GitHub gives an address, 60 an hour', async () => {
  const reply = await rest(fake, 'GET', REPO);

  expect(budget(reply.headers)).toMatchObject({ limit: '60', remaining: '59', resource: 'core' });
});

test('a name that no GitHub login or resource can have is refused, and Object.prototype stays as it was', () => {
  const spend = fake.spendRateLimit as (login: string, resource: string, requests: number) => void;

  for (const name of ['__proto__', 'constructor', 'prototype']) {
    expect(() => {
      spend(name, 'core', 1);
    }).toThrow(`No GitHub caller is named ${name}`);
    expect(() => {
      spend('priya', name, 1);
    }).toThrow(`No rate limit is named ${name}`);
  }

  expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain('core');
  expect(({} as Record<string, unknown>).core).toBeUndefined();
});
