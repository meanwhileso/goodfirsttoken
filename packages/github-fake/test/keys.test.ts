import { afterEach, beforeEach, expect, test } from 'vitest';
import { createGitHubFake, type GitHubFake } from '../src/index.ts';
import { graphql, rest } from './call.ts';

// The fake keeps tokens, accounts, repos, apps, codes, branches, and git
// objects in plain objects, keyed by what a request names. A name like
// __proto__ must find nothing that isn't there, and must never reach
// Object.prototype, since the dev server answers anyone on this machine.

let fake: GitHubFake;
const UPSTREAM = '/repos/meanwhileso/goodfirsttoken';
const inherited = Object.prototype as Record<string, unknown>;

beforeEach(() => {
  fake = createGitHubFake();
});

afterEach(() => {
  // A failing run must not leave the next test a polluted prototype.
  for (const name of ['lastUsedAt', 'login', 'scopes']) Reflect.deleteProperty(inherited, name);
});

test('a token named like __proto__ is a bad credential, and leaves Object.prototype alone', async () => {
  const reply = await rest(fake, 'GET', UPSTREAM, { token: '__proto__' });

  expect(reply.status).toBe(401);
  expect(reply.body).toMatchObject({ message: 'Bad credentials' });
  expect(Object.hasOwn(inherited, 'lastUsedAt')).toBe(false);
  expect(fake.calls.at(-1)).toMatchObject({ token: '__proto__', login: null, status: 401 });
});

test('an account, a repo, or a branch named like __proto__ is not found', async () => {
  const token = fake.tokenFor('kenji');

  const user = await rest(fake, 'GET', '/users/__proto__');
  const branch = await rest(fake, 'GET', `${UPSTREAM}/branches/constructor`);
  const commit = await graphql<{ createCommitOnBranch: unknown }>(
    fake,
    token,
    `mutation ($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }`,
    {
      input: {
        branch: { repositoryNameWithOwner: '__proto__', branchName: 'main' },
        expectedHeadOid: '0'.repeat(40),
        message: { headline: 'Nothing' },
      },
    },
  );

  expect(user.status).toBe(404);
  expect(branch.status).toBe(404);
  expect(commit.body.errors).toMatchObject([{ type: 'NOT_FOUND' }]);
});

test('a branch named __proto__ is a branch like any other', async () => {
  const token = fake.tokenFor('kenji');
  const main = await rest<{ object: { sha: string } }>(fake, 'GET', `${UPSTREAM}/git/ref/heads/main`);

  const created = await rest(fake, 'POST', `${UPSTREAM}/git/refs`, {
    token,
    body: { ref: 'refs/heads/__proto__', sha: main.body.object.sha },
  });
  const read = await rest<{ name: string; commit: { sha: string } }>(fake, 'GET', `${UPSTREAM}/branches/__proto__`);

  expect(created.status).toBe(201);
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({ name: '__proto__', commit: { sha: main.body.object.sha } });
});
