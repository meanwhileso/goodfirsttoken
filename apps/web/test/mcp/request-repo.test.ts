import { REQUEST_STATUS_WORDS } from '@goodfirsttoken/core';
import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { addToDoNotList, blockDonor, createProject, savePerson, setProjectStatus } from '../../src/db';
import { requestRepo } from '../../src/requests/request';
import { ORIGIN, startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from './helpers';

// A donor asks for a repo they want to work on with request_repo
// (docs/specs/add-a-repo.md, under Requesting a repo). A request lists
// nothing and writes nothing to GitHub. It keeps the repo by GitHub's ID,
// and its status comes from the projects when it is read. The people and
// repos are the GitHub fake's sample data, and the repos a test makes are
// made up: priya is a donor with no role on the sample-owner repos, and
// sample-maintainer registered the projects here.

let github: GitHubFake;
const PRIYA = { githubId: 1001, login: 'priya' };
const KENJI = { githubId: 1002, login: 'kenji' };
const MAINTAINER = { githubId: 1009, login: 'sample-maintainer' };
const ADMIN = { githubId: 1010, login: 'sample-admin' };
const NOTES = 'sample-owner/sample-notes';
const PARSER = 'sample-owner/sample-parser';
const APP = 'sample-owner/sample-app';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Noon UTC on a day in the past, for the limits' clock. */
const NOON = Date.UTC(2026, 9, 14, 12, 0, 0);

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
  vi.spyOn(env.MCP_LIMITER, 'limit').mockResolvedValue({ success: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  for (const person of [PRIYA, KENJI, MAINTAINER, ADMIN]) await savePerson(env.DB, person, Date.now());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Result {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function call(agent: ConnectedAgent, args: Record<string, unknown>): Promise<Result> {
  return (await agent.client.callTool({ name: 'request_repo', arguments: args })) as Result;
}

const textOf = (result: Result) => result.content.map((c) => c.text).join('\n');
const refusalOf = (result: Result) => (result.isError ? (/^Refused \((\w+)\)/.exec(textOf(result))?.[1] ?? 'error') : null);

function repoRecord(repo: string) {
  const record = github.state.repos[repo.toLowerCase()];
  if (!record) throw new Error(`missing sample repo ${repo}`);
  return record;
}

const idOf = (repo: string) => repoRecord(repo).id;

interface Row {
  repo_id: number;
  repo: string;
  github_id: number;
  requested_at: number;
  withdrawn_at: number | null;
}

async function rows(): Promise<Row[]> {
  const { results } = await env.DB.prepare('SELECT repo_id, repo, github_id, requested_at, withdrawn_at FROM repo_requests ORDER BY requested_at, id').all<Row>();
  return results;
}

async function project(repo: string, status: 'approved' | 'pending' | 'rejected' | 'paused', ids: { repo: number; issueRepo?: number }, issueRepo?: string) {
  await createProject(
    env.DB,
    {
      repo,
      status: status === 'paused' || status === 'rejected' ? 'approved' : status,
      source: 'registered',
      policy: null,
      settings: { tags: ['help wanted'], ...(issueRepo === undefined ? {} : { issueRepo }) },
      addedBy: MAINTAINER.githubId,
      repoIds: ids,
    },
    Date.now(),
  );
  if (status === 'paused' || status === 'rejected') {
    await setProjectStatus(env.DB, repo, { status, reason: status === 'rejected' ? 'No tagged issues yet.' : null, changedBy: MAINTAINER.githubId }, Date.now());
  }
}

/** The shared request, as priya, with her token on the GitHub fake, at `now`. */
function asPriya(repo: string, now: number, withdraw?: boolean) {
  const token = github.tokenFor(PRIYA.login);
  const caller = { ...PRIYA, gitHubToken: () => Promise.resolve(token) };
  return requestRepo(env.DB, caller, { repo, ...(withdraw === undefined ? {} : { withdraw }) }, ORIGIN, now);
}

describe('request_repo', () => {
  test('a repo with no project records a request, by its GitHub ID, and answers not_listed', async () => {
    const priya = await connectAgent(github, PRIYA.login);

    const result = await call(priya, { repo: NOTES });

    expect(result.structuredContent).toEqual({
      repo: NOTES,
      status: 'not_listed',
      requested: true,
      message: 'Not listed on Good First Token yet. Its maintainers can register it at /maintainers.',
    });
    expect(textOf(result)).toContain(`${NOTES}: Not listed on Good First Token yet.`);
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ repo_id: idOf(NOTES), repo: NOTES, github_id: PRIYA.githubId, withdrawn_at: null });
  });

  test('is listed for every signed-in agent', async () => {
    const priya = await connectAgent(github, PRIYA.login);

    const { tools } = await priya.client.listTools();

    expect(tools.map((tool) => tool.name)).toContain('request_repo');
  });

  test('a listed project answers listed with its page, and records no request', async () => {
    await project(APP, 'approved', { repo: idOf(APP) });
    const priya = await connectAgent(github, PRIYA.login);

    const result = await call(priya, { repo: APP });

    expect(result.structuredContent).toEqual({
      repo: APP,
      status: 'listed',
      requested: false,
      projectUrl: `${ORIGIN}/${APP}`,
      message: 'Listed. Find its issues on its project page.',
    });
    expect(await rows()).toEqual([]);
  });

  test('a paused project answers paused with its page, and records no request', async () => {
    await project(APP, 'paused', { repo: idOf(APP) });
    const priya = await connectAgent(github, PRIYA.login);

    const result = await call(priya, { repo: APP });

    expect(result.structuredContent).toMatchObject({
      status: 'paused',
      requested: false,
      projectUrl: `${ORIGIN}/${APP}`,
      message: 'Listed and paused. It takes no claims right now.',
    });
    expect(await rows()).toEqual([]);
  });

  test("a repo that holds a listed project's issues answers listed, with that project's page", async () => {
    await project(APP, 'approved', { repo: idOf(APP), issueRepo: idOf(NOTES) }, NOTES);
    const priya = await connectAgent(github, PRIYA.login);

    const result = await call(priya, { repo: NOTES });

    expect(result.structuredContent).toMatchObject({ repo: NOTES, status: 'listed', projectUrl: `${ORIGIN}/${APP}` });
    expect(await rows()).toEqual([]);
  });

  test('a pending project, a rejected one, and a repo on the do-not-list all answer not_listed with the same words, and record a request', async () => {
    const harbor = 'sample-owner/sample-harbor';
    await project(NOTES, 'pending', { repo: idOf(NOTES) });
    await project(PARSER, 'rejected', { repo: idOf(PARSER) });
    await addToDoNotList(env.DB, { repo: harbor, reason: null, addedBy: ADMIN.githubId }, Date.now());
    const priya = await connectAgent(github, PRIYA.login);

    const answers = [];
    for (const repo of [NOTES, PARSER, harbor]) answers.push(await call(priya, { repo }));

    for (const [i, repo] of [NOTES, PARSER, harbor].entries()) {
      expect(answers[i]?.structuredContent, repo).toEqual({ repo, status: 'not_listed', requested: true, message: REQUEST_STATUS_WORDS.not_listed });
    }
    expect(new Set(answers.map((answer, i) => textOf(answer).replaceAll([NOTES, PARSER, harbor][i] ?? '', 'the repo'))).size).toBe(1);
    expect((await rows()).map((row) => row.repo)).toEqual([NOTES, PARSER, harbor]);
  });

  test('a request lists nothing, and adds nothing to the admin queue or the seed list', async () => {
    const priya = await connectAgent(github, PRIYA.login);

    await call(priya, { repo: NOTES });

    for (const table of ['projects', 'crawl_candidates', 'crawl_seeds', 'removal_requests']) {
      const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n');
      expect(count, table).toBe(0);
    }
  });

  test("makes no call to GitHub but reads, each with the donor's own token", async () => {
    await project(APP, 'approved', { repo: idOf(APP) });
    const priya = await connectAgent(github, PRIYA.login);
    const from = github.calls.length;

    await call(priya, { repo: NOTES });
    await call(priya, { repo: APP });
    await call(priya, { repo: NOTES, withdraw: true });
    await call(priya, { repo: 'sample-owner/no-such-repo' });

    const calls = github.calls.slice(from).filter((c) => c.url.startsWith(github.apiUrl));
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.method, c.operation).toBe('GET');
      expect(c.login, c.operation).toBe(PRIYA.login);
    }
  });

  test('asking twice records one request, and answers that it is live', async () => {
    const priya = await connectAgent(github, PRIYA.login);

    await call(priya, { repo: NOTES });
    const again = await call(priya, { repo: NOTES });

    expect(again.structuredContent).toMatchObject({ status: 'not_listed', requested: true });
    expect(await rows()).toHaveLength(1);
  });

  test('withdrawing takes the request back, and asking again records a new one', async () => {
    const priya = await connectAgent(github, PRIYA.login);
    await call(priya, { repo: NOTES });

    const withdrawn = await call(priya, { repo: NOTES, withdraw: true });

    expect(withdrawn.structuredContent).toMatchObject({ repo: NOTES, status: 'not_listed', requested: false });
    expect(textOf(withdrawn)).toContain(`The donor has no request for ${NOTES}.`);
    expect((await rows())[0]?.withdrawn_at).not.toBeNull();

    const again = await call(priya, { repo: NOTES });
    expect(again.structuredContent).toMatchObject({ requested: true });
    expect((await rows()).map((row) => row.withdrawn_at === null)).toEqual([false, true]);
  });

  test("withdrawing a request for a repo GitHub no longer shows finds it by the name GitHub gave", async () => {
    const priya = await connectAgent(github, PRIYA.login);
    await call(priya, { repo: NOTES });
    github.deleteRepo(NOTES);

    const withdrawn = await call(priya, { repo: NOTES, withdraw: true });

    expect(withdrawn.structuredContent).toMatchObject({ repo: NOTES, requested: false });
    expect((await rows())[0]?.withdrawn_at).not.toBeNull();
  });

  test('a repo renamed after the request is the same request, found by its repo ID', async () => {
    const priya = await connectAgent(github, PRIYA.login);
    await call(priya, { repo: NOTES });
    github.renameRepo(NOTES, 'sample-owner/sample-notebook');

    const again = await call(priya, { repo: 'sample-owner/sample-notebook' });

    expect(again.structuredContent).toMatchObject({ repo: 'sample-owner/sample-notebook', requested: true });
    expect(await rows()).toHaveLength(1);

    const withdrawn = await call(priya, { repo: 'sample-owner/sample-notebook', withdraw: true });
    expect(withdrawn.structuredContent).toMatchObject({ requested: false });
    expect((await rows())[0]).toMatchObject({ repo: NOTES, repo_id: idOf('sample-owner/sample-notebook') });
    expect((await rows())[0]?.withdrawn_at).not.toBeNull();
  });

  test('a repo renamed after it was listed answers listed under its new name', async () => {
    await project(APP, 'approved', { repo: idOf(APP) });
    github.renameRepo(APP, 'sample-owner/sample-app-next');
    const priya = await connectAgent(github, PRIYA.login);

    const result = await call(priya, { repo: 'sample-owner/sample-app-next' });

    expect(result.structuredContent).toMatchObject({ repo: 'sample-owner/sample-app-next', status: 'listed', projectUrl: `${ORIGIN}/${APP}` });
  });

  test('takes a GitHub repo link or a Good First Token project link, as owner/repo', async () => {
    const priya = await connectAgent(github, PRIYA.login);

    const byGitHub = await call(priya, { repo: `${github.webUrl}/${NOTES}.git` });
    const byPage = await call(priya, { repo: `${ORIGIN}/${PARSER}/issues/3` });

    expect(byGitHub.structuredContent).toMatchObject({ repo: NOTES, requested: true });
    expect(byPage.structuredContent).toMatchObject({ repo: PARSER, requested: true });
    expect((await rows()).map((row) => row.repo)).toEqual([NOTES, PARSER]);
  });

  test('a repo it can read as no repo is refused with invalid_input', async () => {
    const priya = await connectAgent(github, PRIYA.login);

    for (const repo of ['not a repo', 'https://elsewhere.example/sample-owner/sample-notes', `${github.webUrl}/sample-owner`]) {
      const result = await call(priya, { repo });
      expect(refusalOf(result), repo).toBe('invalid_input');
      expect(textOf(result)).toContain('Name a repo as owner/repo, a GitHub repo link, or a Good First Token project link.');
    }
    expect(await rows()).toEqual([]);
  });

  test('a blocked donor is refused with donor_blocked', async () => {
    await blockDonor(env.DB, { githubId: PRIYA.githubId, reason: null, blockedBy: ADMIN.githubId }, Date.now());
    const priya = await connectAgent(github, PRIYA.login);

    const result = await call(priya, { repo: NOTES });

    expect(refusalOf(result)).toBe('donor_blocked');
    expect(textOf(result)).toContain('A Good First Token admin blocked @priya, so Good First Token takes no requests from them.');
    expect(await rows()).toEqual([]);
  });

  test.each([
    ['GitHub shows no repo by the name', (repo: string) => {
      github.deleteRepo(repo);
    }, "GitHub shows no public repo sample-owner/sample-notes, so agents can't work on it."],
    ['the repo is private', (repo: string) => (repoRecord(repo).private = true), "GitHub shows no public repo sample-owner/sample-notes, so agents can't work on it."],
    ['the repo is archived', (repo: string) => (repoRecord(repo).archived = true), 'sample-owner/sample-notes is archived on GitHub, so it takes no changes.'],
    ['pull requests are off', (repo: string) => (repoRecord(repo).hasPullRequests = false), "sample-owner/sample-notes has pull requests turned off, so agents can't send PRs to it."],
    [
      'only collaborators can open pull requests',
      (repo: string) => (repoRecord(repo).pullRequestCreationPolicy = 'collaborators_only'),
      "sample-owner/sample-notes lets only collaborators open pull requests, so agents can't send PRs to it.",
    ],
  ])('when %s, it is refused with repo_not_eligible, naming why', async (_case, change, message) => {
    change(NOTES);
    const priya = await connectAgent(github, PRIYA.login);

    const result = await call(priya, { repo: NOTES });

    expect(refusalOf(result)).toBe('repo_not_eligible');
    expect(textOf(result)).toContain(message);
    expect(await rows()).toEqual([]);
  });

  test('a repo GitHub says nothing about on pull requests passes', async () => {
    const priya = await connectAgent(github, PRIYA.login);
    const fake = github.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fake(input, init);
      if (!new Request(input, init).url.endsWith(`/repos/${NOTES}`)) return response;
      const repo: Record<string, unknown> = await response.json();
      delete repo.has_pull_requests;
      delete repo.pull_request_creation_policy;
      return Response.json(repo, { status: response.status, headers: response.headers });
    });

    const result = await call(priya, { repo: NOTES });

    expect(result.structuredContent).toMatchObject({ repo: NOTES, status: 'not_listed', requested: true });
  });
});

describe('the limits on requests', () => {
  /** Makes `count` new public repos under sample-owner, named `<prefix>-1` on. */
  function newRepos(prefix: string, count: number): string[] {
    return Array.from({ length: count }, (_, i) => {
      const repo = `sample-owner/${prefix}-${String(i + 1)}`;
      github.createRepo(repo);
      return repo;
    });
  }

  test('an 11th new request in a UTC day is refused with rate_limited, withdrawn ones included, and goes in the next day', async () => {
    const repos = newRepos('daily', 11);
    for (const [i, repo] of repos.slice(0, 10).entries()) {
      expect(await asPriya(repo, NOON + i * 60_000)).toMatchObject({ requested: true });
    }
    for (const repo of repos.slice(0, 4)) await asPriya(repo, NOON + HOUR, true);

    const refused = await asPriya(repos[10] ?? '', NOON + 2 * HOUR);

    expect(refused).toEqual({ code: 'rate_limited', message: "You've sent 10 requests today. The next one can go in at 00:00 UTC." });
    expect(await asPriya(repos[10] ?? '', Date.UTC(2026, 9, 15, 0, 0, 0))).toMatchObject({ requested: true });
  });

  test("asking again for a repo with a live request doesn't count toward the day's requests", async () => {
    const repos = newRepos('again', 10);
    for (const repo of repos.slice(0, 9)) await asPriya(repo, NOON);
    for (let i = 0; i < 5; i++) await asPriya(repos[0] ?? '', NOON + HOUR);

    expect(await asPriya(repos[9] ?? '', NOON + 2 * HOUR)).toMatchObject({ requested: true });
  });

  test('a 51st live request is refused with rate_limited, and goes in once one is withdrawn', async () => {
    const repos = newRepos('live', 51);
    for (const [i, repo] of repos.slice(0, 50).entries()) await asPriya(repo, NOON + Math.floor(i / 10) * DAY);
    const at = NOON + 6 * DAY;

    const refused = await asPriya(repos[50] ?? '', at);

    expect(refused).toEqual({
      code: 'rate_limited',
      message: 'You have 50 live requests, the most one person can have. The next one can go in once you withdraw one.',
    });
    await asPriya(repos[0] ?? '', at, true);
    expect(await asPriya(repos[50] ?? '', at)).toMatchObject({ requested: true });
  });

  test("one person's limits leave another person's requests alone", async () => {
    const repos = newRepos('other', 11);
    for (const repo of repos.slice(0, 10)) await asPriya(repo, NOON);
    const token = github.tokenFor(KENJI.login);
    const kenji = { ...KENJI, gitHubToken: () => Promise.resolve(token) };

    expect(await requestRepo(env.DB, kenji, { repo: repos[10] ?? '' }, ORIGIN, NOON)).toMatchObject({ requested: true });
  });
});
