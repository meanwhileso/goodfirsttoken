import { beforeEach, expect, test } from 'vitest';
import { createGitHubFake, type GitHubFake } from '../src/index.ts';
import { graphql, rest } from './call.ts';

// How an issue shows the pull requests linked to it: GraphQL's
// closedByPullRequestsReferences for a closing keyword, and the timeline's
// cross-referenced events for any mention. The helpers that change issues
// and open PRs, the way people do on GitHub, are here too.
// https://docs.github.com/en/graphql/reference/issues#object-issue
// https://docs.github.com/en/rest/issues/timeline
// https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue

let fake: GitHubFake;
let token: string;
const REPO = 'meanwhileso/goodfirsttoken';

beforeEach(() => {
  fake = createGitHubFake();
  token = fake.tokenFor('lena');
});

interface Pull {
  number: number;
  state: string;
  url: string;
  repository: { nameWithOwner: string };
}

interface ClosedBy {
  repository: { issue: { closedByPullRequestsReferences: { totalCount: number; nodes: Pull[] } } | null };
}

const CLOSED_BY = `query ($number: Int!, $closed: Boolean) {
  repository(owner: "meanwhileso", name: "goodfirsttoken") {
    issue(number: $number) {
      closedByPullRequestsReferences(first: 10, includeClosedPrs: $closed) {
        totalCount
        nodes { number state url repository { nameWithOwner } }
      }
    }
  }
}`;

async function closedBy(number: number, closed = false) {
  const reply = await graphql<ClosedBy>(fake, token, CLOSED_BY, { number, closed });
  return reply.body.data?.repository.issue?.closedByPullRequestsReferences.nodes.map((pr) => [pr.number, pr.state]);
}

test("an issue lists the open PRs whose description closes it, and the PR's repo and link", async () => {
  const reply = await graphql<ClosedBy>(fake, token, CLOSED_BY, { number: 918 });

  // PR 957 says "Closes #918".
  expect(reply.body.errors).toBeUndefined();
  expect(reply.body.data?.repository.issue?.closedByPullRequestsReferences).toEqual({
    totalCount: 1,
    nodes: [
      {
        number: 957,
        state: 'OPEN',
        url: `${fake.webUrl}/${REPO}/pull/957`,
        repository: { nameWithOwner: REPO },
      },
    ],
  });
});

test('a PR that only mentions the issue, or aims at another branch, is no closing reference, and both show on the timeline', async () => {
  const mention = fake.openPullRequest(REPO, { title: 'Tidy the lanes', body: 'See #912 for context.', by: 'priya' });
  const offDefault = fake.openPullRequest(REPO, {
    title: 'Backport the lanes',
    body: 'Fixes #912',
    by: 'kenji',
    base: 'release',
  });

  const timeline = await rest<{ event: string; source?: { issue: { number: number; pull_request?: object } } }[]>(
    fake,
    'GET',
    `/repos/${REPO}/issues/912/timeline`,
  );

  expect(await closedBy(912)).toEqual([]);
  expect(
    timeline.body.filter((e) => e.event === 'cross-referenced').map((e) => [e.source?.issue.number, 'pull_request' in (e.source?.issue ?? {})]),
  ).toEqual([
    [mention, true],
    [offDefault, true],
  ]);
});

test('a PR that closes an issue in another repo is listed on that issue', async () => {
  const fixed = fake.openPullRequest('sample-owner/sample-app', {
    title: 'Name the agent in the lanes',
    body: 'Closes meanwhileso/goodfirsttoken#912',
    by: 'sample-maintainer',
  });

  const reply = await graphql<ClosedBy>(fake, token, CLOSED_BY, { number: 912 });

  expect(reply.body.data?.repository.issue?.closedByPullRequestsReferences.nodes).toEqual([
    expect.objectContaining({ number: fixed, repository: { nameWithOwner: 'sample-owner/sample-app' } }),
  ]);
});

test('a closed or merged PR is left out, unless includeClosedPrs asks for it', async () => {
  fake.closePullRequest(REPO, 958, 'octo-maintainer');
  fake.mergePullRequest(REPO, 957, 'octo-maintainer');

  expect(await closedBy(925)).toEqual([]);
  expect(await closedBy(925, true)).toEqual([[958, 'CLOSED']]);
  expect(await closedBy(918, true)).toEqual([[957, 'MERGED']]);
});

test('a PR closed without merging opens again, as open with no close time, and closes its issue again, and a merged one never does', async () => {
  fake.closePullRequest(REPO, 958, 'octo-maintainer');
  fake.mergePullRequest(REPO, 957, 'octo-maintainer');
  const closed = await closedBy(925);

  fake.reopenPullRequest(REPO, 958, 'arjun');
  const reply = await graphql<{ repository: { pullRequest: { state: string; closedAt: string | null } } }>(
    fake,
    token,
    '{ repository(owner: "meanwhileso", name: "goodfirsttoken") { pullRequest(number: 958) { state closedAt } } }',
  );
  const issue = await rest<{ state: string; state_reason: string | null; closed_at: string | null }>(fake, 'GET', `/repos/${REPO}/issues/958`);

  expect(closed).toEqual([]);
  expect(await closedBy(925)).toEqual([[958, 'OPEN']]);
  expect(reply.body.data?.repository.pullRequest).toEqual({ state: 'OPEN', closedAt: null });
  expect(issue.body).toMatchObject({ state: 'open', state_reason: 'reopened', closed_at: null });
  expect(() => {
    fake.reopenPullRequest(REPO, 957, 'octo-maintainer');
  }).toThrow();
});

test('a pull request reads as open, merged, or closed, with its times', async () => {
  fake.closePullRequest(REPO, 958, 'octo-maintainer');
  const reply = await graphql<Record<string, { pullRequest: { state: string; merged: boolean; mergedAt: string | null; closedAt: string | null } | null }>>(
    fake,
    token,
    `{
      a: repository(owner: "meanwhileso", name: "goodfirsttoken") { pullRequest(number: 957) { state merged mergedAt closedAt } }
      b: repository(owner: "meanwhileso", name: "goodfirsttoken") { pullRequest(number: 952) { state merged mergedAt closedAt } }
      c: repository(owner: "meanwhileso", name: "goodfirsttoken") { pullRequest(number: 958) { state merged mergedAt closedAt } }
    }`,
  );

  expect(reply.body.data?.a?.pullRequest).toEqual({ state: 'OPEN', merged: false, mergedAt: null, closedAt: null });
  expect(reply.body.data?.b?.pullRequest).toMatchObject({ state: 'MERGED', merged: true });
  expect(Date.parse(reply.body.data?.b?.pullRequest?.mergedAt ?? '')).toBeLessThan(Date.now());
  expect(reply.body.data?.c?.pullRequest).toMatchObject({ state: 'CLOSED', merged: false, mergedAt: null });
  expect(reply.body.data?.c?.pullRequest?.closedAt).not.toBeNull();
});

test("an issue's number is no pull request, and a pull request's is no issue", async () => {
  const reply = await graphql<{ repository: { issue: unknown; pullRequest: unknown } }>(
    fake,
    token,
    '{ repository(owner: "meanwhileso", name: "goodfirsttoken") { issue(number: 957) { number } pullRequest(number: 918) { number } } }',
  );

  expect(reply.body.data?.repository).toEqual({ issue: null, pullRequest: null });
  expect(reply.body.errors).toMatchObject([
    { type: 'NOT_FOUND', path: ['repository', 'issue'], message: 'Could not resolve to an Issue with the number of 957.' },
    { type: 'NOT_FOUND', path: ['repository', 'pullRequest'], message: 'Could not resolve to a PullRequest with the number of 918.' },
  ]);
});

test('the list of closing PRs has to be paged with first, at most 100, as on GitHub', async () => {
  const query = (first: string) =>
    `{ repository(owner: "meanwhileso", name: "goodfirsttoken") { issue(number: 918) { closedByPullRequestsReferences${first} { totalCount } } } }`;

  const none = await graphql(fake, token, query(''));
  const tooMany = await graphql(fake, token, query('(first: 101)'));

  expect(none.body.errors).toMatchObject([{ type: 'MISSING_PAGINATION_BOUNDARIES' }]);
  expect(tooMany.body.errors).toMatchObject([{ type: 'EXCESSIVE_PAGINATION' }]);
});

test('a test can open, label, assign, and close an issue, and the issue lists and timeline follow', async () => {
  const number = fake.openIssue(REPO, { title: 'Sort the wall by time', labels: ['goodfirsttoken'], by: 'octo-maintainer' });
  const tagged = () =>
    rest<{ number: number }[]>(fake, 'GET', `/repos/${REPO}/issues?labels=goodfirsttoken,ready&assignee=none`);

  const before = await tagged();
  fake.labelIssue(REPO, number, 'ready', 'octo-maintainer');
  const labeled = await tagged();
  fake.assignIssue(REPO, number, 'kenji', 'octo-maintainer');
  const assigned = await tagged();
  fake.closeIssue(REPO, number, 'octo-maintainer');
  const issue = await rest<{ state: string; labels: { name: string }[] }>(fake, 'GET', `/repos/${REPO}/issues/${String(number)}`);
  const timeline = await rest<{ event: string }[]>(fake, 'GET', `/repos/${REPO}/issues/${String(number)}/timeline`);

  expect(before.body.map((i) => i.number)).toEqual([]);
  expect(labeled.body.map((i) => i.number)).toEqual([number]);
  expect(assigned.body.map((i) => i.number)).toEqual([]);
  expect(issue.body.state).toBe('closed');
  // A label the repo lacked is made, so the issue shows it.
  expect(issue.body.labels.map((l) => l.name)).toEqual(['goodfirsttoken', 'ready']);
  expect(timeline.body.map((e) => e.event)).toEqual(['labeled', 'labeled', 'assigned', 'closed']);
});

test('a test can take a label off an issue, and the issue lists and timeline follow', async () => {
  const number = fake.openIssue(REPO, { title: 'Sort the wall by time', labels: ['goodfirsttoken', 'ready'], by: 'octo-maintainer' });
  const tagged = () => rest<{ number: number }[]>(fake, 'GET', `/repos/${REPO}/issues?labels=goodfirsttoken&assignee=none`);

  const before = await tagged();
  fake.unlabelIssue(REPO, number, 'GoodFirstToken', 'octo-maintainer');
  const after = await tagged();
  const issue = await rest<{ labels: { name: string }[] }>(fake, 'GET', `/repos/${REPO}/issues/${String(number)}`);
  const timeline = await rest<{ event: string; label?: { name: string } }[]>(fake, 'GET', `/repos/${REPO}/issues/${String(number)}/timeline`);

  expect(before.body.map((i) => i.number)).toContain(number);
  expect(after.body.map((i) => i.number)).not.toContain(number);
  expect(issue.body.labels.map((l) => l.name)).toEqual(['ready']);
  expect(timeline.body.at(-1)).toMatchObject({ event: 'unlabeled', label: { name: 'goodfirsttoken' } });
});

test('a PR a test opens comes from a branch for someone with push access, and from a fork for anyone else', async () => {
  const fromBranch = fake.openPullRequest(REPO, { title: 'Branch work', body: 'Closes #921', by: 'kenji' });
  const fromFork = fake.openPullRequest(REPO, { title: 'Fork work', body: 'Closes #921', by: 'sam' });

  const pulls = await rest<{ number: number; head: { repo: { full_name: string } }; user: { login: string } }[]>(
    fake,
    'GET',
    `/repos/${REPO}/pulls`,
  );
  const heads = new Map(pulls.body.map((p) => [p.number, [p.head.repo.full_name, p.user.login]]));

  expect(heads.get(fromBranch)).toEqual([REPO, 'kenji']);
  expect(heads.get(fromFork)).toEqual(['sam/goodfirsttoken', 'sam']);
  expect(await closedBy(921)).toEqual([
    [fromBranch, 'OPEN'],
    [fromFork, 'OPEN'],
  ]);
});
