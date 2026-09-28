import { beforeEach, expect, test } from 'vitest';
import { createGitHubFake, type GitHubFake } from '../src/index.ts';
import { findRepo } from '../src/state.ts';
import { fromBase64, graphql, rest, toBase64 } from './call.ts';

let fake: GitHubFake;
// The fake's clock, which the tests move.
let clock: number;

beforeEach(() => {
  clock = Date.now();
  fake = createGitHubFake({ now: () => new Date(clock) });
});

/** Time passes, and GitHub finishes making the forks it started. */
function forksFinish(): void {
  clock += fake.forkDelayMs;
}

const UPSTREAM = '/repos/meanwhileso/goodfirsttoken';

async function head(repo: string, branch: string): Promise<string> {
  const { body } = await rest<{ object: { sha: string } }>(fake, 'GET', `/repos/${repo}/git/ref/heads/${branch}`);
  return body.object.sha;
}

async function forkWithBranch(login: string, branch: string) {
  const token = fake.tokenFor(login);
  await rest(fake, 'POST', `${UPSTREAM}/forks`, { token, body: {} });
  forksFinish();
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

test("a collaborator working on a branch in the repo is the commit's author and the PR's opener", async () => {
  const kenji = fake.tokenFor('kenji');
  const sha = await head('meanwhileso/goodfirsttoken', 'main');
  await rest(fake, 'POST', `${UPSTREAM}/git/refs`, { token: kenji, body: { ref: 'refs/heads/kenji-921', sha } });

  const commit = await graphql<CommitReply>(fake, kenji, COMMIT, {
    input: {
      branch: { repositoryNameWithOwner: 'meanwhileso/goodfirsttoken', branchName: 'kenji-921' },
      expectedHeadOid: sha,
      message: { headline: 'Explain the tough badge on hover' },
      fileChanges: { additions: [{ path: 'apps/web/src/tough.ts', contents: toBase64('export {};\n') }] },
    },
  });
  const pr = await rest(fake, 'POST', `${UPSTREAM}/pulls`, {
    token: kenji,
    body: { title: 'Explain the tough badge on hover', head: 'kenji-921', base: 'main', body: 'Closes #921' },
  });

  expect(commit.body.data?.createCommitOnBranch?.commit.author).toEqual({ user: { login: 'kenji' } });
  expect(pr.status).toBe(201);
  expect(pr.body).toMatchObject({
    user: { login: 'kenji' },
    head: { label: 'meanwhileso:kenji-921', repo: { full_name: 'meanwhileso/goodfirsttoken' } },
  });
});

test("a PR's head must come from the base repo or a fork of it", async () => {
  const sam = fake.tokenFor('sam');
  await rest(fake, 'POST', '/repos/sample-owner/sample-app/forks', { token: sam, body: {} });
  forksFinish();
  await rest(fake, 'POST', '/repos/sam/sample-app/git/refs', {
    token: sam,
    body: { ref: 'refs/heads/elsewhere', sha: await head('sam/sample-app', 'main') },
  });
  await commitFile(sam, 'sam/sample-app', 'elsewhere', 'elsewhere.txt');

  const reply = await rest<{ errors: { field?: string }[] }>(fake, 'POST', `${UPSTREAM}/pulls`, {
    token: sam,
    body: { title: 'Elsewhere', head: 'sam:elsewhere', head_repo: 'sam/sample-app', base: 'main' },
  });
  const open = await rest<unknown[]>(fake, 'GET', `${UPSTREAM}/pulls?head=sam:elsewhere`);

  expect(reply.status).toBe(422);
  expect(reply.body.errors).toMatchObject([{ resource: 'PullRequest', code: 'invalid', field: 'head_repo' }]);
  expect(open.body).toEqual([]);
});

test("a commit to an open PR's branch moves the PR's head, as a push does", async () => {
  const { token } = await forkWithBranch('sam', 'moving');
  await commitFile(token, 'sam/goodfirsttoken', 'moving', 'first.txt');
  const pr = await rest<{ number: number }>(fake, 'POST', `${UPSTREAM}/pulls`, {
    token,
    body: { title: 'Moving', head: 'sam:moving', base: 'main' },
  });

  await commitFile(token, 'sam/goodfirsttoken', 'moving', 'second.txt');
  const read = await rest<{ head: { sha: string }; commits: number; changed_files: number }>(
    fake,
    'GET',
    `${UPSTREAM}/pulls/${String(pr.body.number)}`,
  );

  expect(read.body.head.sha).toBe(await head('sam/goodfirsttoken', 'moving'));
  expect(read.body).toMatchObject({ commits: 2, changed_files: 2 });
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

const REF = `query ($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { target { oid } } }
}`;

test("a new fork's git data answers 409 until GitHub finishes making it, and forking again meanwhile gives the same fork", async () => {
  const sam = fake.tokenFor('sam');
  const upstreamHead = await head('meanwhileso/goodfirsttoken', 'main');

  const forked = await rest<{ full_name: string }>(fake, 'POST', `${UPSTREAM}/forks`, { token: sam, body: {} });
  const again = await rest<{ full_name: string }>(fake, 'POST', `${UPSTREAM}/forks`, { token: sam, body: {} });
  const read = await rest<{ message: string }>(fake, 'GET', '/repos/sam/goodfirsttoken/git/ref/heads/main', { token: sam });
  const branch = await rest<{ message: string }>(fake, 'POST', '/repos/sam/goodfirsttoken/git/refs', {
    token: sam,
    body: { ref: 'refs/heads/early', sha: upstreamHead },
  });
  const ref = await graphql<{ repository: { ref: unknown } }>(fake, sam, REF, {
    owner: 'sam',
    name: 'goodfirsttoken',
    ref: 'refs/heads/main',
  });
  const commit = await graphql<CommitReply>(fake, sam, COMMIT, {
    input: {
      branch: { repositoryNameWithOwner: 'sam/goodfirsttoken', branchName: 'main' },
      expectedHeadOid: upstreamHead,
      message: { headline: 'Too early' },
      fileChanges: { additions: [{ path: 'early.txt', contents: toBase64('early') }] },
    },
  });
  const pull = await rest<{ errors: { field?: string }[] }>(fake, 'POST', `${UPSTREAM}/pulls`, {
    token: sam,
    body: { title: 'Too early', head: 'sam:main', base: 'main' },
  });

  expect([forked.status, again.status]).toEqual([202, 202]);
  expect(again.body.full_name).toBe(forked.body.full_name);
  expect([read.status, read.body.message]).toEqual([409, 'Git Repository is empty.']);
  expect([branch.status, branch.body.message]).toEqual([409, 'Git Repository is empty.']);
  expect(ref.body.data?.repository.ref).toBeNull();
  expect(commit.body.data?.createCommitOnBranch).toBeNull();
  expect(commit.body.errors?.[0]?.message).toBe('Git Repository is empty.');
  expect(pull.status).toBe(422);
  expect(pull.body.errors).toMatchObject([{ field: 'head' }]);

  forksFinish();
  const ready = await rest(fake, 'POST', '/repos/sam/goodfirsttoken/git/refs', {
    token: sam,
    body: { ref: 'refs/heads/later', sha: upstreamHead },
  });
  expect(ready.status).toBe(201);
  expect(await head('sam/goodfirsttoken', 'later')).toBe(upstreamHead);
});

test('someone without push access can make no branch in the repo, and commit nothing to it', async () => {
  const priya = fake.tokenFor('priya');
  const sha = await head('meanwhileso/goodfirsttoken', 'main');

  const branch = await rest(fake, 'POST', `${UPSTREAM}/git/refs`, { token: priya, body: { ref: 'refs/heads/priya-1', sha } });
  const commit = await graphql<CommitReply>(fake, priya, COMMIT, {
    input: {
      branch: { repositoryNameWithOwner: 'meanwhileso/goodfirsttoken', branchName: 'main' },
      expectedHeadOid: sha,
      message: { headline: 'Not mine to push' },
      fileChanges: { additions: [{ path: 'nope.txt', contents: toBase64('nope') }] },
    },
  });

  expect(branch.status).toBe(404);
  expect(commit.body.data?.createCommitOnBranch).toBeNull();
  expect(commit.body.errors).toEqual([expect.objectContaining({ type: 'FORBIDDEN' })]);
  expect(await head('meanwhileso/goodfirsttoken', 'main')).toBe(sha);
});

test('a change under .github/workflows/ needs the workflow scope, unless another branch has the same file', async () => {
  const { token } = await forkWithBranch('sam', 'ci');
  const scoped = fake.tokenFor('sam', ['public_repo', 'workflow']);
  const commitWorkflow = async (as: string, change: { contents: string } | { deleted: true }) =>
    graphql<CommitReply>(fake, as, COMMIT, {
      input: {
        branch: { repositoryNameWithOwner: 'sam/goodfirsttoken', branchName: 'ci' },
        expectedHeadOid: await head('sam/goodfirsttoken', 'ci'),
        message: { headline: 'Change CI' },
        fileChanges:
          'deleted' in change
            ? { deletions: [{ path: '.github/workflows/ci.yml' }] }
            : { additions: [{ path: '.github/workflows/ci.yml', contents: toBase64(change.contents) }] },
      },
    });

  const changed = await commitWorkflow(token, { contents: 'name: CI\non: [push]\n' });
  const deleted = await commitWorkflow(token, { deleted: true });
  // main has the file as it is, so it may go on another branch.
  const same = await commitWorkflow(token, { contents: 'name: CI\non: [pull_request]\n' });
  const withScope = await commitWorkflow(scoped, { contents: 'name: CI\non: [push]\n' });

  expect(changed.body.errors).toEqual([
    expect.objectContaining({
      type: 'FORBIDDEN',
      message: 'refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope',
    }),
  ]);
  expect(deleted.body.errors).toEqual([expect.objectContaining({ type: 'FORBIDDEN' })]);
  expect(same.body.errors).toBeUndefined();
  expect(withScope.body.errors).toBeUndefined();
});

test('a comparison lists the files a branch changed since a commit, with lines added and removed, and finds a fork branch by its owner', async () => {
  const { token, sha } = await forkWithBranch('sam', 'compare-me');
  await graphql(fake, token, COMMIT, {
    input: {
      branch: { repositoryNameWithOwner: 'sam/goodfirsttoken', branchName: 'compare-me' },
      expectedHeadOid: sha,
      message: { headline: 'Three changes' },
      fileChanges: {
        additions: [
          { path: 'README.md', contents: toBase64('# Good First Token\n\nSpend your spare tokens.\nOn open source.\n') },
          { path: 'NEW.md', contents: toBase64('one\ntwo\n') },
        ],
        deletions: [{ path: 'package.json' }],
      },
    },
  });

  const inFork = await rest<{ files: unknown[] }>(fake, 'GET', `/repos/sam/goodfirsttoken/compare/${sha}...compare-me`);
  const acrossForks = await rest<{ ahead_by: number }>(fake, 'GET', `${UPSTREAM}/compare/main...sam:compare-me`);
  const unknown = await rest(fake, 'GET', `/repos/sam/goodfirsttoken/compare/${sha}...no-such-branch`);

  expect(inFork.body).toMatchObject({ status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1 });
  expect(inFork.body.files).toMatchObject([
    { filename: 'NEW.md', status: 'added', additions: 2, deletions: 0 },
    { filename: 'README.md', status: 'modified', additions: 2, deletions: 1 },
    { filename: 'package.json', status: 'removed', additions: 0, deletions: 1 },
  ]);
  expect(acrossForks.body.ahead_by).toBe(1);
  expect(unknown.status).toBe(404);
});

test("a blob's content comes back in base64", async () => {
  const text = '# Good First Token\n\nSpend your spare tokens on open source.\n';
  const readme = await rest<{ sha: string }>(fake, 'GET', `${UPSTREAM}/contents/README.md`);

  const read = await rest<{ content: string; encoding: string; size: number }>(
    fake,
    'GET',
    `${UPSTREAM}/git/blobs/${readme.body.sha}`,
  );
  const missing = await rest(fake, 'GET', `${UPSTREAM}/git/blobs/${'0'.repeat(40)}`);

  expect(read.body.encoding).toBe('base64');
  expect(fromBase64(read.body.content)).toBe(text);
  expect(read.body.size).toBe(Buffer.byteLength(text));
  expect(missing.status).toBe(404);
});

const ENTRIES = `query ($owner: String!, $name: String!, $dir: String!, $sub: String!) {
  repository(owner: $owner, name: $name) {
    dir: object(expression: $dir) { ... on Tree { entries { name type mode oid size } } }
    sub: object(expression: $sub) { __typename }
  }
}`;

interface EntriesReply {
  repository: {
    dir: { entries: { name: string; type: string; mode: number; oid: string; size: number }[] } | null;
    sub: { __typename: string } | null;
  };
}

test("a tree gives each entry's mode, and createCommitOnBranch writes an addition as a plain file, whatever it was", async () => {
  const submodule = 'a'.repeat(40);
  fake.commitFiles(
    'meanwhileso/goodfirsttoken',
    { 'tools/run.sh': 'echo run\n', 'tools/latest': 'run.sh', 'tools/vendor': submodule, 'tools/notes.md': 'Notes.\n' },
    'octo-maintainer',
    { modes: { 'tools/run.sh': '100755', 'tools/latest': '120000', 'tools/vendor': '160000' } },
  );
  const { token } = await forkWithBranch('sam', 'modes');
  const read = async (ref: string) => {
    const reply = await graphql<EntriesReply>(fake, token, ENTRIES, {
      owner: 'sam',
      name: 'goodfirsttoken',
      dir: `${ref}:tools`,
      sub: `${ref}:tools/vendor`,
    });
    return reply.body.data?.repository;
  };
  const before = await read('modes');

  await graphql(fake, token, COMMIT, {
    input: {
      branch: { repositoryNameWithOwner: 'sam/goodfirsttoken', branchName: 'modes' },
      expectedHeadOid: await head('sam/goodfirsttoken', 'modes'),
      message: { headline: 'Write over the executable' },
      fileChanges: { additions: [{ path: 'tools/run.sh', contents: toBase64('echo walk\n') }], deletions: [{ path: 'tools/vendor' }] },
    },
  });
  const after = await read('modes');

  expect(before?.dir?.entries.map(({ name, type, mode }) => [name, type, mode])).toEqual([
    ['latest', 'blob', 0o120000],
    ['notes.md', 'blob', 0o100644],
    ['run.sh', 'blob', 0o100755],
    ['vendor', 'commit', 0o160000],
  ]);
  expect(before?.dir?.entries.find((entry) => entry.name === 'vendor')?.oid).toBe(submodule);
  // A submodule's commit is in another repo.
  expect(before?.sub).toBeNull();
  expect(after?.dir?.entries.map(({ name, mode }) => [name, mode])).toEqual([
    ['latest', 0o120000],
    ['notes.md', 0o100644],
    ['run.sh', 0o100644],
  ]);
});

test("Update branch merges the base branch into a PR's branch, in a merge commit by the person who clicked it", async () => {
  const { token } = await forkWithBranch('sam', 'behind');
  await commitFile(token, 'sam/goodfirsttoken', 'behind', 'mine.txt');
  const pr = await rest<{ number: number }>(fake, 'POST', `${UPSTREAM}/pulls`, {
    token,
    body: { title: 'Behind', head: 'sam:behind', base: 'main' },
  });
  const was = await head('sam/goodfirsttoken', 'behind');
  const main = fake.commitFiles('meanwhileso/goodfirsttoken', { 'theirs.txt': 'From main.\n' }, 'octo-maintainer');

  const merged = fake.updatePullRequestBranch('meanwhileso/goodfirsttoken', pr.body.number, 'octo-maintainer');
  // A maintainer commits a reviewer's suggestion to the PR's branch in the fork.
  const suggested = fake.commitFiles('sam/goodfirsttoken', { 'mine.txt': 'Suggested.\n' }, 'octo-maintainer', { branch: 'behind' });

  const commit = fake.state.objects[merged];
  expect(commit?.type === 'commit' && [commit.parents, commit.author.login]).toEqual([[was, main], 'octo-maintainer']);
  const read = await rest<{ head: { sha: string } }>(fake, 'GET', `${UPSTREAM}/pulls/${String(pr.body.number)}`);
  expect(read.body.head.sha).toBe(suggested);
  expect(await head('sam/goodfirsttoken', 'behind')).toBe(suggested);
  const file = async (path: string) =>
    (await rest<{ content: string }>(fake, 'GET', `/repos/sam/goodfirsttoken/contents/${path}?ref=behind`)).body.content;
  expect(fromBase64(await file('theirs.txt'))).toBe('From main.\n');
  expect(fromBase64(await file('mine.txt'))).toBe('Suggested.\n');
});
