import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  adminAddProject,
  adminBlockDonor,
  adminDecide,
  adminPauseProject,
  adminQueue,
  adminRemoveProject,
} from '../../src/admin/actions';
import { PermissionRefused, type Caller } from '../../src/auth/permissions';
import {
  addCandidate,
  getBlock,
  getCandidate,
  getDoNotListEntry,
  getProject,
  savePerson,
  setProjectStatus,
  settingsHistory,
  statusHistory,
} from '../../src/db';
import { startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from './helpers';

// The admin's tools, called by agents through the MCP client SDK against the
// whole Worker and the GitHub fake, and the actions behind them, called
// directly. The people and repos are the fake's sample data: sample-admin is
// the admin here, octo-maintainer is an admin of sample-owner/sample-harbor,
// sample-maintainer of the other sample-owner repos, and priya has no role
// anywhere. The policy text is made up.

let github: GitHubFake;
const configuredAdmins = env.ADMIN_GITHUB_IDS;
const ADMIN = { githubId: 1010, login: 'sample-admin' };
const HARBOR = 'sample-owner/sample-harbor';
const BUNDLER = 'sample-owner/sample-bundler';
const TOOLS = 'sample-owner/sample-tools';
const ADMIN_TOOLS = [
  'admin_add_project',
  'admin_block_donor',
  'admin_decide',
  'admin_pause_project',
  'admin_queue',
  'admin_remove_project',
];
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
  // These tests make more calls than the limit of 120 a minute allows the
  // same few people. tools.test.ts tests the limit.
  vi.spyOn(env.MCP_LIMITER, 'limit').mockResolvedValue({ success: true });
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

/** The admin as the actions see them, with the GitHub token the fake gave their agent. */
function adminCaller(): Caller {
  const token = Object.entries(github.state.tokens).find(([, grant]) => grant.login === ADMIN.login)?.[0] ?? null;
  return { ...ADMIN, gitHubToken: () => Promise.resolve(token) };
}

function sampleRepo(name: string) {
  const repo = github.state.repos[name];
  if (!repo) throw new Error(`missing sample repo ${name}`);
  return repo;
}

/** Registers HARBOR as octo-maintainer, who waits for an admin. */
async function registerHarbor(settings: Record<string, unknown> = { tags: ['help wanted'], agentNotes: 'Run just test.' }) {
  const maintainer = await connectAgent(github, 'octo-maintainer');
  const registered = await call(maintainer, 'register_project', { repo: HARBOR, settings });
  expect(registered.structuredContent).toMatchObject({ status: 'pending' });
  return maintainer;
}

/** The queue item ID of the first item waiting for `repo`. */
async function queueId(admin: ConnectedAgent, repo: string): Promise<string> {
  const queue = await call(admin, 'admin_queue', {});
  const items = (queue.structuredContent?.items ?? []) as { id: string; repo: string }[];
  const item = items.find((i) => i.repo === repo);
  if (!item) throw new Error(`${repo} isn't in the queue`);
  return item.id;
}

/** A crawler find for sample-bundler, found an hour ago. */
async function crawlerFind(settings: Record<string, unknown> = { personWrittenDescription: true }) {
  const now = Date.now();
  const candidate = await addCandidate(
    env.DB,
    {
      repo: BUNDLER,
      facts: { stars: 12000, createdAt: now - 6 * 365 * 86_400_000, pushedAt: now - 7_200_000, ownerCreatedAt: now - 9 * 365 * 86_400_000 },
      policy: POLICY,
      settings,
      suggestedTags: [{ name: 'contribution welcome', openIssues: 1 }],
    },
    now - 3_600_000,
  );
  if (!candidate) throw new Error('the candidate was not added');
  return candidate;
}

describe('who sees the admin tools', () => {
  test("a donor's agent lists no admin tool, and an admin's lists all six", async () => {
    const donor = await connectAgent(github, 'priya');
    const admin = await connectAgent(github, ADMIN.login);

    const donorTools = (await donor.client.listTools()).tools.map((tool) => tool.name);
    const adminTools = (await admin.client.listTools()).tools.map((tool) => tool.name);

    expect(donorTools.filter((name) => name.startsWith('admin_'))).toEqual([]);
    expect(donorTools).toContain('register_project');
    expect(adminTools.filter((name) => name.startsWith('admin_')).sort()).toEqual(ADMIN_TOOLS);
  });

  test('who is an admin is read on every request, so an admin taken off ADMIN_GITHUB_IDS loses the tools at once', async () => {
    const admin = await connectAgent(github, ADMIN.login);
    env.ADMIN_GITHUB_IDS = '';

    const names = (await admin.client.listTools()).tools.map((tool) => tool.name);

    expect(names.filter((name) => name.startsWith('admin_'))).toEqual([]);
  });

  test("the GitHub fake's sample admin is no admin outside development", async () => {
    // The tests run the Worker as staging, with GitHub on https hosts.
    env.ADMIN_GITHUB_IDS = '';
    const admin = await connectAgent(github, ADMIN.login);

    const names = (await admin.client.listTools()).tools.map((tool) => tool.name);
    const refused = await adminQueue({ ...ADMIN, gitHubToken: () => Promise.resolve(null) }, { kind: 'all' }).catch(
      (error: unknown) => error,
    );

    expect(names.filter((name) => name.startsWith('admin_'))).toEqual([]);
    expect(refused).toMatchObject({ code: 'not_admin' });
  });

  test.each(ADMIN_TOOLS)("a non-admin's call to %s is refused, and nothing is read or written", async (name) => {
    await registerHarbor();
    const donor = await connectAgent(github, 'priya');
    const reads = github.calls.length;
    const before = await getProject(env.DB, HARBOR);
    const args: Record<string, Record<string, unknown>> = {
      admin_queue: {},
      admin_decide: { id: 'reg_1', decision: 'approve' },
      admin_add_project: { repo: BUNDLER, policy: POLICY, settings: { tags: ['contribution welcome'] } },
      admin_block_donor: { login: 'octo-maintainer' },
      admin_pause_project: { repo: HARBOR, reason: 'Spam reports.' },
      admin_remove_project: { repo: HARBOR },
    };

    let refused: boolean;
    try {
      refused = (await call(donor, name, args[name] ?? {})).isError === true;
    } catch {
      refused = true;
    }

    expect(refused).toBe(true);
    expect(github.calls.slice(reads).filter((c) => c.login === 'priya')).toEqual([]);
    expect(await getProject(env.DB, HARBOR)).toEqual(before);
    expect(await getProject(env.DB, BUNDLER)).toBeNull();
    expect(await getDoNotListEntry(env.DB, HARBOR)).toBeNull();
  });

  test.each([
    ['admin_queue', (caller: Caller) => adminQueue(caller, { kind: 'all' })],
    ['admin_decide', (caller: Caller) => adminDecide(caller, { id: 'reg_1', decision: 'approve' }, Date.now())],
    [
      'admin_add_project',
      (caller: Caller) =>
        adminAddProject(caller, { repo: BUNDLER, policy: POLICY, settings: { tags: ['contribution welcome'] } }, Date.now()),
    ],
    ['admin_block_donor', (caller: Caller) => adminBlockDonor(caller, { login: 'priya', blocked: true }, Date.now())],
    ['admin_pause_project', (caller: Caller) => adminPauseProject(caller, { repo: HARBOR, paused: true, reason: 'x' }, Date.now())],
    ['admin_remove_project', (caller: Caller) => adminRemoveProject(caller, { repo: HARBOR }, Date.now())],
  ] as const)('%s checks the permission before it reads or writes anything', async (_name, run) => {
    const token = vi.fn(() => Promise.resolve('gho_not-read'));
    const prepare = vi.spyOn(env.DB, 'prepare');
    const batch = vi.spyOn(env.DB, 'batch');
    const fetch = vi.spyOn(globalThis, 'fetch');

    const error = await run({ githubId: 1001, login: 'priya', gitHubToken: token }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PermissionRefused);
    expect((error as PermissionRefused).code).toBe('not_admin');
    expect(token).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('admin_queue', () => {
  test("a registration shows the repo's facts from GitHub, read with the admin's own token, and the settings and notes in full", async () => {
    await registerHarbor();
    const admin = await connectAgent(github, ADMIN.login);
    const reads = github.calls.length;

    const result = await call(admin, 'admin_queue', {});

    const repo = sampleRepo(HARBOR);
    expect(result.structuredContent).toEqual({
      items: [
        {
          id: expect.stringMatching(/^reg_\d+$/) as unknown,
          kind: 'registration',
          repo: HARBOR,
          requestedBy: 'octo-maintainer',
          requestedAt: expect.any(String) as unknown,
          facts: {
            stars: 4200,
            createdAt: new Date(repo.createdAt).toISOString(),
            pushedAt: new Date(repo.pushedAt).toISOString(),
            ownerCreatedAt: new Date(github.state.accounts['sample-owner']?.createdAt ?? '').toISOString(),
          },
          factsMissing: null,
          settings: expect.objectContaining({ tags: ['help wanted'], agentNotes: 'Run just test.' }) as unknown,
          policy: null,
          suggestedTags: [],
          onDoNotList: false,
        },
      ],
    });
    expect(textOf(result)).toContain('4,200 stars');
    expect(textOf(result)).toContain('Run just test.');
    const githubReads = github.calls.slice(reads);
    expect(githubReads.map((c) => new URL(c.url).pathname)).toEqual(
      expect.arrayContaining([`/repos/${HARBOR}`, '/users/sample-owner']),
    );
    expect(new Set(githubReads.map((c) => c.login))).toEqual(new Set([ADMIN.login]));
  });

  test("a crawler find shows the facts the crawler read, its policy quote, and the labels it suggests", async () => {
    const candidate = await crawlerFind();
    const admin = await connectAgent(github, ADMIN.login);

    const result = await call(admin, 'admin_queue', { kind: 'candidate' });

    expect(result.structuredContent).toMatchObject({
      items: [
        {
          id: candidate.id,
          kind: 'candidate',
          repo: BUNDLER,
          requestedBy: null,
          facts: { stars: 12000 },
          settings: { personWrittenDescription: true },
          policy: POLICY,
          suggestedTags: [{ name: 'contribution welcome', openIssues: 1 }],
        },
      ],
    });
    expect(textOf(result)).toContain(POLICY.quote);
  });

  test('a registration whose repo GitHub no longer shows still waits, with no facts', async () => {
    await registerHarbor();
    sampleRepo(HARBOR).private = true;
    const admin = await connectAgent(github, ADMIN.login);

    const result = await call(admin, 'admin_queue', {});

    expect(result.structuredContent).toMatchObject({ items: [{ repo: HARBOR, facts: null, factsMissing: 'not_public' }] });
    expect(textOf(result)).toContain(`GitHub showed no public repo named ${HARBOR} when asked.`);
  });

  test("a registration whose facts GitHub didn't give, as on a rate limit, says GitHub didn't answer, and never that the repo isn't public", async () => {
    await registerHarbor();
    const admin = await connectAgent(github, ADMIN.login);
    const fake = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith('/users/sample-owner')) {
        return Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
      }
      return fake(request);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await call(admin, 'admin_queue', {});

    expect(result.structuredContent).toMatchObject({ items: [{ repo: HARBOR, facts: null, factsMissing: 'no_answer' }] });
    expect(textOf(result)).toContain(`GitHub didn't answer when asked about ${HARBOR}. Read the queue again for its facts.`);
    expect(textOf(result)).not.toContain('no public repo');
  });

  test("a registration whose repo GitHub showed, but not its owner, says GitHub didn't answer, since the repo is public", async () => {
    await registerHarbor();
    const admin = await connectAgent(github, ADMIN.login);
    const fake = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith('/users/sample-owner')) {
        return Response.json({ message: 'Not Found' }, { status: 404 });
      }
      return fake(request);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await call(admin, 'admin_queue', {});

    expect(result.structuredContent).toMatchObject({ items: [{ repo: HARBOR, facts: null, factsMissing: 'no_answer' }] });
    expect(textOf(result)).not.toContain('no public repo');
  });
});

describe('admin_decide on a registration', () => {
  test("a rejection needs a reason, and the reason reaches the maintainer through project_status", async () => {
    const maintainer = await registerHarbor();
    const admin = await connectAgent(github, ADMIN.login);
    const id = await queueId(admin, HARBOR);

    const noReason = await call(admin, 'admin_decide', { id, decision: 'reject' });
    const rejected = await call(admin, 'admin_decide', { id, decision: 'reject', reason: 'The notes ask agents to skip the tests.' });
    const status = await call(maintainer, 'project_status', { repo: HARBOR });

    expect(noReason.isError).toBe(true);
    expect(textOf(noReason)).toContain('reason');
    expect(rejected.structuredContent).toEqual({ repo: HARBOR, kind: 'registration', status: 'rejected' });
    expect(status.structuredContent).toMatchObject({ status: 'rejected', statusReason: 'The notes ask agents to skip the tests.' });
    expect(textOf(status)).toContain('Reason: The notes ask agents to skip the tests.');
    expect(await statusHistory(env.DB, HARBOR)).toMatchObject([
      { status: 'rejected', changedBy: ADMIN.githubId },
      { status: 'pending', changedBy: 1008 },
    ]);
  });

  test('approving lists the project with the settings its maintainer chose, and it leaves the queue', async () => {
    const maintainer = await registerHarbor();
    const admin = await connectAgent(github, ADMIN.login);
    const id = await queueId(admin, HARBOR);

    const approved = await call(admin, 'admin_decide', { id, decision: 'approve' });
    const again = await call(admin, 'admin_decide', { id, decision: 'approve' });
    const queue = await call(admin, 'admin_queue', {});

    expect(approved.structuredContent).toEqual({ repo: HARBOR, kind: 'registration', status: 'approved' });
    expect((await call(maintainer, 'project_status', { repo: HARBOR })).structuredContent).toMatchObject({
      status: 'approved',
      statusReason: null,
    });
    expect(textOf(again)).toMatch(/^Refused \(not_found\)/);
    expect(queue.structuredContent).toEqual({ items: [] });
  });

  test('a registration keeps the settings its maintainer chose: approving one with settings or a tier is refused', async () => {
    await registerHarbor();
    const admin = await connectAgent(github, ADMIN.login);
    const id = await queueId(admin, HARBOR);

    const result = await call(admin, 'admin_decide', { id, decision: 'approve', settings: { prMode: 'automatic' } });

    expect(textOf(result)).toMatch(/^Refused \(invalid_settings\)/);
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'pending', settings: { prMode: 'reviewed' } });
  });

  test('an ID read before the registration changed status no longer names it', async () => {
    await registerHarbor();
    const admin = await connectAgent(github, ADMIN.login);
    const id = await queueId(admin, HARBOR);
    await setProjectStatus(env.DB, HARBOR, { status: 'rejected', reason: 'Spam.', changedBy: ADMIN.githubId }, Date.now());

    const result = await call(admin, 'admin_decide', { id, decision: 'approve' });

    expect(textOf(result)).toMatch(/^Refused \(not_found\)/);
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'rejected' });
  });
});

describe('admin_decide on a crawler find', () => {
  test('approving lists it from its policy with the tier and settings the admin confirmed, and tags are required', async () => {
    const candidate = await crawlerFind();
    const admin = await connectAgent(github, ADMIN.login);

    const noTags = await call(admin, 'admin_decide', { id: candidate.id, decision: 'approve' });
    const approved = await call(admin, 'admin_decide', {
      id: candidate.id,
      decision: 'approve',
      tier: 'invites_agents',
      settings: { tags: ['contribution welcome'], prMode: 'automatic' },
    });

    expect(textOf(noTags)).toBe('Refused (invalid_settings): Settings not saved.\ntags: is required');
    expect(approved.structuredContent).toEqual({ repo: BUNDLER, kind: 'candidate', status: 'approved' });
    expect(await getProject(env.DB, BUNDLER)).toMatchObject({
      status: 'approved',
      source: 'policy',
      policy: { ...POLICY, tier: 'invites_agents' },
      addedBy: ADMIN.githubId,
      settings: { tags: ['contribution welcome'], prMode: 'automatic', personWrittenDescription: true },
    });
    expect(await getCandidate(env.DB, candidate.id)).toMatchObject({ status: 'approved', decidedBy: ADMIN.githubId });
  });

  test('rejecting one needs a reason, which stays with the find', async () => {
    const candidate = await crawlerFind();
    const admin = await connectAgent(github, ADMIN.login);

    const result = await call(admin, 'admin_decide', { id: candidate.id, decision: 'reject', reason: 'The policy is about docs only.' });

    expect(result.structuredContent).toEqual({ repo: BUNDLER, kind: 'candidate', status: 'rejected' });
    expect(await getCandidate(env.DB, candidate.id)).toMatchObject({ status: 'rejected', reason: 'The policy is about docs only.' });
    expect(await getProject(env.DB, BUNDLER)).toBeNull();
  });

  test("approving a find for a repo its maintainers registered is refused, and their settings and status stay", async () => {
    const candidate = await crawlerFind({ tags: ['contribution welcome'], prMode: 'automatic' });
    const maintainer = await connectAgent(github, 'sample-maintainer');
    await call(maintainer, 'register_project', { repo: BUNDLER, settings: { tags: ['bug'], agentNotes: 'Ours.' } });
    const admin = await connectAgent(github, ADMIN.login);

    const result = await call(admin, 'admin_decide', { id: candidate.id, decision: 'approve' });

    expect(textOf(result)).toBe(
      `Refused (already_registered): ${BUNDLER} is registered by its maintainers, and is pending. Their settings stay.`,
    );
    expect(await getProject(env.DB, BUNDLER)).toMatchObject({
      status: 'pending',
      source: 'registered',
      policy: null,
      settings: { tags: ['bug'], agentNotes: 'Ours.', prMode: 'reviewed' },
    });
    expect(await settingsHistory(env.DB, BUNDLER)).toHaveLength(1);
    expect(await getCandidate(env.DB, candidate.id)).toMatchObject({ status: 'waiting' });
  });

  test('a find whose repo GitHub now shows archived is refused, and nothing is listed', async () => {
    const candidate = await crawlerFind({ tags: ['contribution welcome'] });
    sampleRepo(BUNDLER).archived = true;
    const admin = await connectAgent(github, ADMIN.login);

    const result = await call(admin, 'admin_decide', { id: candidate.id, decision: 'approve' });

    expect(textOf(result)).toMatch(/^Refused \(repo_not_eligible\): sample-owner\/sample-bundler is archived/);
    expect(await getProject(env.DB, BUNDLER)).toBeNull();
    expect(await getCandidate(env.DB, candidate.id)).toMatchObject({ status: 'waiting' });
  });
});

describe('admin_add_project', () => {
  test('lists a public repo from its policy at once, as GitHub names it, checked with the admin\'s own token', async () => {
    const admin = await connectAgent(github, ADMIN.login);
    const reads = github.calls.length;

    const result = await call(admin, 'admin_add_project', {
      repo: 'Sample-Owner/Sample-Bundler',
      policy: POLICY,
      settings: { tags: ['contribution welcome'], personWrittenDescription: true },
    });

    expect(result.structuredContent).toEqual({ repo: BUNDLER, status: 'approved', source: 'policy', updated: false });
    expect(await getProject(env.DB, BUNDLER)).toMatchObject({ source: 'policy', policy: POLICY, addedBy: ADMIN.githubId });
    expect(github.calls.slice(reads).map((c) => c.login)).toEqual([ADMIN.login]);
  });

  test("listing a repo already listed from its policy replaces the listing's policy and settings, and keeps its status", async () => {
    const admin = await connectAgent(github, ADMIN.login);
    await call(admin, 'admin_add_project', { repo: BUNDLER, policy: POLICY, settings: { tags: ['contribution welcome'] } });
    await call(admin, 'admin_pause_project', { repo: BUNDLER, reason: 'Checking the policy again.' });
    const quote = 'Agent pull requests are welcome.';

    const result = await call(admin, 'admin_add_project', {
      repo: BUNDLER,
      policy: { ...POLICY, quote, tier: 'invites_agents' },
      settings: { tags: ['contribution welcome'], prMode: 'automatic' },
    });

    expect(result.structuredContent).toEqual({ repo: BUNDLER, status: 'paused', source: 'policy', updated: true });
    expect(await getProject(env.DB, BUNDLER)).toMatchObject({
      status: 'paused',
      policy: { quote, tier: 'invites_agents' },
      settings: { prMode: 'automatic' },
    });
    expect(await settingsHistory(env.DB, BUNDLER)).toMatchObject([
      { version: 2, changed: ['prMode'], changedBy: ADMIN.githubId },
      { version: 1 },
    ]);
  });

  test('listing a repo again changes only the settings sent, and the rest keep the listing\'s values', async () => {
    const admin = await connectAgent(github, ADMIN.login);
    await call(admin, 'admin_add_project', {
      repo: BUNDLER,
      policy: POLICY,
      settings: { tags: ['contribution welcome'], prMode: 'automatic', agentNotes: 'Write the description yourself.' },
    });

    const result = await call(admin, 'admin_add_project', { repo: BUNDLER, policy: POLICY, settings: { tags: ['help wanted'] } });

    expect(result.structuredContent).toMatchObject({ updated: true });
    expect((await getProject(env.DB, BUNDLER))?.settings).toMatchObject({
      tags: ['help wanted'],
      prMode: 'automatic',
      agentNotes: 'Write the description yourself.',
    });
  });

  test('a new listing needs its tags, and the settings left out take their defaults', async () => {
    const admin = await connectAgent(github, ADMIN.login);

    const noTags = await call(admin, 'admin_add_project', { repo: BUNDLER, policy: POLICY, settings: { prMode: 'automatic' } });
    await call(admin, 'admin_add_project', { repo: BUNDLER, policy: POLICY, settings: { tags: ['help wanted'] } });

    expect(textOf(noTags)).toBe('Refused (invalid_settings): Settings not saved.\ntags: is required');
    expect((await getProject(env.DB, BUNDLER))?.settings).toMatchObject({ tags: ['help wanted'], prMode: 'reviewed', claimsPerIssue: 3 });
  });

  test('a repo its maintainers registered is refused, and keeps their settings', async () => {
    await registerHarbor();
    const admin = await connectAgent(github, ADMIN.login);

    const result = await call(admin, 'admin_add_project', {
      repo: HARBOR,
      policy: { ...POLICY, url: `https://github.com/${HARBOR}/blob/develop/CONTRIBUTING.md` },
      settings: { tags: ['help wanted'], prMode: 'automatic' },
    });

    expect(textOf(result)).toMatch(/^Refused \(already_registered\)/);
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ source: 'registered', settings: { prMode: 'reviewed' } });
  });

  test('a repo that is not public, or lets only collaborators open pull requests, is refused', async () => {
    const admin = await connectAgent(github, ADMIN.login);
    sampleRepo(TOOLS).pullRequestCreationPolicy = 'collaborators_only';
    const listing = { policy: POLICY, settings: { tags: ['help wanted'] } };

    const hidden = await call(admin, 'admin_add_project', { repo: 'sample-owner/no-such-repo', ...listing });
    const closed = await call(admin, 'admin_add_project', { repo: TOOLS, ...listing });

    expect(textOf(hidden)).toBe(
      'Refused (repo_not_eligible): GitHub shows no public repo named sample-owner/no-such-repo. Only a public repo can be listed.',
    );
    expect(textOf(closed)).toBe(
      `Refused (repo_not_eligible): ${TOOLS} lets only collaborators open pull requests. Only a repo that takes pull requests from anyone can be listed.`,
    );
    expect(await getProject(env.DB, TOOLS)).toBeNull();
  });
});

describe('admin_block_donor', () => {
  test('blocks a donor by their login now, with the reason and the admin, and unblocks them', async () => {
    await savePerson(env.DB, { githubId: 1001, login: 'priya' }, Date.now());
    const admin = await connectAgent(github, ADMIN.login);

    const blocked = await call(admin, 'admin_block_donor', { login: 'PRIYA', reason: 'Posted a token twice.' });
    const block = await getBlock(env.DB, 1001);
    const unblocked = await call(admin, 'admin_block_donor', { login: 'priya', blocked: false });

    expect(blocked.structuredContent).toEqual({ login: 'priya', blocked: true });
    expect(block).toMatchObject({ reason: 'Posted a token twice.', blockedBy: ADMIN.githubId });
    expect(unblocked.structuredContent).toEqual({ login: 'priya', blocked: false });
    expect(await getBlock(env.DB, 1001)).toBeNull();
  });

  test('someone who never signed in is not found', async () => {
    const admin = await connectAgent(github, ADMIN.login);

    const result = await call(admin, 'admin_block_donor', { login: 'nobody-here' });

    expect(textOf(result)).toBe('Refused (not_found): No one has signed in to Good First Token as @nobody-here.');
  });
});

describe('admin_pause_project', () => {
  async function approvedHarbor(): Promise<ConnectedAgent> {
    const maintainer = await registerHarbor();
    await savePerson(env.DB, ADMIN, Date.now());
    await setProjectStatus(env.DB, HARBOR, { status: 'approved', reason: null, changedBy: ADMIN.githubId }, Date.now());
    return maintainer;
  }

  test("an admin's pause stays until an admin lifts it, and the admin's resume puts back the status before it", async () => {
    const maintainer = await approvedHarbor();
    const admin = await connectAgent(github, ADMIN.login);

    const paused = await call(admin, 'admin_pause_project', { repo: HARBOR, reason: 'Spam reports.' });
    const byMaintainer = await call(maintainer, 'pause_project', { repo: HARBOR, paused: false });
    const resumed = await call(admin, 'admin_pause_project', { repo: HARBOR, paused: false });

    expect(paused.structuredContent).toEqual({ repo: HARBOR, status: 'paused', changed: true });
    expect(textOf(byMaintainer)).toMatch(/^Refused \(not_admin\)/);
    expect(resumed.structuredContent).toEqual({ repo: HARBOR, status: 'approved', changed: true });
    expect((await call(maintainer, 'project_status', { repo: HARBOR })).structuredContent).toMatchObject({ status: 'approved' });
  });

  test("an admin pausing a project its maintainer paused, with the same reason, makes the pause the admin's, so the maintainer can't lift it", async () => {
    const maintainer = await approvedHarbor();
    await call(maintainer, 'pause_project', { repo: HARBOR, reason: 'Release week.' });
    const admin = await connectAgent(github, ADMIN.login);

    const paused = await call(admin, 'admin_pause_project', { repo: HARBOR, reason: 'Release week.' });
    const byMaintainer = await call(maintainer, 'pause_project', { repo: HARBOR, paused: false });

    expect(paused.structuredContent).toEqual({ repo: HARBOR, status: 'paused', changed: true });
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'paused', statusChangedBy: ADMIN.githubId });
    expect(textOf(byMaintainer)).toBe(
      `Refused (not_admin): A Good First Token admin paused ${HARBOR}. Only Good First Token's admins can resume it.`,
    );
  });

  test("a maintainer's resume that lands while an admin pauses over the maintainer's pause doesn't undo the admin's pause", async () => {
    const maintainer = await approvedHarbor();
    await call(maintainer, 'pause_project', { repo: HARBOR, reason: 'Release week.' });
    await connectAgent(github, ADMIN.login);
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, 'batch').mockImplementationOnce(async (statements) => {
      // The maintainer resumes between the admin's read and the admin's write.
      await setProjectStatus(env.DB, HARBOR, { status: 'approved', reason: null, changedBy: 1008 }, Date.now());
      return batch(statements);
    });

    const result = await adminPauseProject(adminCaller(), { repo: HARBOR, paused: true, reason: 'Release week.' }, Date.now());

    expect(result).toEqual({ ok: true, value: { repo: HARBOR, status: 'paused', changed: true } });
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'paused', statusChangedBy: ADMIN.githubId });
  });

  test("a maintainer's resume on its way when an admin pauses over the maintainer's pause, with the same reason, is refused, and the pause stays the admin's", async () => {
    const maintainer = await approvedHarbor();
    await call(maintainer, 'pause_project', { repo: HARBOR, reason: 'Release week.' });
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, 'batch').mockImplementationOnce(async (statements) => {
      // The admin pauses between the maintainer's read and the maintainer's write.
      await adminPauseProject(adminCaller(), { repo: HARBOR, paused: true, reason: 'Release week.' }, Date.now());
      return batch(statements);
    });

    const result = await call(maintainer, 'pause_project', { repo: HARBOR, paused: false });

    expect(textOf(result)).toBe(
      `Refused (not_admin): A Good First Token admin paused ${HARBOR}. Only Good First Token's admins can resume it.`,
    );
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'paused', statusChangedBy: ADMIN.githubId });
  });

  test("an admin's resume decided on a paused project doesn't land over a removal that came first, so the project stays removed", async () => {
    await approvedHarbor();
    await connectAgent(github, ADMIN.login);
    await setProjectStatus(env.DB, HARBOR, { status: 'paused', reason: 'Spam reports.', changedBy: ADMIN.githubId }, Date.now());
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, 'batch').mockImplementationOnce(async (statements) => {
      // Another admin removes the project between this admin's read and write.
      await adminRemoveProject(adminCaller(), { repo: HARBOR }, Date.now());
      return batch(statements);
    });

    const result = await adminPauseProject(adminCaller(), { repo: HARBOR, paused: false }, Date.now());

    expect(result).toEqual({ ok: true, value: { repo: HARBOR, status: 'rejected', changed: false } });
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'rejected', statusReason: "Removed at its maintainers' request." });
  });

  test("a pause Good First Token made on its own, like a delisting, stays until an admin lifts it", async () => {
    const maintainer = await approvedHarbor();
    await setProjectStatus(env.DB, HARBOR, { status: 'paused', reason: 'The repo went private.', changedBy: null }, Date.now());
    const admin = await connectAgent(github, ADMIN.login);

    const byMaintainer = await call(maintainer, 'pause_project', { repo: HARBOR, paused: false });
    const byAdmin = await call(admin, 'admin_pause_project', { repo: HARBOR, paused: false });

    expect(textOf(byMaintainer)).toMatch(/^Refused \(not_admin\): Good First Token paused/);
    expect(byAdmin.structuredContent).toEqual({ repo: HARBOR, status: 'approved', changed: true });
  });

  test('only an approved project can be paused, and pausing needs a reason', async () => {
    await registerHarbor();
    const admin = await connectAgent(github, ADMIN.login);

    const pending = await call(admin, 'admin_pause_project', { repo: HARBOR, reason: 'Spam reports.' });
    const noReason = await call(admin, 'admin_pause_project', { repo: HARBOR });

    expect(textOf(pending)).toMatch(/^Refused \(project_not_open\)/);
    expect(noReason.isError).toBe(true);
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'pending' });
  });
});

describe('the do-not-list', () => {
  test("removing a listing at its maintainers' request rejects it with a reason they see, rejects its waiting find, and puts it on the do-not-list", async () => {
    const admin = await connectAgent(github, ADMIN.login);
    await call(admin, 'admin_add_project', { repo: BUNDLER, policy: POLICY, settings: { tags: ['contribution welcome'] } });
    const candidate = await crawlerFind();

    const removed = await call(admin, 'admin_remove_project', { repo: BUNDLER, note: 'Asked in sample-owner/sample-bundler#130.' });
    const maintainer = await connectAgent(github, 'sample-maintainer');
    const status = await call(maintainer, 'project_status', { repo: BUNDLER });

    expect(removed.structuredContent).toEqual({ repo: BUNDLER, status: 'rejected' });
    expect(status.structuredContent).toMatchObject({ status: 'rejected', statusReason: "Removed at its maintainers' request." });
    expect(await getDoNotListEntry(env.DB, BUNDLER)).toMatchObject({
      reason: 'Asked in sample-owner/sample-bundler#130.',
      addedBy: ADMIN.githubId,
    });
    expect(await getCandidate(env.DB, candidate.id)).toMatchObject({ status: 'rejected' });
  });

  test('nothing lists a removed repo again: an admin listing it by hand, and the crawler, are refused', async () => {
    const admin = await connectAgent(github, ADMIN.login);
    await call(admin, 'admin_remove_project', { repo: BUNDLER });

    const byHand = await call(admin, 'admin_add_project', { repo: BUNDLER, policy: POLICY, settings: { tags: ['contribution welcome'] } });

    expect(textOf(byHand)).toBe(
      `Refused (repo_not_eligible): ${BUNDLER} is on the do-not-list, because its maintainers asked to be removed. Only they can list it again, by registering it.`,
    );
    await expect(crawlerFind()).rejects.toThrow('the candidate was not added');
    expect(await getProject(env.DB, BUNDLER)).toBeNull();
  });

  test("a removal that lands while an admin lists the same repo by hand leaves no project listed, and the listing is refused", async () => {
    await connectAgent(github, ADMIN.login);
    const fake = globalThis.fetch;
    let removed = false;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (!removed && new URL(request.url).pathname.endsWith(`/repos/${BUNDLER}`)) {
        removed = true;
        // Another admin removes the repo while this listing waits on GitHub.
        await adminRemoveProject(adminCaller(), { repo: BUNDLER }, Date.now());
      }
      return fake(request);
    });

    const result = await adminAddProject(
      adminCaller(),
      { repo: BUNDLER, policy: POLICY, settings: { tags: ['contribution welcome'] } },
      Date.now(),
    );

    expect(removed).toBe(true);
    expect(result).toMatchObject({ ok: false, refusal: { code: 'repo_not_eligible' } });
    expect(await getProject(env.DB, BUNDLER)).toBeNull();
    expect(await getDoNotListEntry(env.DB, BUNDLER)).not.toBeNull();
  });

  test("a removal that lands while an admin lists a listed repo again leaves the listing as the removal left it", async () => {
    const admin = await connectAgent(github, ADMIN.login);
    await call(admin, 'admin_add_project', { repo: BUNDLER, policy: POLICY, settings: { tags: ['contribution welcome'] } });
    const fake = globalThis.fetch;
    let removed = false;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (!removed && new URL(request.url).pathname.endsWith(`/repos/${BUNDLER}`)) {
        removed = true;
        await adminRemoveProject(adminCaller(), { repo: BUNDLER }, Date.now());
      }
      return fake(request);
    });

    const result = await adminAddProject(
      adminCaller(),
      { repo: BUNDLER, policy: { ...POLICY, tier: 'invites_agents' }, settings: { tags: ['contribution welcome'], prMode: 'automatic' } },
      Date.now(),
    );

    expect(result).toMatchObject({ ok: false, refusal: { code: 'repo_not_eligible' } });
    expect(await getProject(env.DB, BUNDLER)).toMatchObject({
      status: 'rejected',
      policy: POLICY,
      settings: { prMode: 'reviewed' },
      settingsVersion: 1,
    });
  });

  test('a maintainer who registers a removed listing puts it back in the queue, and takes the repo off the do-not-list', async () => {
    const admin = await connectAgent(github, ADMIN.login);
    await call(admin, 'admin_add_project', { repo: BUNDLER, policy: POLICY, settings: { tags: ['contribution welcome'] } });
    await call(admin, 'admin_remove_project', { repo: BUNDLER });
    const maintainer = await connectAgent(github, 'sample-maintainer');

    const registered = await call(maintainer, 'register_project', { repo: BUNDLER, settings: { tags: ['contribution welcome'] } });
    const queue = await call(admin, 'admin_queue', {});
    const approved = await call(admin, 'admin_decide', { id: await queueId(admin, BUNDLER), decision: 'approve' });

    expect(registered.structuredContent).toMatchObject({ status: 'pending' });
    expect(queue.structuredContent).toMatchObject({ items: [{ repo: BUNDLER, kind: 'registration', onDoNotList: false }] });
    expect(approved.structuredContent).toMatchObject({ status: 'approved' });
    expect(await getDoNotListEntry(env.DB, BUNDLER)).toBeNull();
  });

  test('a maintainer who registers a removed registration again puts it back in the queue, off the do-not-list, and a second registration is refused', async () => {
    const maintainer = await registerHarbor();
    const admin = await connectAgent(github, ADMIN.login);
    await call(admin, 'admin_remove_project', { repo: HARBOR });

    const again = await call(maintainer, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'], claimsPerIssue: 2 } });
    const twice = await call(maintainer, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });

    expect(again.structuredContent).toMatchObject({ saved: true, status: 'pending' });
    expect(await getProject(env.DB, HARBOR)).toMatchObject({
      status: 'pending',
      statusReason: null,
      statusChangedBy: 1008,
      settings: { claimsPerIssue: 2 },
    });
    expect(await getDoNotListEntry(env.DB, HARBOR)).toBeNull();
    expect(textOf(twice)).toMatch(/^Refused \(already_registered\)/);
  });

  test("a maintainer who registers a repo that was on the do-not-list, and no project, takes it off the list", async () => {
    const admin = await connectAgent(github, ADMIN.login);
    await call(admin, 'admin_remove_project', { repo: TOOLS });
    const maintainer = await connectAgent(github, 'sample-maintainer');

    const registered = await call(maintainer, 'register_project', { repo: TOOLS, settings: { tags: ['help wanted'] } });

    expect(registered.structuredContent).toMatchObject({ saved: true, status: 'pending' });
    expect(await getDoNotListEntry(env.DB, TOOLS)).toBeNull();
  });

  test("a removal that lands just after a maintainer registers the repo again leaves it rejected and on the do-not-list", async () => {
    const maintainer = await registerHarbor();
    const admin = await connectAgent(github, ADMIN.login);
    await call(admin, 'admin_remove_project', { repo: HARBOR });
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, 'batch').mockImplementationOnce(async (statements) => {
      const results = await batch(statements);
      // The maintainers ask again, right after the registration's write.
      await adminRemoveProject(adminCaller(), { repo: HARBOR }, Date.now());
      return results;
    });

    await call(maintainer, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });

    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'rejected', statusReason: "Removed at its maintainers' request." });
    expect(await getDoNotListEntry(env.DB, HARBOR)).not.toBeNull();
  });

  test("a registration that lands while a removal rejects the project doesn't leave it off the do-not-list", async () => {
    const maintainer = await registerHarbor();
    const admin = await connectAgent(github, ADMIN.login);
    await call(admin, 'admin_decide', { id: await queueId(admin, HARBOR), decision: 'reject', reason: 'Not ready yet.' });
    const batch = env.DB.batch.bind(env.DB);
    let again: Result | undefined;
    vi.spyOn(env.DB, 'batch').mockImplementationOnce(async (statements) => {
      // The maintainer registers again after the removal put the repo on the
      // list and read the project, and before its rejection lands.
      again = await call(maintainer, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });
      return batch(statements);
    });

    const removed = await adminRemoveProject(adminCaller(), { repo: HARBOR }, Date.now());

    expect(again?.structuredContent).toMatchObject({ saved: true, status: 'pending' });
    expect(removed).toEqual({ ok: true, value: { repo: HARBOR, status: 'rejected' } });
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'rejected', statusReason: "Removed at its maintainers' request." });
    expect(await getDoNotListEntry(env.DB, HARBOR)).not.toBeNull();
  });

  test("removing a repo that isn't a project puts it on the do-not-list alone", async () => {
    const admin = await connectAgent(github, ADMIN.login);

    const result = await call(admin, 'admin_remove_project', { repo: TOOLS });

    expect(result.structuredContent).toEqual({ repo: TOOLS, status: null });
    expect(await getDoNotListEntry(env.DB, TOOLS)).not.toBeNull();
  });
});
