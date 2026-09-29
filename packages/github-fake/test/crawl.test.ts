import { beforeEach, expect, test } from 'vitest';
import { createGitHubFake, type GitHubFake } from '../src/index.ts';
import { graphql, rest } from './call.ts';

// What the policy crawler reads: repository search in bands of star counts,
// and many repos' facts, folders, files, and labels in GraphQL batches. The
// sample-policies repos and their policy text are made up.

let fake: GitHubFake;
let token: string;

beforeEach(() => {
  fake = createGitHubFake();
  token = fake.tokenFor('lena');
});

const since = () => new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

async function search(q: string, extra = '') {
  return rest<{ total_count: number; items: { full_name: string; stargazers_count: number; archived: boolean }[] }>(
    fake,
    'GET',
    `/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=asc&per_page=100${extra}`,
    { token },
  );
}

test('repository search reads a band of star counts, closed or open, fewest stars first, with its count', async () => {
  const closed = await search(`org:sample-policies stars:2000..2999 pushed:>=${since()} archived:false is:public`);
  const open = await search(`org:sample-policies stars:>=3000 pushed:>=${since()} archived:false is:public`);

  expect(closed.body.items.map((r) => [r.full_name, r.stargazers_count])).toEqual([
    ['sample-policies/mixed-signals', 2200],
    ['sample-policies/with-conditions', 2400],
    ['sample-policies/collaborators-only', 2700],
    ['sample-policies/bans-ai', 2900],
  ]);
  expect(closed.body.total_count).toBe(4);
  expect(open.body.items.map((r) => r.full_name)).toEqual(['sample-policies/invites-agents', 'sample-policies/silent']);
  expect(closed.headers.get('x-ratelimit-resource')).toBe('search');
});

test('repository search leaves out archived repos, and repos with too few stars or no recent push', async () => {
  const found = await search(`org:sample-policies stars:>=1000 pushed:>=${since()} archived:false is:public`);
  const archived = await search('org:sample-policies archived:true');

  const names = found.body.items.map((r) => r.full_name);
  expect(names).not.toContain('sample-policies/archived-invites');
  expect(names).not.toContain('sample-policies/small-seed');
  expect(archived.body.items.map((r) => r.full_name)).toEqual(['sample-policies/archived-invites']);
});

test("one GraphQL query reads many repos' facts, their owners' age, their folders, and folders inside folders", async () => {
  const reply = await graphql<Record<string, unknown>>(
    fake,
    token,
    `query ($o0: String!, $n0: String!, $o1: String!, $n1: String!) {
      r0: repository(owner: $o0, name: $n0) { ...Crawled }
      r1: repository(owner: $o1, name: $n1) { ...Crawled }
    }
    fragment Crawled on Repository {
      nameWithOwner isArchived stargazerCount pushedAt
      defaultBranchRef { name }
      owner { ... on User { createdAt } ... on Organization { createdAt } }
      dotGithub: object(expression: "HEAD:.github") { ... on Tree { entries { name type size } } }
      skills: object(expression: "HEAD:.claude/skills") { ... on Tree { entries { name type object { ... on Tree { entries { name type size } } } } } }
    }`,
    { o0: 'sample-policies', n0: 'with-conditions', o1: 'sample-policies', n1: 'small-seed' },
  );

  expect(reply.body.errors).toBeUndefined();
  expect(reply.body.data).toMatchObject({
    r0: {
      nameWithOwner: 'sample-policies/with-conditions',
      isArchived: false,
      stargazerCount: 2400,
      defaultBranchRef: { name: 'main' },
      owner: { createdAt: expect.any(String) as unknown },
      dotGithub: { entries: [{ name: 'VOUCHED.td', type: 'blob', size: 12 }] },
      skills: null,
    },
    r1: {
      skills: { entries: [{ name: 'contributing', type: 'tree', object: { entries: [{ name: 'SKILL.md', type: 'blob' }] } }] },
    },
  });
});

test('a repo gives its labels, a page at a time, each with how many open issues carry it, pull requests left out', async () => {
  fake.openIssue('sample-policies/invites-agents', { title: 'Add a flag', labels: ['agent ready'], by: 'sample-maintainer' });
  const closed = fake.openIssue('sample-policies/invites-agents', { title: 'Done', labels: ['help wanted'], by: 'sample-maintainer' });
  fake.closeIssue('sample-policies/invites-agents', closed, 'sample-maintainer');
  const pull = fake.openPullRequest('sample-policies/invites-agents', { title: 'A fix', body: 'Fixes it.', by: 'sample-maintainer' });
  fake.labelIssue('sample-policies/invites-agents', pull, 'agent ready', 'sample-maintainer');
  const query = `query ($after: String) {
    repository(owner: "sample-policies", name: "invites-agents") {
      labels(first: 2, after: $after) {
        nodes { name issues(states: [OPEN]) { totalCount } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;
  type Labels = { repository: { labels: { nodes: { name: string; issues: { totalCount: number } }[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } };

  const first = await graphql<Labels>(fake, token, query);
  const second = await graphql<Labels>(fake, token, query, { after: first.body.data?.repository.labels.pageInfo.endCursor });

  const counts = [...(first.body.data?.repository.labels.nodes ?? []), ...(second.body.data?.repository.labels.nodes ?? [])].map(
    (label) => [label.name, label.issues.totalCount],
  );
  expect(counts).toEqual([
    ['bug', 0],
    ['good first issue', 1],
    ['help wanted', 0],
    ['agent ready', 3],
  ]);
  expect(first.body.data?.repository.labels.pageInfo.hasNextPage).toBe(true);
  expect(second.body.data?.repository.labels.pageInfo.hasNextPage).toBe(false);
});

test("a label's issues need first or last to list them, as on GitHub, and not to count them", async () => {
  const reply = await graphql(
    fake,
    token,
    `{ repository(owner: "sample-policies", name: "invites-agents") { labels(first: 1) { nodes { issues { nodes { number } } } } } }`,
  );

  expect(reply.body.errors).toMatchObject([{ type: 'MISSING_PAGINATION_BOUNDARIES' }]);
});

test('a GraphQL read of a repo the fake has no such name for is null, with a NOT_FOUND error, and the others still read', async () => {
  const reply = await graphql<Record<string, { nameWithOwner: string } | null>>(
    fake,
    token,
    `{ a: repository(owner: "sample-policies", name: "silent") { nameWithOwner } b: repository(owner: "sample-policies", name: "gone") { nameWithOwner } }`,
  );

  expect(reply.body.data).toEqual({ a: { nameWithOwner: 'sample-policies/silent' }, b: null });
  expect(reply.body.errors).toMatchObject([{ type: 'NOT_FOUND', path: ['b'] }]);
});
