import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  addCandidate,
  getIssueSync,
  getProject,
  holdProject,
  listIssues,
  releaseProject,
  savePerson,
  setProjectStatus,
} from '../../src/db';
import { adminAddProject, adminDecide } from '../../src/admin/actions';
import type { Caller } from '../../src/auth/permissions';
import { syncTaggedIssues } from '../../src/sync/issues';
import { readsOnApprovalSettled } from '../../src/sync/read-now';
import { startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { freshNumbers, jobDeps, knowServiceToken, SERVICE_LOGIN, TIMELINE } from '../sync/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from './helpers';

// An admin approves a project, and Good First Token reads its tagged issues
// from GitHub with the service token right after it answers, with no cron
// run. The admin's tools are called through the MCP client SDK against the
// whole Worker and the GitHub fake, which waits for the read before it
// gives back the tool's answer, and once directly, to show the action
// answers while the read goes on. sample-admin is the admin, and
// octo-maintainer an admin of sample-owner/sample-harbor on the fake. The
// repos and policy text are the fake's made-up sample data.

let github: GitHubFake;
const configuredAdmins = env.ADMIN_GITHUB_IDS;
const ADMIN = { githubId: 1010, login: 'sample-admin' };
const HARBOR = 'sample-owner/sample-harbor';
const BUNDLER = 'sample-owner/sample-bundler';
const TAG = 'contribution welcome';
const POLICY = {
  quote: 'AI help is fine. Write the PR description yourself.',
  url: `https://github.com/${BUNDLER}/blob/main/CONTRIBUTING.md`,
  tier: 'allows_with_conditions' as const,
};
const SECOND = 1000;
let logged: string[];

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
  knowServiceToken(github);
  freshNumbers(github, BUNDLER);
  freshNumbers(github, HARBOR);
  env.ADMIN_GITHUB_IDS = String(ADMIN.githubId);
  vi.spyOn(env.MCP_LIMITER, 'limit').mockResolvedValue({ success: true });
  logged = [];
  const keep = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'warn').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
});

afterEach(async () => {
  await readsOnApprovalSettled();
  env.ADMIN_GITHUB_IDS = configuredAdmins;
  vi.useRealTimers();
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

/** The admin as the actions see them, with the GitHub token the fake gave their agent. */
function adminCaller(): Caller {
  const token = Object.entries(github.state.tokens).find(([, grant]) => grant.login === ADMIN.login)?.[0] ?? null;
  return { ...ADMIN, gitHubToken: () => Promise.resolve(token) };
}

/** Makes the fake refuse the service token, as GitHub refused it once it expired. */
function refuseServiceToken(): void {
  Reflect.deleteProperty(github.state.tokens, env.GH_SERVICE_TOKEN);
}

const serviceCalls = () => github.calls.filter((c) => c.login === SERVICE_LOGIN);

function openIssues(repo: string, count: number, label: string): void {
  for (let n = 0; n < count; n++) {
    github.openIssue(repo, { title: `Sample issue ${String(n)}`, labels: [label], by: 'sample-maintainer' });
  }
}

/** Lists sample-bundler from its policy with admin_add_project. */
function listBundler(admin: ConnectedAgent, settings: Record<string, unknown> = { tags: [TAG] }) {
  return call(admin, 'admin_add_project', { repo: BUNDLER, policy: POLICY, settings });
}

/** Registers sample-harbor as octo-maintainer, and gives its ID in the admin queue. */
async function registerHarbor(admin: ConnectedAgent): Promise<string> {
  const maintainer = await connectAgent(github, 'octo-maintainer');
  await call(maintainer, 'register_project', { repo: HARBOR, settings: { tags: ['help wanted'] } });
  const queue = await call(admin, 'admin_queue', {});
  const items = (queue.structuredContent?.items ?? []) as { id: string; repo: string }[];
  const id = items.find((item) => item.repo === HARBOR)?.id;
  if (id === undefined) throw new Error('the registration is not in the queue');
  return id;
}

/**
 * A gate in front of the service token's calls to GitHub, closed until
 * `open` is called. `asked` has the path of each call that reached it.
 */
function gateServiceToken(): { open: () => void; reached: Promise<void>; asked: string[] } {
  const asked: string[] = [];
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  let reach: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.headers.get('authorization')?.includes(env.GH_SERVICE_TOKEN)) {
      asked.push(new URL(request.url).pathname);
      reach();
      await opened;
    }
    return github.fetch(request);
  });
  return { open, reached, asked };
}

describe('a read on approval', () => {
  test('a project listed with admin_add_project has its tagged issues stored without a cron run', async () => {
    openIssues(BUNDLER, 3, TAG);
    const admin = await connectAgent(github, ADMIN.login);

    const listed = await listBundler(admin);
    await readsOnApprovalSettled();

    expect(listed.structuredContent).toEqual({ repo: BUNDLER, status: 'approved', source: 'policy', updated: false });
    // The 3 opened here and the fake's own sample issue under the tag.
    expect(await listIssues(env.DB, BUNDLER)).toHaveLength(4);
    expect((await getIssueSync(env.DB, BUNDLER))?.readAt).not.toBeNull();
    expect(serviceCalls().map((c) => c.operation)).toContain(TIMELINE);
  });

  test("the admin's answer doesn't wait for the read: it comes while the read waits on GitHub, and the issues land after", async () => {
    openIssues(BUNDLER, 2, TAG);
    await connectAgent(github, ADMIN.login);
    const caller = adminCaller();
    const gate = gateServiceToken();

    // The action admin_add_project runs. A request to the Worker would wait
    // for the read here, as tests' requests do.
    const listed = await adminAddProject(caller, { repo: BUNDLER, policy: POLICY, settings: { tags: [TAG] } }, Date.now());
    await gate.reached;
    const before = await listIssues(env.DB, BUNDLER);
    gate.open();
    await readsOnApprovalSettled();

    expect(listed).toMatchObject({ ok: true, value: { repo: BUNDLER, status: 'approved' } });
    expect(before).toEqual([]);
    expect(await listIssues(env.DB, BUNDLER)).toHaveLength(3);
  });

  test('a registration approved with admin_decide has its tagged issues stored without a cron run', async () => {
    const admin = await connectAgent(github, ADMIN.login);
    const id = await registerHarbor(admin);
    openIssues(HARBOR, 2, 'help wanted');
    const before = serviceCalls().length;

    const approved = await call(admin, 'admin_decide', { id, decision: 'approve' });
    await readsOnApprovalSettled();

    expect(approved.structuredContent).toMatchObject({ repo: HARBOR, kind: 'registration', status: 'approved' });
    expect(serviceCalls().length).toBeGreaterThan(before);
    expect((await listIssues(env.DB, HARBOR)).map((i) => i.title)).toEqual(expect.arrayContaining(['Sample issue 0', 'Sample issue 1']));
    expect((await getIssueSync(env.DB, HARBOR))?.readAt).not.toBeNull();
  });

  test("a rejected registration isn't read", async () => {
    const admin = await connectAgent(github, ADMIN.login);
    const id = await registerHarbor(admin);
    const before = serviceCalls().length;

    await call(admin, 'admin_decide', { id, decision: 'reject', reason: 'Not a fit.' });
    await readsOnApprovalSettled();

    expect(serviceCalls()).toHaveLength(before);
    expect(await listIssues(env.DB, HARBOR)).toEqual([]);
  });

  test('a crawler find approved with admin_decide has its tagged issues stored without a cron run', async () => {
    openIssues(BUNDLER, 2, TAG);
    const now = Date.now();
    const candidate = await addCandidate(
      env.DB,
      {
        repo: BUNDLER,
        facts: { stars: 12000, createdAt: now - 6 * 365 * 86_400_000, pushedAt: now - 7_200_000, ownerCreatedAt: now - 9 * 365 * 86_400_000 },
        policy: POLICY,
        settings: {},
        suggestedTags: [{ name: TAG, openIssues: 1 }],
      },
      now - 3_600_000,
    );
    if (!candidate) throw new Error('the candidate was not added');
    const admin = await connectAgent(github, ADMIN.login);

    const approved = await call(admin, 'admin_decide', { id: candidate.id, decision: 'approve', settings: { tags: [TAG] } });
    await readsOnApprovalSettled();

    expect(approved.structuredContent).toMatchObject({ repo: BUNDLER, kind: 'candidate', status: 'approved' });
    expect(await listIssues(env.DB, BUNDLER)).toHaveLength(3);
  });

  test('listing an approved project again reads it when no pass ever finished, and not once one has', async () => {
    const admin = await connectAgent(github, ADMIN.login);
    // The service token is refused at first, as it was while it had expired.
    refuseServiceToken();
    await listBundler(admin);
    await readsOnApprovalSettled();
    expect(await listIssues(env.DB, BUNDLER)).toEqual([]);
    knowServiceToken(github);

    const relisted = await listBundler(admin, { tags: [TAG] });
    await readsOnApprovalSettled();
    const read = await listIssues(env.DB, BUNDLER);
    const calls = serviceCalls().length;
    await listBundler(admin, { tags: [TAG, 'help wanted'] });
    await readsOnApprovalSettled();

    expect(relisted.structuredContent).toMatchObject({ status: 'approved', updated: true });
    expect(read).toHaveLength(1);
    expect(serviceCalls()).toHaveLength(calls);
  });

  test("an admin's resume reads a project no pass ever finished, and not one the sync read", async () => {
    await savePerson(env.DB, ADMIN, Date.now());
    const admin = await connectAgent(github, ADMIN.login);
    refuseServiceToken();
    await listBundler(admin);
    await readsOnApprovalSettled();
    await call(admin, 'admin_pause_project', { repo: BUNDLER, paused: true, reason: 'Checking the policy.' });
    knowServiceToken(github);

    await call(admin, 'admin_pause_project', { repo: BUNDLER, paused: false });
    await readsOnApprovalSettled();
    const read = await listIssues(env.DB, BUNDLER);
    await call(admin, 'admin_pause_project', { repo: BUNDLER, paused: true, reason: 'Checking the policy.' });
    const calls = serviceCalls().length;
    await call(admin, 'admin_pause_project', { repo: BUNDLER, paused: false });
    await readsOnApprovalSettled();

    expect(read).toHaveLength(1);
    expect(serviceCalls()).toHaveLength(calls);
  });

  test('approving a pause Good First Token made reads the project when no pass ever finished', async () => {
    await savePerson(env.DB, ADMIN, Date.now());
    const admin = await connectAgent(github, ADMIN.login);
    refuseServiceToken();
    await listBundler(admin);
    await readsOnApprovalSettled();
    await setProjectStatus(env.DB, BUNDLER, { status: 'paused', reason: 'Paused for a test.', changedBy: null }, Date.now());
    knowServiceToken(github);
    const queue = await call(admin, 'admin_queue', { kind: 'pause' });
    const id = ((queue.structuredContent?.items ?? []) as { id: string; repo: string }[]).find((i) => i.repo === BUNDLER)?.id;

    const resumed = await call(admin, 'admin_decide', { id, decision: 'approve' });
    await readsOnApprovalSettled();

    expect(resumed.structuredContent).toMatchObject({ repo: BUNDLER, kind: 'pause', status: 'approved' });
    expect(await listIssues(env.DB, BUNDLER)).toHaveLength(1);
  });
});

describe('the rules a read on approval keeps', () => {
  test('with no service token, the listing still lands, nothing is read, and the log names the secret', async () => {
    const admin = await connectAgent(github, ADMIN.login);
    const vars = env as unknown as Record<string, string>;
    const token = vars.GH_SERVICE_TOKEN ?? '';
    vars.GH_SERVICE_TOKEN = '';
    try {
      const listed = await listBundler(admin);
      await readsOnApprovalSettled();

      expect(listed.structuredContent).toMatchObject({ repo: BUNDLER, status: 'approved' });
      expect(await getProject(env.DB, BUNDLER)).toMatchObject({ status: 'approved' });
      expect(serviceCalls()).toEqual([]);
      expect(logged.join('\n')).toContain(`No read of ${BUNDLER}'s tagged issues ran on its approval. The GH_SERVICE_TOKEN secret is not set.`);
    } finally {
      vars.GH_SERVICE_TOKEN = token;
    }
  });

  test('when GitHub refuses the service token, the listing still lands, and the log says GitHub refused it', async () => {
    const admin = await connectAgent(github, ADMIN.login);
    refuseServiceToken();

    const listed = await listBundler(admin);
    await readsOnApprovalSettled();

    expect(listed.structuredContent).toMatchObject({ repo: BUNDLER, status: 'approved' });
    expect(await listIssues(env.DB, BUNDLER)).toEqual([]);
    expect(logged.join('\n')).toContain(`The read of ${BUNDLER} on its approval stopped. GitHub refused the service token (401).`);
  });

  test('it leaves a fifth of the hour to the other jobs, as the sync does: with less left it reads no issue, and the next cron run reads them', async () => {
    const admin = await connectAgent(github, ADMIN.login);
    github.spendRateLimit(SERVICE_LOGIN, 'core', 4100);

    await listBundler(admin);
    await readsOnApprovalSettled();
    const onApproval = serviceCalls().map((c) => c.operation);
    github.state.rateLimits = {};
    const run = await syncTaggedIssues(jobDeps(github));

    expect(onApproval).toEqual(['GET /rate_limit']);
    expect(run).toMatchObject({ finished: 1, held: [] });
    expect(await listIssues(env.DB, BUNDLER)).toHaveLength(1);
  });

  test('with a little more than a fifth of the hour left, it reads', async () => {
    openIssues(BUNDLER, 2, TAG);
    const admin = await connectAgent(github, ADMIN.login);
    github.spendRateLimit(SERVICE_LOGIN, 'core', 3900);

    await listBundler(admin);

    expect(await listIssues(env.DB, BUNDLER)).toHaveLength(3);
  });

  test('it makes at most 200 calls, and the next cron run reads the rest of its pass, skipping the issues it read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    openIssues(BUNDLER, 230, TAG);
    const admin = await connectAgent(github, ADMIN.login);

    await listBundler(admin);
    await readsOnApprovalSettled();
    const calls = serviceCalls().length;
    const readOnApproval = (await listIssues(env.DB, BUNDLER)).length;
    const sync = await getIssueSync(env.DB, BUNDLER);
    const timelines = () => serviceCalls().filter((c) => c.operation === TIMELINE).length;
    const before = timelines();
    const run = await syncTaggedIssues(jobDeps(github));

    expect(calls).toBe(200);
    expect(readOnApproval).toBeGreaterThan(0);
    expect(sync).toMatchObject({ readAt: null, readingUntil: null });
    expect(sync?.passStartedAt).not.toBeNull();
    expect(run).toMatchObject({ finished: 1, held: [] });
    expect(await listIssues(env.DB, BUNDLER)).toHaveLength(231);
    expect(timelines() - before).toBe(231 - readOnApproval);
  });

  test('it stops before a call once it has read for 20 seconds, lets go of the project, and the next cron run reads the rest', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    openIssues(BUNDLER, 30, TAG);
    const admin = await connectAgent(github, ADMIN.login);
    let timelineReads = 0;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith('/timeline')) {
        timelineReads += 1;
        if (timelineReads === 3) vi.setSystemTime(Date.now() + 19 * SECOND);
        if (timelineReads === 6) vi.setSystemTime(Date.now() + SECOND);
      }
      return github.fetch(request);
    });

    await listBundler(admin);
    await readsOnApprovalSettled();
    const read = await listIssues(env.DB, BUNDLER);
    const run = await syncTaggedIssues(jobDeps(github));

    expect(timelineReads).toBe(6 + run.issues);
    expect(read).toHaveLength(6);
    expect(logged.join('\n')).toContain(`The read of ${BUNDLER} on its approval stopped.`);
    expect(run).toMatchObject({ finished: 1, held: [] });
    expect(await listIssues(env.DB, BUNDLER)).toHaveLength(31);
  });

  test('while another run holds the project, the read on approval reads nothing of it, and the approval lands', async () => {
    const admin = await connectAgent(github, ADMIN.login);
    const id = await registerHarbor(admin);
    const until = Date.now() + 15 * 60 * SECOND;
    expect(await holdProject(env.DB, HARBOR, Date.now(), until)).toBe(true);
    const before = serviceCalls().length;

    const approved = await call(admin, 'admin_decide', { id, decision: 'approve' });
    await readsOnApprovalSettled();
    await releaseProject(env.DB, HARBOR, until);

    expect(approved.structuredContent).toMatchObject({ status: 'approved' });
    expect(serviceCalls()).toHaveLength(before);
    expect(await listIssues(env.DB, HARBOR)).toEqual([]);
  });

  test('reads on approval run one at a time: one approved while another reads waits for it, then reads', async () => {
    openIssues(HARBOR, 1, 'help wanted');
    const admin = await connectAgent(github, ADMIN.login);
    const id = await registerHarbor(admin);
    const gate = gateServiceToken();

    await adminAddProject(adminCaller(), { repo: BUNDLER, policy: POLICY, settings: { tags: [TAG] } }, Date.now());
    await gate.reached;
    await adminDecide(adminCaller(), { id, decision: 'approve' }, Date.now());
    await new Promise((resolve) => setTimeout(resolve, 100));
    const askedWhileFirstReads = [...gate.asked];
    gate.open();
    await readsOnApprovalSettled();

    expect(askedWhileFirstReads).toHaveLength(1);
    expect(await listIssues(env.DB, BUNDLER)).toHaveLength(1);
    expect((await listIssues(env.DB, HARBOR)).map((i) => i.title)).toContain('Sample issue 0');
  });

  test("a read that waited its turn past its 20 seconds reads nothing, and the next cron run reads the project", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    openIssues(BUNDLER, 5, TAG);
    const admin = await connectAgent(github, ADMIN.login);
    const id = await registerHarbor(admin);
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    let reach: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => { reach = resolve; });
    let timelineReads = 0;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith('/timeline') && ++timelineReads === 2) {
        reach();
        await opened;
      }
      return github.fetch(request);
    });

    await adminAddProject(adminCaller(), { repo: BUNDLER, policy: POLICY, settings: { tags: [TAG] } }, Date.now());
    await reached;
    await adminDecide(adminCaller(), { id, decision: 'approve' }, Date.now());
    vi.setSystemTime(Date.now() + 21 * SECOND);
    open();
    await readsOnApprovalSettled();
    const harborBefore = await listIssues(env.DB, HARBOR);
    const run = await syncTaggedIssues(jobDeps(github));

    expect(logged.join('\n')).toContain(`No read of ${HARBOR}'s tagged issues ran on its approval. It waited for other reads on approval for 20 seconds.`);
    expect(harborBefore).toEqual([]);
    expect(run).toMatchObject({ held: [], finished: 2 });
    expect((await listIssues(env.DB, HARBOR)).length).toBeGreaterThan(0);
  });

  test('a read that hangs on GitHub holds the project for a minute at most, and the cron reads it after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    openIssues(BUNDLER, 3, TAG);
    await connectAgent(github, ADMIN.login);
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let reach: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => { reach = resolve; });
    let timelineReads = 0;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith('/timeline') && ++timelineReads === 1) {
        reach();
        await released;
      }
      return github.fetch(request);
    });

    await adminAddProject(adminCaller(), { repo: BUNDLER, policy: POLICY, settings: { tags: [TAG] } }, Date.now());
    await reached;
    const held = await getIssueSync(env.DB, BUNDLER);
    const approvedAt = Date.now();
    vi.setSystemTime(approvedAt + 61 * SECOND);
    const run = await syncTaggedIssues(jobDeps(github));
    release();

    expect(held?.readingUntil).toBeLessThanOrEqual(approvedAt + 60 * SECOND);
    expect(run).toMatchObject({ held: [], finished: 1 });
    expect(await listIssues(env.DB, BUNDLER)).toHaveLength(4);
  });
});
