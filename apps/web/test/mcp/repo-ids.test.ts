import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  changeSettings,
  createProject,
  getIssueSync,
  getProject,
  getWaitingRemoval,
  savePerson,
  setProjectStatus,
  settingsHistory,
  statusHistory,
  storedRepoIds,
} from '../../src/db';
import type { ProjectSettingsInput } from '@goodfirsttoken/core';
import { syncTaggedIssues } from '../../src/sync/issues';
import { startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { jobDeps } from '../sync/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from './helpers';

// A project is kept under its repo's name, and also under GitHub's ID for
// the repo, which the repo keeps through a rename and a new repo under the
// old name never has. Every maintainer check, admin listing, and sync read
// compares the two. The people and repos are the GitHub fake's sample
// data: sample-maintainer is an admin of the sample-owner repos, priya has
// no role on them, and sample-admin is the site's admin here. The new repos
// are made in the fake by each test. Every policy and reason is made up.

let github: GitHubFake;
const configuredAdmins = env.ADMIN_GITHUB_IDS;
const ADMIN = { githubId: 1010, login: 'sample-admin' };
const MAINTAINER_ID = 1009;
const HOUR = 3_600_000;
const APP = 'sample-owner/sample-app';
const RENAMED = 'sample-owner/sample-app-next';
const BUNDLER = 'sample-owner/sample-bundler';
const TOOLS = 'sample-owner/sample-tools';
const POLICY = {
  quote: 'AI help is fine. Write the PR description yourself.',
  url: `https://github.com/${BUNDLER}/blob/main/CONTRIBUTING.md`,
  tier: 'allows_with_conditions' as const,
};

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
  env.ADMIN_GITHUB_IDS = String(ADMIN.githubId);
  vi.spyOn(env.MCP_LIMITER, 'limit').mockResolvedValue({ success: true });
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

async function call(agent: ConnectedAgent, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await agent.client.callTool({ name, arguments: args })) as Result;
}

function textOf(result: Result): string {
  return result.content.map((c) => c.text).join('\n');
}

function repoRecord(repo: string) {
  const record = github.state.repos[repo];
  if (!record) throw new Error(`missing sample repo ${repo}`);
  return record;
}

function idOf(repo: string): number {
  return repoRecord(repo).id;
}

/** The IDs stored for the project's code repo and issue repo, by role. */
async function idsOf(project: string): Promise<{ code: number | null; issues: number | null }> {
  const stored = await storedRepoIds(env.DB, [project]);
  const code = stored.find((entry) => entry.role === 'code')?.id ?? null;
  const row = await env.DB.prepare('SELECT issue_repo_id FROM projects WHERE repo = ?').bind(project).first<{ issue_repo_id: number | null }>();
  return { code, issues: row?.issue_repo_id ?? null };
}

/** Registers the repo as sample-maintainer, and has the admin approve it, or reject it. */
async function registered(
  agent: ConnectedAgent,
  repo = APP,
  settings: Record<string, unknown> = { tags: ['help wanted'] },
  status: 'approved' | 'rejected' = 'approved',
): Promise<void> {
  const saved = await call(agent, 'register_project', { repo, settings });
  if (saved.structuredContent?.saved !== true) throw new Error(textOf(saved));
  await savePerson(env.DB, ADMIN, Date.now());
  const reason = status === 'rejected' ? 'Not yet.' : null;
  await setProjectStatus(env.DB, repo, { status, reason, changedBy: ADMIN.githubId }, Date.now());
}

/**
 * GitHub gives the repo's name to a new repo that priya is an admin of: the
 * project's repo was renamed away, or deleted, first.
 */
function replace(repo: string, how: 'renamed' | 'deleted'): number {
  if (how === 'renamed') github.renameRepo(repo, `${repo}-next`);
  else github.deleteRepo(repo);
  return github.createRepo(repo, { admins: ['priya'] });
}

function sync() {
  return syncTaggedIssues(jobDeps(github));
}

const REFUSED = `Refused (not_maintainer): The repo GitHub shows as ${APP} is not the one Good First Token keeps under that name: its GitHub ID differs. Only an admin or maintainer of the repo Good First Token keeps can do this.`;

describe('a new repo under a project’s name', () => {
  test.each(['renamed', 'deleted'] as const)(
    'when the project’s repo was %s, the new repo’s admin is refused every maintainer tool on the project, and nothing changes',
    async (how) => {
      const maintainer = await connectAgent(github, 'sample-maintainer');
      await registered(maintainer);
      const before = { history: await statusHistory(env.DB, APP), settings: await settingsHistory(env.DB, APP) };
      replace(APP, how);
      const newAdmin = await connectAgent(github, 'priya');

      const calls = {
        project_status: await call(newAdmin, 'project_status', { repo: APP, refresh: true }),
        update_project: await call(newAdmin, 'update_project', { repo: APP, settings: { claimsPerIssue: 1 } }),
        pause: await call(newAdmin, 'pause_project', { repo: APP, paused: true, reason: 'Mine now.' }),
        request_removal: await call(newAdmin, 'request_removal', { repo: APP, reason: 'Take it down.' }),
      };
      // A pause its maintainers made, which only they can lift.
      await setProjectStatus(env.DB, APP, { status: 'paused', reason: 'Release week.', changedBy: MAINTAINER_ID }, Date.now());
      const resume = await call(newAdmin, 'pause_project', { repo: APP, paused: false });

      for (const [name, result] of Object.entries({ ...calls, resume })) {
        expect(textOf(result), name).toBe(REFUSED);
      }
      expect(await getProject(env.DB, APP)).toMatchObject({ status: 'paused', statusChangedBy: MAINTAINER_ID });
      expect(await statusHistory(env.DB, APP)).toHaveLength(before.history.length + 1);
      expect(await settingsHistory(env.DB, APP)).toEqual(before.settings);
      expect(await getWaitingRemoval(env.DB, APP)).toBeNull();
      expect(await getIssueSync(env.DB, APP)).toBeNull();
    },
  );

  test.each(['renamed', 'deleted'] as const)(
    'when the project’s repo was %s, the new repo’s admin can’t register it again over the rejected registration',
    async (how) => {
      const maintainer = await connectAgent(github, 'sample-maintainer');
      await registered(maintainer, APP, { tags: ['help wanted'] }, 'rejected');
      replace(APP, how);
      const newAdmin = await connectAgent(github, 'priya');

      const result = await call(newAdmin, 'register_project', { repo: APP, settings: { tags: ['help wanted'] } });

      expect(textOf(result)).toBe(REFUSED);
      expect(await getProject(env.DB, APP)).toMatchObject({ status: 'rejected', addedBy: MAINTAINER_ID });
    },
  );

  test('the new repo’s admin can’t take over a listing an admin made from the old repo’s policy, and the admin can’t list the new repo over it', async () => {
    const admin = await connectAgent(github, ADMIN.login);
    const listed = await call(admin, 'admin_add_project', { repo: BUNDLER, policy: POLICY, settings: { tags: ['help wanted'] } });
    expect(listed.structuredContent).toMatchObject({ repo: BUNDLER, updated: false });
    expect(await idsOf(BUNDLER)).toEqual({ code: idOf(BUNDLER), issues: idOf(BUNDLER) });
    replace(BUNDLER, 'renamed');
    const newAdmin = await connectAgent(github, 'priya');

    const takeover = await call(newAdmin, 'register_project', { repo: BUNDLER, settings: { tags: ['help wanted'] } });
    const relisting = await call(admin, 'admin_add_project', {
      repo: BUNDLER,
      policy: { ...POLICY, quote: 'Agents welcome.' },
      settings: { tags: ['help wanted'] },
    });

    expect(textOf(takeover)).toContain('Refused (not_maintainer)');
    expect(textOf(relisting)).toBe(
      `Refused (repo_not_eligible): The repo GitHub shows as ${BUNDLER} is not the one Good First Token keeps under that name: its GitHub ID differs. It can't be listed under that name.`,
    );
    expect(await getProject(env.DB, BUNDLER)).toMatchObject({ source: 'policy', policy: POLICY, addedBy: ADMIN.githubId });
  });

  test('the admin can’t list another project with its issues in a new repo under the name of a project’s issue repo', async () => {
    const maintainer = await connectAgent(github, 'sample-maintainer');
    await registered(maintainer, APP, { tags: ['help wanted'], issueRepo: TOOLS });
    replace(TOOLS, 'renamed');
    const admin = await connectAgent(github, ADMIN.login);

    const listed = await call(admin, 'admin_add_project', { repo: BUNDLER, policy: POLICY, settings: { tags: ['help wanted'], issueRepo: TOOLS } });

    expect(textOf(listed)).toBe(
      `Refused (repo_not_eligible): The repo GitHub shows as ${TOOLS} is not the one Good First Token keeps under that name: its GitHub ID differs. It can't be listed under that name.`,
    );
    expect(await getProject(env.DB, BUNDLER)).toBeNull();
  });

  test('the sync delists the project, and pauses it, saying another repo has its name', async () => {
    const maintainer = await connectAgent(github, 'sample-maintainer');
    await registered(maintainer);
    replace(APP, 'deleted');

    const run = await sync();

    const taken = `GitHub shows another repo under the name ${APP} now.`;
    expect(run.paused).toEqual([APP]);
    expect(await getIssueSync(env.DB, APP)).toMatchObject({ delisted: taken });
    expect(await getProject(env.DB, APP)).toMatchObject({ status: 'paused', statusReason: taken, statusChangedBy: null });
  });

  test('project_status tells the project’s maintainer that another repo has its name, once the sync delisted it', async () => {
    const maintainer = await connectAgent(github, 'sample-maintainer');
    await registered(maintainer);
    replace(APP, 'renamed');

    await sync();
    const status = await call(maintainer, 'project_status', { repo: APP });

    expect(textOf(status)).toBe(
      `Refused (not_maintainer): Only an admin or maintainer of ${APP} on GitHub can do this. Good First Token delisted this project: GitHub shows another repo under the name ${APP} now.`,
    );
  });

  test('a new repo under the name of a project’s issue repo delists the project, and its maintainer can’t keep the issues there', async () => {
    const maintainer = await connectAgent(github, 'sample-maintainer');
    await registered(maintainer, APP, { tags: ['help wanted'], issueRepo: TOOLS });
    expect(await idsOf(APP)).toEqual({ code: idOf(APP), issues: idOf(TOOLS) });
    replace(TOOLS, 'renamed');
    repoRecord(TOOLS).collaborators['sample-maintainer'] = 'admin';

    const run = await sync();
    const update = await call(maintainer, 'update_project', { repo: APP, settings: { claimsPerIssue: 1 } });

    expect(run.paused).toEqual([APP]);
    expect(await getIssueSync(env.DB, APP)).toMatchObject({
      delisted: `GitHub shows another repo under the name ${TOOLS} now.`,
    });
    expect(textOf(update)).toBe(`Refused (not_maintainer): Only an admin or maintainer of ${TOOLS} on GitHub can keep this project's issues there.`);
  });
});

describe('a repo renamed onto a name another project keeps', () => {
  test('its own project’s maintainer still manages it by its name, and can’t manage the other project by the name it took', async () => {
    const maintainer = await connectAgent(github, 'sample-maintainer');
    await registered(maintainer);
    await registered(maintainer, TOOLS);
    // The first project's repo is deleted, and the second's is renamed onto its name.
    github.deleteRepo(APP);
    github.renameRepo(TOOLS, APP);

    const own = await call(maintainer, 'project_status', { repo: TOOLS });
    const other = await call(maintainer, 'project_status', { repo: APP });

    expect(own.structuredContent).toMatchObject({ repo: TOOLS, status: 'approved' });
    expect(textOf(other)).toBe(REFUSED);
  });

  test('can’t be registered by an old name GitHub sends on to it, over the other project', async () => {
    const maintainer = await connectAgent(github, 'sample-maintainer');
    await registered(maintainer, TOOLS, { tags: ['help wanted'] }, 'rejected');
    github.deleteRepo(TOOLS);
    github.renameRepo(APP, TOOLS);

    const result = await call(maintainer, 'register_project', { repo: APP, settings: { tags: ['help wanted'] } });

    expect(textOf(result)).toContain('Refused (not_maintainer)');
    expect(await getProject(env.DB, TOOLS)).toMatchObject({ status: 'rejected' });
    expect(await idsOf(TOOLS)).not.toMatchObject({ code: idOf(TOOLS) });
  });

  test('can’t have its removal asked for by an old name GitHub sends on to it, under the other project’s name', async () => {
    const maintainer = await connectAgent(github, 'sample-maintainer');
    await registered(maintainer, TOOLS);
    github.deleteRepo(TOOLS);
    github.renameRepo(APP, TOOLS);

    const result = await call(maintainer, 'request_removal', { repo: APP, reason: 'Take us off, please.' });

    expect(textOf(result)).toContain('Refused (not_maintainer)');
    expect(await getWaitingRemoval(env.DB, TOOLS)).toBeNull();
  });
});

describe('moving a project’s issues', () => {
  test('keeps the new issue repo’s ID, so a new repo under its name is caught at once', async () => {
    const maintainer = await connectAgent(github, 'sample-maintainer');
    await registered(maintainer);

    const moved = await call(maintainer, 'update_project', { repo: APP, settings: { issueRepo: TOOLS } });

    expect(moved.structuredContent).toMatchObject({ repo: APP, changed: ['issueRepo'] });
    expect(await idsOf(APP)).toEqual({ code: idOf(APP), issues: idOf(TOOLS) });
  });
});

describe('a rename GitHub follows', () => {
  test('keeps the project under its name, and its maintainers manage it by that name, since the ID is the same', async () => {
    const maintainer = await connectAgent(github, 'sample-maintainer');
    await registered(maintainer);
    github.renameRepo(APP, RENAMED);

    const status = await call(maintainer, 'project_status', { repo: APP });
    const update = await call(maintainer, 'update_project', { repo: APP, settings: { claimsPerIssue: 1 } });
    const run = await sync();
    const byNewName = await call(maintainer, 'project_status', { repo: RENAMED });

    expect(status.structuredContent).toMatchObject({ repo: APP, status: 'approved', delisted: null });
    expect(update.structuredContent).toMatchObject({ repo: APP, changed: ['claimsPerIssue'] });
    expect(run).toMatchObject({ paused: [], finished: 1 });
    expect(await getIssueSync(env.DB, APP)).toMatchObject({ delisted: null });
    expect(await getProject(env.DB, APP)).toMatchObject({ repo: APP, status: 'approved' });
    expect(await getProject(env.DB, RENAMED)).toBeNull();
    expect(textOf(byNewName)).toBe(`Refused (not_found): ${RENAMED} is not a project on Good First Token. Register it with register_project.`);
    expect(await idsOf(APP)).toEqual({ code: idOf(RENAMED), issues: idOf(RENAMED) });
  });
});

describe('a renamed project listed again', () => {
  test('is listed again under the name it has, and the admin can’t list it again under its new name', async () => {
    const admin = await connectAgent(github, ADMIN.login);
    await call(admin, 'admin_add_project', { repo: BUNDLER, policy: POLICY, settings: { tags: ['help wanted'] } });
    const renamed = `${BUNDLER}-next`;
    github.renameRepo(BUNDLER, renamed);
    const quote = { ...POLICY, quote: 'Agents welcome. Write the PR description yourself.' };

    const byNewName = await call(admin, 'admin_add_project', { repo: renamed, policy: quote, settings: { tags: ['help wanted'] } });
    const byOldName = await call(admin, 'admin_add_project', { repo: BUNDLER, policy: quote, settings: { tags: ['help wanted'] } });

    expect(textOf(byNewName)).toBe(
      `Refused (repo_not_eligible): The repo GitHub shows as ${renamed} is listed as ${BUNDLER}, by its GitHub ID. List it as ${BUNDLER}.`,
    );
    expect(byOldName.structuredContent).toMatchObject({ repo: BUNDLER, updated: true });
    expect(await getProject(env.DB, BUNDLER)).toMatchObject({ policy: quote });
    expect(await getProject(env.DB, renamed)).toBeNull();
    expect(await storedRepoIds(env.DB, [renamed])).toEqual([]);
  });
});

describe('a project stored before IDs were kept', () => {
  /** A project as it was stored before this change: with no IDs, added at `addedAt`. */
  async function storedWithoutIds(repo: string, settings: ProjectSettingsInput, addedAt = Date.now()): Promise<void> {
    await savePerson(env.DB, { githubId: MAINTAINER_ID, login: 'sample-maintainer' }, addedAt);
    await createProject(
      env.DB,
      { repo, status: 'approved', source: 'registered', policy: null, settings, addedBy: MAINTAINER_ID },
      addedAt,
    );
  }

  test('gets its IDs from the next maintainer check, and from then on a new repo under its name is refused', async () => {
    await storedWithoutIds(APP, { tags: ['help wanted'] });
    const maintainer = await connectAgent(github, 'sample-maintainer');
    expect(await idsOf(APP)).toEqual({ code: null, issues: null });

    const status = await call(maintainer, 'project_status', { repo: APP });
    const filled = await idsOf(APP);
    replace(APP, 'renamed');
    const newAdmin = await connectAgent(github, 'priya');
    const refused = await call(newAdmin, 'pause_project', { repo: APP, paused: true });

    expect(status.structuredContent).toMatchObject({ repo: APP, status: 'approved' });
    expect(filled).toEqual({ code: idOf(`${APP}-next`), issues: idOf(`${APP}-next`) });
    expect(textOf(refused)).toBe(REFUSED);
  });

  test('gets its code repo’s and issue repo’s IDs from the next sync', async () => {
    await storedWithoutIds(APP, { tags: ['help wanted'], issueRepo: TOOLS });

    await sync();

    expect(await idsOf(APP)).toEqual({ code: idOf(APP), issues: idOf(TOOLS) });
    expect(await getIssueSync(env.DB, APP)).toMatchObject({ delisted: null });
  });

  test('counts its issue repo from the save that named it, so an issue repo made after the project was added still gets its ID', async () => {
    const now = Date.now();
    await storedWithoutIds(APP, { tags: ['help wanted'] }, now - 3 * HOUR);
    repoRecord(TOOLS).createdAt = new Date(now - 150 * 60_000).toISOString();
    await changeSettings(env.DB, APP, { issueRepo: TOOLS }, MAINTAINER_ID, now - 2 * HOUR);
    await changeSettings(env.DB, APP, { claimsPerIssue: 1 }, MAINTAINER_ID, now - HOUR);

    const stored = await storedRepoIds(env.DB, [TOOLS]);
    await sync();

    expect(stored).toEqual([{ project: APP, role: 'issues', repo: TOOLS, id: null, since: now - 2 * HOUR }]);
    expect(await idsOf(APP)).toEqual({ code: idOf(APP), issues: idOf(TOOLS) });
    expect(await getIssueSync(env.DB, APP)).toMatchObject({ delisted: null });
  });

  test('takes on a repo GitHub made at the same moment the project was stored', async () => {
    const addedAt = Date.now() - HOUR;
    await storedWithoutIds(APP, { tags: ['help wanted'] }, addedAt);
    repoRecord(APP).createdAt = new Date(addedAt).toISOString();
    const maintainer = await connectAgent(github, 'sample-maintainer');

    const status = await call(maintainer, 'project_status', { repo: APP });

    expect(status.structuredContent).toMatchObject({ repo: APP, status: 'approved' });
    expect(await idsOf(APP)).toEqual({ code: idOf(APP), issues: idOf(APP) });
  });

  test('never takes on a repo GitHub made after the project was stored: the check refuses, and the sync delists it', async () => {
    await storedWithoutIds(APP, { tags: ['help wanted'] }, Date.now() - 60_000);
    replace(APP, 'deleted');
    const newAdmin = await connectAgent(github, 'priya');

    const refused = await call(newAdmin, 'update_project', { repo: APP, settings: { claimsPerIssue: 1 } });
    const run = await sync();

    expect(textOf(refused)).toBe(REFUSED);
    expect(run.paused).toEqual([APP]);
    expect(await idsOf(APP)).toEqual({ code: null, issues: null });
  });
});
