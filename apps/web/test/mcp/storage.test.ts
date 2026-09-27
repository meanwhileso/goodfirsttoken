import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { symmetricDecrypt } from 'better-auth/crypto';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { emptyDatabase } from '../db/helpers';
import { ORIGIN, startGitHub, wholeDatabase } from '../auth/helpers';
import {
  agentFetch,
  appTokens,
  connectAgent,
  emptyKv,
  encodings,
  readableKv,
  startSession,
  wholeKv,
} from './helpers';

// Where an agent's GitHub token is kept. The grant's props in OAUTH_KV are
// encrypted with a key that only the agent's own tokens unwrap, and KV keeps
// only hashes of those tokens. The one other copy is in D1, encrypted with
// AUTH_SECRET, for Disconnect.

let github: GitHubFake;

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('nothing in the OAUTH_KV namespace holds a GitHub token, or the tokens the agents hold, in any key, value, or metadata', async () => {
  const priya = await connectAgent(github, 'priya');
  const kenji = await connectAgent(github, 'kenji');
  await startSession(priya);
  await startSession(kenji);
  // A refresh rewrites the grant and issues new tokens.
  const refreshed = await agentFetch()(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: priya.oauth.saved?.refresh_token ?? '',
      client_id: priya.oauth.client?.client_id ?? '',
    }),
  });
  const newTokens = await refreshed.json<{ access_token: string; refresh_token: string }>();

  const kv = await wholeKv();
  const readable = await readableKv();
  const secrets = [
    ...appTokens(github),
    ...[priya, kenji].flatMap((agent) => [agent.oauth.saved?.access_token ?? '', agent.oauth.saved?.refresh_token ?? '']),
    newTokens.access_token,
    newTokens.refresh_token,
  ];

  expect(refreshed.status).toBe(200);
  expect(appTokens(github)).toHaveLength(2);
  expect(kv).toContain('grant:');
  // The search reads what it should: the client's name, which the library
  // stores in the clear.
  expect(readable).toContain('Claude Code (test)');
  for (const secret of secrets) {
    expect(secret.length).toBeGreaterThan(20);
    for (const form of encodings(secret)) expect(kv).not.toContain(form);
    expect(readable).not.toContain(secret);
  }
});

test('the KV search finds a token stored only encoded, as base64 of JSON, the way props would look unencrypted', async () => {
  const token = 'gho_encodedButNotEncrypted0123456789';
  const props = btoa(JSON.stringify({ githubId: 1, gitHubToken: token }));
  await env.OAUTH_KV.put('grant:1:test', JSON.stringify({ encryptedProps: props }));

  expect(await readableKv()).toContain(token);
});

test("D1 holds each agent's GitHub token only encrypted with AUTH_SECRET", async () => {
  await connectAgent(github, 'sam');
  const [token = ''] = appTokens(github);

  const stored = await env.DB.prepare('SELECT github_token FROM connected_agents').first<string>('github_token');

  expect(await wholeDatabase()).not.toContain(token);
  expect(await symmetricDecrypt({ key: env.AUTH_SECRET, data: stored ?? '' })).toBe(token);
});
