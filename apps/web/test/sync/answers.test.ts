import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { addPr, getPr, getProject, saveClaim } from '../../src/db';
import { syncTaggedIssues } from '../../src/sync/issues';
import { followPrs } from '../../src/sync/prs';
import { ALLOWANCES } from '../../src/sync/scheduled';
import { startGitHub } from '../auth/helpers';
import { db, emptyDatabase, maintainer, priya, registeredProject, sha, signIn } from '../db/helpers';
import { freshNumbers, jobDeps } from './helpers';
import { newClaim } from '@goodfirsttoken/core';

// How the jobs read GitHub's answers when they aren't the ones they asked
// for: rate limits GitHub gives in its other forms, errors of GitHub's own,
// answers that don't come from GitHub at all, and no answer. None of them
// may pause a project. The projects, issues, and PRs here are made up, in
// the GitHub fake's sample repos.

const APP = 'sample-owner/sample-app';
const TOOLS = 'sample-owner/sample-tools';
const BY = 'sample-maintainer';

let github: GitHubFake;

beforeEach(async () => {
  await emptyDatabase();
  await signIn(maintainer, priya);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  github = startGitHub();
  freshNumbers(github, APP);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Answer = (request: Request) => Response | Promise<Response> | null;

/**
 * Stands in for GitHub. A request `answer` gives a response for gets that
 * response, and every other request goes to the fake. Returns the paths it
 * answered.
 */
function answering(answer: Answer): string[] {
  const answered: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const own = await answer(new Request(request.url, { method: request.method, headers: request.headers }));
    if (own === null) return github.fetch(request);
    answered.push(new URL(request.url).pathname);
    return own;
  });
  return answered;
}

const isRepoRead = (request: Request) => /^\/repos\/[^/]+\/[^/]+$/.test(new URL(request.url).pathname);
const isGraphQL = (request: Request) => new URL(request.url).pathname.endsWith('/graphql');

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** What GitHub sends with a call while most of the hour's budget is left. */
const plentyLeft = {
  'x-ratelimit-limit': '5000',
  'x-ratelimit-remaining': '4990',
  'x-ratelimit-used': '10',
  'x-ratelimit-reset': '4102444800',
  'x-ratelimit-resource': 'core',
};

// https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits
const SECONDARY = 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.';

function sync() {
  return syncTaggedIssues(jobDeps(github));
}

async function projects() {
  await registeredProject();
  await registeredProject({ tags: ['help wanted'] }, TOOLS);
}

async function statuses() {
  return [(await getProject(db, APP))?.status, (await getProject(db, TOOLS))?.status];
}

/** A claim on a new issue in sample-app whose PR closed on GitHub, for the PR job to find. */
async function closedClaimPr(): Promise<string> {
  await registeredProject();
  const issue = github.openIssue(APP, { title: 'Keep the hash in rewrites', labels: ['help wanted'], by: BY });
  const number = github.openPullRequest(APP, { title: 'Keep the hash', body: `Closes #${String(issue)}`, by: 'priya' });
  github.closePullRequest(APP, number, BY);
  const pr = { repo: APP, number, url: `${github.webUrl}/${APP}/pull/${String(number)}` };
  const now = Date.now();
  await saveClaim(
    db,
    {
      id: 'c_answers',
      issue: `${APP}#${String(issue)}`,
      project: APP,
      githubId: priya.githubId,
      login: priya.login,
      agent: 'claude-code',
      ownProject: false,
      startCommit: sha,
      tokenEstimate: null,
      ...newClaim(now - 60_000),
      state: 'pr_opened',
      submittedAt: now - 30_000,
      pr,
    },
    1,
  );
  await addPr(db, { claimId: 'c_answers', pr, openedAt: now - 30_000 });
  return 'c_answers';
}

describe('rate limits in their other forms', () => {
  test('a secondary rate limit, a 403 with budget left and no wait given, stops the sync', async () => {
    await projects();
    const answered = answering((request) => (isRepoRead(request) ? json(403, { message: SECONDARY }, plentyLeft) : null));

    const run = await sync();

    expect(run.stopped).toBe('rate_limited');
    expect(answered).toHaveLength(1);
    expect(await statuses()).toEqual(['approved', 'approved']);
  });

  test('a 403 for a primary limit spent since the run began stops the sync', async () => {
    await projects();
    answering((request) =>
      isRepoRead(request)
        ? json(403, { message: 'API rate limit exceeded for user ID 1.' }, { ...plentyLeft, 'x-ratelimit-remaining': '0' })
        : null,
    );

    const run = await sync();

    expect(run.stopped).toBe('rate_limited');
    expect(await statuses()).toEqual(['approved', 'approved']);
  });

  test('a 429 with no headers stops the sync', async () => {
    await projects();
    answering((request) => (isRepoRead(request) ? new Response('', { status: 429 }) : null));

    const run = await sync();

    expect(run.stopped).toBe('rate_limited');
    expect(await statuses()).toEqual(['approved', 'approved']);
  });

  test('a 403 that says to wait, with retry-after, stops the sync, whatever its message', async () => {
    await projects();
    answering((request) =>
      isRepoRead(request) ? json(403, { message: 'Forbidden' }, { ...plentyLeft, 'retry-after': '60' }) : null,
    );

    const run = await sync();

    expect(run.stopped).toBe('rate_limited');
    expect(await statuses()).toEqual(['approved', 'approved']);
  });

  test('a rate limit on a query stops the PR job, which ends without an error, as a 403 or as a 200 with an error', async () => {
    const claimId = await closedClaimPr();
    answering((request) => (isGraphQL(request) ? json(403, { message: SECONDARY }) : null));

    const forbidden = await followPrs(jobDeps(github, ALLOWANCES.prs));
    answering((request) => (isGraphQL(request) ? json(200, { errors: [{ message: SECONDARY }] }) : null));
    const secondaryInBody = await followPrs(jobDeps(github, ALLOWANCES.prs));
    const primary = { type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' };
    answering((request) => (isGraphQL(request) ? json(200, { errors: [primary] }) : null));
    const primaryInBody = await followPrs(jobDeps(github, ALLOWANCES.prs));

    expect([forbidden.stopped, secondaryInBody.stopped, primaryInBody.stopped]).toEqual([
      'rate_limited',
      'rate_limited',
      'rate_limited',
    ]);
    expect(await getPr(db, claimId)).toMatchObject({ state: 'open' });
  });

  test('any other refusal of the query stops the PR job, which ends without an error', async () => {
    const claimId = await closedClaimPr();
    answering((request) => (isGraphQL(request) ? json(422, { message: 'Unprocessable Entity' }) : null));

    const run = await followPrs(jobDeps(github, ALLOWANCES.prs));

    expect(run.stopped).toBe('github_error');
    expect(await getPr(db, claimId)).toMatchObject({ state: 'open' });
  });
});

describe("answers that aren't GitHub's", () => {
  test('an API that answers every call with an HTML 404 pauses no project, and the run stops', async () => {
    await projects();
    answering(() => new Response('<html>Not Found</html>', { status: 404, headers: { 'content-type': 'text/html' } }));

    const run = await sync();

    expect(run.stopped).toBe('github_error');
    expect(run.paused).toEqual([]);
    expect(await statuses()).toEqual(['approved', 'approved']);
  });

  test("a run first asks GitHub for its rate limit, which costs nothing, and stops before any other call when the answer isn't GitHub's", async () => {
    await projects();
    const answered = answering((request) =>
      new URL(request.url).pathname.endsWith('/rate_limit') ? json(200, { ok: true }) : null,
    );

    const run = await sync();

    expect(run.stopped).toBe('github_error');
    expect(answered).toEqual(['/rate_limit']);
    expect(github.calls).toEqual([]);
  });

  test("a repo read that isn't GitHub's 404 pauses nothing, and the run stops", async () => {
    await projects();
    answering((request) => (isRepoRead(request) ? new Response('Not Found', { status: 404 }) : null));

    const run = await sync();

    expect(run.stopped).toBe('github_error');
    expect(await statuses()).toEqual(['approved', 'approved']);
  });

  test("a repo read answered without the fields GitHub sends pauses nothing, whatever it says, and the run stops", async () => {
    await projects();
    answering((request) => (isRepoRead(request) ? json(200, { private: true, archived: true }, plentyLeft) : null));

    const run = await sync();

    expect(run.stopped).toBe('github_error');
    expect(await statuses()).toEqual(['approved', 'approved']);
  });

  test("a repo read GitHub refuses for another reason, like a 403 that isn't a rate limit, pauses nothing, and the run goes on to the next project", async () => {
    await projects();
    const forbidden = { message: 'Resource not accessible by personal access token' };
    answering((request) => (new URL(request.url).pathname === `/repos/${APP}` ? json(403, forbidden, plentyLeft) : null));

    const run = await sync();

    expect(run.skipped).toEqual([APP]);
    expect(run.finished).toBe(1);
    expect(await statuses()).toEqual(['approved', 'approved']);
  });

  test('an answer of 5xx stops the run, and pauses nothing', async () => {
    await projects();
    answering((request) => (isRepoRead(request) ? json(502, { message: 'Server Error' }) : null));

    const run = await sync();

    expect(run.stopped).toBe('github_error');
    expect(await statuses()).toEqual(['approved', 'approved']);
  });

  test('no answer at all stops the run, and pauses nothing', async () => {
    await projects();
    answering((request) => {
      if (isRepoRead(request)) throw new TypeError('Network connection lost.');
      return null;
    });

    const run = await sync();

    expect(run.stopped).toBe('github_error');
    expect(await statuses()).toEqual(['approved', 'approved']);
  });
});
