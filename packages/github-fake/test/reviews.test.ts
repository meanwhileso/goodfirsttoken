import { beforeEach, expect, test } from 'vitest';
import { createGitHubFake, type GitHubFake } from '../src/index.ts';
import { graphql, rest } from './call.ts';

// A PR's author, reviews, and review comments through GraphQL, the way the
// PR job reads them, and a GitHub App's bot among the reviewers. The PRs
// and people are the sample data's, all made up.

let fake: GitHubFake;
let token: string;

beforeEach(() => {
  fake = createGitHubFake();
  token = fake.tokenFor('sam');
});

const REPO = 'meanwhileso/goodfirsttoken';
const UPSTREAM = `/repos/${REPO}`;

interface Actor {
  __typename: string;
  login: string;
}

interface Review {
  id: string;
  databaseId: number;
  author: Actor | null;
  body: string;
  state: string;
  url: string;
  submittedAt: string;
  comments: { totalCount: number; nodes: { id: string; author: Actor | null; body: string; path: string; url: string; createdAt: string }[] };
}

interface Pull {
  author: Actor | null;
  reviews: { totalCount: number; nodes: Review[]; pageInfo: { hasPreviousPage: boolean } };
}

const REVIEWS = `
  author { __typename login }
  reviews(%ARGS%) {
    totalCount
    pageInfo { hasPreviousPage }
    nodes {
      id databaseId body state url submittedAt
      author { __typename login }
      comments(first: 10) { totalCount nodes { id body path url createdAt author { __typename login } } }
    }
  }`;

async function readPull(number: number, args = 'first: 10'): Promise<Pull | null | undefined> {
  const reply = await graphql<{ repository: { pullRequest: Pull | null } }>(
    fake,
    token,
    `query ($n: Int!) { repository(owner: "meanwhileso", name: "goodfirsttoken") { pullRequest(number: $n) { ${REVIEWS.replace('%ARGS%', args)} } } }`,
    { n: number },
  );
  expect(reply.body.errors).toBeUndefined();
  return reply.body.data?.repository.pullRequest;
}

test("a PR's author, and its reviews with their comments, oldest first, with who wrote each and where to read it", async () => {
  fake.reviewPullRequest(REPO, 957, { login: 'kenji', state: 'COMMENTED', body: 'Could the stream close after an hour?' });

  const pull = await readPull(957);

  expect(pull?.author).toEqual({ __typename: 'User', login: 'priya' });
  expect(pull?.reviews.totalCount).toBe(2);
  const [first, second] = pull?.reviews.nodes ?? [];
  expect(first).toMatchObject({
    author: { __typename: 'User', login: 'octo-maintainer' },
    state: 'CHANGES_REQUESTED',
    body: 'Can the formatter skip events with an empty text field? Otherwise looks good.',
    comments: {
      totalCount: 1,
      nodes: [
        {
          author: { __typename: 'User', login: 'octo-maintainer' },
          body: 'This writes events with empty text too.',
          path: 'apps/web/src/feed/format.ts',
        },
      ],
    },
  });
  expect(second).toMatchObject({ author: { login: 'kenji' }, state: 'COMMENTED', comments: { totalCount: 0, nodes: [] } });
  expect(Date.parse(first?.submittedAt ?? '')).toBeLessThan(Date.parse(second?.submittedAt ?? ''));
  // The same review and comment as REST gives them, at the same links.
  const restReviews = await rest<{ id: number; node_id: string; html_url: string }[]>(fake, 'GET', `${UPSTREAM}/pulls/957/reviews`);
  const restComments = await rest<{ node_id: string; html_url: string }[]>(fake, 'GET', `${UPSTREAM}/pulls/957/comments`);
  expect(first).toMatchObject({ id: restReviews.body[0]?.node_id, databaseId: restReviews.body[0]?.id, url: restReviews.body[0]?.html_url });
  expect(first?.comments.nodes[0]).toMatchObject({ id: restComments.body[0]?.node_id, url: restComments.body[0]?.html_url });
});

test('last gives the newest reviews, still oldest first, and states picks the reviews by their verdict', async () => {
  for (const [i, state] of (['COMMENTED', 'APPROVED', 'COMMENTED'] as const).entries()) {
    fake.reviewPullRequest(REPO, 957, { login: 'kenji', state, body: `Review ${String(i + 1)}.` });
  }

  const newest = await readPull(957, 'last: 2');
  const approvals = await readPull(957, 'first: 10, states: [APPROVED]');

  expect(newest?.reviews.nodes.map((review) => review.body)).toEqual(['Review 2.', 'Review 3.']);
  expect(newest?.reviews).toMatchObject({ totalCount: 4, pageInfo: { hasPreviousPage: true } });
  expect(approvals?.reviews.nodes.map((review) => review.body)).toEqual(['Review 2.']);
});

test("a GitHub App's review names a Bot, by the login GraphQL gives it, and REST gives its login with [bot]", async () => {
  fake.reviewPullRequest(REPO, 957, {
    login: 'sample-ci[bot]',
    state: 'COMMENTED',
    body: 'Coverage went down.',
    comments: [{ path: 'apps/web/src/feed/format.ts', line: 1, body: 'Not covered.' }],
  });

  const pull = await readPull(957);
  const reviews = await rest<{ user: { login: string; type: string } }[]>(fake, 'GET', `${UPSTREAM}/pulls/957/reviews`);

  const bot = pull?.reviews.nodes[1];
  expect(bot?.author).toEqual({ __typename: 'Bot', login: 'sample-ci' });
  expect(bot?.comments.nodes[0]?.author).toEqual({ __typename: 'Bot', login: 'sample-ci' });
  expect(reviews.body[1]?.user).toMatchObject({ login: 'sample-ci[bot]', type: 'Bot' });
  expect(() => fake.tokenFor('sample-ci[bot]')).toThrow('Tokens belong to people.');
});

test('a merged PR and one closed without merging keep their reviews, and read as merged and closed', async () => {
  fake.mergePullRequest(REPO, 957, 'octo-maintainer');
  fake.closePullRequest(REPO, 958, 'octo-maintainer');

  const reply = await graphql<Record<string, { pullRequest: { state: string; reviews: { totalCount: number } } }>>(
    fake,
    token,
    `query {
      a: repository(owner: "meanwhileso", name: "goodfirsttoken") { pullRequest(number: 957) { state reviews(first: 5) { totalCount } } }
      b: repository(owner: "meanwhileso", name: "goodfirsttoken") { pullRequest(number: 958) { state reviews(first: 5) { totalCount } } }
    }`,
  );

  expect(reply.body.data?.a?.pullRequest).toEqual({ state: 'MERGED', reviews: { totalCount: 1 } });
  expect(reply.body.data?.b?.pullRequest).toEqual({ state: 'CLOSED', reviews: { totalCount: 1 } });
});

test('a connection takes first or last, and refuses both at once, as GitHub does', async () => {
  const reply = await graphql(
    fake,
    token,
    'query { repository(owner: "meanwhileso", name: "goodfirsttoken") { pullRequest(number: 957) { reviews(first: 1, last: 1) { totalCount } } } }',
  );

  expect(reply.body.errors).toMatchObject([
    { message: 'Passing both `first` and `last` to paginate the `reviews` connection is not supported.' },
  ]);
});

test("each review and comment says how its author relates to the repo, as GitHub's authorAssociation does", async () => {
  const org = fake.state.accounts.meanwhileso;
  if (!org) throw new Error('no meanwhileso');
  org.members = ['lena'];
  const comments = [{ path: 'README.md', line: 1, body: 'A note.' }];
  for (const login of ['lena', 'kenji', 'ines', 'sam']) {
    fake.reviewPullRequest(REPO, 958, { login, state: 'COMMENTED', body: `From ${login}.`, comments });
  }

  const reply = await graphql<{
    repository: { pullRequest: { reviews: { nodes: { authorAssociation: string; comments: { nodes: { authorAssociation: string }[] } }[] } } };
  }>(
    fake,
    token,
    'query { repository(owner: "meanwhileso", name: "goodfirsttoken") { pullRequest(number: 958) { reviews(first: 10) { nodes { authorAssociation comments(first: 1) { nodes { authorAssociation } } } } } } }',
  );
  const reviews = await rest<{ author_association: string }[]>(fake, 'GET', `${UPSTREAM}/pulls/958/reviews`);

  // The sample PR's bot, then a member of the organization that owns the
  // repo, a collaborator, someone whose PR merged there, and someone with
  // none of those.
  const expected = ['NONE', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE'];
  const nodes = reply.body.data?.repository.pullRequest.reviews.nodes ?? [];
  expect(nodes.map((n) => n.authorAssociation)).toEqual(expected);
  expect(nodes.map((n) => n.comments.nodes[0]?.authorAssociation)).toEqual(expected);
  expect(reviews.body.map((r) => r.author_association)).toEqual(expected);
});

test('a pending review and its comments show only to its author, and a dismissed one shows to everyone as dismissed', async () => {
  const comments = [{ path: 'README.md', line: 1, body: 'Draft note.' }];
  fake.reviewPullRequest(REPO, 958, { login: 'octo-maintainer', state: 'PENDING', body: 'Not sent yet.', comments });
  const dismissed = fake.reviewPullRequest(REPO, 958, { login: 'kenji', state: 'CHANGES_REQUESTED', body: 'Undo this.', comments });
  fake.dismissReview(REPO, 958, dismissed);
  const read = async (as: string) => {
    const asToken = fake.tokenFor(as);
    const reply = await graphql<{ repository: { pullRequest: { reviews: { nodes: { state: string; body: string; submittedAt: string | null }[] } } } }>(
      fake,
      asToken,
      'query { repository(owner: "meanwhileso", name: "goodfirsttoken") { pullRequest(number: 958) { reviews(first: 10) { nodes { state body submittedAt } } } } }',
    );
    const lineComments = await rest<{ body: string }[]>(fake, 'GET', `${UPSTREAM}/pulls/958/comments`, { token: asToken });
    return { reviews: reply.body.data?.repository.pullRequest.reviews.nodes ?? [], comments: lineComments.body.map((c) => c.body) };
  };

  const byAuthor = await read('octo-maintainer');
  const byOthers = await read('sam');

  // The sample PR's bot review shows to everyone, with its comment.
  const bot = { state: 'COMMENTED', body: 'Found one problem in 2 files.' };
  const botComment = 'This list has no tab for OpenCode.';
  expect(byAuthor.reviews).toMatchObject([
    bot,
    { state: 'PENDING', body: 'Not sent yet.', submittedAt: null },
    { state: 'DISMISSED', body: 'Undo this.' },
  ]);
  expect(byAuthor.comments).toEqual([botComment, 'Draft note.', 'Draft note.']);
  expect(byOthers.reviews).toMatchObject([bot, { state: 'DISMISSED', body: 'Undo this.' }]);
  expect(byOthers.comments).toEqual([botComment, 'Draft note.']);
});

test('a review says whether its author can push to the repo, from their role there, whatever GitHub names them', async () => {
  const org = fake.state.accounts.meanwhileso;
  const repo = fake.state.repos[REPO];
  if (!org || !repo) throw new Error('no meanwhileso/goodfirsttoken');
  // lena's membership of the organization is public, and gives her no role
  // on the repo. priya's is private, and she can push through a team. ines
  // is a collaborator who can only read.
  org.members = ['lena'];
  org.privateMembers = ['priya'];
  repo.teamRoles = { priya: 'write' };
  repo.collaborators.ines = 'read';
  for (const login of ['octo-maintainer', 'kenji', 'priya', 'lena', 'ines', 'sam']) {
    fake.reviewPullRequest(REPO, 958, { login, state: 'COMMENTED', body: `From ${login}.` });
  }

  const reply = await graphql<{
    repository: { pullRequest: { reviews: { nodes: { author: Actor; authorAssociation: string; authorCanPushToRepository: boolean }[] } } };
  }>(
    fake,
    token,
    'query { repository(owner: "meanwhileso", name: "goodfirsttoken") { pullRequest(number: 958) { reviews(first: 10) { nodes { author { __typename login } authorAssociation authorCanPushToRepository } } } } }',
  );

  expect(reply.body.errors).toBeUndefined();
  const nodes = reply.body.data?.repository.pullRequest.reviews.nodes ?? [];
  expect(nodes.map((n) => [n.author.login, n.authorAssociation, n.authorCanPushToRepository])).toEqual([
    // The sample PR's bot, which has no role on the repo.
    ['sample-ci', 'NONE', false],
    ['octo-maintainer', 'COLLABORATOR', true],
    ['kenji', 'COLLABORATOR', true],
    ['priya', 'NONE', true],
    ['lena', 'MEMBER', false],
    ['ines', 'COLLABORATOR', false],
    ['sam', 'NONE', false],
  ]);
});

test('a member whose membership of the organization is private reads as a member only to another member', async () => {
  const org = fake.state.accounts.meanwhileso;
  if (!org) throw new Error('no meanwhileso');
  org.members = ['lena'];
  org.privateMembers = ['priya', 'ines'];
  fake.reviewPullRequest(REPO, 958, { login: 'priya', state: 'COMMENTED', body: 'From priya.' });
  const read = async (as: string) => {
    const asToken = fake.tokenFor(as);
    const reply = await rest<{ author_association: string }[]>(fake, 'GET', `${UPSTREAM}/pulls/958/reviews`, { token: asToken });
    const query = await graphql<{ repository: { pullRequest: { reviews: { nodes: { authorAssociation: string }[] } } } }>(
      fake,
      asToken,
      'query { repository(owner: "meanwhileso", name: "goodfirsttoken") { pullRequest(number: 958) { reviews(first: 10) { nodes { authorAssociation } } } } }',
    );
    return [reply.body.map((r) => r.author_association), query.body.data?.repository.pullRequest.reviews.nodes.map((n) => n.authorAssociation)];
  };
  const anonymous = await rest<{ author_association: string }[]>(fake, 'GET', `${UPSTREAM}/pulls/958/reviews`);

  // A public member and a private one see her as a member, and anyone else
  // doesn't. The sample PR's bot review comes first.
  expect(await read('lena')).toEqual([['NONE', 'MEMBER'], ['NONE', 'MEMBER']]);
  expect(await read('ines')).toEqual([['NONE', 'MEMBER'], ['NONE', 'MEMBER']]);
  expect(await read('sam')).toEqual([['NONE', 'NONE'], ['NONE', 'NONE']]);
  expect(anonymous.body.map((r) => r.author_association)).toEqual(['NONE', 'NONE']);
});

interface Conversation {
  comments: { totalCount: number; nodes: { id: string; body: string; url: string; createdAt: string; author: Actor | null }[] };
}

async function readConversation(number: number, args: string): Promise<Conversation | undefined> {
  const reply = await graphql<{ repository: { pullRequest: Conversation } }>(
    fake,
    token,
    `query ($n: Int!) { repository(owner: "meanwhileso", name: "goodfirsttoken") { pullRequest(number: $n) {
      comments(${args}) { totalCount nodes { id body url createdAt author { __typename login } } }
    } } }`,
    { n: number },
  );
  expect(reply.body.errors).toBeUndefined();
  return reply.body.data?.repository.pullRequest;
}

test("a PR's conversation comments, oldest first, by people and by a GitHub App's bot, and last gives the newest", async () => {
  const id = fake.commentOnIssue(REPO, 958, { by: 'kenji', body: 'Works for me.' });

  const all = await readConversation(958, 'first: 10');
  const newest = await readConversation(958, 'last: 2');

  // The sample PR has a bot's comment, a maintainer's, and one from someone with no role on the repo.
  expect(all?.comments.totalCount).toBe(4);
  expect(all?.comments.nodes.map((c) => [c.author?.__typename, c.author?.login, c.body])).toEqual([
    ['Bot', 'sample-ci', 'Coverage: 81% (no change).'],
    ['User', 'octo-maintainer', 'Thanks. Could the Cursor tab come after Codex?'],
    ['User', 'sam', 'Could this add a Zed tab too?'],
    ['User', 'kenji', 'Works for me.'],
  ]);
  expect(all?.comments.nodes[3]?.url).toBe(`${fake.webUrl}/${REPO}/pull/958#issuecomment-${String(id)}`);
  expect(newest?.comments.nodes.map((c) => c.author?.login)).toEqual(['sam', 'kenji']);
});

interface Head {
  headRefOid: string;
  baseRefOid: string;
  mergeable: string;
  commits: {
    nodes: {
      commit: {
        oid: string;
        statusCheckRollup: {
          state: string;
          contexts: { totalCount: number; nodes: ({ __typename: 'CheckRun'; name: string; status: string; conclusion: string | null } | { __typename: 'StatusContext'; context: string; state: string })[] };
        } | null;
      };
    }[];
  };
}

async function readHead(number: number): Promise<Head | undefined> {
  const reply = await graphql<{ repository: { pullRequest: Head } }>(
    fake,
    token,
    `query ($n: Int!) { repository(owner: "meanwhileso", name: "goodfirsttoken") { pullRequest(number: $n) {
      headRefOid baseRefOid mergeable
      commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { totalCount nodes {
        __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state }
      } } } } } }
    } } }`,
    { n: number },
  );
  expect(reply.body.errors).toBeUndefined();
  return reply.body.data?.repository.pullRequest;
}

test("the checks on a PR's head, together and one by one, and none on a new head until they run", async () => {
  fake.addCheck(REPO, 958, { type: 'StatusContext', name: 'ci/docs', state: 'PENDING' });
  const failing = await readHead(958);
  const head = failing?.headRefOid ?? '';
  fake.addCheck(REPO, 958, { type: 'CheckRun', name: 'test', conclusion: null });
  fake.addCheck(REPO, 958, { type: 'StatusContext', name: 'ci/docs', state: 'SUCCESS' });
  const running = await readHead(958);
  fake.addCheck(REPO, 958, { type: 'CheckRun', name: 'test', conclusion: 'SUCCESS' });
  const passing = await readHead(958);
  fake.commitFiles(`arjun/goodfirsttoken`, { 'README.md': 'Cursor too.\n' }, 'arjun', { branch: 'cursor-tab' });
  const pushed = await readHead(958);

  expect(failing?.commits.nodes[0]?.commit.oid).toBe(head);
  expect(failing?.commits.nodes[0]?.commit.statusCheckRollup).toEqual({
    state: 'FAILURE',
    contexts: {
      totalCount: 3,
      nodes: [
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'StatusContext', context: 'ci/docs', state: 'PENDING' },
      ],
    },
  });
  expect(running?.commits.nodes[0]?.commit.statusCheckRollup?.state).toBe('PENDING');
  expect(passing?.commits.nodes[0]?.commit.statusCheckRollup?.state).toBe('SUCCESS');
  expect(pushed?.headRefOid).not.toBe(head);
  expect(pushed?.commits.nodes[0]?.commit).toEqual({ oid: pushed?.headRefOid, statusCheckRollup: null });
});

test('a PR conflicts when its base changed a file it changed, merges once the base is merged into it, and can read as unknown', async () => {
  const conflicting = await readHead(958);
  const base = fake.state.repos[REPO]?.branches.main;
  fake.updatePullRequestBranch(REPO, 958, 'arjun');
  const updated = await readHead(958);
  fake.setMergeable(REPO, 958, 'UNKNOWN');
  const unknown = await readHead(958);
  fake.setMergeable(REPO, 958, null);

  expect(conflicting).toMatchObject({ mergeable: 'CONFLICTING', baseRefOid: base });
  expect(updated?.mergeable).toBe('MERGEABLE');
  expect(unknown?.mergeable).toBe('UNKNOWN');
  expect((await readHead(958))?.mergeable).toBe('MERGEABLE');
});
