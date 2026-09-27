import { beforeEach, expect, test } from 'vitest';
import { createGitHubFake, type GitHubFake } from '../src/index.ts';
import { graphql, rest } from './call.ts';

// Private repos. GitHub shows one only to its owner and collaborators, and
// only through a token with the repo scope. Everyone else gets a 404, as if
// it weren't there.
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps#available-scopes
// https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api

let fake: GitHubFake;
const PRIVATE = '/repos/sample-owner/sample-tools';

beforeEach(() => {
  fake = createGitHubFake();
  // sample-maintainer is an admin of sample-tools, and priya has no role on it.
  const repo = fake.state.repos['sample-owner/sample-tools'];
  if (!repo) throw new Error('missing sample repo');
  repo.private = true;
});

test('a private repo answers 404 to a caller with no role on it, even with the repo scope, and to no token at all', async () => {
  const outsider = await rest(fake, 'GET', PRIVATE, { token: fake.tokenFor('priya', ['repo']) });
  const anonymous = await rest(fake, 'GET', PRIVATE);
  const labels = await rest(fake, 'GET', `${PRIVATE}/labels`, { token: fake.tokenFor('priya', ['repo']) });

  expect([outsider.status, anonymous.status, labels.status]).toEqual([404, 404, 404]);
  expect(outsider.body).toMatchObject({ message: 'Not Found' });
});

test("a private repo answers 404 to its own admin when the token has only the public_repo scope", async () => {
  const reply = await rest(fake, 'GET', PRIVATE, { token: fake.tokenFor('sample-maintainer', ['public_repo']) });

  expect(reply.status).toBe(404);
});

test('a collaborator whose token has the repo scope sees the private repo, marked private', async () => {
  const reply = await rest(fake, 'GET', PRIVATE, { token: fake.tokenFor('sample-maintainer', ['repo']) });

  expect(reply.status).toBe(200);
  expect(reply.body).toMatchObject({
    private: true,
    visibility: 'private',
    permissions: { admin: true, maintain: true },
  });
});

test('a public repo says it is public', async () => {
  const reply = await rest(fake, 'GET', '/repos/sample-owner/sample-app');

  expect(reply.body).toMatchObject({ private: false, visibility: 'public' });
});

test("GraphQL can't resolve a private repo for a caller who can't see it", async () => {
  const query = '{ repository(owner: "sample-owner", name: "sample-tools") { isPrivate } }';

  const outsider = await graphql<{ repository: { isPrivate: boolean } | null }>(fake, fake.tokenFor('priya', ['repo']), query);
  const admin = await graphql<{ repository: { isPrivate: boolean } | null }>(
    fake,
    fake.tokenFor('sample-maintainer', ['repo']),
    query,
  );

  expect(outsider.body.data?.repository).toBeNull();
  expect(outsider.body.errors).toMatchObject([{ type: 'NOT_FOUND' }]);
  expect(admin.body.data?.repository).toEqual({ isPrivate: true });
});

test('search leaves out private repos the caller cannot see', async () => {
  const q = encodeURIComponent('org:sample-owner');
  const names = async (token?: string) =>
    (await rest<{ items: { full_name: string }[] }>(fake, 'GET', `/search/repositories?q=${q}`, { token })).body.items.map(
      (r) => r.full_name,
    );

  expect(await names(fake.tokenFor('priya', ['repo']))).not.toContain('sample-owner/sample-tools');
  expect(await names(fake.tokenFor('sample-maintainer', ['repo']))).toContain('sample-owner/sample-tools');
});

test("a private repo's raw files are not served", async () => {
  const response = await fake.fetch(`${fake.webUrl}/sample-owner/sample-tools/raw/main/README.md`);

  expect(response.status).toBe(404);
});
