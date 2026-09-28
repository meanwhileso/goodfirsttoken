import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createProject,
  getDoNotListEntry,
  getProject,
  getWaitingRemoval,
  listWaitingRemovals,
  savePerson,
  setProjectStatus,
} from '../../src/db';
import { startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from './helpers';

// A maintainer's request to be removed, from request_removal to the admin's
// removal, called by agents through the MCP client SDK against the whole
// Worker and the GitHub fake. The people and repos are the fake's sample
// data: sample-admin is the admin here, octo-maintainer is an admin of
// sample-owner/sample-harbor, sample-maintainer of the other sample-owner
// repos, and priya and kenji have no role on them unless a test gives one.
// The reasons and the policy text are made up.

let github: GitHubFake;
const configuredAdmins = env.ADMIN_GITHUB_IDS;
const ADMIN = { githubId: 1010, login: 'sample-admin' };
const HARBOR = 'sample-owner/sample-harbor';
const BUNDLER = 'sample-owner/sample-bundler';
const TOOLS = 'sample-owner/sample-tools';
const CLI = 'sample-owner/sample-cli';
const REASON = 'We review every pull request by hand now, so please take us off.';
const REMOVED = "Removed at its maintainers' request.";

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

function sampleRepo(name: string) {
  const repo = github.state.repos[name];
  if (!repo) throw new Error(`missing sample repo ${name}`);
  return repo;
}

/** The admin queue's items as the admin's agent reads them. */
async function queue(admin: ConnectedAgent, kind = 'all'): Promise<Record<string, unknown>[]> {
  const read = await call(admin, 'admin_queue', { kind });
  return (read.structuredContent?.items ?? []) as Record<string, unknown>[];
}

/** Every request ever made, closed ones included, as stored. */
async function storedRequests() {
  const { results } = await env.DB.prepare(
    'SELECT repo, status, requested_by, closed_by FROM removal_requests ORDER BY requested_at, id',
  ).all<{ repo: string; status: string; requested_by: number; closed_by: number | null }>();
  return results;
}

/** HARBOR registered by octo-maintainer and approved by the admin. */
async function approvedHarbor(): Promise<ConnectedAgent> {
  const maintainer = await connectAgent(github, 'octo-maintainer');
  await call(maintainer, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });
  await savePerson(env.DB, ADMIN, Date.now());
  await setProjectStatus(env.DB, HARBOR, { status: 'approved', reason: null, changedBy: ADMIN.githubId }, Date.now());
  return maintainer;
}

/** BUNDLER listed from its AI policy by the admin. */
async function bundlerListing(): Promise<void> {
  await savePerson(env.DB, ADMIN, Date.now());
  await createProject(
    env.DB,
    {
      repo: BUNDLER,
      status: 'approved',
      source: 'policy',
      policy: {
        quote: 'AI help is fine. Write the PR description yourself.',
        url: `https://github.com/${BUNDLER}/blob/main/CONTRIBUTING.md`,
        tier: 'allows_with_conditions',
      },
      settings: { tags: ['contribution welcome'] },
      addedBy: ADMIN.githubId,
    },
    Date.now(),
  );
}

describe('request_removal', () => {
  test("a maintainer's request waits in the admin queue with who sent it, when, and their reason, and pauses nothing", async () => {
    const maintainer = await approvedHarbor();
    const reads = github.calls.length;

    const asked = await call(maintainer, 'request_removal', { repo: 'Sample-Owner/Sample-Harbor', reason: REASON });
    const askedGitHub = github.calls.slice(reads).map((c) => [c.operation, c.login]);
    const admin = await connectAgent(github, ADMIN.login);
    const items = await queue(admin);

    expect(asked.structuredContent).toEqual({
      repo: HARBOR,
      requestedBy: 'octo-maintainer',
      requestedAt: expect.any(String) as unknown,
      changed: true,
    });
    expect(textOf(asked)).toContain(`Asked Good First Token's admins to remove ${HARBOR}. The request waits for an admin.`);
    expect(askedGitHub).toEqual([['GET /repos/{owner}/{repo}', 'octo-maintainer']]);
    expect(items).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^rem_/) as unknown,
        kind: 'removal',
        repo: HARBOR,
        requestedBy: 'octo-maintainer',
        requestedAt: asked.structuredContent?.requestedAt,
        facts: expect.objectContaining({ stars: 4200 }) as unknown,
        onDoNotList: false,
        removal: { reason: REASON, project: { status: 'approved', source: 'registered' } },
      }),
    ]);
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'approved' });
    expect(await getDoNotListEntry(env.DB, HARBOR)).toBeNull();
  });

  test("the queue's text quotes the reason as the maintainer's words, and says how to act on it", async () => {
    const maintainer = await approvedHarbor();
    await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });
    const admin = await connectAgent(github, ADMIN.login);

    const text = textOf(await call(admin, 'admin_queue', { kind: 'removal' }));

    expect(text).toContain(`removal · ${HARBOR}`);
    expect(text).toContain('from @octo-maintainer');
    expect(text).toContain(`their reason, in their own words: "${REASON}"`);
    expect(text).toContain('Its project is approved, registered by its maintainers.');
    expect(text).toContain('Act on a request to be removed with admin_remove_project and its repo');
  });

  test("someone GitHub says doesn't maintain the repo is refused, and no request is saved", async () => {
    await approvedHarbor();
    const donor = await connectAgent(github, 'priya');
    const writer = await connectAgent(github, 'kenji');
    sampleRepo(HARBOR).collaborators.kenji = 'write';

    const byDonor = await call(donor, 'request_removal', { repo: HARBOR, reason: REASON });
    const byWriter = await call(writer, 'request_removal', { repo: HARBOR, reason: REASON });

    const refused = `Refused (not_maintainer): Only an admin or maintainer of ${HARBOR} on GitHub can do this.`;
    expect([textOf(byDonor), textOf(byWriter)]).toEqual([refused, refused]);
    expect(await storedRequests()).toEqual([]);
  });

  test('the maintain role on GitHub is enough to ask', async () => {
    await approvedHarbor();
    const agent = await connectAgent(github, 'kenji');
    sampleRepo(HARBOR).collaborators.kenji = 'maintain';

    const asked = await call(agent, 'request_removal', { repo: HARBOR, reason: REASON });

    expect(asked.structuredContent).toMatchObject({ repo: HARBOR, requestedBy: 'kenji', changed: true });
  });

  test("a repo that lets only collaborators open pull requests can ask, though it can't be registered", async () => {
    const maintainer = await connectAgent(github, 'sample-maintainer');
    sampleRepo(TOOLS).pullRequestCreationPolicy = 'collaborators_only';

    const registered = await call(maintainer, 'register_project', { repo: TOOLS });
    const asked = await call(maintainer, 'request_removal', { repo: TOOLS, reason: REASON });

    expect(textOf(registered)).toMatch(/^Refused \(repo_not_eligible\)/);
    expect(asked.structuredContent).toMatchObject({ repo: TOOLS, changed: true });
    expect(await getWaitingRemoval(env.DB, TOOLS)).toMatchObject({ reason: REASON, requestedBy: 1009 });
  });

  test('a project Good First Token paused on its own, because GitHub shows its repo archived, can ask', async () => {
    const maintainer = await approvedHarbor();
    await setProjectStatus(
      env.DB,
      HARBOR,
      { status: 'paused', reason: `${HARBOR} is archived on GitHub.`, changedBy: null },
      Date.now(),
    );
    sampleRepo(HARBOR).archived = true;
    const admin = await connectAgent(github, ADMIN.login);

    const asked = await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });
    const [item] = await queue(admin);

    expect(asked.structuredContent).toMatchObject({ repo: HARBOR, changed: true });
    expect(item).toMatchObject({ kind: 'removal', removal: { project: { status: 'paused', source: 'registered' } } });
  });

  test("a repo GitHub shows the maintainer no public repo for, like one that went private, is refused, and its project stays paused", async () => {
    const maintainer = await approvedHarbor();
    await setProjectStatus(
      env.DB,
      HARBOR,
      { status: 'paused', reason: `GitHub shows no public repo named ${HARBOR}.`, changedBy: null },
      Date.now(),
    );
    sampleRepo(HARBOR).private = true;

    const asked = await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });

    expect(textOf(asked)).toBe(
      `Refused (not_maintainer): GitHub shows you no public repo named ${HARBOR}. Only an admin or maintainer of a public repo can do this.`,
    );
    expect(await storedRequests()).toEqual([]);
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'paused', statusChangedBy: null });
  });

  test('a repo GitHub blocked access to is refused, since GitHub says nothing of who maintains it', async () => {
    const maintainer = await approvedHarbor();
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === `/repos/${HARBOR}`) {
        return Response.json({ message: 'Repository access blocked', block: { reason: 'dmca' } }, { status: 451 });
      }
      return github.fetch(request);
    });

    const asked = await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });

    expect(textOf(asked)).toBe(
      `Refused (not_maintainer): GitHub blocked access to ${HARBOR}, so it can't say whether you are an admin or maintainer of it.`,
    );
    expect(await storedRequests()).toEqual([]);
  });

  test('a second request while one waits keeps the first, and says who asked and when', async () => {
    const maintainer = await approvedHarbor();
    const coMaintainer = await connectAgent(github, 'kenji');
    sampleRepo(HARBOR).collaborators.kenji = 'maintain';
    const first = await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });

    const second = await call(coMaintainer, 'request_removal', { repo: HARBOR, reason: 'Off, please.' });

    expect(second.structuredContent).toEqual({
      repo: HARBOR,
      requestedBy: 'octo-maintainer',
      requestedAt: first.structuredContent?.requestedAt,
      changed: false,
    });
    expect(textOf(second)).toContain('and that request still waits for an admin. Nothing changed.');
    expect(await listWaitingRemovals(env.DB)).toMatchObject([{ reason: REASON, requestedBy: 1008 }]);
  });

  test("a listing made from its AI policy can ask, and the admin's removal rejects the listing and closes the request", async () => {
    await bundlerListing();
    const maintainer = await connectAgent(github, 'sample-maintainer');
    await call(maintainer, 'request_removal', { repo: BUNDLER, reason: REASON });
    const admin = await connectAgent(github, ADMIN.login);
    const [item] = await queue(admin);

    const removed = await call(admin, 'admin_remove_project', { repo: BUNDLER });

    expect(item).toMatchObject({ repo: BUNDLER, removal: { project: { status: 'approved', source: 'policy' } } });
    expect(removed.structuredContent).toEqual({ repo: BUNDLER, status: 'rejected' });
    expect(await queue(admin)).toEqual([]);
    expect(await storedRequests()).toEqual([{ repo: BUNDLER, status: 'removed', requested_by: 1009, closed_by: ADMIN.githubId }]);
    expect(await getProject(env.DB, BUNDLER)).toMatchObject({ status: 'rejected', statusReason: REMOVED });
    expect((await call(maintainer, 'project_status', { repo: BUNDLER })).structuredContent).toMatchObject({
      status: 'rejected',
      statusReason: REMOVED,
    });
  });

  test("a repo that isn't a project can ask, and the admin's removal puts it on the do-not-list and closes the request", async () => {
    const maintainer = await connectAgent(github, 'sample-maintainer');
    await call(maintainer, 'request_removal', { repo: CLI, reason: REASON });
    const admin = await connectAgent(github, ADMIN.login);
    const [item] = await queue(admin, 'removal');

    const removed = await call(admin, 'admin_remove_project', { repo: CLI });

    expect(item).toMatchObject({ repo: CLI, removal: { project: null } });
    expect(removed.structuredContent).toEqual({ repo: CLI, status: null });
    expect(await getDoNotListEntry(env.DB, CLI)).toMatchObject({ addedBy: ADMIN.githubId });
    expect(await storedRequests()).toMatchObject([{ status: 'removed', closed_by: ADMIN.githubId }]);
  });

  test("admin_decide doesn't decide a request to be removed, and the request keeps waiting", async () => {
    const maintainer = await approvedHarbor();
    await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });
    const admin = await connectAgent(github, ADMIN.login);
    const [item] = await queue(admin);
    const id = String(item?.id);

    const approved = await call(admin, 'admin_decide', { id, decision: 'approve' });
    const rejected = await call(admin, 'admin_decide', { id, decision: 'reject', reason: 'No.' });

    const refused = `Refused (not_found): ${id} is a request to be removed, which admin_decide doesn't decide. Remove its repo with admin_remove_project, which closes the request.`;
    expect([textOf(approved), textOf(rejected)]).toEqual([refused, refused]);
    expect(await getWaitingRemoval(env.DB, HARBOR)).toMatchObject({ id });
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'approved' });
  });

  test("a closed request stays closed when the repo later leaves the do-not-list, and its maintainers can ask again", async () => {
    const maintainer = await approvedHarbor();
    await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });
    const admin = await connectAgent(github, ADMIN.login);
    await call(admin, 'admin_remove_project', { repo: HARBOR });
    await call(maintainer, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });
    const [registration] = await queue(admin);

    await call(admin, 'admin_decide', { id: String(registration?.id), decision: 'approve' });
    const afterApproval = await queue(admin);
    const again = await call(maintainer, 'request_removal', { repo: HARBOR, reason: 'Changed our minds again.' });

    expect(await getDoNotListEntry(env.DB, HARBOR)).toBeNull();
    expect(afterApproval).toEqual([]);
    expect(again.structuredContent).toMatchObject({ changed: true });
    expect(await storedRequests()).toMatchObject([
      { status: 'removed', closed_by: ADMIN.githubId },
      { status: 'waiting', closed_by: null },
    ]);
  });
});
