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
  expect(reply.body.data?.b?.pullRequest).toEqual({ state: 'CLOSED', reviews: { totalCount: 0 } });
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
