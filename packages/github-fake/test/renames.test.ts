import { beforeEach, expect, test } from 'vitest';
import { createGitHubFake, type GitHubFake } from '../src/index.ts';
import { graphql, rest } from './call.ts';

// Renamed, transferred, deleted, and new repos. A repo keeps its ID through a
// rename or a transfer, and GitHub sends calls to the old name on to it:
// 301 for a read, 307 for anything else, the split by method people
// observe. A new repo made under the old name takes the name, with an ID
// of its own.
// https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository
// https://developer.github.com/changes/2015-04-17-preview-repository-redirects/

let fake: GitHubFake;
// sample-maintainer is an admin of sample-owner/sample-app.
const OLD = 'sample-owner/sample-app';
const NEW = 'sample-owner/sample-app-2';

beforeEach(() => {
  fake = createGitHubFake();
});

interface Repo {
  id: number;
  node_id: string;
  full_name: string;
  created_at: string;
}

function idOf(name: string): number {
  const repo = fake.state.repos[name];
  if (!repo) throw new Error(`missing sample repo ${name}`);
  return repo.id;
}

test('a renamed repo keeps its ID, and its old name sends a read on to it with a 301 that fetch follows', async () => {
  const id = idOf(OLD);

  fake.renameRepo(OLD, NEW);
  const byNew = await rest<Repo>(fake, 'GET', `/repos/${NEW}`);
  const byOld = await rest<Repo>(fake, 'GET', `/repos/${OLD}`);

  expect(byNew.body).toMatchObject({ id, full_name: NEW });
  expect(byOld.status).toBe(200);
  expect(byOld.body).toEqual(byNew.body);
  expect(fake.calls.map((call) => [call.url, call.status])).toEqual([
    [`${fake.apiUrl}/repos/${NEW}`, 200],
    [`${fake.apiUrl}/repos/${OLD}`, 301],
    [`${fake.apiUrl}/repositories/${String(id)}`, 200],
  ]);
});

test("a call that doesn't follow redirects sees GitHub's 301, with the repo's ID path in Location", async () => {
  const id = idOf(OLD);
  fake.renameRepo(OLD, NEW);

  const response = await fake.fetch(`${fake.apiUrl}/repos/${OLD}/labels?per_page=5`, {
    headers: { 'user-agent': 'github-fake-tests' },
    redirect: 'manual',
  });

  expect(response.status).toBe(301);
  expect(response.headers.get('location')).toBe(`${fake.apiUrl}/repositories/${String(id)}/labels?per_page=5`);
  expect(await response.json()).toMatchObject({ message: 'Moved Permanently' });
});

test("a write to a renamed repo's old name gets a 307, and goes on to the repo with its method and body", async () => {
  fake.renameRepo(OLD, NEW);
  const token = fake.tokenFor('sample-maintainer');

  const created = await rest(fake, 'POST', `/repos/${OLD}/labels`, { token, body: { name: 'moved-label', color: '123456' } });

  expect(created.status).toBe(201);
  expect(fake.calls.map((call) => call.status)).toEqual([307, 201]);
  expect(fake.state.repos[NEW]?.labels.map((label) => label.name)).toContain('moved-label');
});

test("GraphQL finds a renamed repo by its old name", async () => {
  fake.renameRepo(OLD, NEW);

  const reply = await graphql<{ repository: { nameWithOwner: string } | null }>(
    fake,
    fake.tokenFor('priya'),
    `{ repository(owner: "sample-owner", name: "sample-app") { nameWithOwner } }`,
  );

  expect(reply.body.data?.repository).toEqual({ nameWithOwner: NEW });
});

test('a transfer to another account keeps the ID, and the old name goes on to the new owner', async () => {
  const id = idOf(OLD);

  fake.renameRepo(OLD, 'sample-maintainer/sample-app');
  const byOld = await rest<Repo>(fake, 'GET', `/repos/${OLD}`);

  expect(byOld.body).toMatchObject({ id, full_name: 'sample-maintainer/sample-app' });
});

test("a new repo made under a renamed repo's old name takes the name, with an ID of its own and a later created_at", async () => {
  const id = idOf(OLD);
  fake.renameRepo(OLD, NEW);

  const made = fake.createRepo(OLD, { admins: ['priya'] });
  const byOld = await rest<Repo & { permissions: { admin: boolean } }>(fake, 'GET', `/repos/${OLD}`, {
    token: fake.tokenFor('priya'),
  });
  const byNew = await rest<Repo>(fake, 'GET', `/repos/${NEW}`);

  expect(made).not.toBe(id);
  expect(byOld.status).toBe(200);
  expect(byOld.body).toMatchObject({ id: made, full_name: OLD, permissions: { admin: true } });
  expect(Date.parse(byOld.body.created_at)).toBeGreaterThan(Date.parse(byNew.body.created_at));
  expect(byNew.body.id).toBe(id);
  expect(fake.calls.map((call) => call.status)).toEqual([200, 200]);
});

test('a deleted repo answers 404 by its name and by its old names, and a repo made under its name is a new one', async () => {
  const id = idOf(OLD);
  fake.renameRepo(OLD, NEW);

  fake.deleteRepo(NEW);
  const [byNew, byOld, byId] = await Promise.all([
    rest(fake, 'GET', `/repos/${NEW}`),
    rest(fake, 'GET', `/repos/${OLD}`),
    rest(fake, 'GET', `/repositories/${String(id)}`),
  ]);
  const made = fake.createRepo(NEW);
  const again = await rest<Repo>(fake, 'GET', `/repos/${NEW}`);

  expect([byNew.status, byOld.status, byId.status]).toEqual([404, 404, 404]);
  expect(again.body.id).toBe(made);
  expect(made).not.toBe(id);
});
