import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  addPr,
  createProject,
  getProject,
  listProjectsByIssueRepo,
  savePerson,
  saveClaim,
  saveIssues,
  setPrState,
  setProjectStatus,
  settingsHistory,
  statusHistory,
} from '../../src/db';
import { APP, startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from './helpers';
import { newClaim } from '@goodfirsttoken/core';

// The maintainer's tools, called by an agent through the MCP client SDK
// against the whole Worker and the GitHub fake. The people and repos are the
// fake's sample data: octo-maintainer is an admin of sample-owner/sample-harbor
// and meanwhileso/goodfirsttoken, sample-maintainer is an admin of the other
// sample-owner repos, kenji can write to meanwhileso/goodfirsttoken, and
// priya has no role anywhere. The policy text is made up.

let github: GitHubFake;
const configuredAdmins = env.ADMIN_GITHUB_IDS;
const admin = { githubId: 9001, login: 'sample-admin' };
const HARBOR = 'sample-owner/sample-harbor';
const APP_REPO = 'sample-owner/sample-app';
const TOOLS = 'sample-owner/sample-tools';
const BUNDLER = 'sample-owner/sample-bundler';

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
});

afterEach(() => {
  env.ADMIN_GITHUB_IDS = configuredAdmins;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Result {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function call(agent: ConnectedAgent, name: string, args: Record<string, unknown>): Promise<Result> {
  return (await agent.client.callTool({ name, arguments: args })) as Result;
}

function textOf(result: Result): string {
  return result.content.map((c) => c.text).join('\n');
}

/** The GitHub token the fake gave `login`'s agent when it signed in. */
function gitHubTokenOf(login: string): string {
  const found = Object.entries(github.state.tokens).find(
    ([, grant]) => grant.clientId === APP.clientId && grant.login === login,
  );
  if (!found) throw new Error(`${login} has no agent token`);
  return found[0];
}

function sampleRepo(name: string) {
  const repo = github.state.repos[name];
  if (!repo) throw new Error(`missing sample repo ${name}`);
  return repo;
}

function hasLabel(name: string, label: string): boolean {
  return sampleRepo(name).labels.some((l) => l.name.toLowerCase() === label);
}

/** A listing an admin made from the repo's AI policy. */
async function policyListing(repo: string, status: 'approved' | 'paused' | 'rejected' = 'approved') {
  await savePerson(env.DB, admin, Date.now());
  await createProject(
    env.DB,
    {
      repo,
      status: 'approved',
      source: 'policy',
      policy: {
        quote: 'Agent pull requests are welcome once a person has read the diff.',
        url: `https://github.com/${repo}/blob/main/CONTRIBUTING.md`,
        tier: 'allows_with_conditions',
      },
      settings: { tags: ['contribution welcome'], prMode: 'automatic', agentNotes: 'Run the tests first.' },
      addedBy: admin.githubId,
    },
    Date.now(),
  );
  if (status === 'paused') {
    await setProjectStatus(env.DB, repo, { status: 'paused', reason: 'Checking the policy.', changedBy: admin.githubId }, Date.now());
  }
  if (status === 'rejected') {
    await setProjectStatus(env.DB, repo, { status: 'rejected', reason: 'The policy changed.', changedBy: admin.githubId }, Date.now());
  }
}

/** GitHub's answer for the repo itself, changed the way GitHub could send it. */
function repoAnswer(repo: string, change: (body: Record<string, unknown>) => void): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await github.fetch(request);
    if (request.method !== 'GET' || new URL(request.url).pathname !== `/repos/${repo}`) return response;
    const body = await response.json<Record<string, unknown>>();
    change(body);
    return Response.json(body, { status: response.status });
  });
}

/** GitHub refusing to create labels, as an organization's OAuth app access restrictions do. */
function refuseLabels(): void {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/labels')) {
      return Promise.resolve(
        Response.json({ message: 'the sample-owner organization has enabled OAuth App access restrictions' }, { status: 403 }),
      );
    }
    return github.fetch(request);
  });
}

async function approve(repo: string): Promise<void> {
  await savePerson(env.DB, admin, Date.now());
  await setProjectStatus(env.DB, repo, { status: 'approved', reason: null, changedBy: admin.githubId }, Date.now());
}

describe('register_project', () => {
  test('with no settings, it proposes settings from the repo, with the reasons, and saves nothing', async () => {
    const agent = await connectAgent(github, 'octo-maintainer');

    const result = await call(agent, 'register_project', { repo: HARBOR });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      repo: HARBOR,
      saved: false,
      status: null,
      settings: { tags: ['help wanted'], personWrittenDescription: true, prMode: 'reviewed' },
      reasons: [
        { setting: 'tags', reason: 'a label the repo has for outside help' },
        {
          setting: 'personWrittenDescription',
          reason: 'CONTRIBUTING.md asks contributors to write the PR description themselves',
        },
      ],
      createdLabels: [],
    });
    expect(textOf(result)).toContain('Nothing is saved yet');
    expect(await getProject(env.DB, HARBOR)).toBeNull();
  });

  test('with settings, it saves the project as pending, registered by the caller, with the settings history naming them', async () => {
    const agent = await connectAgent(github, 'octo-maintainer');

    const result = await call(agent, 'register_project', {
      repo: HARBOR,
      settings: { tags: ['help wanted'], claimsPerIssue: 2 },
    });

    expect(result.structuredContent).toMatchObject({ repo: HARBOR, saved: true, status: 'pending', createdLabels: [] });
    expect(textOf(result)).toContain('A Good First Token admin reviews it before agents can claim its issues.');
    expect(await getProject(env.DB, HARBOR)).toMatchObject({
      status: 'pending',
      source: 'registered',
      policy: null,
      addedBy: 1008,
      settings: { tags: ['help wanted'], claimsPerIssue: 2, prMode: 'reviewed' },
    });
    expect(await settingsHistory(env.DB, HARBOR)).toMatchObject([{ version: 1, changedBy: 1008 }]);
    expect(await statusHistory(env.DB, HARBOR)).toMatchObject([{ status: 'pending', changedBy: 1008 }]);
  });

  test("a repo named in another case is registered under GitHub's own name for it", async () => {
    const agent = await connectAgent(github, 'octo-maintainer');

    const result = await call(agent, 'register_project', { repo: 'Sample-Owner/SAMPLE-harbor', settings: { tags: ['help wanted'] } });

    expect(result.structuredContent).toMatchObject({ repo: HARBOR });
    expect((await getProject(env.DB, HARBOR))?.repo).toBe(HARBOR);
  });

  test('a caller who can write to the repo but has neither admin nor maintain on it is refused', async () => {
    const agent = await connectAgent(github, 'kenji');

    const result = await call(agent, 'register_project', {
      repo: 'meanwhileso/goodfirsttoken',
      settings: { tags: ['goodfirsttoken'] },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'Refused (not_maintainer): Only an admin or maintainer of meanwhileso/goodfirsttoken on GitHub can do this.',
    );
    expect(await getProject(env.DB, 'meanwhileso/goodfirsttoken')).toBeNull();
  });

  test('a caller GitHub gives the maintain role, without admin, can register', async () => {
    sampleRepo(APP_REPO).collaborators['octo-maintainer'] = 'maintain';
    const agent = await connectAgent(github, 'octo-maintainer');

    const result = await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['help wanted'] } });

    expect(result.structuredContent).toMatchObject({ saved: true, status: 'pending' });
  });

  test('a private repo is refused: GitHub shows it to no token with only public_repo, even its admin\'s', async () => {
    sampleRepo(APP_REPO).private = true;
    const agent = await connectAgent(github, 'sample-maintainer');

    const result = await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['help wanted'] } });

    expect(textOf(result)).toBe(
      `Refused (not_maintainer): GitHub shows you no public repo named ${APP_REPO}. Only an admin or maintainer of a public repo can do this.`,
    );
    expect(github.calls.filter((c) => c.operation === 'GET /repos/{owner}/{repo}').map((c) => c.status)).toEqual([404]);
    expect(await getProject(env.DB, APP_REPO)).toBeNull();
  });

  test('a private repo GitHub does show, to a token with the repo scope, is refused as not public', async () => {
    sampleRepo(APP_REPO).private = true;
    const agent = await connectAgent(github, 'sample-maintainer');
    const grant = github.state.tokens[gitHubTokenOf('sample-maintainer')];
    if (grant) grant.scopes = ['repo'];

    const result = await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['goodfirsttoken'] } });

    expect(textOf(result)).toBe(`Refused (repo_not_eligible): ${APP_REPO} is not public. Only public repos can be registered.`);
    expect(await getProject(env.DB, APP_REPO)).toBeNull();
    expect(hasLabel(APP_REPO, 'goodfirsttoken')).toBe(false);
  });

  test('an archived repo is refused', async () => {
    sampleRepo(APP_REPO).archived = true;
    const agent = await connectAgent(github, 'sample-maintainer');

    const result = await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['help wanted'] } });

    expect(textOf(result)).toMatch(/^Refused \(repo_not_eligible\): sample-owner\/sample-app is archived on GitHub\./);
    expect(await getProject(env.DB, APP_REPO)).toBeNull();
  });

  test('a repo that lets only collaborators open pull requests is refused', async () => {
    sampleRepo(APP_REPO).pullRequestCreationPolicy = 'collaborators_only';
    const agent = await connectAgent(github, 'sample-maintainer');

    const result = await call(agent, 'register_project', { repo: APP_REPO });

    expect(textOf(result)).toBe(
      `Refused (repo_not_eligible): ${APP_REPO} lets only collaborators open pull requests. Let anyone open them on GitHub to register it.`,
    );
  });

  test('a repo with pull requests turned off is refused', async () => {
    sampleRepo(APP_REPO).hasPullRequests = false;
    const agent = await connectAgent(github, 'sample-maintainer');

    const result = await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['help wanted'] } });

    expect(textOf(result)).toMatch(/^Refused \(repo_not_eligible\): .* has pull requests turned off on GitHub\./);
    expect(await getProject(env.DB, APP_REPO)).toBeNull();
  });

  test('picking the goodfirsttoken tag creates the label in the repo, with the maintainer\'s own token', async () => {
    const agent = await connectAgent(github, 'sample-maintainer');
    const start = github.calls.length;

    const result = await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['goodfirsttoken'] } });

    expect(result.structuredContent).toMatchObject({ saved: true, createdLabels: ['goodfirsttoken'] });
    expect(textOf(result)).toContain('Created 1 label in the issue repo: goodfirsttoken.');
    expect(sampleRepo(APP_REPO).labels.find((l) => l.name === 'goodfirsttoken')).toMatchObject({
      color: '7057ff',
      description: 'Tagged for outside help through Good First Token',
    });
    const created = github.calls.slice(start).find((c) => c.operation === 'POST /repos/{owner}/{repo}/labels');
    expect(created).toMatchObject({ token: gitHubTokenOf('sample-maintainer'), login: 'sample-maintainer', status: 201 });
  });

  test('when the repo already has the label, in any case, registering creates none', async () => {
    const agent = await connectAgent(github, 'octo-maintainer');
    const start = github.calls.length;

    const result = await call(agent, 'register_project', {
      repo: 'meanwhileso/goodfirsttoken',
      settings: { tags: ['GoodFirstToken'] },
    });

    expect(result.structuredContent).toMatchObject({ saved: true, createdLabels: [] });
    expect(github.calls.slice(start).some((c) => c.method === 'POST')).toBe(false);
    expect(sampleRepo('meanwhileso/goodfirsttoken').labels.filter((l) => l.name.toLowerCase() === 'goodfirsttoken')).toHaveLength(1);
  });

  test('without the goodfirsttoken tag, no label is made', async () => {
    const agent = await connectAgent(github, 'sample-maintainer');

    await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['help wanted'] } });

    expect(hasLabel(APP_REPO, 'goodfirsttoken')).toBe(false);
  });

  test('when GitHub refuses to create the label with the caller\'s token, nothing is saved and the refusal says why', async () => {
    const agent = await connectAgent(github, 'sample-maintainer');
    refuseLabels();

    const result = await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['goodfirsttoken'] } });

    expect(textOf(result)).toBe(
      'Refused (label_not_created): GitHub refused to create the goodfirsttoken label in sample-owner/sample-app with your token (403: the sample-owner organization has enabled OAuth App access restrictions). Nothing was saved. Create the label in the repo on GitHub, or pick another tag, then call register_project again.',
    );
    expect(await getProject(env.DB, APP_REPO)).toBeNull();
  });

  test('a repo GitHub describes without saying whether it takes pull requests, or who can open them, is refused', async () => {
    const agent = await connectAgent(github, 'sample-maintainer');
    repoAnswer(APP_REPO, (body) => Reflect.deleteProperty(body, 'has_pull_requests'));
    const noPulls = await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['help wanted'] } });
    repoAnswer(APP_REPO, (body) => Reflect.deleteProperty(body, 'pull_request_creation_policy'));
    const noPolicy = await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['help wanted'] } });

    expect(textOf(noPulls)).toBe(
      `Refused (repo_not_eligible): GitHub didn't say whether ${APP_REPO} takes pull requests. Only a repo that takes pull requests from anyone can be registered.`,
    );
    expect(textOf(noPolicy)).toBe(
      `Refused (repo_not_eligible): GitHub didn't say who can open pull requests on ${APP_REPO}. Only a repo that takes pull requests from anyone can be registered.`,
    );
    expect(await getProject(env.DB, APP_REPO)).toBeNull();
  });

  test('a repo GitHub gives a visibility other than public is refused, even when it says the repo is not private', async () => {
    const agent = await connectAgent(github, 'sample-maintainer');
    repoAnswer(APP_REPO, (body) => {
      body.visibility = 'internal';
    });

    const result = await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['help wanted'] } });

    expect(textOf(result)).toBe(`Refused (repo_not_eligible): ${APP_REPO} is not public. Only public repos can be registered.`);
    expect(await getProject(env.DB, APP_REPO)).toBeNull();
  });

  test('an issue repo the caller does not maintain is refused, and nothing is saved or created', async () => {
    const agent = await connectAgent(github, 'sample-maintainer');

    const result = await call(agent, 'register_project', {
      repo: APP_REPO,
      settings: { tags: ['goodfirsttoken'], issueRepo: HARBOR },
    });

    expect(textOf(result)).toBe(`Refused (not_maintainer): Only an admin or maintainer of ${HARBOR} on GitHub can do this.`);
    expect(await getProject(env.DB, APP_REPO)).toBeNull();
    expect(hasLabel(HARBOR, 'goodfirsttoken')).toBe(false);
    expect(hasLabel(APP_REPO, 'goodfirsttoken')).toBe(false);
  });

  test('a caller who maintains both repos can keep issues in the other one, and the label goes there', async () => {
    const agent = await connectAgent(github, 'sample-maintainer');
    const start = github.calls.length;

    const result = await call(agent, 'register_project', {
      repo: APP_REPO,
      settings: { tags: ['goodfirsttoken'], issueRepo: TOOLS },
    });

    expect(result.structuredContent).toMatchObject({ saved: true, createdLabels: ['goodfirsttoken'], settings: { issueRepo: TOOLS } });
    expect(hasLabel(TOOLS, 'goodfirsttoken')).toBe(true);
    expect(hasLabel(APP_REPO, 'goodfirsttoken')).toBe(false);
    // The issue repo's permission is asked of GitHub with the caller's token too.
    const reads = github.calls.slice(start).filter((c) => c.operation === 'GET /repos/{owner}/{repo}');
    expect(reads.map((c) => [new URL(c.url).pathname, c.login])).toContainEqual([`/repos/${TOOLS}`, 'sample-maintainer']);
  });

  test('a repo already registered is refused, and keeps its settings', async () => {
    const agent = await connectAgent(github, 'octo-maintainer');
    await call(agent, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });

    const again = await call(agent, 'register_project', { repo: HARBOR, settings: { tags: ['goodfirsttoken'] } });
    const proposal = await call(agent, 'register_project', { repo: HARBOR });

    expect(textOf(again)).toBe(
      `Refused (already_registered): ${HARBOR} is already registered, and is pending. See it with project_status, and change its settings with update_project.`,
    );
    expect(proposal.isError).toBe(true);
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ settingsVersion: 1, settings: { tags: ['help wanted'] } });
    expect(hasLabel(HARBOR, 'goodfirsttoken')).toBe(false);
  });

  test("registering a repo listed from its AI policy replaces the listing's settings, makes it registered, and keeps its status", async () => {
    await policyListing(APP_REPO);
    const agent = await connectAgent(github, 'sample-maintainer');

    const result = await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['help wanted'] } });

    expect(result.structuredContent).toMatchObject({ saved: true, status: 'approved' });
    expect(textOf(result)).toContain('Your settings replace the ones it was listed with, and apply now.');
    const project = await getProject(env.DB, APP_REPO);
    expect(project).toMatchObject({ source: 'registered', policy: null, status: 'approved', addedBy: 1009 });
    // Every setting is the maintainer's: the listing's PR mode and notes are gone.
    expect(project?.settings).toMatchObject({ tags: ['help wanted'], prMode: 'reviewed', agentNotes: '' });
    expect((await settingsHistory(env.DB, APP_REPO)).map((v) => v.changedBy)).toEqual([1009, admin.githubId]);
  });

  test('a paused listing taken over by its maintainer stays paused', async () => {
    await policyListing(APP_REPO, 'paused');
    const agent = await connectAgent(github, 'sample-maintainer');

    const result = await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['help wanted'] } });

    expect(result.structuredContent).toMatchObject({ status: 'paused' });
    expect(textOf(result)).toContain('Agents get no new claims on it until the pause is lifted.');
    expect(textOf(result)).not.toContain('apply now');
    expect(await getProject(env.DB, APP_REPO)).toMatchObject({ status: 'paused', statusChangedBy: admin.githubId });
  });

  test('a rejected listing taken over by its maintainer goes back to pending, so an admin reviews it again', async () => {
    await policyListing(APP_REPO, 'rejected');
    const agent = await connectAgent(github, 'sample-maintainer');

    const result = await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['help wanted'] } });

    expect(result.structuredContent).toMatchObject({ saved: true, status: 'pending' });
    expect(textOf(result)).toContain('A Good First Token admin reviews it before agents can claim its issues.');
    expect(await getProject(env.DB, APP_REPO)).toMatchObject({
      source: 'registered',
      status: 'pending',
      statusReason: null,
      statusChangedBy: 1009,
    });
    expect((await statusHistory(env.DB, APP_REPO))[0]).toMatchObject({ status: 'pending', reason: null, changedBy: 1009 });
  });
});

describe('update_project', () => {
  test('a change applies at once, and the history records who made it', async () => {
    const agent = await connectAgent(github, 'octo-maintainer');
    await call(agent, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });

    const result = await call(agent, 'update_project', { repo: HARBOR, settings: { prMode: 'automatic', claimsPerIssue: 5 } });

    expect(result.structuredContent).toMatchObject({
      repo: HARBOR,
      status: 'pending',
      changed: ['prMode', 'claimsPerIssue'],
      createdLabels: [],
      settings: { tags: ['help wanted'], prMode: 'automatic', claimsPerIssue: 5 },
    });
    expect(await settingsHistory(env.DB, HARBOR)).toMatchObject([
      { version: 2, changedBy: 1008, changed: ['prMode', 'claimsPerIssue'] },
      { version: 1, changedBy: 1008 },
    ]);
  });

  test('a setting that fails its check is refused, naming the field, and nothing changes', async () => {
    const agent = await connectAgent(github, 'octo-maintainer');
    await call(agent, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });

    const outOfRange = await call(agent, 'update_project', { repo: HARBOR, settings: { claimsPerIssue: 0, prMode: 'yolo' } });
    const unknown = await call(agent, 'update_project', { repo: HARBOR, settings: { claimsPerIsue: 2 } });
    const clash = await call(agent, 'update_project', { repo: HARBOR, settings: { excludedTags: ['Help Wanted'] } });

    expect(outOfRange.isError).toBe(true);
    expect(textOf(outOfRange)).toContain('settings.claimsPerIssue: must be a whole number from 1 to 10');
    expect(textOf(outOfRange)).toContain('settings.prMode: must be automatic or reviewed');
    expect(textOf(unknown)).toContain('claimsPerIsue');
    expect(textOf(clash)).toBe(
      'Refused (invalid_settings): Settings not saved.\nexcludedTags: lists "Help Wanted", which is also a tag',
    );
    expect(await settingsHistory(env.DB, HARBOR)).toHaveLength(1);
  });

  test('a listing made from a policy is refused, and the refusal says to take it over with register_project', async () => {
    await policyListing(APP_REPO);
    const agent = await connectAgent(github, 'sample-maintainer');

    const result = await call(agent, 'update_project', { repo: APP_REPO, settings: { prMode: 'reviewed' } });

    expect(textOf(result)).toBe(
      `Refused (listed_from_policy): ${APP_REPO} is listed from its AI policy. Take it over with register_project and your settings, then change them with update_project.`,
    );
    expect(await getProject(env.DB, APP_REPO)).toMatchObject({ source: 'policy', settings: { prMode: 'automatic' } });
    expect(await settingsHistory(env.DB, APP_REPO)).toHaveLength(1);
  });

  test('an issue repo the caller does not maintain is refused in an update, and the project keeps its own', async () => {
    const agent = await connectAgent(github, 'sample-maintainer');
    await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['help wanted'] } });
    await approve(APP_REPO);

    const result = await call(agent, 'update_project', { repo: APP_REPO, settings: { issueRepo: HARBOR } });

    expect(textOf(result)).toBe(`Refused (not_maintainer): Only an admin or maintainer of ${HARBOR} on GitHub can do this.`);
    expect(await getProject(env.DB, APP_REPO)).toMatchObject({ settings: { issueRepo: null } });
    expect(await listProjectsByIssueRepo(env.DB, HARBOR)).toEqual([]);
  });

  test('moving the issues to another repo the caller maintains creates the label there when the tags pick it', async () => {
    const agent = await connectAgent(github, 'sample-maintainer');
    await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['goodfirsttoken'], issueRepo: TOOLS } });

    const result = await call(agent, 'update_project', { repo: APP_REPO, settings: { issueRepo: BUNDLER } });

    expect(result.structuredContent).toMatchObject({ changed: ['issueRepo'], createdLabels: ['goodfirsttoken'] });
    expect(hasLabel(BUNDLER, 'goodfirsttoken')).toBe(true);
    expect((await listProjectsByIssueRepo(env.DB, BUNDLER)).map((p) => p.repo)).toEqual([APP_REPO]);
  });

  test('when GitHub refuses to create the label in an update, nothing is saved', async () => {
    const agent = await connectAgent(github, 'sample-maintainer');
    await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['help wanted'] } });
    refuseLabels();

    const result = await call(agent, 'update_project', { repo: APP_REPO, settings: { tags: ['goodfirsttoken'] } });

    expect(textOf(result)).toMatch(/^Refused \(label_not_created\): .* then call update_project again\.$/);
    expect(await getProject(env.DB, APP_REPO)).toMatchObject({ settingsVersion: 1, settings: { tags: ['help wanted'] } });
  });

  test('settings that break a rule are refused before GitHub is asked for a label', async () => {
    const agent = await connectAgent(github, 'sample-maintainer');
    await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['help wanted'] } });
    const start = github.calls.length;

    const result = await call(agent, 'update_project', {
      repo: APP_REPO,
      settings: { tags: ['goodfirsttoken'], excludedTags: ['GoodFirstToken'] },
    });

    expect(textOf(result)).toMatch(/^Refused \(invalid_settings\)/);
    expect(github.calls.slice(start).filter((c) => c.operation.includes('/labels'))).toEqual([]);
    expect(hasLabel(APP_REPO, 'goodfirsttoken')).toBe(false);
  });

  test('picking the goodfirsttoken tag in an update creates the label', async () => {
    const agent = await connectAgent(github, 'sample-maintainer');
    await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['help wanted'] } });

    const result = await call(agent, 'update_project', { repo: APP_REPO, settings: { tags: ['help wanted', 'goodfirsttoken'] } });

    expect(result.structuredContent).toMatchObject({ changed: ['tags'], createdLabels: ['goodfirsttoken'] });
    expect(hasLabel(APP_REPO, 'goodfirsttoken')).toBe(true);
  });

  test('a repo that is not a project is not found', async () => {
    const agent = await connectAgent(github, 'octo-maintainer');

    const result = await call(agent, 'update_project', { repo: HARBOR, settings: { prMode: 'automatic' } });

    expect(textOf(result)).toBe(
      `Refused (not_found): ${HARBOR} is not a project on Good First Token. Register it with register_project.`,
    );
  });
});

describe('the permission check', () => {
  test("asks GitHub with the caller's own token on every call, and keeps nothing between calls or people", async () => {
    const maintainer = await connectAgent(github, 'octo-maintainer');
    const writer = await connectAgent(github, 'kenji');
    await call(maintainer, 'register_project', { repo: 'meanwhileso/goodfirsttoken', settings: { tags: ['goodfirsttoken'] } });
    const start = github.calls.length;
    const permissionCalls = () =>
      github.calls
        .slice(start)
        .filter((c) => c.operation === 'GET /repos/{owner}/{repo}')
        .map((c) => [c.token, c.login, c.status]);

    const first = await call(maintainer, 'project_status', { repo: 'meanwhileso/goodfirsttoken' });
    const second = await call(maintainer, 'update_project', { repo: 'meanwhileso/goodfirsttoken', settings: { claimsPerIssue: 2 } });
    const someoneElse = await call(writer, 'update_project', { repo: 'meanwhileso/goodfirsttoken', settings: { claimsPerIssue: 9 } });
    // GitHub takes the maintainer's role away. The next call asks again, and is refused.
    sampleRepo('meanwhileso/goodfirsttoken').collaborators['octo-maintainer'] = 'write';
    const demoted = await call(maintainer, 'update_project', { repo: 'meanwhileso/goodfirsttoken', settings: { claimsPerIssue: 8 } });

    expect([first.isError, second.isError]).toEqual([undefined, undefined]);
    expect([someoneElse, demoted].map((r) => textOf(r).slice(0, 25))).toEqual([
      'Refused (not_maintainer):',
      'Refused (not_maintainer):',
    ]);
    const octo = gitHubTokenOf('octo-maintainer');
    const kenji = gitHubTokenOf('kenji');
    expect(permissionCalls()).toEqual([
      [octo, 'octo-maintainer', 200],
      [octo, 'octo-maintainer', 200],
      [kenji, 'kenji', 200],
      [octo, 'octo-maintainer', 200],
    ]);
    expect(await getProject(env.DB, 'meanwhileso/goodfirsttoken')).toMatchObject({ settings: { claimsPerIssue: 2 } });
  });

  test("every GitHub call a registration makes carries the caller's own token", async () => {
    const agent = await connectAgent(github, 'sample-maintainer');
    const token = gitHubTokenOf('sample-maintainer');
    const start = github.calls.length;

    await call(agent, 'register_project', { repo: APP_REPO });
    await call(agent, 'register_project', { repo: APP_REPO, settings: { tags: ['goodfirsttoken'] } });

    const made = github.calls.slice(start);
    expect(made.map((c) => c.operation)).toEqual(
      expect.arrayContaining(['GET /repos/{owner}/{repo}', 'GET /repos/{owner}/{repo}/labels', 'query repository', 'POST /repos/{owner}/{repo}/labels']),
    );
    expect(made.filter((c) => c.token !== token)).toEqual([]);
  });

  test("a maintainer tool whose GitHub token GitHub no longer accepts disconnects the agent", async () => {
    const agent = await connectAgent(github, 'octo-maintainer');
    Reflect.deleteProperty(github.state.tokens, gitHubTokenOf('octo-maintainer'));

    const result = await call(agent, 'project_status', { repo: HARBOR });

    expect(textOf(result)).toBe(
      "GitHub no longer accepts this connection's token, so Good First Token disconnected it. Reconnect the MCP server to sign in again.",
    );
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM connected_agents').first<number>('n')).toBe(0);
  });
});

describe('project_status', () => {
  test("shows the status, how the project got in, its settings, and its activity", async () => {
    const agent = await connectAgent(github, 'octo-maintainer');
    await call(agent, 'register_project', {
      repo: HARBOR,
      settings: { tags: ['help wanted'], excludedTags: ['good first issue'] },
    });
    const now = Date.now();
    const issue = (number: number, labels: string[]) => ({
      issue: `${HARBOR}#${String(number)}`,
      project: HARBOR,
      title: `Sample issue ${String(number)}`,
      labels,
      linkedPr: null,
      syncedAt: now,
    });
    await saveIssues(env.DB, [
      issue(88, ['help wanted']),
      issue(89, ['Help Wanted', 'bug']),
      issue(90, ['help wanted', 'good first issue']),
      issue(91, ['bug']),
    ]);
    await savePerson(env.DB, { githubId: 1001, login: 'priya' }, now);
    const claim = (id: string, number: number) => ({
      id,
      issue: `${HARBOR}#${String(number)}`,
      project: HARBOR,
      githubId: 1001,
      login: 'priya',
      agent: 'claude-code',
      ownProject: false,
      startCommit: '4f2a91c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6',
      tokenEstimate: null,
      ...newClaim(now - 60_000),
    });
    const pr = { repo: HARBOR, number: 95, url: `https://github.com/${HARBOR}/pull/95` };
    await saveClaim(env.DB, claim('c_1', 88), 1);
    await saveClaim(env.DB, { ...claim('c_2', 89), state: 'pr_opened', submittedAt: now - 30_000, pr }, 1);
    await addPr(env.DB, { claimId: 'c_2', pr, openedAt: now - 30_000 });
    await setPrState(env.DB, 'c_2', 'merged', now);

    const result = await call(agent, 'project_status', { repo: HARBOR });

    expect(result.structuredContent).toMatchObject({
      repo: HARBOR,
      status: 'pending',
      source: 'registered',
      statusReason: null,
      settings: { tags: ['help wanted'], excludedTags: ['good first issue'] },
      counts: { taggedIssues: 2, working: 1, openPrs: 0, merged: 1 },
    });
    expect(textOf(result)).toContain('Registered by its maintainers.');
  });

  test("a rejected project's status carries the admin's reason", async () => {
    const agent = await connectAgent(github, 'octo-maintainer');
    await call(agent, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });
    await savePerson(env.DB, admin, Date.now());
    await setProjectStatus(
      env.DB,
      HARBOR,
      { status: 'rejected', reason: 'The notes ask agents to skip the tests.', changedBy: admin.githubId },
      Date.now(),
    );

    const result = await call(agent, 'project_status', { repo: HARBOR });

    expect(result.structuredContent).toMatchObject({ status: 'rejected', statusReason: 'The notes ask agents to skip the tests.' });
    expect(textOf(result)).toContain('Reason: The notes ask agents to skip the tests.');
  });

  test('someone who is no maintainer of the repo sees nothing of it', async () => {
    const owner = await connectAgent(github, 'octo-maintainer');
    await call(owner, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });
    const donor = await connectAgent(github, 'priya');

    const result = await call(donor, 'project_status', { repo: HARBOR });

    expect(textOf(result)).toMatch(/^Refused \(not_maintainer\)/);
    expect(result.structuredContent).toBeUndefined();
  });
});

describe('pause_project', () => {
  async function approved(agent: ConnectedAgent, repo = HARBOR) {
    await call(agent, 'register_project', { repo, settings: { tags: ['help wanted'] } });
    await approve(repo);
  }

  test('a maintainer pauses an approved project with a reason, and resuming makes it approved again', async () => {
    const agent = await connectAgent(github, 'octo-maintainer');
    await approved(agent);

    const paused = await call(agent, 'pause_project', { repo: HARBOR, reason: 'Release week.' });
    const resumed = await call(agent, 'pause_project', { repo: HARBOR, paused: false });

    expect(paused.structuredContent).toEqual({ repo: HARBOR, status: 'paused', changed: true, resumableBy: 'maintainers' });
    expect(resumed.structuredContent).toEqual({ repo: HARBOR, status: 'approved', changed: true, resumableBy: null });
    expect(await statusHistory(env.DB, HARBOR)).toMatchObject([
      { status: 'approved', reason: null, changedBy: 1008 },
      { status: 'paused', reason: 'Release week.', changedBy: 1008 },
      { status: 'approved', changedBy: admin.githubId },
      { status: 'pending', changedBy: 1008 },
    ]);
  });

  test('only an approved project can be paused', async () => {
    const agent = await connectAgent(github, 'octo-maintainer');
    await call(agent, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });

    const result = await call(agent, 'pause_project', { repo: HARBOR });

    expect(textOf(result)).toBe(
      `Refused (project_not_open): ${HARBOR} is pending, so agents can't claim its issues yet. Only an approved project can be paused.`,
    );
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'pending' });
  });

  test('pausing a rejected project is refused, and says it was rejected', async () => {
    const agent = await connectAgent(github, 'octo-maintainer');
    await call(agent, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });
    await savePerson(env.DB, admin, Date.now());
    await setProjectStatus(env.DB, HARBOR, { status: 'rejected', reason: 'Spam.', changedBy: admin.githubId }, Date.now());

    const result = await call(agent, 'pause_project', { repo: HARBOR });

    expect(textOf(result)).toBe(
      `Refused (project_not_open): ${HARBOR} was rejected, so agents can't claim its issues. Only an approved project can be paused.`,
    );
  });

  test("someone who isn't a maintainer of the repo can neither pause nor resume it, and its status stays", async () => {
    const owner = await connectAgent(github, 'octo-maintainer');
    await approved(owner);
    const donor = await connectAgent(github, 'priya');

    const pause = await call(donor, 'pause_project', { repo: HARBOR });
    await call(owner, 'pause_project', { repo: HARBOR, reason: 'Release week.' });
    const resume = await call(donor, 'pause_project', { repo: HARBOR, paused: false });

    expect([pause, resume].map((r) => textOf(r).slice(0, 25))).toEqual(['Refused (not_maintainer):', 'Refused (not_maintainer):']);
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'paused', statusReason: 'Release week.', statusChangedBy: 1008 });
    expect(await statusHistory(env.DB, HARBOR)).toHaveLength(3);
  });

  test('resuming goes back to the status before the pause, so it never approves a project', async () => {
    const agent = await connectAgent(github, 'octo-maintainer');
    await call(agent, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });
    await setProjectStatus(env.DB, HARBOR, { status: 'paused', reason: null, changedBy: 1008 }, Date.now());

    const resumed = await call(agent, 'pause_project', { repo: HARBOR, paused: false });

    expect(resumed.structuredContent).toEqual({ repo: HARBOR, status: 'pending', changed: true, resumableBy: null });
  });

  test("a pause an admin or Good First Token made stays until an admin lifts it, and pausing again doesn't take it over", async () => {
    const agent = await connectAgent(github, 'octo-maintainer');
    await approved(agent);
    env.ADMIN_GITHUB_IDS = String(admin.githubId);
    await setProjectStatus(env.DB, HARBOR, { status: 'paused', reason: 'Spam reports.', changedBy: admin.githubId }, Date.now());

    const repause = await call(agent, 'pause_project', { repo: HARBOR, reason: 'Mine now.' });
    const byAdmin = await call(agent, 'pause_project', { repo: HARBOR, paused: false });
    await setProjectStatus(env.DB, HARBOR, { status: 'paused', reason: 'The repo was archived.', changedBy: null }, Date.now());
    const byGoodFirstToken = await call(agent, 'pause_project', { repo: HARBOR, paused: false });

    expect(repause.structuredContent).toEqual({ repo: HARBOR, status: 'paused', changed: false, resumableBy: 'admins' });
    expect(textOf(repause)).not.toContain('paused: false');
    expect(textOf(byAdmin)).toBe(
      `Refused (not_admin): A Good First Token admin paused ${HARBOR}. Only Good First Token's admins can resume it.`,
    );
    expect(textOf(byGoodFirstToken)).toBe(
      `Refused (not_admin): Good First Token paused ${HARBOR}. Only Good First Token's admins can resume it.`,
    );
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'paused', statusChangedBy: null });
  });

  test("resuming a project that isn't paused changes nothing", async () => {
    const agent = await connectAgent(github, 'octo-maintainer');
    await approved(agent);

    const result = await call(agent, 'pause_project', { repo: HARBOR, paused: false });

    expect(result.structuredContent).toEqual({ repo: HARBOR, status: 'approved', changed: false, resumableBy: null });
    expect(textOf(result)).not.toContain('Resumed');
    expect(await statusHistory(env.DB, HARBOR)).toHaveLength(2);
  });

  /** Runs `meanwhile` just before the first write to the database, as if it landed between the tool's read and write. */
  function beforeTheWrite(meanwhile: () => Promise<unknown>): void {
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, 'batch').mockImplementationOnce(async (statements) => {
      await meanwhile();
      return batch(statements);
    });
  }

  test("a pause that lands while a maintainer's pause is on its way stays the admin's", async () => {
    const agent = await connectAgent(github, 'octo-maintainer');
    await approved(agent);
    env.ADMIN_GITHUB_IDS = String(admin.githubId);
    beforeTheWrite(() =>
      setProjectStatus(env.DB, HARBOR, { status: 'paused', reason: 'Spam reports.', changedBy: admin.githubId }, Date.now()),
    );

    const result = await call(agent, 'pause_project', { repo: HARBOR, reason: 'Release week.' });

    expect(result.structuredContent).toEqual({ repo: HARBOR, status: 'paused', changed: false, resumableBy: 'admins' });
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ statusReason: 'Spam reports.', statusChangedBy: admin.githubId });
  });

  test("an admin's pause that lands while a maintainer's resume is on its way is not lifted", async () => {
    const agent = await connectAgent(github, 'octo-maintainer');
    await approved(agent);
    env.ADMIN_GITHUB_IDS = String(admin.githubId);
    await call(agent, 'pause_project', { repo: HARBOR, reason: 'Release week.' });
    beforeTheWrite(() =>
      setProjectStatus(env.DB, HARBOR, { status: 'paused', reason: 'Spam reports.', changedBy: admin.githubId }, Date.now()),
    );

    const result = await call(agent, 'pause_project', { repo: HARBOR, paused: false });

    expect(textOf(result)).toBe(
      `Refused (not_admin): A Good First Token admin paused ${HARBOR}. Only Good First Token's admins can resume it.`,
    );
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'paused', statusChangedBy: admin.githubId });
  });
});
