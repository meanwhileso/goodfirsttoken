import type { D1Migration } from 'cloudflare:test';
import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getProject, savePerson, setProjectStatus } from '../../src/db';
import { syncTaggedIssues } from '../../src/sync/issues';
import { startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { jobDeps, SERVICE_LOGIN } from '../sync/helpers';
import { workerFetch } from '../worker';
import { connectAgent, emptyKv, type ConnectedAgent } from './helpers';

// What a maintainer hears from project_status, and an admin from
// admin_pause_project, about a project the sync delisted: which repo GitHub
// showed private, archived, blocked, or gone, what it showed, when the sync
// delisted the project and last checked the repos, and what brings the page
// back. Each case runs the sync against the GitHub fake, whose sample data
// these are: sample-maintainer is an admin of the sample-owner repos, and
// sample-admin is the site's admin here. Every token the site holds for a
// person reads public repos only, as deployed. Every reason for a pause is
// made up.

let github: GitHubFake;
const configuredAdmins = env.ADMIN_GITHUB_IDS;
const ADMIN = { githubId: 1010, login: 'sample-admin' };
const APP = 'sample-owner/sample-app';
const DESKTOP = 'sample-owner/sample-desktop';
// The issues the sync caches for each, by their titles.
const APP_TITLE = 'Handle trailing slashes in rewrites';
const DESKTOP_TITLE = 'Suspend fails on the second resume';
const ISSUES_IN_DESKTOP = { tags: ['ready'], issueRepo: DESKTOP };
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
  delistedAt: string | null;
  checkedAt: string | null;
  onDoNotList: boolean;
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

function expectDuring(time: string | null | undefined, { from, to }: { from: number; to: number }): void {
  const at = Date.parse(time ?? '');
  expect(at).toBeGreaterThanOrEqual(from);
  expect(at).toBeLessThanOrEqual(to);
}

/** A time as the answers' text writes it, to the minute. */
const minute = (iso: string | null | undefined) => `${(iso ?? '').slice(0, 10)} ${(iso ?? '').slice(11, 16)} UTC`;

const SINCE_A_TIME = expect.any(String) as unknown;

describe('a project the sync delisted while it was approved', () => {
  const cases = [
    {
      // The code repo, which GitHub still shows its maintainers.
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
      // Its issue repo went private. The service token reads public repos
      // only, so it shows as gone, and GitHub still shows the maintainer the
      // public code repo.
      showed: 'gone',
      repo: DESKTOP,
      reason: `GitHub shows no public repo named ${DESKTOP}. It went private or was deleted.`,
      settings: ISSUES_IN_DESKTOP,
      title: DESKTOP_TITLE,
      arrange: () => {
        sampleRepo(DESKTOP).private = true;
      },
    },
    {
      // A service token that can see the private issue repo reads it as private.
      showed: 'private',
      repo: DESKTOP,
      reason: `${DESKTOP} is no longer public on GitHub.`,
      settings: ISSUES_IN_DESKTOP,
      title: DESKTOP_TITLE,
      arrange: () => {
        sampleRepo(DESKTOP).private = true;
        sampleRepo(DESKTOP).collaborators[SERVICE_LOGIN] = 'read';
        serviceScopes = ['repo'];
      },
    },
    {
      showed: 'blocked',
      repo: DESKTOP,
      reason: `GitHub blocked access to ${DESKTOP}.`,
      settings: ISSUES_IN_DESKTOP,
      title: DESKTOP_TITLE,
      arrange: () => {
        blockAccess(DESKTOP);
      },
    },
  ] as const;

  test.each(cases)(
    "project_status says GitHub showed $repo $showed, when the sync delisted it, that a resume brings no page back, and shows nothing cached from its repos",
    async ({ showed, repo, reason, settings, title, arrange }) => {
      const agent = await listedAndRead(settings);
      const before = await call(agent, 'project_status', { repo: APP });
      arrange();
      const run = await delistingRun();

      const result = await call(agent, 'project_status', { repo: APP });
      const delisted = delistedIn(result);
      const text = textOf(result);

      // The sync paused the approved project for Good First Token, and the
      // mark sits beside that pause.
      expect(result.structuredContent).toMatchObject({ repo: APP, status: 'paused', statusReason: reason, resumableBy: 'admins' });
      expect(delisted).toEqual({ repo, showed, reason, delistedAt: SINCE_A_TIME, checkedAt: SINCE_A_TIME, onDoNotList: false });
      expectDuring(delisted?.delistedAt, run);
      expect(delisted?.checkedAt).toBe(delisted?.delistedAt);
      // The count of its cached tagged issues showed while it was listed, and no longer does.
      expect(before.structuredContent?.counts).toMatchObject({ taggedIssues: expect.any(Number) as unknown });
      expect(result.structuredContent?.counts).toEqual({ taggedIssues: null, working: 0, openPrs: 0, merged: 0 });
      expect(JSON.stringify(result.structuredContent)).not.toContain(title);
      expect(text).not.toContain(title);
      expect(text).toContain(`Delisted by the sync on ${minute(delisted?.delistedAt)}: ${reason} The sync last checked the repos on`);
      expect(text).toContain('The project has no page, and agents get no claims on it, whatever its status.');
      expect(text).toContain('The page comes back by itself once the sync reads its repos public and open again.');
      expect(text).toContain("A resume doesn't bring it back.");
      expect(text).toContain('\ntagged issues not shown while it is delisted · 0 working now · 0 open PRs · 0 merged\n');
      // The other lines read as before.
      expect(text).toContain(`${APP}: paused. Registered by its maintainers.\nReason: ${reason}\n`);
    },
  );

  test.each(cases)(
    'an admin who resumes it hears it stays delisted, since GitHub showed $repo $showed, and it has no page',
    async ({ showed, repo, reason, settings, arrange }) => {
      await listedAndRead(settings);
      arrange();
      const run = await delistingRun();
      const admin = await connectAgent(github, ADMIN.login);

      const resumed = await call(admin, 'admin_pause_project', { repo: APP, paused: false });

      expect(resumed.structuredContent).toMatchObject({ repo: APP, status: 'approved', changed: true });
      expect(delistedIn(resumed)).toEqual({ repo, showed, reason, delistedAt: SINCE_A_TIME, checkedAt: SINCE_A_TIME, onDoNotList: false });
      expectDuring(delistedIn(resumed)?.delistedAt, run);
      expect(textOf(resumed)).toMatch(new RegExp(`^Resumed ${APP}\\. Status: approved\\.\\nDelisted by the sync on `));
      expect(textOf(resumed)).toContain("A resume doesn't bring it back.");
      expect(await page(`/${APP}`)).toBe(404);
    },
  );

  test('project_status keeps when the sync delisted it, while each later check moves when it last checked', async () => {
    const agent = await listedAndRead();
    sampleRepo(APP).archived = true;
    const run = await delistingRun();
    const first = delistedIn(await call(agent, 'project_status', { repo: APP }));
    await new Promise((resolve) => setTimeout(resolve, 5));

    await sync();
    const later = await call(agent, 'project_status', { repo: APP });

    expectDuring(first?.delistedAt, run);
    expect(delistedIn(later)?.delistedAt).toBe(first?.delistedAt);
    expect(Date.parse(delistedIn(later)?.checkedAt ?? '')).toBeGreaterThan(Date.parse(first?.delistedAt ?? ''));
    expect(textOf(later)).toContain(`Delisted by the sync on ${minute(first?.delistedAt)}: `);
  });

  test.each([
    {
      showed: 'gone',
      reason: `GitHub shows no public repo named ${APP}. It went private or was deleted.`,
      refused: `GitHub shows you no public repo named ${APP}. Only an admin or maintainer of a public repo can do this.`,
      arrange: () => {
        sampleRepo(APP).private = true;
      },
    },
    {
      showed: 'blocked',
      reason: `GitHub blocked access to ${APP}.`,
      refused: `GitHub blocked access to ${APP}, so it can't say whether you are an admin or maintainer of it.`,
      arrange: () => {
        blockAccess(APP);
      },
    },
  ])(
    'a caller GitHub shows no code repo, since it is $showed, is refused with not_maintainer, which says Good First Token delisted the project, and the admin hears why',
    async ({ showed, reason, refused, arrange }) => {
      const agent = await listedAndRead();
      arrange();
      await delistingRun();
      const admin = await connectAgent(github, ADMIN.login);

      const asked = await call(agent, 'project_status', { repo: APP });
      const resumed = await call(admin, 'admin_pause_project', { repo: APP, paused: false });

      expect(textOf(asked)).toBe(`Refused (not_maintainer): ${refused} Good First Token delisted this project: ${reason}`);
      expect(asked.structuredContent).toBeUndefined();
      expect(delistedIn(resumed)).toMatchObject({ repo: APP, showed, reason });
    },
  );

  test.each([
    {
      delisted: 'for its issue repo',
      settings: ISSUES_IN_DESKTOP,
      arrange: () => {
        sampleRepo(DESKTOP).private = true;
      },
    },
    {
      delisted: 'for its archived code repo',
      settings: { tags: ['help wanted'] },
      arrange: () => {
        sampleRepo(APP).archived = true;
      },
    },
  ])(
    'a caller with no role on a project the sync delisted $delisted is refused with not_maintainer, which names no delisting, since GitHub still shows them the code repo',
    async ({ settings, arrange }) => {
      await listedAndRead(settings);
      arrange();
      await delistingRun();
      const donor = await connectAgent(github, 'priya');

      const asked = await call(donor, 'project_status', { repo: APP });

      expect(textOf(asked)).toMatch(/^Refused \(not_maintainer\): /);
      expect(textOf(asked)).not.toContain('delisted');
      expect(asked.structuredContent).toBeUndefined();
    },
  );

  test("a caller who isn't a maintainer of a project the sync didn't delist hears nothing of a delisting", async () => {
    await listedAndRead();
    const donor = await connectAgent(github, 'priya');

    const asked = await call(donor, 'project_status', { repo: APP });

    expect(textOf(asked)).toMatch(/^Refused \(not_maintainer\): /);
    expect(textOf(asked)).not.toContain('delisted');
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

  test('project_status keeps their pause and reason, says it is delisted, and a resume leaves it delisted until the next check pauses it for Good First Token', async () => {
    const { agent, run } = await pausedThenArchived();

    const whilePaused = await call(agent, 'project_status', { repo: APP });
    await call(agent, 'pause_project', { repo: APP, paused: false });
    const resumed = await call(agent, 'project_status', { repo: APP });
    await sync();
    const afterTheCheck = await call(agent, 'project_status', { repo: APP });

    expect(whilePaused.structuredContent).toMatchObject({ status: 'paused', statusReason: 'Release week.', resumableBy: 'maintainers' });
    expect(delistedIn(whilePaused)).toEqual({
      repo: APP,
      showed: 'archived',
      reason: ARCHIVED,
      delistedAt: SINCE_A_TIME,
      checkedAt: SINCE_A_TIME,
      onDoNotList: false,
    });
    expectDuring(delistedIn(whilePaused)?.delistedAt, run);
    expect(textOf(whilePaused)).toContain(`Reason: Release week.\nIts maintainers can resume it.\nDelisted by the sync on `);
    // The resume changed the status and left the mark, so there is still no page.
    expect(resumed.structuredContent).toMatchObject({ status: 'approved', statusReason: null, resumableBy: null });
    expect(delistedIn(resumed)).toMatchObject({ repo: APP, showed: 'archived', delistedAt: delistedIn(whilePaused)?.delistedAt });
    expect(textOf(resumed)).toContain(`${APP}: approved. Registered by its maintainers.\nDelisted by the sync on `);
    // The next check paused it for Good First Token, as the text warned.
    expect(afterTheCheck.structuredContent).toMatchObject({ status: 'paused', statusReason: ARCHIVED, resumableBy: 'admins' });
    expect(textOf(afterTheCheck)).toContain(`Reason: ${ARCHIVED}\nOnly Good First Token's admins can resume it.\nDelisted by the sync on `);
    expect(delistedIn(afterTheCheck)).toMatchObject({ repo: APP, showed: 'archived' });
    expect(await getProject(env.DB, APP)).toMatchObject({ status: 'paused', statusChangedBy: null });
    expect(await page(`/${APP}`)).toBe(404);
  });

  test('an admin who takes the pause over hears it is delisted', async () => {
    const { run } = await pausedThenArchived();
    const admin = await connectAgent(github, ADMIN.login);

    const paused = await call(admin, 'admin_pause_project', { repo: APP, reason: 'Checking the repo.' });

    expect(paused.structuredContent).toMatchObject({ repo: APP, status: 'paused', changed: true });
    expect(delistedIn(paused)).toEqual({
      repo: APP,
      showed: 'archived',
      reason: ARCHIVED,
      delistedAt: SINCE_A_TIME,
      checkedAt: SINCE_A_TIME,
      onDoNotList: false,
    });
    expectDuring(delistedIn(paused)?.delistedAt, run);
    expect(textOf(paused)).toContain(`Paused ${APP}. Agents get no new claims on it until an admin resumes it.\nDelisted by the sync on `);
  });
});

describe('a mark in other words, from before the sync kept its time', () => {
  test('still hides the page, and project_status says what it can: the reason, and that the time is not known', async () => {
    const agent = await listedAndRead();
    // Before migration 0006, the sync delisted a project by pausing it for
    // Good First Token, and one could have no reason. Its row then had no
    // read of the repos, and 0006 marks the project with words of its own.
    await setProjectStatus(env.DB, APP, { status: 'paused', reason: null, changedBy: null }, Date.now());
    await env.DB.prepare('UPDATE issue_syncs SET repos_read_at = NULL WHERE project = ?').bind(APP).run();
    const { TEST_MIGRATIONS } = env as Env & { TEST_MIGRATIONS: D1Migration[] };
    const marks = TEST_MIGRATIONS.find((m) => m.name === '0006_delisting.sql')?.queries.filter((q) => /^\s*INSERT\b/i.test(q)) ?? [];
    expect(marks).toHaveLength(1);
    for (const query of marks) await env.DB.prepare(query).run();

    const status = await call(agent, 'project_status', { repo: APP });
    const text = textOf(status);

    expect(delistedIn(status)).toEqual({
      repo: null,
      showed: null,
      reason: 'GitHub showed its repo private, archived, blocked, or gone.',
      delistedAt: null,
      checkedAt: null,
      onDoNotList: false,
    });
    expect(status.structuredContent?.counts).toMatchObject({ taggedIssues: null });
    expect(text).toContain(
      "Delisted by the sync at a time that isn't known: GitHub showed its repo private, archived, blocked, or gone. The project has no page,",
    );
    expect(text).not.toContain('last checked');
    expect(await page(`/${APP}`)).toBe(404);
  });
});

describe('a project the sync delisted whose issue repo went on the do-not-list', () => {
  test("keeps its mark, which the sync no longer reads, and project_status says the page stays gone while the repo is on the list", async () => {
    const agent = await listedAndRead(ISSUES_IN_DESKTOP);
    sampleRepo(DESKTOP).archived = true;
    await delistingRun();
    const admin = await connectAgent(github, ADMIN.login);
    await call(admin, 'admin_remove_project', { repo: DESKTOP });
    sampleRepo(DESKTOP).archived = false;
    const run = await sync();

    const status = await call(agent, 'project_status', { repo: APP });
    const text = textOf(status);

    expect(run.checked).toBe(0);
    expect(delistedIn(status)).toMatchObject({ repo: DESKTOP, showed: 'archived', onDoNotList: true });
    expect(text).toContain(
      "The project's repo or issue repo is on the do-not-list, so the sync doesn't read its repos, and the page stays gone while it is on the list.",
    );
    expect(text).not.toContain('comes back by itself');
    expect(await page(`/${APP}`)).toBe(404);
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
  test('project_status and the admin say nothing of a delisting, the count shows again, and the page is back', async () => {
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
    expect(status.structuredContent).toMatchObject({ status: 'paused', resumableBy: 'admins', delisted: null, counts: { taggedIssues: 1 } });
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
    expect(refreshed.structuredContent).toMatchObject({ status: 'approved', refresh: 'read', delisted: null, resumableBy: null });
    expect(textOf(refreshed)).not.toContain('Delisted');
    expect(await page(`/${APP}`)).toBe(200);
  });
});
