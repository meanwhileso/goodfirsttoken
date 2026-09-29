import type { CrawlMessage, Policy, ProjectSettingsInput, ProjectStatus } from '@goodfirsttoken/core';
import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FINGERPRINT_VERSION } from '../../src/crawl/fingerprint';
import { readCrawlBatch } from '../../src/crawl/queue';
import { BAN_REASON } from '../../src/crawl/reread';
import { fillCrawlQueue } from '../../src/crawl/search';
import {
  addCandidate,
  addSeed,
  addToDoNotList,
  createProject,
  decideCandidate,
  getPolicyRead,
  getProject,
  getSeed,
  listCandidates,
  listPolicyChanges,
  savePerson,
  setDelisted,
  setProjectStatus,
  statusHistory,
} from '../../src/db';
import { syncTaggedIssues } from '../../src/sync/issues';
import { ServiceGitHub } from '../../src/sync/github';
import { ALLOWANCES } from '../../src/sync/scheduled';
import { startGitHub } from '../auth/helpers';
import { db, emptyDatabase } from '../db/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from '../mcp/helpers';
import { jobDeps, knowServiceToken, SERVICE_LOGIN } from '../sync/helpers';

// Keeping listings current: the policy crawler's cron job queues each listed
// project for a weekly read, and the crawl queue's consumer reads its docs
// from the GitHub fake with the same reads and rules as a crawl. A ban or
// pull requests limited to collaborators pause it at once, a listing whose
// policy changed goes back to the admin queue, and the admins see both in
// admin_queue. The search reads the wider pool again each month, when a
// rejected find comes back only once its docs read differently. The repos
// are the fake's made-up sample-policies and sample-owner repos, and every
// line of policy text is made up. sample-admin is the admin here, and
// sample-maintainer an admin of every repo the tests use.

const INVITES = 'sample-policies/invites-agents';
const CONDITIONS = 'sample-policies/with-conditions';
const SILENT = 'sample-policies/silent';
const BANS_AI = 'sample-policies/bans-ai';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const ADMIN = { githubId: 1010, login: 'sample-admin' };
const MAINTAINER = { githubId: 1009, login: 'sample-maintainer' };
const configuredAdmins = env.ADMIN_GITHUB_IDS;

const QUOTE = 'Agents may open pull requests on their own, on issues labeled `agent ready`.';
const LISTED: Policy = { quote: QUOTE, url: `https://github.com/${INVITES}/blob/main/AI_POLICY.md`, tier: 'invites_agents' };
const AI_POLICY = `# AI policy\n\n${QUOTE}\n\nDisclose it with an Assisted-by: trailer.\n`;
const BAN = 'We no longer accept pull requests written with AI.';
const NO_AUTONOMY = 'sample-policies/no-autonomous-agents';
const CHANGED = 'Agents may open pull requests on their own, on issues labeled `agent ready` or `help wanted`.';
/** A fingerprint of the version the crawler makes now. */
const THIS_VERSION = new RegExp(`^v${String(FINGERPRINT_VERSION)}:[0-9a-f]{64}$`);
/** A fingerprint of another version, as a read kept before a change to the rules. */
const OTHER_VERSION = `v${String(FINGERPRINT_VERSION + 1)}:${'0'.repeat(64)}`;
/** A time the sync kept, like when it delisted a project. */
const A_TIME = expect.any(String) as unknown;
/** Docs that welcome AI help, which the rules misread as a ban. */
const MISREAD = '# AI policy\n\nUsing AI tools is fine. Never commit a `.env` file.\n';
const MISREAD_LISTED: Policy = {
  quote: 'Using AI tools is fine.',
  url: `https://github.com/${SILENT}/blob/main/AI_POLICY.md`,
  tier: 'allows_with_conditions',
};
const LIMITED = `${INVITES} lets only collaborators open pull requests. Only a repo that takes pull requests from anyone can be listed.`;

let github: GitHubFake;
let clock: number;
let sent: CrawlMessage[];
let resent: { body: CrawlMessage; delaySeconds: number | undefined }[];
let logged: string[];

const queue = {
  sendBatch: (messages: Iterable<MessageSendRequest<CrawlMessage>>) => {
    for (const message of messages) sent.push(message.body);
    return Promise.resolve();
  },
};

const crawlQueue = {
  send: (body: CrawlMessage, options?: QueueSendOptions) => {
    resent.push({ body, delaySeconds: options?.delaySeconds });
    return Promise.resolve();
  },
};

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
  knowServiceToken(github);
  env.ADMIN_GITHUB_IDS = String(ADMIN.githubId);
  // These tests make more MCP calls than the limit of 120 a minute allows
  // the same few people. tools.test.ts tests the limit.
  vi.spyOn(env.MCP_LIMITER, 'limit').mockResolvedValue({ success: true });
  logged = [];
  const keep = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'warn').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
  clock = Date.now();
  sent = [];
  resent = [];
  await savePerson(db, ADMIN, clock);
  await savePerson(db, MAINTAINER, clock);
});

afterEach(() => {
  env.ADMIN_GITHUB_IDS = configuredAdmins;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function sampleRepo(name: string) {
  const repo = github.state.repos[name];
  if (!repo) throw new Error(`missing sample repo ${name}`);
  return repo;
}

/** A project an admin listed from its policy, approved. */
async function listing(repo = INVITES, policy: Policy = LISTED, settings: ProjectSettingsInput = { tags: ['agent ready'], prMode: 'automatic' }) {
  const project = await createProject(db, { repo, status: 'approved', source: 'policy', policy, settings, addedBy: ADMIN.githubId }, clock);
  if (project === null) throw new Error(`${repo} is a project already`);
  return project;
}

/** A project an admin listed by approving the crawler's find of it in the admin queue. */
async function listedFromFind(repo = INVITES, policy: Policy = LISTED) {
  const find = await addCandidate(
    db,
    {
      repo,
      facts: { stars: 3100, createdAt: clock - WEEK, pushedAt: clock - HOUR, ownerCreatedAt: clock - WEEK },
      policy,
      settings: { tags: ['agent ready'], prMode: 'automatic' },
      suggestedTags: [],
    },
    clock - HOUR,
  );
  const admin = await connectAgent(github, ADMIN.login);
  const decided = await call(admin, 'admin_decide', { id: find?.id ?? '', decision: 'approve' });
  expect(decided.structuredContent).toMatchObject({ repo, kind: 'candidate', status: 'approved' });
}

/** A project its maintainer registered, approved, or pending, or rejected by the admin. */
async function registered(repo: string, status: ProjectStatus = 'approved') {
  const project = await createProject(
    db,
    {
      repo,
      status: status === 'rejected' ? 'pending' : status,
      source: 'registered',
      policy: null,
      settings: { tags: ['help wanted'] },
      addedBy: MAINTAINER.githubId,
    },
    clock,
  );
  if (project === null) throw new Error(`${repo} is a project already`);
  if (status === 'rejected') await setProjectStatus(db, repo, { status, reason: 'Not now.', changedBy: ADMIN.githubId }, clock);
}

/** Commits files to the repo's default branch as its maintainer. */
function commit(repo: string, files: Record<string, string | null>): void {
  github.commitFiles(repo, files, MAINTAINER.login);
}

/** One run of the crawler's cron job at the test's clock. */
function fill() {
  return fillCrawlQueue({ db, queue, github: new ServiceGitHub(env.GH_SERVICE_TOKEN, ALLOWANCES.crawlSearch), now: () => clock });
}

/** Runs the consumer on a batch at the test's clock, as Queues delivers it, and says what it did with each message. */
async function consume(bodies: unknown[], attempts = 1) {
  const acked: string[] = [];
  const retried: { id: string; delaySeconds: number | undefined }[] = [];
  const messages = bodies.map((body, i) => ({
    id: `m${String(i)}`,
    timestamp: new Date(),
    attempts,
    body,
    ack: () => void acked.push(`m${String(i)}`),
    retry: (options?: QueueRetryOptions) => void retried.push({ id: `m${String(i)}`, delaySeconds: options?.delaySeconds }),
  }));
  const batch = { queue: 'crawl', messages, ackAll: () => undefined, retryAll: () => undefined } as unknown as MessageBatch;
  const run = await readCrawlBatch(batch, { ...env, CRAWL_QUEUE: crawlQueue }, () => clock);
  return { acked, retried, run };
}

/**
 * A week on: the cron job queues the listed projects due for their weekly
 * read, and the consumer reads the weekly reads it queued. What the search
 * queued is dropped.
 */
async function week() {
  clock += WEEK;
  await fill();
  const rereads = sent.splice(0).filter((message) => message.reread === true);
  return consume(rereads);
}

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

interface Item {
  id: string;
  kind: string;
  repo: string;
  [field: string]: unknown;
}

function itemsOf(result: Result): Item[] {
  return (result.structuredContent?.items ?? []) as Item[];
}

/** The one queue item of `kind` for `repo`, which fails the test when there isn't exactly one. */
async function onlyItem(admin: ConnectedAgent, kind: string, repo: string): Promise<{ item: Item; text: string }> {
  const queue = await call(admin, 'admin_queue', { kind });
  const found = itemsOf(queue).filter((item) => item.repo === repo);
  expect(found, `${kind} items for ${repo}`).toHaveLength(1);
  return { item: found[0] as Item, text: textOf(queue) };
}

async function rows(table: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n')) ?? 0;
}

describe('the weekly read', () => {
  test('the cron job queues each listed project once a week, paused ones too, and leaves out the rest', async () => {
    await listing(INVITES);
    await registered('sample-owner/sample-app');
    await setProjectStatus(db, 'sample-owner/sample-app', { status: 'paused', reason: null, changedBy: MAINTAINER.githubId }, clock);
    await registered(SILENT, 'pending');
    await registered(BANS_AI, 'rejected');
    await registered(CONDITIONS);
    await addToDoNotList(db, { repo: CONDITIONS, reason: null, addedBy: ADMIN.githubId }, clock);
    await registered('sample-owner/sample-desktop');
    await setDelisted(db, 'sample-owner/sample-desktop', 'sample-owner/sample-desktop is archived on GitHub.', clock);

    const rereads = () => sent.splice(0).filter((m) => m.reread === true).flatMap((m) => m.repos);
    const first = await fill();
    const queued = rereads();
    clock += WEEK - MINUTE;
    await fill();
    const tooSoon = rereads();
    clock += MINUTE;
    await fill();
    const nextWeek = rereads();

    expect(first.rereads).toBe(2);
    // Queued at the same time, so by repo.
    expect(queued).toEqual(['sample-owner/sample-app', INVITES]);
    expect(tooSoon).toEqual([]);
    expect(nextWeek).toEqual(['sample-owner/sample-app', INVITES]);
    expect(await getPolicyRead(db, INVITES)).toMatchObject({ queuedAt: clock });
  });

  test('one run queues at most 500 listed projects for their weekly read, and the next run takes the rest', async () => {
    const names = Array.from({ length: 501 }, (_, i) => `sample-bulk/listed-${String(i).padStart(3, '0')}`);
    for (const repo of names) {
      await createProject(
        db,
        { repo, status: 'approved', source: 'registered', policy: null, settings: { tags: ['help wanted'] }, addedBy: MAINTAINER.githubId },
        clock,
      );
    }
    const rereads = () => sent.splice(0).filter((m) => m.reread === true).flatMap((m) => m.repos);

    const first = await fill();
    const firstRepos = rereads();
    clock += HOUR;
    const second = await fill();
    const secondRepos = rereads();

    expect(first.rereads).toBe(500);
    expect(firstRepos).toEqual(names.slice(0, 500));
    expect(second.rereads).toBe(1);
    expect(secondRepos).toEqual(names.slice(500));
  });

  test('reads through GitHub with the service token only: a GraphQL query for the repos, one for their files, and a REST call each', async () => {
    await listing(INVITES);
    await registered('sample-owner/sample-app');
    await fill();
    const rereads = sent.filter((m) => m.reread === true);
    const calls = github.calls.length;

    const { run } = await consume(rereads);

    const made = github.calls.slice(calls);
    expect(run?.reread.read).toBe(2);
    expect(new Set(made.map((c) => c.login))).toEqual(new Set([SERVICE_LOGIN]));
    expect(made.map((c) => (c.operation.startsWith('query') ? 'graphql' : c.operation))).toEqual([
      'GET /rate_limit',
      'graphql',
      'graphql',
      'GET /repos/{owner}/{repo}',
      'GET /repos/{owner}/{repo}',
    ]);
  });
});

describe('a listing whose policy changes', () => {
  test('goes back to the admin queue with its new policy, stays listed while it waits, and an admin lists it from the new policy', async () => {
    await listing();
    await week();
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${CHANGED}\n\nDisclose it with an Assisted-by: trailer.\n` });

    const { run } = await week();

    expect(run?.reread.changed).toEqual([INVITES]);
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'approved', policy: LISTED });
    const admin = await connectAgent(github, ADMIN.login);
    const { item, text } = await onlyItem(admin, 'policy_change', INVITES);
    expect(item).toMatchObject({
      policy: { quote: CHANGED, url: `https://github.com/${INVITES}/blob/main/AI_POLICY.md`, tier: 'invites_agents' },
      change: { listed: LISTED, status: 'approved' },
      facts: { stars: 3100 },
    });
    // The new quote and the one it is listed from are the repo's words, marked line by line.
    expect(text).toMatch(/^ +> Agents may open pull requests on their own, on issues labeled `agent ready` or `help wanted`\.$/m);
    expect(text).toMatch(/^ +> Agents may open pull requests on their own, on issues labeled `agent ready`\.$/m);

    const decided = await call(admin, 'admin_decide', { id: item.id, decision: 'approve' });

    expect(decided.structuredContent).toEqual({ repo: INVITES, kind: 'policy_change', status: 'approved', decision: 'approve', delisted: null });
    expect(await getProject(db, INVITES)).toMatchObject({
      status: 'approved',
      policy: { quote: CHANGED, tier: 'invites_agents' },
      settings: { tags: ['agent ready'], prMode: 'automatic' },
    });
    expect((await week()).run?.reread.changed).toEqual([]);
    expect(await listPolicyChanges(db, 'waiting')).toEqual([]);
  });

  test('an admin who rejects the change keeps the listing as it was, and it comes back only when the docs change again', async () => {
    await listing();
    await week();
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${CHANGED}\n` });
    await week();
    const admin = await connectAgent(github, ADMIN.login);
    const { item } = await onlyItem(admin, 'policy_change', INVITES);

    const decided = await call(admin, 'admin_decide', { id: item.id, decision: 'reject', reason: 'The same welcome, reworded.' });
    const unchanged = await week();
    commit(INVITES, { 'AI_POLICY.md': AI_POLICY });
    const back = await week();

    expect(textOf(decided)).toBe(`Kept the listing of ${INVITES} as it was. The change leaves the queue. Status: approved.`);
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'approved', policy: LISTED });
    expect(unchanged.run?.reread.changed).toEqual([]);
    expect(back.run?.reread.changed).toEqual([INVITES]);
  });

  test('a newer reading replaces the change that waits, so an admin never approves one they did not see', async () => {
    await listing();
    await week();
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${CHANGED}\n` });
    await week();
    const [older] = await listPolicyChanges(db, 'waiting');
    commit(INVITES, { 'AI_POLICY.md': '# AI policy\n\nAgents may open pull requests on their own, on any open issue.\n' });
    await week();
    const admin = await connectAgent(github, ADMIN.login);

    const stale = await call(admin, 'admin_decide', { id: older?.id ?? '', decision: 'approve' });

    expect(textOf(stale)).toMatch(/^Refused \(not_found\)/);
    const { item } = await onlyItem(admin, 'policy_change', INVITES);
    expect(item).toMatchObject({ policy: { quote: 'Agents may open pull requests on their own, on any open issue.' } });
    expect(await getProject(db, INVITES)).toMatchObject({ policy: LISTED });
  });

  test('docs that no longer welcome AI help go back to the queue with no policy to list from, and the admin keeps or pauses the listing', async () => {
    await listing();
    await week();
    commit(INVITES, { 'AI_POLICY.md': null, 'CONTRIBUTING.md': '# Contributing\n\nRun the tests before you open a pull request.\n' });
    await week();
    const admin = await connectAgent(github, ADMIN.login);
    const { item, text } = await onlyItem(admin, 'policy_change', INVITES);

    const approve = await call(admin, 'admin_decide', { id: item.id, decision: 'approve' });

    expect(item.policy).toBeNull();
    expect(text).toContain("The crawler's rules read no policy in its docs now that welcomes AI help.");
    expect(textOf(approve)).toMatch(/^Refused \(repo_not_eligible\)/);
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'approved', policy: LISTED });
  });

  test('a listing made by hand with a quote the rules read otherwise goes back once, on its first read, and not again while the docs read the same', async () => {
    await listing(INVITES, { ...LISTED, quote: 'Agents are welcome here.' });

    const first = await week();
    const admin = await connectAgent(github, ADMIN.login);
    const { item } = await onlyItem(admin, 'policy_change', INVITES);
    await call(admin, 'admin_decide', { id: item.id, decision: 'reject', reason: 'The listing quotes it well enough.' });
    const second = await week();

    expect(first.run?.reread.changed).toEqual([INVITES]);
    expect(second.run?.reread.changed).toEqual([]);
    expect(await listPolicyChanges(db, 'waiting')).toEqual([]);
  });

  test('a hash of another version, as after a change to the rules, takes the new one, and sends nothing back to the queue', async () => {
    await listing(INVITES, { ...LISTED, quote: 'Agents are welcome here.' });
    await week();
    const admin = await connectAgent(github, ADMIN.login);
    const { item } = await onlyItem(admin, 'policy_change', INVITES);
    await call(admin, 'admin_decide', { id: item.id, decision: 'reject', reason: 'The listing quotes it well enough.' });
    await db.prepare('UPDATE policy_reads SET fingerprint = ? WHERE project = ?').bind(OTHER_VERSION, INVITES).run();

    const bumped = await week();
    const after = await week();

    expect(bumped.run?.reread).toMatchObject({ read: 1, changed: [], paused: [] });
    expect(after.run?.reread).toMatchObject({ read: 1, changed: [], paused: [] });
    expect((await getPolicyRead(db, INVITES))?.fingerprint).toMatch(THIS_VERSION);
    expect(await listPolicyChanges(db, 'waiting')).toEqual([]);
  });

  test('a hash of another version still pauses a listing whose docs read a ban now and not at the last read, and sends no policy change', async () => {
    await listing();
    await week();
    await db.prepare('UPDATE policy_reads SET fingerprint = ?, banned = 0 WHERE project = ?').bind(OTHER_VERSION, INVITES).run();
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${BAN}\n` });

    const { run } = await week();

    expect(run?.reread).toMatchObject({ read: 1, paused: [INVITES], changed: [] });
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'paused', statusChangedBy: null, statusReason: BAN_REASON });
    const read = await getPolicyRead(db, INVITES);
    expect(read?.fingerprint).toMatch(THIS_VERSION);
    expect(read?.banned).toBe(true);
    expect(await rows('policy_changes')).toBe(0);
    const admin = await connectAgent(github, ADMIN.login);
    const { item } = await onlyItem(admin, 'pause', INVITES);
    expect(item.pause).toMatchObject({ reason: BAN_REASON, ban: { path: 'AI_POLICY.md', line: BAN } });
  });

  test('a hash of another version pauses nothing when the last read was a ban too, as after an admin resumed the listing', async () => {
    await listing();
    await week();
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${BAN}\n` });
    await week();
    const admin = await connectAgent(github, ADMIN.login);
    const { item } = await onlyItem(admin, 'pause', INVITES);
    await call(admin, 'admin_decide', { id: item.id, decision: 'approve' });
    await db.prepare('UPDATE policy_reads SET fingerprint = ? WHERE project = ?').bind(OTHER_VERSION, INVITES).run();
    expect((await getPolicyRead(db, INVITES))?.banned).toBe(true);

    const { run } = await week();

    expect(run?.reread).toMatchObject({ read: 1, paused: [], changed: [] });
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'approved', statusChangedBy: ADMIN.githubId });
    expect((await getPolicyRead(db, INVITES))?.fingerprint).toMatch(THIS_VERSION);
    expect(await rows('policy_changes')).toBe(0);
  });

  test('a hash of another version with no ban kept beside it follows the first read: a listing made from a find pauses, a hand listing and a registered project stay', async () => {
    await listedFromFind();
    await listing(CONDITIONS, { quote: 'AI help is welcome.', url: `https://github.com/${CONDITIONS}/blob/main/CONTRIBUTING.md`, tier: 'allows_with_conditions' });
    await registered(BANS_AI);
    await week();
    await db.prepare('UPDATE policy_reads SET fingerprint = ?, banned = NULL').bind(OTHER_VERSION).run();
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${BAN}\n` });
    commit(CONDITIONS, { 'CONTRIBUTING.md': `# Contributing\n\n${BAN}\n` });

    const { run } = await week();

    expect(run?.reread).toMatchObject({ read: 3, paused: [INVITES], changed: [] });
    expect(await getProject(db, CONDITIONS)).toMatchObject({ status: 'approved' });
    expect(await getProject(db, BANS_AI)).toMatchObject({ status: 'approved' });
  });

  test("a hash of another version takes a registered project's docs as the new rules read them, a ban included, and pauses nothing", async () => {
    await registered(BANS_AI);
    await week();
    // As if the old rules read no ban in these docs, and the new ones read one.
    await db.prepare('UPDATE policy_reads SET fingerprint = ?, banned = 0 WHERE project = ?').bind(OTHER_VERSION, BANS_AI).run();

    const { run } = await week();

    expect(run?.reread).toMatchObject({ read: 1, paused: [], changed: [] });
    expect(await getProject(db, BANS_AI)).toMatchObject({ status: 'approved' });
    const read = await getPolicyRead(db, BANS_AI);
    expect(read?.fingerprint).toMatch(THIS_VERSION);
    expect(read?.banned).toBe(true);
  });

  test('a quote that moves to another file goes back to the queue, since the listing links to the file', async () => {
    await listing();
    await week();
    commit(INVITES, {
      'AI_POLICY.md': null,
      'CONTRIBUTING.md': `# Contributing\n\n## AI policy\n\n${QUOTE}\n\nDisclose it with an Assisted-by: trailer.\n`,
    });

    const { run } = await week();

    expect(run?.reread.changed).toEqual([INVITES]);
    const [change] = await listPolicyChanges(db, 'waiting');
    expect(change?.policy).toMatchObject({ quote: QUOTE, url: `https://github.com/${INVITES}/blob/main/CONTRIBUTING.md` });
  });

  test("removing the repo at its maintainers' request, or a maintainer taking the listing over, drops its policy change from the queue", async () => {
    await listing(INVITES);
    await listing(CONDITIONS, { quote: 'AI help is welcome.', url: `https://github.com/${CONDITIONS}/blob/main/CONTRIBUTING.md`, tier: 'allows_with_conditions' });
    await week();
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${CHANGED}\n` });
    await week();
    const waiting = (await listPolicyChanges(db, 'waiting')).map((c) => c.repo).sort();
    const admin = await connectAgent(github, ADMIN.login);
    const maintainer = await connectAgent(github, MAINTAINER.login);

    await call(admin, 'admin_remove_project', { repo: INVITES, note: 'Asked in an issue.' });
    const taken = await call(maintainer, 'register_project', { repo: CONDITIONS, settings: { tags: ['help wanted'] } });

    expect(waiting).toEqual([INVITES, CONDITIONS].sort());
    expect(taken.structuredContent).toMatchObject({ saved: true });
    expect(itemsOf(await call(admin, 'admin_queue', { kind: 'policy_change' }))).toEqual([]);
  });

  test('a policy change shows nothing read from a repo the sync delisted: no policy, no lines, and no sentences', async () => {
    await listing();
    await week();
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${CHANGED}\n` });
    await week();
    sampleRepo(INVITES).private = true;
    await syncTaggedIssues(jobDeps(github));
    const admin = await connectAgent(github, ADMIN.login);

    const { item, text } = await onlyItem(admin, 'policy_change', INVITES);

    const reason = `GitHub shows no public repo named ${INVITES}. It went private or was deleted.`;
    const delisted = { repo: INVITES, showed: 'gone', reason, delistedAt: A_TIME, checkedAt: A_TIME, onDoNotList: false };
    expect(item).toMatchObject({ policy: null, sources: [], aiSentences: [], change: { listed: null, delisted } });
    expect(text).toContain(`: ${reason}`);
    expect(text).toContain('Nothing read from its repo shows here.');
    expect(text).not.toContain('Agents may open pull requests');
  });

  test("a registered project whose docs change stays out of the queue, since its maintainers chose its settings", async () => {
    await registered(CONDITIONS);
    await week();
    commit(CONDITIONS, { 'CONTRIBUTING.md': '# Contributing\n\nAI help is welcome. Disclose it with an Assisted-by: trailer.\n' });

    const { run } = await week();

    expect(run?.reread).toMatchObject({ read: 1, changed: [], paused: [] });
    expect(await rows('policy_changes')).toBe(0);
    expect(await getProject(db, CONDITIONS)).toMatchObject({ status: 'approved' });
  });
});

describe('a reformat or a change the rules take nothing from', () => {
  test('docs that read the same, reformatted, or changed only where the rules take nothing, leave a listing alone', async () => {
    await listing();
    await week();
    commit(INVITES, {
      // The same words, wrapped, in bold, with a list mark and a smaller heading.
      'AI_POLICY.md':
        '## AI policy\n\n**Agents** may open pull requests\non their own, on issues labeled `agent ready`.\n\n- Disclose it with an _Assisted-by:_ trailer.\n',
      // A file the rules read, with a line that names no AI and sets nothing.
      'CONTRIBUTING.md': '# Contributing\n\nRun the tests before you open a pull request.\n',
      // A file the rules don't read.
      'CHANGELOG.md': '# Changelog\n\n- Sorted the output.\n',
    });

    const { run } = await week();

    expect(run?.reread).toMatchObject({ read: 1, changed: [], paused: [] });
    expect(await rows('policy_changes')).toBe(0);
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'approved', policy: LISTED });
  });
});

describe('a ban', () => {
  test('a listing whose docs now ban AI is paused at once for Good First Token, and the admins see the line with its link', async () => {
    await listing();
    await week();
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${BAN}\n` });

    const { run } = await week();

    expect(run?.reread.paused).toEqual([INVITES]);
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'paused', statusChangedBy: null, statusReason: BAN_REASON });
    expect((await statusHistory(db, INVITES))[0]).toMatchObject({ status: 'paused', changedBy: null, reason: BAN_REASON });
    expect(await rows('policy_changes')).toBe(0);
    const admin = await connectAgent(github, ADMIN.login);
    const { item, text } = await onlyItem(admin, 'pause', INVITES);
    expect(item).toMatchObject({
      pause: { reason: BAN_REASON, delisted: null, ban: { path: 'AI_POLICY.md', line: BAN, url: `https://github.com/${INVITES}/blob/main/AI_POLICY.md` } },
      policy: LISTED,
      facts: null,
    });
    expect(text).toMatch(/^ +> We no longer accept pull requests written with AI\.$/m);
    expect(text.split('\n').filter((line) => line.includes(BAN)).every((line) => /^ +> /.test(line))).toBe(true);
    // The project's page shows no reason, and its maintainers read ours, which holds none of the repo's text.
    expect(BAN_REASON).not.toContain(BAN);
  });

  test("its maintainers can't lift the pause, an admin resumes it, and the next read of the same docs leaves it listed", async () => {
    await listing();
    await week();
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${BAN}\n` });
    await week();
    const maintainer = await connectAgent(github, MAINTAINER.login);
    const admin = await connectAgent(github, ADMIN.login);

    const lift = await call(maintainer, 'pause_project', { repo: INVITES, paused: false });
    const { item } = await onlyItem(admin, 'pause', INVITES);
    const resumed = await call(admin, 'admin_decide', { id: item.id, decision: 'approve' });
    const next = await week();

    expect(textOf(lift)).toMatch(/^Refused \(not_admin\)/);
    expect(resumed.structuredContent).toEqual({ repo: INVITES, kind: 'pause', status: 'approved', decision: 'approve', delisted: null });
    expect(next.run?.reread.paused).toEqual([]);
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'approved', statusChangedBy: ADMIN.githubId });
    expect(itemsOf(await call(admin, 'admin_queue', { kind: 'pause' }))).toEqual([]);
  });

  test('an admin who rejects the pause keeps it paused as their own, with their reason, and it leaves the queue', async () => {
    await listing();
    await week();
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${BAN}\n` });
    await week();
    const admin = await connectAgent(github, ADMIN.login);
    const { item } = await onlyItem(admin, 'pause', INVITES);

    const kept = await call(admin, 'admin_decide', { id: item.id, decision: 'reject', reason: 'Its AI policy bans AI help now.' });
    const again = await call(admin, 'admin_decide', { id: item.id, decision: 'approve' });

    expect(kept.structuredContent).toEqual({ repo: INVITES, kind: 'pause', status: 'paused', decision: 'reject', delisted: null });
    expect(await getProject(db, INVITES)).toMatchObject({
      status: 'paused',
      statusChangedBy: ADMIN.githubId,
      statusReason: 'Its AI policy bans AI help now.',
    });
    expect(textOf(again)).toMatch(/^Refused \(not_found\)/);
    expect(itemsOf(await call(admin, 'admin_queue', { kind: 'pause' }))).toEqual([]);
  });

  test('a ban takes over a pause its maintainers made, which the queue shows, and approving puts their pause back for them to lift', async () => {
    await listing();
    await week();
    await setProjectStatus(db, INVITES, { status: 'paused', reason: 'Taking a break.', changedBy: MAINTAINER.githubId }, clock);
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${BAN}\n` });

    await week();

    expect(await getProject(db, INVITES)).toMatchObject({ status: 'paused', statusChangedBy: null, statusReason: BAN_REASON });
    expect((await statusHistory(db, INVITES)).map((c) => [c.status, c.changedBy])).toEqual([
      ['paused', null],
      ['paused', MAINTAINER.githubId],
      ['approved', ADMIN.githubId],
    ]);
    const admin = await connectAgent(github, ADMIN.login);
    const { item, text } = await onlyItem(admin, 'pause', INVITES);
    expect(item.pause).toMatchObject({ tookOver: { by: MAINTAINER.login, reason: 'Taking a break.' } });
    expect(text).toContain(`It took over a pause @${MAINTAINER.login} made on`);
    expect(text).toContain('with their reason, in their own words, as a JSON string: "Taking a break."');
    const decided = await call(admin, 'admin_decide', { id: item.id, decision: 'approve' });
    expect(decided.structuredContent).toEqual({ repo: INVITES, kind: 'pause', status: 'paused', decision: 'approve', delisted: null });
    expect(await getProject(db, INVITES)).toMatchObject({
      status: 'paused',
      statusChangedBy: MAINTAINER.githubId,
      statusReason: 'Taking a break.',
    });
    expect(itemsOf(await call(admin, 'admin_queue', { kind: 'pause' }))).toEqual([]);
    const maintainer = await connectAgent(github, MAINTAINER.login);
    const lifted = await call(maintainer, 'pause_project', { repo: INVITES, paused: false });
    expect(lifted.structuredContent).toMatchObject({ status: 'approved', changed: true });
  });

  test('a listing made from a find whose docs ban AI by its first weekly read is paused, since the find read them as a welcome', async () => {
    await listedFromFind();
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${BAN}\n` });

    const { run } = await week();

    expect(run?.reread.paused).toEqual([INVITES]);
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'paused', statusChangedBy: null, statusReason: BAN_REASON });
  });

  test('a listing made by hand whose docs the rules read as a ban at its first read takes them as they are: no pause, and it goes back once as a policy change', async () => {
    commit(SILENT, { 'AI_POLICY.md': MISREAD });
    // A find an admin rejected before is no find behind the listing.
    const rejected = await addCandidate(
      db,
      {
        repo: SILENT,
        facts: { stars: 1200, createdAt: clock - WEEK, pushedAt: clock - HOUR, ownerCreatedAt: clock - WEEK },
        policy: MISREAD_LISTED,
        settings: {},
        suggestedTags: [],
      },
      clock - DAY,
    );
    await decideCandidate(db, rejected?.id ?? '', { status: 'rejected', decidedBy: ADMIN.githubId, reason: 'Not now.' }, clock - HOUR);
    await listing(SILENT, MISREAD_LISTED, { tags: ['help wanted'] });

    const first = await week();
    const second = await week();

    expect(first.run?.reread).toMatchObject({ read: 1, paused: [], changed: [SILENT] });
    expect(second.run?.reread).toMatchObject({ read: 1, paused: [], changed: [] });
    expect(await getProject(db, SILENT)).toMatchObject({ status: 'approved' });
    expect((await getPolicyRead(db, SILENT))?.banned).toBe(true);
    const admin = await connectAgent(github, ADMIN.login);
    const { item } = await onlyItem(admin, 'policy_change', SILENT);
    expect(item.policy).toBeNull();
  });

  test('an admin who lifts the pause with admin_pause_project puts back the pause it took over, as approving it does, and lifting again resumes the project', async () => {
    await listing();
    await week();
    await setProjectStatus(db, INVITES, { status: 'paused', reason: 'Taking a break.', changedBy: MAINTAINER.githubId }, clock);
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${BAN}\n` });
    await week();
    const admin = await connectAgent(github, ADMIN.login);

    const lifted = await call(admin, 'admin_pause_project', { repo: INVITES, paused: false });

    expect(lifted.structuredContent).toMatchObject({ repo: INVITES, status: 'paused', changed: true, restored: true });
    expect(textOf(lifted)).toBe(
      `Lifted Good First Token's pause on ${INVITES}, and put back the pause it took over, for whoever made it to lift. Status: paused.`,
    );
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'paused', statusChangedBy: MAINTAINER.githubId, statusReason: 'Taking a break.' });
    expect(itemsOf(await call(admin, 'admin_queue', { kind: 'pause' }))).toEqual([]);
    const again = await call(admin, 'admin_pause_project', { repo: INVITES, paused: false });
    expect(again.structuredContent).toMatchObject({ repo: INVITES, status: 'approved', changed: true, restored: false });
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'approved', statusChangedBy: ADMIN.githubId });
  });

  test("a ban's pause over the crawler's own pause for pull requests resumes the project, and the next read pauses it for them again", async () => {
    await listing();
    await week();
    sampleRepo(INVITES).pullRequestCreationPolicy = 'collaborators_only';
    await week();
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${BAN}\n` });
    await week();
    const admin = await connectAgent(github, ADMIN.login);
    const { item } = await onlyItem(admin, 'pause', INVITES);
    expect(item.pause).toMatchObject({ reason: BAN_REASON, tookOver: null });

    await call(admin, 'admin_decide', { id: item.id, decision: 'approve' });
    const resumed = await getProject(db, INVITES);
    const next = await week();

    expect(resumed).toMatchObject({ status: 'approved', statusChangedBy: ADMIN.githubId });
    expect(next.run?.reread.paused).toEqual([INVITES]);
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'paused', statusChangedBy: null, statusReason: LIMITED });
  });

  test("a ban its docs had at a registered project's first read stays the maintainers' call, reworded, or beside a new build step", async () => {
    await registered(BANS_AI);
    await week();
    commit(BANS_AI, {
      'CONTRIBUTING.md': "# Contributing\n\nWe welcome contributions from everyone.\n\n## AI\n\nWe don't accept AI-generated pull requests.\n",
    });
    const reworded = await week();
    commit(BANS_AI, { 'AGENTS.md': '# AGENTS.md\n\nRun make test before you open a pull request.\n' });
    const buildStep = await week();

    expect(reworded.run?.reread).toMatchObject({ read: 1, paused: [] });
    expect(buildStep.run?.reread).toMatchObject({ read: 1, paused: [] });
    expect(await getProject(db, BANS_AI)).toMatchObject({ status: 'approved' });
  });

  test('a listing whose ban pause an admin lifted is not paused again when its banned docs change, and goes back to the queue as a policy change', async () => {
    await listing();
    await week();
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${BAN}\n` });
    await week();
    const admin = await connectAgent(github, ADMIN.login);
    const { item } = await onlyItem(admin, 'pause', INVITES);
    await call(admin, 'admin_decide', { id: item.id, decision: 'approve' });
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${BAN}\n\nRun the tests first.\n` });

    const next = await week();

    expect(next.run?.reread).toMatchObject({ read: 1, paused: [], changed: [INVITES] });
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'approved' });
    const { item: change } = await onlyItem(admin, 'policy_change', INVITES);
    expect(change.policy).toBeNull();
  });

  test('a pause shows nothing read from a repo the sync delisted: no ban line, no sentences, and no policy', async () => {
    await listing();
    await week();
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${BAN}\n` });
    await week();
    sampleRepo(INVITES).private = true;
    await syncTaggedIssues(jobDeps(github));
    const admin = await connectAgent(github, ADMIN.login);

    const { item, text } = await onlyItem(admin, 'pause', INVITES);

    const reason = `GitHub shows no public repo named ${INVITES}. It went private or was deleted.`;
    const delisted = { repo: INVITES, showed: 'gone', reason, delistedAt: A_TIME, checkedAt: A_TIME, onDoNotList: false };
    expect(item).toMatchObject({ pause: { reason: BAN_REASON, delisted, ban: null }, aiSentences: [], moreAiSentences: 0, policy: null });
    expect(text).toContain(`: ${reason}`);
    expect(text).toContain('Nothing read from its repo shows here.');
    expect(text).not.toContain(BAN);
    expect(text).not.toContain(QUOTE);
    // Deciding it says the project is delisted, as admin_pause_project does, since a resume doesn't bring its page back.
    const decided = await call(admin, 'admin_decide', { id: item.id, decision: 'approve' });
    expect(decided.structuredContent).toMatchObject({ kind: 'pause', status: 'approved', delisted });
    expect(textOf(decided)).toContain(`: ${reason}`);
    expect(textOf(decided)).toContain('A resume doesn\'t bring it back.');
  });

  test("a registered project whose docs come to ban AI is paused too, though a ban its docs had at the first read stays the maintainers' call", async () => {
    await registered(SILENT);
    await registered(BANS_AI);
    await week();
    commit(SILENT, { 'CONTRIBUTING.md': `# Contributing\n\n${BAN}\n` });

    const { run } = await week();

    expect(run?.reread.paused).toEqual([SILENT]);
    expect(await getProject(db, SILENT)).toMatchObject({ status: 'paused', statusChangedBy: null, statusReason: BAN_REASON });
    expect(await getProject(db, BANS_AI)).toMatchObject({ status: 'approved' });
  });

  test('a pause on a ban stays when the docs welcome AI help again, until an admin resumes it', async () => {
    await listing();
    await week();
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${BAN}\n` });
    await week();
    commit(INVITES, { 'AI_POLICY.md': AI_POLICY });

    await week();

    expect(await getProject(db, INVITES)).toMatchObject({ status: 'paused', statusChangedBy: null, statusReason: BAN_REASON });
  });

  test("the line read as a ban shows only with the crawler's own pause, and a later pause for another reason shows none of it", async () => {
    await listing();
    await week();
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${BAN}\n` });
    await week();
    const admin = await connectAgent(github, ADMIN.login);
    const { item: banned } = await onlyItem(admin, 'pause', INVITES);
    await call(admin, 'admin_decide', { id: banned.id, decision: 'approve' });
    sampleRepo(INVITES).archived = true;
    await syncTaggedIssues(jobDeps(github));
    // Unarchived, the sync takes its mark off, and its pause stays until an admin lifts it.
    sampleRepo(INVITES).archived = false;

    await syncTaggedIssues(jobDeps(github));

    const { item, text } = await onlyItem(admin, 'pause', INVITES);
    expect(item).toMatchObject({ pause: { reason: `${INVITES} is archived on GitHub.`, delisted: null, ban: null }, aiSentences: [] });
    expect(text).not.toContain(BAN);
  });
});

describe('pull requests limited to collaborators', () => {
  test.each([
    [
      'lets only collaborators open pull requests',
      (repo: GitHubFake['state']['repos'][string]) => (repo.pullRequestCreationPolicy = 'collaborators_only'),
      `${INVITES} lets only collaborators open pull requests. Only a repo that takes pull requests from anyone can be listed.`,
    ],
    [
      'has pull requests turned off',
      (repo: GitHubFake['state']['repos'][string]) => (repo.hasPullRequests = false),
      `${INVITES} has pull requests turned off on GitHub. Only a repo that takes pull requests from anyone can be listed.`,
    ],
  ])('a listed project whose repo now %s is paused at once, and the admins see why', async (_what, change, reason) => {
    await listing();
    await week();
    change(sampleRepo(INVITES));

    const { run } = await week();

    expect(run?.reread.paused).toEqual([INVITES]);
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'paused', statusChangedBy: null, statusReason: reason });
    const admin = await connectAgent(github, ADMIN.login);
    const { item } = await onlyItem(admin, 'pause', INVITES);
    expect(item.pause).toEqual({ reason, delisted: null, ban: null, tookOver: null });
  });

  test.each([
    ['who can open pull requests', (repo: GitHubFake['state']['repos'][string]) => Reflect.deleteProperty(repo, 'pullRequestCreationPolicy')],
    ['whether it takes pull requests', (repo: GitHubFake['state']['repos'][string]) => Reflect.deleteProperty(repo, 'hasPullRequests')],
  ])("a repo GitHub doesn't say %s for pauses nothing, and the log says so", async (_what, change) => {
    await listing();
    await week();
    change(sampleRepo(INVITES));

    const { run } = await week();

    expect(run?.reread).toMatchObject({ read: 1, paused: [] });
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'approved' });
    expect(logged.some((line) => line.includes(`GitHub didn't say who can open pull requests on ${INVITES}`))).toBe(true);
  });

  test('a pause is resumed or kept with no tier and no settings, and one sent with either changes nothing', async () => {
    await listing();
    await week();
    sampleRepo(INVITES).pullRequestCreationPolicy = 'collaborators_only';
    await week();
    const admin = await connectAgent(github, ADMIN.login);
    const { item } = await onlyItem(admin, 'pause', INVITES);

    const withSettings = await call(admin, 'admin_decide', { id: item.id, decision: 'approve', settings: { claimsPerIssue: 2 } });
    const withTier = await call(admin, 'admin_decide', { id: item.id, decision: 'reject', reason: 'Kept.', tier: 'invites_agents' });

    expect(textOf(withSettings)).toMatch(/^Refused \(invalid_settings\)/);
    expect(textOf(withTier)).toMatch(/^Refused \(invalid_settings\)/);
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'paused', statusChangedBy: null, settings: { claimsPerIssue: 3 } });
  });

  test('a registered project is paused too, and a pause its maintainers made stays theirs', async () => {
    await registered(CONDITIONS);
    await registered(SILENT);
    await setProjectStatus(db, SILENT, { status: 'paused', reason: 'Taking a break.', changedBy: MAINTAINER.githubId }, clock);
    sampleRepo(CONDITIONS).pullRequestCreationPolicy = 'collaborators_only';
    sampleRepo(SILENT).pullRequestCreationPolicy = 'collaborators_only';

    const { run } = await week();

    expect(run?.reread.paused).toEqual([CONDITIONS]);
    expect(await getProject(db, CONDITIONS)).toMatchObject({ status: 'paused', statusChangedBy: null });
    expect(await getProject(db, SILENT)).toMatchObject({ status: 'paused', statusChangedBy: MAINTAINER.githubId, statusReason: 'Taking a break.' });
  });
});

describe('an archived repo', () => {
  test('is left to the sync, which pauses the project, and the admins see the pause with the reason the sync gave', async () => {
    await listing();
    await week();
    sampleRepo(INVITES).archived = true;

    const { run } = await week();
    const before = await getProject(db, INVITES);
    await syncTaggedIssues(jobDeps(github));

    expect(run?.reread).toMatchObject({ read: 0, paused: [], skipped: { left_for_sync: 1 } });
    expect(before).toMatchObject({ status: 'approved' });
    const reason = `${INVITES} is archived on GitHub.`;
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'paused', statusChangedBy: null, statusReason: reason });
    const admin = await connectAgent(github, ADMIN.login);
    const { item, text } = await onlyItem(admin, 'pause', INVITES);
    expect(item.pause).toEqual({
      reason,
      delisted: { repo: INVITES, showed: 'archived', reason, delistedAt: A_TIME, checkedAt: A_TIME, onDoNotList: false },
      ban: null,
      tookOver: null,
    });
    expect(text).toContain(`: ${reason} The sync last checked the repos on`);
    expect(text).toContain('The project has no page, and agents get no claims on it, whatever its status.');
    expect(text).toContain('Nothing read from its repo shows here.');
    // Delisted, it isn't queued for a weekly read again.
    clock += WEEK;
    await fill();
    expect(sent.filter((m) => m.reread === true)).toEqual([]);
  });
});

describe('the monthly pass', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);
  });

  /** Moves the test's clock and the GitHub fake's on. */
  function advance(ms: number): void {
    clock += ms;
    vi.setSystemTime(clock);
  }

  test('brings back a find an admin rejected only once its docs read differently, and never a find that waits or a repo on the do-not-list', async () => {
    await fill();
    await consume(sent.splice(0));
    const found = new Map((await listCandidates(db, 'waiting')).map((c) => [c.repo, c]));
    await decideCandidate(db, found.get(CONDITIONS)?.id ?? '', { status: 'rejected', decidedBy: ADMIN.githubId, reason: 'Not now.' }, clock);
    await addToDoNotList(db, { repo: 'sample-policies/no-autonomous-agents', reason: null, addedBy: ADMIN.githubId }, clock);
    // A push in the month before each pass, so its search finds the repos.
    const pushAll = () => {
      for (const repo of [CONDITIONS, INVITES, 'sample-policies/no-autonomous-agents']) commit(repo, { 'CHANGELOG.md': `Pushed at ${String(clock)}.\n` });
    };

    advance(30 * DAY);
    pushAll();
    await fill();
    const month = sent.splice(0).flatMap((m) => m.repos);
    const same = await consume([{ repos: month }]);
    const waitingAfterSame = (await listCandidates(db, 'waiting')).map((c) => c.repo);
    advance(30 * DAY);
    commit(CONDITIONS, { 'CONTRIBUTING.md': '# Contributing\n\n## AI help\n\nAI help is welcome. Disclose it with an Assisted-by: trailer.\n' });
    pushAll();
    await fill();
    const changed = await consume(sent.splice(0));

    expect(month).toContain(CONDITIONS);
    expect(month).not.toContain(INVITES);
    expect(month).not.toContain('sample-policies/no-autonomous-agents');
    expect(same.run?.skipped).toMatchObject({ rejected_before: 1 });
    expect(waitingAfterSame).not.toContain(CONDITIONS);
    expect(changed.run?.proposed).toEqual([CONDITIONS]);
    expect((await listCandidates(db, 'waiting')).find((c) => c.repo === CONDITIONS)?.policy.quote).toBe(
      'AI help is welcome. Disclose it with an Assisted-by: trailer.',
    );
  });

  test('reads each seed again in every pass, whatever its stars, and never one that is a project, has a find waiting, or is on the do-not-list', async () => {
    const SMALL = 'sample-policies/small-seed';
    await registered(INVITES);
    await addCandidate(
      db,
      {
        repo: CONDITIONS,
        facts: { stars: 2400, createdAt: clock - DAY, pushedAt: clock - HOUR, ownerCreatedAt: clock - DAY },
        policy: { quote: 'AI help is welcome.', url: `https://github.com/${CONDITIONS}/blob/main/CONTRIBUTING.md`, tier: 'allows_with_conditions' },
        settings: {},
        suggestedTags: [],
      },
      clock - HOUR,
    );
    await addToDoNotList(db, { repo: NO_AUTONOMY, reason: null, addedBy: ADMIN.githubId }, clock);
    for (const repo of [SMALL, INVITES, CONDITIONS, NO_AUTONOMY]) await addSeed(db, { repo, addedBy: ADMIN.githubId }, clock);
    const seedsSent = () => {
      const repos = sent.splice(0).flatMap((m) => m.repos);
      return [SMALL, INVITES, CONDITIONS, NO_AUTONOMY].filter((repo) => repos.includes(repo) && repo !== INVITES);
    };

    await fill();
    const firstPass = seedsSent();
    advance(DAY);
    await fill();
    const samePass = seedsSent();
    advance(30 * DAY);
    await fill();
    const nextPass = seedsSent();

    expect([firstPass, samePass, nextPass]).toEqual([[SMALL], [], [SMALL]]);
    const outcomes = await Promise.all([SMALL, INVITES, CONDITIONS, NO_AUTONOMY].map(async (repo) => (await getSeed(db, repo))?.outcome));
    expect(outcomes).toEqual(['queued', 'project', 'proposed', 'do_not_list']);
    expect((await getSeed(db, SMALL))?.handledAt).toBe(clock);
  });

  test('a seed the search finds too is queued once in a pass', async () => {
    await addSeed(db, { repo: SILENT, addedBy: ADMIN.githubId }, clock);

    const run = await fill();

    const repos = sent.splice(0).flatMap((m) => m.repos);
    expect(run.searches).toBeGreaterThan(0);
    expect(repos.filter((repo) => repo === SILENT)).toEqual([SILENT]);
  });

  test('a rejected find stored before finds kept what their docs read takes what they read now, and stays out', async () => {
    const find = await addCandidate(
      db,
      {
        repo: CONDITIONS,
        facts: { stars: 2400, createdAt: clock - DAY, pushedAt: clock - HOUR, ownerCreatedAt: clock - DAY },
        policy: { quote: 'AI help is welcome.', url: `https://github.com/${CONDITIONS}/blob/main/CONTRIBUTING.md`, tier: 'allows_with_conditions' },
        settings: {},
        suggestedTags: [],
      },
      clock - HOUR,
    );
    await decideCandidate(db, find?.id ?? '', { status: 'rejected', decidedBy: ADMIN.githubId, reason: 'Not now.' }, clock);

    const first = await consume([{ repos: [CONDITIONS] }]);
    const second = await consume([{ repos: [CONDITIONS] }]);

    expect(first.run?.skipped).toMatchObject({ rejected_before: 1 });
    expect(second.run?.skipped).toMatchObject({ rejected_before: 1 });
    expect(await listCandidates(db, 'waiting')).toEqual([]);
    const stored = await db.prepare('SELECT fingerprint FROM crawl_candidates WHERE id = ?').bind(find?.id ?? '').first<string | null>('fingerprint');
    expect(stored).toMatch(THIS_VERSION);
  });
});

describe('the budget', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2100, 5, 1, 12, 0, 0));
    clock = Date.now();
  });

  test('a weekly read the budget stops goes back to the queue as a weekly read, using none of its tries, and is read once the budget starts over', async () => {
    await listing();
    github.spendRateLimit(SERVICE_LOGIN, 'graphql', 2100);

    const stopped = await consume([{ repos: [INVITES], reread: true }], 90);
    const back = resent.splice(0);
    vi.setSystemTime(Date.now() + HOUR + MINUTE);
    clock = Date.now();
    const resumed = await consume(back.map((message) => message.body));

    expect(stopped).toMatchObject({ acked: ['m0'], retried: [], run: { stopped: 'budget' } });
    expect(back).toEqual([{ body: { repos: [INVITES], reread: true }, delaySeconds: 3600 }]);
    expect(resumed).toMatchObject({ acked: ['m0'], run: { stopped: null, reread: { read: 1 } } });
    expect((await getPolicyRead(db, INVITES))?.fingerprint).toMatch(THIS_VERSION);
  });
});

describe('never lists', () => {
  test('the weekly reads never approve, list, or add a project, and the only status they write is a pause that names no one', async () => {
    await listing(INVITES);
    await listing(CONDITIONS, { quote: 'AI help is welcome.', url: `https://github.com/${CONDITIONS}/blob/main/CONTRIBUTING.md`, tier: 'allows_with_conditions' });
    await registered(SILENT, 'pending');
    await registered(BANS_AI, 'rejected');
    await registered('sample-owner/sample-app');
    await setProjectStatus(db, CONDITIONS, { status: 'paused', reason: null, changedBy: null }, clock);
    const projects = await rows('projects');
    const settings = await rows('project_settings');
    const changes = await rows('project_status_changes');
    await week();
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${BAN}\n` });
    commit(SILENT, { 'CONTRIBUTING.md': '# Contributing\n\nAgent pull requests are welcome.\n' });
    sampleRepo('sample-owner/sample-app').pullRequestCreationPolicy = 'collaborators_only';

    await week();
    // A weekly read of repos that aren't listed projects, sent to the queue by hand.
    const unlisted = await consume([{ repos: [SILENT, BANS_AI, 'sample-policies/mentions-ai'], reread: true }]);

    expect(unlisted.run?.reread.skipped).toEqual({ not_listed: 3 });
    expect(await rows('projects')).toBe(projects);
    expect(await rows('project_settings')).toBe(settings);
    expect(await rows('crawl_candidates')).toBe(0);
    const written = await db
      .prepare('SELECT status, changed_by FROM project_status_changes ORDER BY id LIMIT -1 OFFSET ?')
      .bind(changes)
      .all<{ status: string; changed_by: number | null }>();
    expect(written.results).toEqual([
      { status: 'paused', changed_by: null },
      { status: 'paused', changed_by: null },
    ]);
    expect(await getProject(db, SILENT)).toMatchObject({ status: 'pending' });
    expect(await getProject(db, BANS_AI)).toMatchObject({ status: 'rejected' });
    expect(await getProject(db, CONDITIONS)).toMatchObject({ status: 'paused', statusChangedBy: null });
  });
});
