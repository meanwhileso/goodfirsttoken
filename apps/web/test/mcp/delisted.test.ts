import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getProject, savePerson, setProjectStatus } from '../../src/db';
import { syncTaggedIssues } from '../../src/sync/issues';
import { APP as OAUTH_APP, startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { jobDeps, SERVICE_LOGIN } from '../sync/helpers';
import { workerFetch } from '../worker';
import { connectAgent, emptyKv, type ConnectedAgent } from './helpers';

// What a maintainer hears from project_status, and an admin from
// admin_pause_project, about a project the sync delisted: which repo GitHub
// showed private, archived, blocked, or gone, what it showed, when the sync
// last read the repos, and what brings the page back. Each case runs the
// sync against the GitHub fake, whose sample data these are:
// sample-maintainer is an admin of the sample-owner repos, and sample-admin
// is the site's admin here. Every reason for a pause is made up.

let github: GitHubFake;
const configuredAdmins = env.ADMIN_GITHUB_IDS;
const ADMIN = { githubId: 1010, login: 'sample-admin' };
const APP = 'sample-owner/sample-app';
const DESKTOP = 'sample-owner/sample-desktop';
// The issues the sync caches for each, with their titles and labels.
const APP_TITLE = 'Handle trailing slashes in rewrites';
const DESKTOP_TITLE = 'Suspend fails on the second resume';
/** The OAuth scopes the service token has in the fake. A deployed one reads public repos only. */
let serviceScopes: string[] = [];

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
  serviceScopes = [];
  env.ADMIN_GITHUB_IDS = String(ADMIN.githubId);
  // These tests make more MCP calls than the limit of 120 a minute allows
  // the same few people. tools.test.ts tests the limit.
  vi.spyOn(env.MCP_LIMITER, 'limit').mockResolvedValue({ success: true });
  // Each run logs a line, and each pause a warning.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  env.ADMIN_GITHUB_IDS = configuredAdmins;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Result {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

interface Delisted {
  repo: string | null;
  showed: string | null;
  reason: string;
  readAt: string | null;
}

async function call(agent: ConnectedAgent, name: string, args: Record<string, unknown>): Promise<Result> {
  return (await agent.client.callTool({ name, arguments: args })) as Result;
}

function textOf(result: Result): string {
  return result.content.map((c) => c.text).join('\n');
}

function delistedIn(result: Result): Delisted | null {
  return (result.structuredContent?.delisted ?? null) as Delisted | null;
}

function sampleRepo(name: string) {
  const repo = github.state.repos[name];
  if (!repo) throw new Error(`missing sample repo ${name}`);
  return repo;
}

/** A scheduled run of the sync, with the service token. */
function sync() {
  const deps = jobDeps(github);
  const token = github.state.tokens[env.GH_SERVICE_TOKEN];
  if (token) token.scopes = serviceScopes;
  return syncTaggedIssues(deps);
}

/** Lets `login`'s agent token see the private repos they have a role on, as a token with the repo scope does. */
function seesPrivateRepos(login: string): void {
  const grant = Object.values(github.state.tokens).find((g) => g.clientId === OAUTH_APP.clientId && g.login === login);
  if (!grant) throw new Error(`${login} has no agent token`);
  grant.scopes = ['repo'];
}

/** GitHub answering every read of the repo with a 451, as it does for one it blocked access to. */
function blockAccess(repo: string): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === `/repos/${repo}`) {
      return Response.json({ message: 'Repository access blocked', block: { reason: 'dmca' } }, { status: 451 });
    }
    return github.fetch(request);
  });
}

const page = async (path: string) => {
  const response = await workerFetch(`http://localhost${path}`);
  await response.body?.cancel();
  return response.status;
};

/** Registers the repo as sample-maintainer, has the admin approve it, and lets the sync read its issues while its repos are public. */
async function listedAndRead(settings: Record<string, unknown> = { tags: ['help wanted'] }): Promise<ConnectedAgent> {
  const agent = await connectAgent(github, 'sample-maintainer');
  const registered = await call(agent, 'register_project', { repo: APP, settings });
  if (registered.structuredContent?.saved !== true) throw new Error(textOf(registered));
  await savePerson(env.DB, ADMIN, Date.now());
  await setProjectStatus(env.DB, APP, { status: 'approved', reason: null, changedBy: ADMIN.githubId }, Date.now());
  await sync();
  expect(await page(`/${APP}`)).toBe(200);
  return agent;
}

/** The sync run that delists the project, and when it ran. */
async function delistingRun(): Promise<{ from: number; to: number }> {
  const from = Date.now();
  const run = await sync();
  expect(run.delisted.length + run.paused.length).toBe(1);
  return { from, to: Date.now() };
}

function expectReadDuring(delisted: Delisted | null, { from, to }: { from: number; to: number }): void {
  const readAt = Date.parse(delisted?.readAt ?? '');
  expect(readAt).toBeGreaterThanOrEqual(from);
  expect(readAt).toBeLessThanOrEqual(to);
}

describe('a project the sync delisted while it was approved', () => {
  const GONE = `GitHub shows no public repo named ${APP}. It went private or was deleted.`;

  const cases = [
    {
      showed: 'archived',
      repo: APP,
      reason: `${APP} is archived on GitHub.`,
      settings: { tags: ['help wanted'] },
      title: APP_TITLE,
      arrange: () => {
        sampleRepo(APP).archived = true;
      },
    },
    {
      // The service token reads public repos only, so a repo that went
      // private shows as gone. Its maintainer's token with the repo scope
      // still sees it, so they get past the role check.
      showed: 'gone',
      repo: APP,
      reason: GONE,
      settings: { tags: ['help wanted'] },
      title: APP_TITLE,
      arrange: () => {
        sampleRepo(APP).private = true;
        seesPrivateRepos('sample-maintainer');
      },
    },
    {
      // A service token that can see the private repo reads it as private.
      showed: 'private',
      repo: APP,
      reason: `${APP} is no longer public on GitHub.`,
      settings: { tags: ['help wanted'] },
      title: APP_TITLE,
      arrange: () => {
        sampleRepo(APP).private = true;
        sampleRepo(APP).collaborators[SERVICE_LOGIN] = 'read';
        serviceScopes = ['repo'];
        seesPrivateRepos('sample-maintainer');
      },
    },
    {
      // Its issue repo, while GitHub shows the code repo public and open.
      showed: 'blocked',
      repo: DESKTOP,
      reason: `GitHub blocked access to ${DESKTOP}.`,
      settings: { tags: ['ready'], issueRepo: DESKTOP },
      title: DESKTOP_TITLE,
      arrange: () => {
        blockAccess(DESKTOP);
      },
    },
  ] as const;

  test.each(cases)(
    'project_status says GitHub showed $repo $showed, when the sync read it, that a resume brings no page back, and shows nothing more of the repo',
    async ({ showed, repo, reason, settings, title, arrange }) => {
      const agent = await listedAndRead(settings);
      arrange();
      const run = await delistingRun();

      const result = await call(agent, 'project_status', { repo: APP });
      const delisted = delistedIn(result);
      const text = textOf(result);

      // The sync paused the approved project for Good First Token, and the
      // mark sits beside that pause.
      expect(result.structuredContent).toMatchObject({ repo: APP, status: 'paused', statusReason: reason });
      // Only the repo's name and what GitHub showed: nothing cached from it.
      expect(delisted).toEqual({ repo, showed, reason, readAt: expect.any(String) as unknown });
      expectReadDuring(delisted, run);
      expect(JSON.stringify(result.structuredContent)).not.toContain(title);
      expect(text).not.toContain(title);
      expect(text).toContain(`Delisted by the sync: ${reason} The sync last read the repos on ${delisted?.readAt?.slice(0, 10) ?? ''}`);
      expect(text).toContain('The page comes back by itself once the sync reads its repos public and open again.');
      expect(text).toContain("A resume doesn't bring it back.");
      // The other lines read as before.
      expect(text).toContain(`${APP}: paused. Registered by its maintainers.\nReason: ${reason}\nDelisted by the sync:`);
      expect(text).toMatch(/\n\d+ tagged issues? · 0 working now · 0 open PRs · 0 merged\n/);
    },
  );

  test.each(cases)(
    "an admin who resumes it hears it stays delisted, since GitHub showed $repo $showed, and it has no page",
    async ({ showed, repo, reason, settings, arrange }) => {
      await listedAndRead(settings);
      arrange();
      const run = await delistingRun();
      const admin = await connectAgent(github, ADMIN.login);

      const resumed = await call(admin, 'admin_pause_project', { repo: APP, paused: false });

      expect(resumed.structuredContent).toMatchObject({ repo: APP, status: 'approved', changed: true });
      expect(delistedIn(resumed)).toEqual({ repo, showed, reason, readAt: expect.any(String) as unknown });
      expectReadDuring(delistedIn(resumed), run);
      expect(textOf(resumed)).toMatch(new RegExp(`^Resumed ${APP}\\. Status: approved\\.\\nDelisted by the sync: `));
      expect(textOf(resumed)).toContain("A resume doesn't bring it back.");
      expect(await page(`/${APP}`)).toBe(404);
    },
  );

  test('a maintainer GitHub shows no repo, as when it went private, is refused with not_maintainer as before, and the admin still hears why', async () => {
    const agent = await listedAndRead();
    sampleRepo(APP).private = true;
    await delistingRun();
    const admin = await connectAgent(github, ADMIN.login);

    const asked = await call(agent, 'project_status', { repo: APP });
    const resumed = await call(admin, 'admin_pause_project', { repo: APP, paused: false });

    expect(textOf(asked)).toBe(
      `Refused (not_maintainer): GitHub shows you no public repo named ${APP}. Only an admin or maintainer of a public repo can do this.`,
    );
    expect(asked.structuredContent).toBeUndefined();
    expect(delistedIn(resumed)).toMatchObject({ repo: APP, showed: 'gone', reason: GONE });
  });
});

describe('a project its maintainer paused before the sync delisted it', () => {
  const ARCHIVED = `${APP} is archived on GitHub.`;

  async function pausedThenArchived() {
    const agent = await listedAndRead();
    const paused = await call(agent, 'pause_project', { repo: APP, reason: 'Release week.' });
    expect(paused.structuredContent).toMatchObject({ status: 'paused', resumableBy: 'maintainers' });
    sampleRepo(APP).archived = true;
    const run = await delistingRun();
    return { agent, run };
  }

  test("project_status keeps their pause and reason, says it is delisted, and a resume leaves it delisted until the next check pauses it for Good First Token", async () => {
    const { agent, run } = await pausedThenArchived();

    const whilePaused = await call(agent, 'project_status', { repo: APP });
    await call(agent, 'pause_project', { repo: APP, paused: false });
    const resumed = await call(agent, 'project_status', { repo: APP });
    await sync();
    const afterTheCheck = await call(agent, 'project_status', { repo: APP });

    expect(whilePaused.structuredContent).toMatchObject({ status: 'paused', statusReason: 'Release week.' });
    expect(delistedIn(whilePaused)).toEqual({ repo: APP, showed: 'archived', reason: ARCHIVED, readAt: expect.any(String) as unknown });
    expectReadDuring(delistedIn(whilePaused), run);
    expect(textOf(whilePaused)).toContain(`Reason: Release week.\nDelisted by the sync: ${ARCHIVED}`);
    // The resume changed the status and left the mark, so there is still no page.
    expect(resumed.structuredContent).toMatchObject({ status: 'approved', statusReason: null });
    expect(delistedIn(resumed)).toMatchObject({ repo: APP, showed: 'archived' });
    expect(textOf(resumed)).toContain(`${APP}: approved. Registered by its maintainers.\nDelisted by the sync: ${ARCHIVED}`);
    // The next check paused it for Good First Token, as the text warned.
    expect(afterTheCheck.structuredContent).toMatchObject({ status: 'paused', statusReason: ARCHIVED });
    expect(delistedIn(afterTheCheck)).toMatchObject({ repo: APP, showed: 'archived' });
    expect(await getProject(env.DB, APP)).toMatchObject({ status: 'paused', statusChangedBy: null });
    expect(await page(`/${APP}`)).toBe(404);
  });

  test('an admin who takes the pause over hears it is delisted', async () => {
    const { run } = await pausedThenArchived();
    const admin = await connectAgent(github, ADMIN.login);

    const paused = await call(admin, 'admin_pause_project', { repo: APP, reason: 'Checking the repo.' });

    expect(paused.structuredContent).toMatchObject({ repo: APP, status: 'paused', changed: true });
    expect(delistedIn(paused)).toEqual({ repo: APP, showed: 'archived', reason: ARCHIVED, readAt: expect.any(String) as unknown });
    expectReadDuring(delistedIn(paused), run);
    expect(textOf(paused)).toContain(`Paused ${APP}. Agents get no new claims on it until an admin resumes it.\nDelisted by the sync: ${ARCHIVED}`);
  });
});

describe('a project the sync delisted that is no longer approved or paused', () => {
  test("shows no delisting once an admin removes it at its maintainers' request, since the sync no longer reads it and it has no page anyway", async () => {
    const agent = await listedAndRead();
    sampleRepo(APP).archived = true;
    await delistingRun();
    // GitHub still shows an archived repo and the maintainer's role on it, so they can ask.
    await call(agent, 'request_removal', { repo: APP, reason: 'We archived the repo.' });
    const admin = await connectAgent(github, ADMIN.login);
    await call(admin, 'admin_remove_project', { repo: APP });

    const status = await call(agent, 'project_status', { repo: APP });
    const resumed = await call(admin, 'admin_pause_project', { repo: APP, paused: false });

    expect(status.structuredContent).toMatchObject({ status: 'rejected', statusReason: "Removed at its maintainers' request.", delisted: null });
    expect(textOf(status)).not.toContain('Delisted');
    expect(resumed.structuredContent).toMatchObject({ status: 'rejected', changed: false, delisted: null });
    expect(textOf(resumed)).toBe(`${APP} isn't paused, so nothing changed. Status: rejected.`);
  });
});

describe('a project the sync lists again once its repo is public', () => {
  test('project_status and the admin say nothing of a delisting, and the page is back', async () => {
    const agent = await listedAndRead();
    sampleRepo(APP).private = true;
    await delistingRun();
    sampleRepo(APP).private = false;
    const run = await sync();

    const status = await call(agent, 'project_status', { repo: APP });
    const admin = await connectAgent(github, ADMIN.login);
    const resumed = await call(admin, 'admin_pause_project', { repo: APP, paused: false });

    expect(run.delisted).toEqual([]);
    // Good First Token's pause stays until an admin lifts it.
    expect(status.structuredContent).toMatchObject({ status: 'paused', delisted: null });
    expect(textOf(status)).not.toContain('Delisted');
    expect(resumed.structuredContent).toMatchObject({ status: 'approved', changed: true, delisted: null });
    expect(textOf(resumed)).toBe(`Resumed ${APP}. Status: approved.`);
    expect(await page(`/${APP}`)).toBe(200);
  });

  test('a refresh that reads the repo public again takes the mark off, and its answer says nothing of a delisting', async () => {
    const agent = await listedAndRead();
    sampleRepo(APP).private = true;
    await delistingRun();
    // An admin resumes it while the repo is still private, so it is approved and delisted.
    const admin = await connectAgent(github, ADMIN.login);
    const resumed = await call(admin, 'admin_pause_project', { repo: APP, paused: false });
    sampleRepo(APP).private = false;

    const refreshed = await call(agent, 'project_status', { repo: APP, refresh: true });

    expect(delistedIn(resumed)).toMatchObject({ repo: APP, showed: 'gone' });
    expect(refreshed.structuredContent).toMatchObject({ status: 'approved', refresh: 'read', delisted: null });
    expect(textOf(refreshed)).not.toContain('Delisted');
    expect(await page(`/${APP}`)).toBe(200);
  });
});
