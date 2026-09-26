import { beforeEach, expect, test } from 'vitest';
import { createGitHubFake, type GitHubFake } from '../src/index.ts';
import { findRepo } from '../src/state.ts';
import { fromBase64, graphql, rest, toBase64 } from './call.ts';

let fake: GitHubFake;

beforeEach(() => {
  fake = createGitHubFake();
});

const UPSTREAM = '/repos/meanwhileso/goodfirsttoken';

async function head(repo: string, branch: string): Promise<string> {
  const { body } = await rest<{ object: { sha: string } }>(fake, 'GET', `/repos/${repo}/git/ref/heads/${branch}`);
  return body.object.sha;
}

async function forkWithBranch(login: string, branch: string) {
  const token = fake.tokenFor(login);
  await rest(fake, 'POST', `${UPSTREAM}/forks`, { token, body: {} });
  const sha = await head('meanwhileso/goodfirsttoken', 'main');
  await rest(fake, 'POST', `/repos/${login}/goodfirsttoken/git/refs`, {
    token,
    body: { ref: `refs/heads/${branch}`, sha },
  });
  return { token, sha };
}

const COMMIT = `mutation ($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit {
      oid
      messageHeadline
      author { user { login } }
      signature { isValid wasSignedByGitHub }
      parents(first: 1) { nodes { oid } }
    }
    ref { name }
  }
}`;

interface CommitReply {
  createCommitOnBranch: {
    commit: {
      oid: string;
      messageHeadline: string;
      author: { user: { login: string } };
      signature: { isValid: boolean; wasSignedByGitHub: boolean };
      parents: { nodes: { oid: string }[] };
    };
  } | null;
}

test('a fork belongs to the person whose token made it, and forking again returns the same fork', async () => {
  const sam = fake.tokenFor('sam');

  const first = await rest<{ id: number }>(fake, 'POST', `${UPSTREAM}/forks`, { token: sam, body: {} });
  const again = await rest<{ id: number }>(fake, 'POST', `${UPSTREAM}/forks`, { token: sam, body: {} });

  expect(first.status).toBe(202);
  expect(first.body).toMatchObject({
    full_name: 'sam/goodfirsttoken',
    fork: true,
    owner: { login: 'sam' },
    parent: { full_name: 'meanwhileso/goodfirsttoken' },
    permissions: { admin: true, push: true },
  });
  expect(again.body.id).toBe(first.body.id);
});

test('a person with push access can make a branch in the repo itself', async () => {
  const kenji = fake.tokenFor('kenji');
  const sha = await head('meanwhileso/goodfirsttoken', 'main');

  const created = await rest(fake, 'POST', `${UPSTREAM}/git/refs`, {
    token: kenji,
    body: { ref: 'refs/heads/kenji-18', sha },
  });
  const branch = await rest(fake, 'GET', `${UPSTREAM}/branches/kenji-18`);

  expect(created.status).toBe(201);
  expect(branch.body).toMatchObject({ name: 'kenji-18', commit: { sha } });
});

async function commitFile(token: string, repo: string, branch: string, path: string) {
  await graphql(fake, token, COMMIT, {
    input: {
      branch: { repositoryNameWithOwner: repo, branchName: branch },
      expectedHeadOid: await head(repo, branch),
      message: { headline: `Add ${path}` },
      fileChanges: { additions: [{ path, contents: toBase64(`${path}\n`) }] },
    },
  });
}

test("createCommitOnBranch commits as the token's person, and GitHub signs the commit", async () => {
  const { token, sha } = await forkWithBranch('sam', 'live-ndjson');

  const reply = await graphql<CommitReply>(fake, token, COMMIT, {
    input: {
      branch: { repositoryNameWithOwner: 'sam/goodfirsttoken', branchName: 'live-ndjson' },
      expectedHeadOid: sha,
      message: { headline: 'Stream /live as NDJSON', body: 'Assisted-by: OpenCode' },
      fileChanges: {
        additions: [{ path: 'apps/web/src/feed/ndjson.ts', contents: toBase64('export const ndjson = true;\n') }],
        deletions: [{ path: 'package.json' }],
      },
    },
  });

  const commit = reply.body.data?.createCommitOnBranch?.commit;
  expect(reply.body.errors).toBeUndefined();
  expect(commit).toMatchObject({
    messageHeadline: 'Stream /live as NDJSON',
    author: { user: { login: 'sam' } },
    signature: { isValid: true, wasSignedByGitHub: true },
    parents: { nodes: [{ oid: sha }] },
  });
  expect(await head('sam/goodfirsttoken', 'live-ndjson')).toBe(commit?.oid);
  const file = await rest<{ content: string }>(
    fake,
    'GET',
    '/repos/sam/goodfirsttoken/contents/apps/web/src/feed/ndjson.ts?ref=live-ndjson',
  );
  expect(fromBase64(file.body.content)).toBe('export const ndjson = true;\n');
  expect((await rest(fake, 'GET', '/repos/sam/goodfirsttoken/contents/package.json?ref=live-ndjson')).status).toBe(404);
  expect(fake.calls.filter((c) => c.operation === 'mutation createCommitOnBranch')).toEqual([
    expect.objectContaining({ login: 'sam', status: 200 }),
  ]);
});

test('createCommitOnBranch refuses a branch that moved since the caller read it', async () => {
  const { token, sha: read } = await forkWithBranch('sam', 'stale');
  await commitFile(token, 'sam/goodfirsttoken', 'stale', 'first.txt');
  const moved = await head('sam/goodfirsttoken', 'stale');

  const reply = await graphql<CommitReply>(fake, token, COMMIT, {
    input: {
      branch: { repositoryNameWithOwner: 'sam/goodfirsttoken', branchName: 'stale' },
      expectedHeadOid: read,
      message: { headline: 'late' },
      fileChanges: { additions: [{ path: 'late.txt', contents: toBase64('late') }] },
    },
  });

  expect(reply.body.data?.createCommitOnBranch).toBeNull();
  expect(reply.body.errors).toEqual([expect.objectContaining({ type: 'STALE_DATA' })]);
  expect(await head('sam/goodfirsttoken', 'stale')).toBe(moved);
});

test('a PR from a fork opens upstream as the token person, and the issue it names gets a cross-reference', async () => {
  const { token } = await forkWithBranch('sam', 'tough-badge');
  await commitFile(token, 'sam/goodfirsttoken', 'tough-badge', 'apps/web/src/tough.ts');

  const pr = await rest<{ number: number }>(fake, 'POST', `${UPSTREAM}/pulls`, {
    token,
    body: { title: 'Explain the tough badge on hover', head: 'sam:tough-badge', base: 'main', body: 'Closes #921' },
  });
  const timeline = await rest<{ event: string }[]>(fake, 'GET', `${UPSTREAM}/issues/921/timeline`);

  expect(pr.status).toBe(201);
  expect(pr.body).toMatchObject({
    state: 'open',
    user: { login: 'sam' },
    head: { label: 'sam:tough-badge', repo: { full_name: 'sam/goodfirsttoken' } },
    base: { ref: 'main', repo: { full_name: 'meanwhileso/goodfirsttoken' } },
    changed_files: 1,
  });
  expect(timeline.body.filter((e) => e.event === 'cross-referenced')).toMatchObject([
    { actor: { login: 'sam' }, source: { type: 'issue', issue: { number: pr.body.number, state: 'open' } } },
  ]);
});

test('GitHub refuses a second open PR from the same branch, and a PR with no new commits', async () => {
  const { token } = await forkWithBranch('sam', 'twice');
  const open = () =>
    rest<{ errors: { message: string }[] }>(fake, 'POST', `${UPSTREAM}/pulls`, {
      token,
      body: { title: 'Twice', head: 'sam:twice', base: 'main' },
    });

  const empty = await open();
  await commitFile(token, 'sam/goodfirsttoken', 'twice', 'twice.txt');
  const first = await open();
  const second = await open();

  expect(empty.status).toBe(422);
  expect(empty.body.errors[0]?.message).toBe('No commits between main and sam:twice');
  expect(first.status).toBe(201);
  expect(second.status).toBe(422);
  expect(second.body.errors[0]?.message).toBe('A pull request already exists for sam:twice.');
});

test('a repo that limits PR creation to collaborators refuses a PR from anyone else', async () => {
  const { token } = await forkWithBranch('sam', 'limited');
  await commitFile(token, 'sam/goodfirsttoken', 'limited', 'limited.txt');
  const upstream = findRepo(fake.state, 'meanwhileso', 'goodfirsttoken');
  if (upstream) upstream.pullRequestCreationPolicy = 'collaborators_only';

  const reply = await rest(fake, 'POST', `${UPSTREAM}/pulls`, {
    token,
    body: { title: 'Limited', head: 'sam:limited', base: 'main' },
  });

  expect((await rest(fake, 'GET', UPSTREAM)).body).toMatchObject({ pull_request_creation_policy: 'collaborators_only' });
  expect(reply.status).toBe(403);
});

test('merging a PR lands its changes and closes the issue it says it closes', async () => {
  fake.mergePullRequest('meanwhileso/goodfirsttoken', 957, 'octo-maintainer');

  const pr = await rest(fake, 'GET', `${UPSTREAM}/pulls/957`);
  const issue = await rest(fake, 'GET', `${UPSTREAM}/issues/918`);
  const file = await rest(fake, 'GET', `${UPSTREAM}/contents/apps/web/src/feed/format.ts`);

  expect(pr.body).toMatchObject({
    state: 'closed',
    merged: true,
    merged_by: { login: 'octo-maintainer' },
    changed_files: 1,
    additions: 3,
  });
  expect(issue.body).toMatchObject({ state: 'closed', state_reason: 'completed', closed_by: { login: 'octo-maintainer' } });
  expect(file.status).toBe(200);
});
