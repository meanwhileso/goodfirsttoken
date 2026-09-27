import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createProject, getProject, listIssues, savePerson } from '../../src/db';
import { startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { syncTaggedIssues } from '../../src/sync/issues';
import { refreshIssues } from '../../src/sync/scheduled';
import { freshNumbers, jobDeps, knowServiceToken, SERVICE_LOGIN } from '../sync/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from './helpers';

// A maintainer asks project_status to read their project's tagged issues from
// GitHub now, through the MCP client SDK against the whole Worker and the
// GitHub fake. sample-maintainer is an admin of sample-app on the fake, and
// priya has no role there. The project is made up.

const APP = 'sample-owner/sample-app';
const admin = { githubId: 9001, login: 'sample-admin' };

let github: GitHubFake;

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
  freshNumbers(github, APP);
  knowServiceToken(github);
  // The limit of 120 calls a minute counts each person's calls across the
  // file. tools.test.ts tests it.
  vi.spyOn(env.MCP_LIMITER, 'limit').mockResolvedValue({ success: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const MINUTE = 60_000;

async function project(status: 'approved' | 'pending' = 'approved'): Promise<void> {
  await savePerson(env.DB, admin, Date.now());
  await createProject(
    env.DB,
    { repo: APP, status, source: 'registered', policy: null, settings: { tags: ['help wanted'] }, addedBy: admin.githubId },
    Date.now(),
  );
}

interface Result {
  content: { text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function status(agent: ConnectedAgent, refresh?: boolean): Promise<Result> {
  const args = refresh === undefined ? { repo: APP } : { repo: APP, refresh };
  return (await agent.client.callTool({ name: 'project_status', arguments: args })) as Result;
}

const textOf = (result: Result) => result.content.map((c) => c.text).join('\n');
const serviceCalls = () => github.calls.filter((call) => call.login === SERVICE_LOGIN);

test('with refresh, project_status reads the tagged issues from GitHub now, with the service token, and counts them', async () => {
  await project();
  github.openIssue(APP, { title: 'Keep the hash in rewrites', labels: ['help wanted'], by: 'sample-maintainer' });
  const agent = await connectAgent(github, 'sample-maintainer');

  const before = await status(agent);
  const result = await status(agent, true);

  expect(before.structuredContent).toMatchObject({ refresh: null, issuesReadAt: null, counts: { taggedIssues: 0 } });
  expect(result.structuredContent).toMatchObject({ refresh: 'read', counts: { taggedIssues: 2 } });
  expect(Date.parse(String(result.structuredContent?.issuesReadAt))).toBeLessThanOrEqual(Date.now());
  expect(textOf(result)).toContain('Read its tagged issues from GitHub just now.');
  expect(await listIssues(env.DB, APP)).toHaveLength(2);
  expect(serviceCalls().length).toBeGreaterThan(0);
});

test('a second refresh within 10 minutes reads nothing, and says so', async () => {
  await project();
  const agent = await connectAgent(github, 'sample-maintainer');
  await status(agent, true);
  const read = serviceCalls().length;

  const again = await status(agent, true);

  expect(again.structuredContent).toMatchObject({ refresh: 'too_soon' });
  expect(textOf(again)).toContain("less than 10 minutes ago, so they weren't read again");
  expect(serviceCalls()).toHaveLength(read);
});

test('a refresh right after scheduled runs reads the issues tagged since', async () => {
  await project();
  const agent = await connectAgent(github, 'sample-maintainer');
  await syncTaggedIssues(jobDeps(github));
  await syncTaggedIssues(jobDeps(github));
  github.openIssue(APP, { title: 'Keep the hash in rewrites', labels: ['help wanted'], by: 'sample-maintainer' });

  const result = await status(agent, true);

  expect(result.structuredContent).toMatchObject({ refresh: 'read', counts: { taggedIssues: 2 } });
});

test('a refresh 10 minutes after the last one reads again', async () => {
  await project();
  const agent = await connectAgent(github, 'sample-maintainer');
  vi.useFakeTimers({ toFake: ['Date'] });
  await status(agent, true);
  github.openIssue(APP, { title: 'Keep the hash in rewrites', labels: ['help wanted'], by: 'sample-maintainer' });
  vi.setSystemTime(Date.now() + 10 * MINUTE);

  const result = await status(agent, true);

  expect(result.structuredContent).toMatchObject({ refresh: 'read', counts: { taggedIssues: 2 } });
});

test("while a scheduled run reads the project, a refresh reads nothing, says the sync is busy with it, and doesn't count as a refresh", async () => {
  await project();
  const agent = await connectAgent(github, 'sample-maintainer');
  let reached: () => void = () => undefined;
  const atTimeline = new Promise<void>((resolve) => { reached = resolve; });
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith('/timeline')) {
      reached();
      await opened;
    }
    return github.fetch(request);
  });

  const scheduled = syncTaggedIssues(jobDeps(github));
  await atTimeline;
  const calls = serviceCalls().length;
  const busy = await status(agent, true);
  const readDuring = serviceCalls().length - calls;
  open();
  await scheduled;
  const after = await status(agent, true);

  expect(busy.structuredContent).toMatchObject({ refresh: 'busy' });
  expect(textOf(busy)).toContain('A scheduled sync is reading its tagged issues from GitHub now');
  expect(readDuring).toBe(0);
  expect(after.structuredContent).toMatchObject({ refresh: 'read' });
});

test('while a refresh reads the project, a scheduled run leaves it', async () => {
  await project();
  const approved = await getProject(env.DB, APP);
  if (approved === null) throw new Error('no project');
  let reached: () => void = () => undefined;
  const atTimeline = new Promise<void>((resolve) => { reached = resolve; });
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith('/timeline')) {
      reached();
      await opened;
    }
    return github.fetch(request);
  });

  // Called here, the way project_status calls it, so the test holds the
  // refresh at its first timeline read.
  const refreshing = refreshIssues(env, approved);
  await atTimeline;
  const calls = serviceCalls().length;
  const scheduled = await syncTaggedIssues(jobDeps(github));
  // The run asks what is left of the budget, and reads nothing of the project.
  const readDuring = serviceCalls()
    .slice(calls)
    .map((call) => call.operation);
  open();
  const refreshed = await refreshing;

  expect(scheduled).toMatchObject({ held: [APP], projects: 0 });
  expect(readDuring).toEqual(['GET /rate_limit']);
  expect(refreshed).toBe('read');
});

test('a refresh leaves half the hour to the scheduled jobs: with less left, it reads no issue, and says so', async () => {
  await project();
  const agent = await connectAgent(github, 'sample-maintainer');
  github.spendRateLimit(SERVICE_LOGIN, 'core', 2600);

  const result = await status(agent, true);

  expect(result.structuredContent).toMatchObject({ refresh: 'not_read' });
  expect(textOf(result)).toContain('Read none of its tagged issues from GitHub');
  expect(await listIssues(env.DB, APP)).toEqual([]);
  expect(serviceCalls().map((call) => call.operation)).toEqual(['GET /rate_limit']);
});

test('a refresh makes at most 60 calls to GitHub, and says it read part of the issues', async () => {
  await project();
  for (let n = 0; n < 70; n++) {
    github.openIssue(APP, { title: `Sample issue ${String(n)}`, labels: ['help wanted'], by: 'sample-maintainer' });
  }
  const agent = await connectAgent(github, 'sample-maintainer');

  const result = await status(agent, true);

  expect(result.structuredContent).toMatchObject({ refresh: 'partly_read' });
  expect(serviceCalls()).toHaveLength(60);
  expect((await listIssues(env.DB, APP)).length).toBeGreaterThan(0);
});

test("a refresh that finds the repo archived pauses the project, and its maintainer can't resume it", async () => {
  await project();
  const repo = github.state.repos[APP];
  if (repo) repo.archived = true;
  const agent = await connectAgent(github, 'sample-maintainer');

  const result = await status(agent, true);
  const resume = (await agent.client.callTool({ name: 'pause_project', arguments: { repo: APP, paused: false } })) as Result;

  expect(result.structuredContent).toMatchObject({
    refresh: 'paused',
    status: 'paused',
    statusReason: `${APP} is archived on GitHub.`,
  });
  expect(resume.isError).toBe(true);
  expect(textOf(resume)).toContain('Refused (not_admin): Good First Token paused sample-owner/sample-app.');
  expect(await getProject(env.DB, APP)).toMatchObject({ status: 'paused', statusChangedBy: null });
});

test('with no service token, a refresh reads nothing, and says the server has none', async () => {
  await project();
  const agent = await connectAgent(github, 'sample-maintainer');
  const vars = env as unknown as Record<string, string>;
  const token = vars.GH_SERVICE_TOKEN ?? '';
  vars.GH_SERVICE_TOKEN = '';
  try {
    const result = await status(agent, true);

    expect(result.structuredContent).toMatchObject({ refresh: 'not_set_up' });
    expect(textOf(result)).toContain('This server has no token for reading GitHub');
    expect(serviceCalls()).toEqual([]);
  } finally {
    vars.GH_SERVICE_TOKEN = token;
  }
});

test("a pending project's issues aren't read", async () => {
  await project('pending');
  const agent = await connectAgent(github, 'sample-maintainer');

  const result = await status(agent, true);

  expect(result.structuredContent).toMatchObject({ refresh: 'not_approved' });
  expect(serviceCalls()).toEqual([]);
});

test("someone who isn't a maintainer of the repo can't make the server read GitHub", async () => {
  await project();
  const agent = await connectAgent(github, 'priya');

  const result = await status(agent, true);

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('Refused (not_maintainer)');
  expect(serviceCalls()).toEqual([]);
});
