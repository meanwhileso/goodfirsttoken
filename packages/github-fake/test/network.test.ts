import { afterEach, expect, test, vi } from 'vitest';
import { createGitHubFake } from '../src/index.ts';
import { localOAuthApp } from '../src/sample-data.ts';
import { graphql, rest, toBase64 } from './call.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the fake refuses any URL outside its two base URLs, so code under test cannot reach the network', async () => {
  const fake = createGitHubFake();

  await expect(fake.fetch('https://api.github.com/user')).rejects.toThrow(/refused https:\/\/api\.github\.com\/user/);
  await expect(fake.fetch('https://github.test.example.com/login/oauth/authorize')).rejects.toThrow(TypeError);
  expect(fake.calls).toEqual([]);
});

test('the fake answers a whole donor flow with the network turned off', async () => {
  const network = vi.fn(() => {
    throw new Error('the network was used');
  });
  vi.stubGlobal('fetch', network);
  const fake = createGitHubFake();

  // Sign in through OAuth.
  const back = await fake.fetch(`${fake.webUrl}/login/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({ client_id: localOAuthApp.clientId, login: 'arjun', scope: 'public_repo' }),
  });
  const code = new URL(back.headers.get('location') ?? '').searchParams.get('code') ?? '';
  const exchanged = await fake.fetch(`${fake.webUrl}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json' },
    body: new URLSearchParams({ client_id: localOAuthApp.clientId, client_secret: localOAuthApp.clientSecret, code }),
  });
  const { access_token: token } = (await exchanged.json()) as { access_token: string };

  // Find an issue, fork, branch, commit, and open the PR.
  const found = await rest<{ total_count: number }>(
    fake,
    'GET',
    `/search/issues?q=${encodeURIComponent('repo:meanwhileso/goodfirsttoken is:issue is:open label:goodfirsttoken')}`,
    { token },
  );
  await rest(fake, 'POST', '/repos/meanwhileso/goodfirsttoken/forks', { token, body: {} });
  const main = await rest<{ object: { sha: string } }>(fake, 'GET', '/repos/meanwhileso/goodfirsttoken/git/ref/heads/main', { token });
  await rest(fake, 'POST', '/repos/arjun/goodfirsttoken/git/refs', {
    token,
    body: { ref: 'refs/heads/agent-names', sha: main.body.object.sha },
  });
  const commit = await graphql(
    fake,
    token,
    'mutation ($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }',
    {
      input: {
        branch: { repositoryNameWithOwner: 'arjun/goodfirsttoken', branchName: 'agent-names' },
        expectedHeadOid: main.body.object.sha,
        message: { headline: "Show each agent's name in the live lanes" },
        fileChanges: { additions: [{ path: 'apps/web/src/lanes.ts', contents: toBase64('export {};\n') }] },
      },
    },
  );
  const pr = await rest(fake, 'POST', '/repos/meanwhileso/goodfirsttoken/pulls', {
    token,
    body: { title: "Show each agent's name in the live lanes", head: 'arjun:agent-names', base: 'main', body: 'Closes #912' },
  });

  expect(found.body.total_count).toBe(3);
  expect(commit.body.errors).toBeUndefined();
  expect(pr.status).toBe(201);
  expect(network).not.toHaveBeenCalled();
  expect(fake.calls.filter((c) => c.token === token).every((c) => c.login === 'arjun')).toBe(true);
});
