import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { adminAddProject, adminRemoveProject } from '../../src/admin/actions';
import type { Caller } from '../../src/auth/permissions';
import {
  addCandidate,
  askRemoval,
  createProject,
  getDoNotListEntry,
  getIssueSync,
  getProject,
  getWaitingRemoval,
  listWaitingRemovals,
  savePerson,
  setDelisted,
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
const RENAMED = 'sample-owner/harbor-renamed';
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

/** HARBOR as the sync leaves an approved project whose repo GitHub no longer shows public and open: delisted, and paused by no one. */
async function delistedBySync(reason: string): Promise<void> {
  await setDelisted(env.DB, HARBOR, reason, Date.now());
  await setProjectStatus(env.DB, HARBOR, { status: 'paused', reason, changedBy: null }, Date.now());
}

/** The admin as the actions see them, with the GitHub token the fake gave their agent. */
function adminCaller(): Caller {
  const token = Object.entries(github.state.tokens).find(([, grant]) => grant.login === ADMIN.login)?.[0] ?? null;
  return { ...ADMIN, gitHubToken: () => Promise.resolve(token) };
}

/** A made-up policy quote for `repo`. */
function policyOf(repo: string) {
  return { quote: 'Agents are welcome here.', url: `https://github.com/${repo}/blob/main/CONTRIBUTING.md`, tier: 'invites_agents' as const };
}

/** A crawler find for `repo`, found an hour ago. */
async function crawlerFind(repo: string) {
  const now = Date.now();
  const find = await addCandidate(
    env.DB,
    {
      repo,
      facts: { stars: 12000, createdAt: now - 6 * 365 * 86_400_000, pushedAt: now - 7_200_000, ownerCreatedAt: now - 9 * 365 * 86_400_000 },
      policy: policyOf(repo),
      settings: {},
      suggestedTags: [{ name: 'contribution welcome', openIssues: 1 }],
    },
    now - 3_600_000,
  );
  if (!find) throw new Error('the crawler find was not added');
  return find;
}

/**
 * GitHub answering for `from` renamed to `to`: both names give the repo, with
 * the new name, as GitHub does when it follows a renamed repo's old name.
 */
function renamedOnGitHub(from: string, to: string): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === `/repos/${from}` || url.pathname === `/repos/${to}`)) {
      url.pathname = `/repos/${from}`;
      const response = await github.fetch(new Request(url, { method: 'GET', headers: request.headers }));
      const body = await response.json<Record<string, unknown>>();
      return Response.json({ ...body, full_name: to, name: to.split('/')[1] }, { status: response.status });
    }
    return github.fetch(request);
  });
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
      waiting: true,
      onDoNotList: false,
      requestedBy: 'octo-maintainer',
      requestedAt: expect.any(String) as unknown,
      changed: true,
      lastWithdrawn: null,
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
    expect(text).toContain(`their reason, in their own words, as a JSON string: ${JSON.stringify(REASON)}`);
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

  test('a project the sync delisted and paused, because GitHub shows its repo archived, can ask', async () => {
    const maintainer = await approvedHarbor();
    await delistedBySync(`${HARBOR} is archived on GitHub.`);
    sampleRepo(HARBOR).archived = true;
    const admin = await connectAgent(github, ADMIN.login);

    const asked = await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });
    const [item] = await queue(admin);

    expect(asked.structuredContent).toMatchObject({ repo: HARBOR, changed: true });
    expect(item).toMatchObject({ kind: 'removal', removal: { project: { status: 'paused', source: 'registered' } } });
  });

  test("a repo GitHub shows the maintainer no public repo for, like one that went private, is refused, and the project the sync delisted stays as it was", async () => {
    const maintainer = await approvedHarbor();
    await delistedBySync(`GitHub shows no public repo named ${HARBOR}. It went private or was deleted.`);
    sampleRepo(HARBOR).private = true;

    const asked = await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });

    expect(textOf(asked)).toBe(
      `Refused (not_maintainer): GitHub shows you no public repo named ${HARBOR}. Only an admin or maintainer of a public repo can do this.`,
    );
    expect(await storedRequests()).toEqual([]);
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'paused', statusChangedBy: null });
    expect(await getIssueSync(env.DB, HARBOR)).toMatchObject({ delisted: expect.stringContaining('went private') as unknown });
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
      waiting: true,
      onDoNotList: false,
      requestedBy: 'octo-maintainer',
      requestedAt: first.structuredContent?.requestedAt,
      changed: false,
      lastWithdrawn: null,
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

  test("admin_decide refuses a waiting request's ID as input it doesn't take, and the request keeps waiting", async () => {
    const maintainer = await approvedHarbor();
    await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });
    const admin = await connectAgent(github, ADMIN.login);
    const [item] = await queue(admin);
    const id = String(item?.id);

    const approved = await call(admin, 'admin_decide', { id, decision: 'approve' });
    const rejected = await call(admin, 'admin_decide', { id, decision: 'reject', reason: 'No.' });

    const refused = `Refused (invalid_input): ${id} is a request to remove ${HARBOR}, which admin_decide doesn't decide. Remove the repo with admin_remove_project, which closes the request.`;
    expect([textOf(approved), textOf(rejected)]).toEqual([refused, refused]);
    expect(await getWaitingRemoval(env.DB, HARBOR)).toMatchObject({ id });
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'approved' });
  });

  test("admin_decide says a closed request's ID, or one never given out, names nothing that waits", async () => {
    const maintainer = await approvedHarbor();
    await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });
    const admin = await connectAgent(github, ADMIN.login);
    const [item] = await queue(admin);
    const id = String(item?.id);
    await call(maintainer, 'request_removal', { repo: HARBOR, withdraw: true });

    const closed = await call(admin, 'admin_decide', { id, decision: 'approve' });
    const madeUp = await call(admin, 'admin_decide', { id: 'rem_Fq9Lw2Xr7Tb4Mz6Kp1Vd', decision: 'approve' });

    expect(textOf(closed)).toMatch(new RegExp(`^Refused \\(not_found\\): Nothing waits in the admin queue with the id ${id}\\.`));
    expect(textOf(madeUp)).toMatch(/^Refused \(not_found\): Nothing waits in the admin queue with the id rem_Fq9Lw2Xr7Tb4Mz6Kp1Vd\./);
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

  test('the request is saved under the name its project was listed with, even when GitHub now names the repo another way', async () => {
    const maintainer = await approvedHarbor();
    renamedOnGitHub(HARBOR, RENAMED);
    const admin = await connectAgent(github, ADMIN.login);

    const asked = await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });
    await call(admin, 'admin_remove_project', { repo: HARBOR });

    expect(asked.structuredContent).toMatchObject({ repo: HARBOR, changed: true });
    expect(await storedRequests()).toMatchObject([{ repo: HARBOR, status: 'removed' }]);
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'rejected', statusReason: REMOVED });
  });

  test("asked for by a name no project has, like a renamed repo's new name, the queue says no project has that name", async () => {
    const maintainer = await approvedHarbor();
    renamedOnGitHub(HARBOR, RENAMED);
    const admin = await connectAgent(github, ADMIN.login);

    await call(maintainer, 'request_removal', { repo: RENAMED, reason: REASON });
    const [item] = await queue(admin);
    const text = textOf(await call(admin, 'admin_queue', {}));

    expect(item).toMatchObject({ repo: RENAMED, removal: { project: null } });
    expect(text).toContain(`No project on Good First Token has the name ${RENAMED}.`);
  });

  test("admin_queue's kind lists only that kind: registrations, crawler finds, or requests to be removed", async () => {
    await crawlerFind(BUNDLER);
    const maintainer = await connectAgent(github, 'octo-maintainer');
    await call(maintainer, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });
    const other = await connectAgent(github, 'sample-maintainer');
    await call(other, 'request_removal', { repo: CLI, reason: REASON });
    const admin = await connectAgent(github, ADMIN.login);

    const kinds = async (kind: string) => (await queue(admin, kind)).map((item) => [item.kind, item.repo]);

    expect(await kinds('registration')).toEqual([['registration', HARBOR]]);
    expect(await kinds('candidate')).toEqual([['candidate', BUNDLER]]);
    expect(await kinds('removal')).toEqual([['removal', CLI]]);
    expect(await kinds('all')).toHaveLength(3);
  });
});

describe('while a request to be removed waits', () => {
  test('no admin can list the repo from its policy, and the request keeps waiting', async () => {
    const maintainer = await connectAgent(github, 'sample-maintainer');
    await call(maintainer, 'request_removal', { repo: CLI, reason: REASON });
    const admin = await connectAgent(github, ADMIN.login);

    const listed = await call(admin, 'admin_add_project', { repo: CLI, policy: policyOf(CLI), settings: { tags: ['agents welcome'] } });

    expect(textOf(listed)).toBe(
      `Refused (repo_not_eligible): A maintainer of ${CLI} asked to have it removed, and that request waits in the admin queue. Remove the repo with admin_remove_project, or list it only once its maintainers withdraw the request.`,
    );
    expect(await getProject(env.DB, CLI)).toBeNull();
    expect(await getWaitingRemoval(env.DB, CLI)).not.toBeNull();
  });

  test("no admin can list a repo already listed from its policy again, and the listing keeps what it had", async () => {
    await bundlerListing();
    const maintainer = await connectAgent(github, 'sample-maintainer');
    await call(maintainer, 'request_removal', { repo: BUNDLER, reason: REASON });
    const admin = await connectAgent(github, ADMIN.login);

    const relisted = await call(admin, 'admin_add_project', {
      repo: BUNDLER,
      policy: policyOf(BUNDLER),
      settings: { tags: ['contribution welcome'], prMode: 'automatic' },
    });

    expect(textOf(relisted)).toMatch(/^Refused \(repo_not_eligible\): A maintainer of sample-owner\/sample-bundler asked to have it removed/);
    expect(await getProject(env.DB, BUNDLER)).toMatchObject({ settings: { prMode: 'reviewed' }, settingsVersion: 1 });
  });

  test.each([
    ['a new listing', CLI, false],
    ['a listing again', BUNDLER, true],
  ] as const)(
    'a request that lands just before %s writes keeps the listing as it was, since the write checks for one',
    async (_name, repo, listedBefore) => {
      if (listedBefore) await bundlerListing();
      // Records sample-maintainer, who asks, and gives the admin a GitHub
      // token, which the listing reads the repo with.
      await connectAgent(github, 'sample-maintainer');
      await connectAgent(github, ADMIN.login);
      const batch = env.DB.batch.bind(env.DB);
      vi.spyOn(env.DB, 'batch').mockImplementationOnce(async (statements) => {
        // The maintainer asks after the listing checked, and before it writes.
        await askRemoval(env.DB, { repo, reason: REASON, requestedBy: 1009 }, Date.now());
        return batch(statements);
      });

      const listed = await adminAddProject(
        adminCaller(),
        { repo, policy: policyOf(repo), settings: { tags: ['agents welcome'], prMode: 'automatic' } },
        Date.now(),
      );

      expect(listed).toEqual({
        ok: false,
        refusal: {
          code: 'repo_not_eligible',
          message: `A maintainer of ${repo} asked to have it removed, and that request waits in the admin queue. Remove the repo with admin_remove_project, or list it only once its maintainers withdraw the request.`,
        },
      });
      expect(await getWaitingRemoval(env.DB, repo)).not.toBeNull();
      if (listedBefore) {
        expect(await getProject(env.DB, repo)).toMatchObject({ settings: { prMode: 'reviewed' }, settingsVersion: 1 });
      } else {
        expect(await getProject(env.DB, repo)).toBeNull();
      }
    },
  );

  test('no admin can approve a registration of the repo, though one can reject it, and each item says why', async () => {
    const maintainer = await connectAgent(github, 'octo-maintainer');
    await call(maintainer, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });
    await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });
    const admin = await connectAgent(github, ADMIN.login);
    const registration = (await queue(admin, 'registration'))[0];
    const text = textOf(await call(admin, 'admin_queue', { kind: 'registration' }));

    const approved = await call(admin, 'admin_decide', { id: String(registration?.id), decision: 'approve' });
    const pending = await getProject(env.DB, HARBOR);
    const rejected = await call(admin, 'admin_decide', { id: String(registration?.id), decision: 'reject', reason: 'Its maintainers asked to be removed.' });

    expect(registration).toMatchObject({ kind: 'registration', removalWaits: true });
    expect(text).toContain("A request to be removed waits for this repo too, so it can't be approved while that waits.");
    expect(textOf(approved)).toMatch(/^Refused \(repo_not_eligible\): A maintainer of sample-owner\/sample-harbor asked to have it removed/);
    expect(pending).toMatchObject({ status: 'pending' });
    expect(rejected.structuredContent).toMatchObject({ status: 'rejected' });
  });

  test("no admin can list a crawler find for the repo, and the find says why", async () => {
    const find = await crawlerFind(BUNDLER);
    const maintainer = await connectAgent(github, 'sample-maintainer');
    await call(maintainer, 'request_removal', { repo: BUNDLER, reason: REASON });
    const admin = await connectAgent(github, ADMIN.login);
    const item = (await queue(admin, 'candidate'))[0];
    const text = textOf(await call(admin, 'admin_queue', { kind: 'candidate' }));

    const approved = await call(admin, 'admin_decide', { id: find.id, decision: 'approve', settings: { tags: ['contribution welcome'] } });

    expect(item).toMatchObject({ kind: 'candidate', removalWaits: true });
    expect(text).toContain("A request to be removed waits for this repo too, so it can't be listed while that waits.");
    expect(textOf(approved)).toMatch(/^Refused \(repo_not_eligible\): A maintainer of sample-owner\/sample-bundler asked to have it removed/);
    expect(await getProject(env.DB, BUNDLER)).toBeNull();
  });

  test('an item with no request waiting for its repo says nothing of one', async () => {
    const maintainer = await connectAgent(github, 'octo-maintainer');
    await call(maintainer, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });
    const admin = await connectAgent(github, ADMIN.login);

    const [item] = await queue(admin);

    expect(item).toMatchObject({ kind: 'registration', removalWaits: false });
  });
});

describe('withdrawing a request', () => {
  test('any maintainer of the repo can withdraw the request that waits, which leaves the queue and is kept as withdrawn', async () => {
    const maintainer = await approvedHarbor();
    await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });
    const coMaintainer = await connectAgent(github, 'kenji');
    sampleRepo(HARBOR).collaborators.kenji = 'maintain';
    const admin = await connectAgent(github, ADMIN.login);

    const withdrawn = await call(coMaintainer, 'request_removal', { repo: HARBOR, withdraw: true });

    expect(withdrawn.structuredContent).toMatchObject({
      repo: HARBOR,
      waiting: false,
      requestedBy: 'octo-maintainer',
      changed: true,
    });
    expect(textOf(withdrawn)).toContain(`Withdrew the request @octo-maintainer made on `);
    expect(await queue(admin)).toEqual([]);
    expect(await storedRequests()).toEqual([{ repo: HARBOR, status: 'withdrawn', requested_by: 1008, closed_by: 1002 }]);
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'approved' });
    expect(await getDoNotListEntry(env.DB, HARBOR)).toBeNull();
  });

  test('someone GitHub says doesn\'t maintain the repo is refused, and the request keeps waiting', async () => {
    const maintainer = await approvedHarbor();
    await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });
    const donor = await connectAgent(github, 'priya');

    const withdrawn = await call(donor, 'request_removal', { repo: HARBOR, withdraw: true });

    expect(textOf(withdrawn)).toBe(`Refused (not_maintainer): Only an admin or maintainer of ${HARBOR} on GitHub can do this.`);
    expect(await getWaitingRemoval(env.DB, HARBOR)).toMatchObject({ reason: REASON });
  });

  test('withdrawing when no request waits changes nothing, and says so', async () => {
    const maintainer = await approvedHarbor();

    const withdrawn = await call(maintainer, 'request_removal', { repo: HARBOR, withdraw: true });

    expect(withdrawn.structuredContent).toEqual({
      repo: HARBOR,
      waiting: false,
      onDoNotList: false,
      requestedBy: null,
      requestedAt: null,
      changed: false,
      lastWithdrawn: null,
    });
    expect(textOf(withdrawn)).toBe(`No request to remove ${HARBOR} waits, so nothing changed.`);
  });

  test('once withdrawn, a registration of the repo can be approved again', async () => {
    const maintainer = await connectAgent(github, 'octo-maintainer');
    await call(maintainer, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });
    await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });
    await call(maintainer, 'request_removal', { repo: HARBOR, withdraw: true });
    const admin = await connectAgent(github, ADMIN.login);
    const [registration] = await queue(admin);

    const approved = await call(admin, 'admin_decide', { id: String(registration?.id), decision: 'approve' });

    expect(registration).toMatchObject({ kind: 'registration', removalWaits: false });
    expect(approved.structuredContent).toMatchObject({ status: 'approved' });
  });
});

describe('a request withdrawn by someone other than the one who asked', () => {
  /** HARBOR removed, registered again by octo-maintainer, and kenji, who maintains it too, asking to keep it off. */
  async function registeredAgainWithRequest() {
    const registrant = await approvedHarbor();
    const admin = await connectAgent(github, ADMIN.login);
    await call(admin, 'admin_remove_project', { repo: HARBOR });
    await call(registrant, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });
    const asker = await connectAgent(github, 'kenji');
    sampleRepo(HARBOR).collaborators.kenji = 'maintain';
    await call(asker, 'request_removal', { repo: HARBOR, reason: 'Keep us off, please.' });
    return { registrant, admin, asker };
  }

  test('shows on the registration it stopped, in the queue, so the admin sees who withdrew it before approving', async () => {
    const { registrant, admin } = await registeredAgainWithRequest();

    const withdrawn = await call(registrant, 'request_removal', { repo: HARBOR, withdraw: true });
    const [item] = await queue(admin);
    const text = textOf(await call(admin, 'admin_queue', {}));

    expect(withdrawn.structuredContent).toMatchObject({ changed: true, requestedBy: 'kenji' });
    expect(item).toMatchObject({
      kind: 'registration',
      removalWaits: false,
      removalWithdrawn: { requestedBy: 'kenji', withdrawnBy: 'octo-maintainer' },
    });
    expect(text).toContain('@kenji asked to remove this repo, and @octo-maintainer withdrew the request on ');
    expect(await storedRequests()).toEqual([{ repo: HARBOR, status: 'withdrawn', requested_by: 1002, closed_by: 1008 }]);
  });

  test('shows on a crawler find for the repo too', async () => {
    const find = await crawlerFind(BUNDLER);
    const asker = await connectAgent(github, 'sample-maintainer');
    await call(asker, 'request_removal', { repo: BUNDLER, reason: REASON });
    const other = await connectAgent(github, 'kenji');
    sampleRepo(BUNDLER).collaborators.kenji = 'maintain';
    await call(other, 'request_removal', { repo: BUNDLER, withdraw: true });
    const admin = await connectAgent(github, ADMIN.login);

    const [item] = await queue(admin, 'candidate');

    expect(item).toMatchObject({
      id: find.id,
      removalWaits: false,
      removalWithdrawn: { requestedBy: 'sample-maintainer', withdrawnBy: 'kenji' },
    });
  });

  test('tells the one who asked, the next time they call, who withdrew their request and when', async () => {
    const asker = await approvedHarbor();
    await call(asker, 'request_removal', { repo: HARBOR, reason: REASON });
    const other = await connectAgent(github, 'kenji');
    sampleRepo(HARBOR).collaborators.kenji = 'maintain';
    const withdrawn = await call(other, 'request_removal', { repo: HARBOR, withdraw: true });

    const again = await call(asker, 'request_removal', { repo: HARBOR, reason: REASON });
    const third = await call(asker, 'request_removal', { repo: HARBOR, reason: REASON });

    expect(withdrawn.structuredContent).toMatchObject({ lastWithdrawn: null });
    expect(again.structuredContent).toMatchObject({
      waiting: true,
      changed: true,
      lastWithdrawn: { by: 'kenji', at: expect.any(String) as unknown },
    });
    expect(textOf(again)).toContain(`@kenji withdrew your last request to remove ${HARBOR}, on `);
    expect(third.structuredContent).toMatchObject({ changed: false, lastWithdrawn: null });
  });

  test('a request its own asker withdrew says nothing more, in the queue or to them', async () => {
    const maintainer = await connectAgent(github, 'octo-maintainer');
    await call(maintainer, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });
    await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });
    await call(maintainer, 'request_removal', { repo: HARBOR, withdraw: true });
    const admin = await connectAgent(github, ADMIN.login);

    const [item] = await queue(admin);
    const again = await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });

    expect(item).toMatchObject({ kind: 'registration', removalWithdrawn: null });
    expect(again.structuredContent).toMatchObject({ lastWithdrawn: null });
  });
});

describe('a repo on the do-not-list already', () => {
  test('withdrawing there says it was removed before, and changes nothing', async () => {
    const maintainer = await approvedHarbor();
    await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });
    const admin = await connectAgent(github, ADMIN.login);
    await call(admin, 'admin_remove_project', { repo: HARBOR });

    const withdrawn = await call(maintainer, 'request_removal', { repo: HARBOR, withdraw: true });

    expect(withdrawn.structuredContent).toEqual({
      repo: HARBOR,
      waiting: false,
      onDoNotList: true,
      requestedBy: null,
      requestedAt: null,
      changed: false,
      lastWithdrawn: null,
    });
    expect(textOf(withdrawn)).toContain(`${HARBOR} is on the do-not-list already, so it was removed before`);
    expect(await storedRequests()).toMatchObject([{ status: 'removed' }]);
  });

  test('asking again says it was removed before, and adds nothing to the queue', async () => {
    const maintainer = await connectAgent(github, 'sample-maintainer');
    const admin = await connectAgent(github, ADMIN.login);
    await call(admin, 'admin_remove_project', { repo: CLI });

    const asked = await call(maintainer, 'request_removal', { repo: CLI, reason: REASON });

    expect(asked.structuredContent).toEqual({
      repo: CLI,
      waiting: false,
      onDoNotList: true,
      requestedBy: null,
      requestedAt: null,
      changed: false,
      lastWithdrawn: null,
    });
    expect(textOf(asked)).toContain(`${CLI} is on the do-not-list already, so it was removed before`);
    expect(await queue(admin)).toEqual([]);
    expect(await storedRequests()).toEqual([]);
  });

  test("while a registration of it waits, asking makes a request, so the registration can't take it off the list unseen", async () => {
    const maintainer = await approvedHarbor();
    const admin = await connectAgent(github, ADMIN.login);
    await call(admin, 'admin_remove_project', { repo: HARBOR });
    await call(maintainer, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });

    const asked = await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });
    const registration = (await queue(admin, 'registration'))[0];
    const approved = await call(admin, 'admin_decide', { id: String(registration?.id), decision: 'approve' });

    expect(asked.structuredContent).toMatchObject({ waiting: true, onDoNotList: true, changed: true });
    expect(textOf(approved)).toMatch(/^Refused \(repo_not_eligible\)/);
    expect(await getDoNotListEntry(env.DB, HARBOR)).not.toBeNull();
  });
});

describe("the admin's removal", () => {
  test("keeps the admin's note, or else names who asked and when", async () => {
    const maintainer = await approvedHarbor();
    const other = await connectAgent(github, 'sample-maintainer');
    const admin = await connectAgent(github, ADMIN.login);
    const asked = await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });
    await call(other, 'request_removal', { repo: CLI, reason: REASON });

    await call(admin, 'admin_remove_project', { repo: HARBOR });
    await call(admin, 'admin_remove_project', { repo: CLI, note: 'They wrote to us too.' });

    expect(await getDoNotListEntry(env.DB, HARBOR)).toMatchObject({
      reason: `Asked by @octo-maintainer with request_removal on ${String(asked.structuredContent?.requestedAt)}.`,
    });
    expect(await getDoNotListEntry(env.DB, CLI)).toMatchObject({ reason: 'They wrote to us too.' });
  });

  test('closes the request only once the project is rejected, so a removal that fails partway leaves it waiting', async () => {
    const maintainer = await approvedHarbor();
    await call(maintainer, 'request_removal', { repo: HARBOR, reason: REASON });
    await connectAgent(github, ADMIN.login);
    vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('D1 is down.'));

    const failed = await adminRemoveProject(adminCaller(), { repo: HARBOR }, Date.now()).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(Error);
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'approved' });
    expect(await getWaitingRemoval(env.DB, HARBOR)).toMatchObject({ reason: REASON });
  });
});
