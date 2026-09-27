import { beforeEach, expect, test, vi } from 'vitest';
import { createGitHubFake, type GitHubFake } from '../src/index.ts';
import { graphql, rest, toBase64 } from './call.ts';

let fake: GitHubFake;

beforeEach(() => {
  fake = createGitHubFake();
});

test('every call records the token it carried and whose token that is', async () => {
  const priya = fake.tokenFor('priya');
  const kenji = fake.tokenFor('kenji');

  await rest(fake, 'GET', '/repos/meanwhileso/goodfirsttoken', { token: priya });
  await graphql(fake, kenji, '{ viewer { login } }');
  await rest(fake, 'GET', '/repos/sample-owner/sample-app');

  expect(fake.calls).toEqual([
    expect.objectContaining({ operation: 'GET /repos/{owner}/{repo}', token: priya, login: 'priya', status: 200 }),
    expect.objectContaining({ operation: 'query viewer', token: kenji, login: 'kenji', status: 200 }),
    expect.objectContaining({ operation: 'GET /repos/{owner}/{repo}', token: null, login: null, status: 200 }),
  ]);
});

test('a token GitHub never issued is refused as bad credentials, and recorded with no owner', async () => {
  const reply = await rest(fake, 'GET', '/repos/meanwhileso/goodfirsttoken', { token: 'gho_not-a-real-token' });

  expect(reply.status).toBe(401);
  expect(reply.body).toMatchObject({ message: 'Bad credentials', status: '401' });
  expect(fake.calls).toEqual([expect.objectContaining({ token: 'gho_not-a-real-token', login: null, status: 401 })]);
});

test('a repo shows the permissions of the person whose token read it', async () => {
  const read = async (login: string) =>
    (await rest<{ permissions: unknown }>(fake, 'GET', '/repos/meanwhileso/goodfirsttoken', { token: fake.tokenFor(login) }))
      .body.permissions;

  expect(await read('octo-maintainer')).toEqual({ admin: true, maintain: true, push: true, triage: true, pull: true });
  expect(await read('kenji')).toEqual({ admin: false, maintain: false, push: true, triage: true, pull: true });
  expect(await read('priya')).toEqual({ admin: false, maintain: false, push: false, triage: false, pull: true });
  expect((await rest(fake, 'GET', '/repos/meanwhileso/goodfirsttoken')).body).not.toHaveProperty('permissions');
});

test("writes need push access, so a donor's token cannot change a repo it can only read", async () => {
  const priya = fake.tokenFor('priya');
  const { body: main } = await rest<{ object: { sha: string } }>(fake, 'GET', '/repos/meanwhileso/goodfirsttoken/git/ref/heads/main');

  const label = await rest(fake, 'POST', '/repos/meanwhileso/goodfirsttoken/labels', {
    token: priya,
    body: { name: 'mine', color: '000000' },
  });
  const branch = await rest(fake, 'POST', '/repos/meanwhileso/goodfirsttoken/git/refs', {
    token: priya,
    body: { ref: 'refs/heads/mine', sha: main.object.sha },
  });
  const commit = await graphql(
    fake,
    priya,
    `mutation ($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }`,
    {
      input: {
        branch: { repositoryNameWithOwner: 'meanwhileso/goodfirsttoken', branchName: 'main' },
        expectedHeadOid: main.object.sha,
        message: { headline: 'mine' },
        fileChanges: { additions: [{ path: 'mine.txt', contents: toBase64('mine') }] },
      },
    },
  );

  expect(label.status).toBe(404);
  expect(branch.status).toBe(404);
  expect(commit.body.errors).toEqual([expect.objectContaining({ type: 'FORBIDDEN' })]);
  const after = await rest<{ object: { sha: string } }>(fake, 'GET', '/repos/meanwhileso/goodfirsttoken/git/ref/heads/main');
  expect(after.body.object.sha).toBe(main.object.sha);
});

test("a maintainer's token can write to their own repo", async () => {
  const reply = await rest(fake, 'POST', '/repos/meanwhileso/goodfirsttoken/labels', {
    token: fake.tokenFor('octo-maintainer'),
    body: { name: 'agents welcome', color: '7057ff' },
  });

  expect(reply.status).toBe(201);
  expect(reply.body).toMatchObject({ name: 'agents welcome', color: '7057ff', default: false });
});

test('GitHub refuses an API call that carries no User-Agent', async () => {
  const response = await fake.fetch(`${fake.apiUrl}/repos/meanwhileso/goodfirsttoken`);

  expect(response.status).toBe(403);
  expect(await response.text()).toContain('User-Agent');
});

test('a new token uses each letter and digit equally, so random bytes that would favour some are skipped', () => {
  // The first draw holds only bytes that would favour the first letters of
  // the alphabet, like 62, 63, and 255. The second draw holds 0 to 35.
  const biased = Uint8Array.from({ length: 36 }, (_, i) => [62, 63, 126, 127, 190, 191, 254, 255][i % 8] ?? 255);
  const fair = Uint8Array.from({ length: 36 }, (_, i) => i);
  const draws = [biased, fair];
  const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
    const next = draws.shift() ?? fair;
    if (array instanceof Uint8Array) array.set(next.subarray(0, array.length));
    return array;
  });
  try {
    expect(createGitHubFake().tokenFor('priya')).toBe('gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
  } finally {
    spy.mockRestore();
  }
});
