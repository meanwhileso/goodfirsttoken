import type { AnthropicFake } from '@goodfirsttoken/anthropic-fake';
import type { CrawlMessage, Policy } from '@goodfirsttoken/core';
import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runReader } from '../../src/crawl/batches';
import { fillCrawlQueue } from '../../src/crawl/producer';
import { readCrawlBatch, type CrawlRun } from '../../src/crawl/queue';
import { MAX_DOCS_BYTES } from '../../src/crawl/reader/docs';
import { MODEL_BAN_REASON } from '../../src/crawl/reread';
import {
  addSeed,
  addToDoNotList,
  createProject,
  decideCandidate,
  getModelRead,
  getProject,
  listCandidates,
  listPending,
  listPolicyChanges,
  savePerson,
  setProjectStatusFrom,
} from '../../src/db';
import { startAnthropic } from '../anthropic';
import { setEnv, startGitHub } from '../auth/helpers';
import { db, emptyDatabase } from '../db/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from '../mcp/helpers';
import { knowServiceToken } from '../sync/helpers';

// The model policy reader deciding, with POLICY_READER=model, end to end:
// the crawl consumer reads a seed's or a listed project's docs from the
// GitHub fake, the rules read them too, and the model's reading, sent and
// collected through the Message Batches API of the Anthropic fake, is the
// one acted on. A find waits for its label check, and a move into a ban
// pauses a listing only with two agreeing readings, a ban line that checks
// out, and the newest docs staged. The repos are the GitHub fake's made-up
// sample-policies repos.

const INVITES = 'sample-policies/invites-agents';
const BANS_AI = 'sample-policies/bans-ai';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WEEK = 7 * 24 * HOUR;
const ADMIN = { githubId: 1010, login: 'sample-admin' };
const MAINTAINER = { githubId: 1009, login: 'sample-maintainer' };
const configuredAdmins = env.ADMIN_GITHUB_IDS;

const QUOTE = 'Agents may open pull requests on their own, on issues labeled `agent ready`.';
const LISTED: Policy = { quote: QUOTE, url: `https://github.com/${INVITES}/blob/main/AI_POLICY.md`, tier: 'invites_agents' };
const BAN = 'We do not accept pull requests written with AI tools.';
const WELCOME = 'Contributions written with AI tools are welcome.';

let github: GitHubFake;
let anthropic: AnthropicFake;
let clock: number;
let sent: CrawlMessage[];
let logged: string[];
let restore: () => void;

const queue = {
  sendBatch: (messages: Iterable<MessageSendRequest<CrawlMessage>>) => {
    for (const message of messages) sent.push(message.body);
    return Promise.resolve();
  },
};

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
  knowServiceToken(github);
  anthropic = startAnthropic(github);
  restore = setEnv({ POLICY_READER: 'model', MODEL_DAILY_BUDGET_USD: '20' });
  env.ADMIN_GITHUB_IDS = String(ADMIN.githubId);
  vi.spyOn(env.MCP_LIMITER, 'limit').mockResolvedValue({ success: true });
  logged = [];
  const keep = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'warn').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
  clock = Date.UTC(2100, 3, 1, 12, 0, 0);
  sent = [];
  await savePerson(db, ADMIN, clock);
  await savePerson(db, MAINTAINER, clock);
});

afterEach(() => {
  restore();
  env.ADMIN_GITHUB_IDS = configuredAdmins;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function consume(repos: string[], reread = false): Promise<CrawlRun> {
  const messages = [
    { id: 'm0', timestamp: new Date(), attempts: 1, body: reread ? { repos, reread: true } : { repos }, ack: () => undefined, retry: () => undefined },
  ];
  const batch = { queue: 'crawl', messages, ackAll: () => undefined, retryAll: () => undefined } as unknown as MessageBatch;
  const run = await readCrawlBatch(batch, { ...env, CRAWL_QUEUE: { send: () => Promise.resolve() } }, () => clock);
  if (run === null) throw new Error('the consumer read nothing');
  return run;
}

async function crawlSeed(repo: string): Promise<CrawlRun> {
  await addSeed(db, { repo, addedBy: ADMIN.githubId }, clock);
  await fillCrawlQueue({ db, queue, now: () => clock });
  return consume(sent.splice(0).filter((m) => m.reread !== true).flatMap((m) => m.repos));
}

/** One of the reader's hourly runs, an hour after the last. */
async function hourly() {
  clock += HOUR;
  return runReader({ db, now: () => clock });
}

/** Hourly runs until the batches sent are collected and nothing waits to be sent. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await hourly();
    if ((await listPending(db)).length === 0) return;
  }
}

async function listing(repo = INVITES, policy: Policy | null = LISTED, source: 'policy' | 'registered' = 'policy') {
  const project = await createProject(
    db,
    { repo, status: 'approved', source, policy, settings: { tags: ['agent ready'], prMode: 'automatic' }, addedBy: ADMIN.githubId },
    clock,
  );
  if (project === null) throw new Error(`${repo} is a project already`);
  return project;
}

async function week(): Promise<CrawlRun> {
  clock += WEEK;
  await fillCrawlQueue({ db, queue, now: () => clock });
  return consume(sent.splice(0).filter((m) => m.reread === true).flatMap((m) => m.repos), true);
}

function commit(repo: string, files: Record<string, string | null>): void {
  github.commitFiles(repo, files, MAINTAINER.login);
}

function readingsAsked(): number {
  return anthropic.requests.filter((r) => r.kind === 'reading').length;
}

/** A statement the model points at. */
function statement(path: string, line: number, quote: string, about: string) {
  return { path, startLine: line, endLine: line, quote, about, label: null, value: null, why: 'It says so.' };
}

/** The model's next readings, `times` of them: these statements, and the tier it gives. */
function reads(statements: ReturnType<typeof statement>[], tier: string, times = 1): void {
  anthropic.answer({ kind: 'reading' }, { output: { statements, tier, steering: [], summary: 'What the docs say.' } }, { times });
}

interface Result {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

async function call(agent: ConnectedAgent, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await agent.client.callTool({ name, arguments: args })) as Result;
}

async function queueItem(kind: string, repo: string): Promise<{ item: Record<string, unknown>; text: string }> {
  const admin = await connectAgent(github, ADMIN.login);
  const result = await call(admin, 'admin_queue', { kind });
  const items = ((result.structuredContent?.items ?? []) as Record<string, unknown>[]).filter((item) => item.repo === repo);
  expect(items, `${kind} items for ${repo}`).toHaveLength(1);
  return { item: items[0] ?? {}, text: result.content.map((c) => c.text).join('\n') };
}

/** A listing whose first weekly read the model read as the welcome it was listed from. */
async function listedAndRead(repo = INVITES, source: 'policy' | 'registered' = 'policy') {
  await listing(repo, source === 'policy' ? LISTED : null, source);
  await week();
  await settle();
  expect(await getModelRead(db, repo)).toMatchObject({ banned: false, readIn: 'model' });
}

/** The docs now hold a ban on line 3, in AI_POLICY.md, which the rules read as a ban too. */
function banCommitted(repo = INVITES): void {
  commit(repo, { 'AI_POLICY.md': `# AI policy\n\n${BAN}\n` });
}

describe('with the model deciding, a seed', () => {
  test("is found from the model's reading once its label check is back, with the rules' verdict beside it when they differ", async () => {
    commit(BANS_AI, { 'AGENTS.md': `# Agents\n\n${WELCOME}\n` });
    reads([statement('AGENTS.md', 3, WELCOME, 'welcomesAi')], 'allows_with_conditions');
    anthropic.answer({ kind: 'labels' }, { output: { labels: [{ name: 'help wanted', meaning: 'readyForOutsideHelp', evidence: 'name', statement: null, why: 'Its name.' }] } });

    const run = await crawlSeed(BANS_AI);
    expect(run.proposed).toEqual([]);
    await hourly();
    await hourly();
    // The reading is back, and the find waits for its label check.
    expect(await listCandidates(db, 'waiting')).toEqual([]);
    await hourly();

    const [find] = await listCandidates(db, 'waiting');
    expect(find).toMatchObject({
      repo: BANS_AI,
      madeBy: 'model',
      rulesTier: 'bans_or_restricts',
      policy: { quote: WELCOME, url: `https://github.com/${BANS_AI}/blob/main/AGENTS.md`, tier: 'allows_with_conditions' },
      settings: { prMode: 'reviewed', tags: ['help wanted'] },
      suggestedTags: [{ name: 'help wanted', openIssues: 0 }],
    });
    const { text } = await queueItem('candidate', BANS_AI);
    expect(text).toContain("the model policy reader's reading, which made this find");
    expect(text).toContain("The crawler's rules read the same docs as bans or restricts.");
    expect(text).not.toContain('It runs in shadow');
  });

  test('a welcome only the rules read makes no find', async () => {
    reads([statement('AI_POLICY.md', 3, QUOTE, 'bansAi')], 'bans_or_restricts');

    const run = await crawlSeed(INVITES);
    await settle();

    expect(run.proposed).toEqual([]);
    expect(await listCandidates(db, 'waiting')).toEqual([]);
  });

  test('the do-not-list and the projects are checked again before the find is written', async () => {
    await crawlSeed(INVITES);
    await hourly();
    await hourly();
    await addToDoNotList(db, { repo: INVITES, reason: 'Its maintainers asked.', addedBy: ADMIN.githubId }, clock);
    await hourly();

    expect(await listCandidates(db, 'waiting')).toEqual([]);
  });

  test("a find the rules made and an admin rejected stays out when the model reads the same docs", async () => {
    restore();
    restore = setEnv({ POLICY_READER: 'rules', MODEL_DAILY_BUDGET_USD: '20' });
    await crawlSeed(INVITES);
    const [rejected] = await listCandidates(db, 'waiting');
    if (rejected === undefined) throw new Error('no find');
    await decideCandidate(db, rejected.id, { status: 'rejected', decidedBy: ADMIN.githubId, reason: 'Not now.' }, clock);
    restore();
    restore = setEnv({ POLICY_READER: 'model', MODEL_DAILY_BUDGET_USD: '20' });

    await consume([INVITES]);
    await settle();

    expect(readingsAsked()).toBe(0);
    expect(await listCandidates(db, 'waiting')).toEqual([]);
  });
});

describe('with the model deciding, a move into a ban', () => {
  test('pauses a listing with two agreeing readings, a ban line that checks out, and the newest docs, with the new reason', async () => {
    await listedAndRead();
    banCommitted();
    reads([statement('AI_POLICY.md', 3, BAN, 'bansAi')], 'bans_or_restricts', 2);

    const run = await week();
    // The rules read a ban too, and pause nothing: the model decides.
    expect(run.reread.paused).toEqual([]);
    await hourly();
    await hourly();
    // One reading is back, and the second is in the next batch.
    expect((await getProject(db, INVITES))?.status).toBe('approved');
    expect(await listPending(db)).toMatchObject([{ step: 'second' }]);
    await settle();

    expect(readingsAsked()).toBe(3);
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'paused', statusChangedBy: null, statusReason: MODEL_BAN_REASON });
    expect(MODEL_BAN_REASON).toBe('Its docs now read as a ban on AI help. An admin checks them before agents can claim its issues again.');
    expect(await getModelRead(db, INVITES)).toMatchObject({ banned: true });
    const { item } = await queueItem('pause', INVITES);
    expect(item.pause).toMatchObject({ reason: MODEL_BAN_REASON, ban: { path: 'AI_POLICY.md', line: BAN } });
  });

  test('is only a move from docs that read no ban: once an admin resumes the listing, a ban reworded pauses nothing', async () => {
    await listedAndRead();
    banCommitted();
    reads([statement('AI_POLICY.md', 3, BAN, 'bansAi')], 'bans_or_restricts', 2);
    await week();
    await settle();
    const paused = await getProject(db, INVITES);
    if (paused?.status !== 'paused') throw new Error('not paused');
    await setProjectStatusFrom(db, paused, { status: 'approved', reason: null, changedBy: ADMIN.githubId }, clock);

    const reworded = 'Pull requests written with AI tools are not accepted.';
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${reworded}\n` });
    reads([statement('AI_POLICY.md', 3, reworded, 'bansAi')], 'bans_or_restricts', 2);
    await week();
    await settle();

    expect((await getProject(db, INVITES))?.status).toBe('approved');
    // One reading of the reworded docs, and no second.
    expect(readingsAsked()).toBe(4);
  });

  test("pauses nothing when the second reading doesn't agree, and sends the listing to the admin queue once", async () => {
    await listedAndRead();
    banCommitted();
    reads([statement('AI_POLICY.md', 3, BAN, 'bansAi')], 'bans_or_restricts');
    reads([], 'no_policy');

    await week();
    await settle();

    expect((await getProject(db, INVITES))?.status).toBe('approved');
    const changes = await listPolicyChanges(db, 'waiting');
    expect(changes).toMatchObject([{ repo: INVITES, why: 'ban_unconfirmed', madeBy: 'model', rulesTier: null }]);
    expect(await getModelRead(db, INVITES)).toMatchObject({ banned: false });
    const { text } = await queueItem('policy_change', INVITES);
    expect(text).toContain('a move into a ban that it could not confirm');

    // The same docs read again decide nothing, so the pair isn't rolled again.
    const asked = readingsAsked();
    await week();
    await settle();
    expect(readingsAsked()).toBe(asked);
    expect(await listPolicyChanges(db, 'waiting')).toHaveLength(1);
  });

  test("pauses nothing, and sends no second reading, when the ban's line doesn't check out", async () => {
    await listedAndRead();
    banCommitted();
    reads([statement('AI_POLICY.md', 3, 'We ban every AI tool there is.', 'bansAi')], 'bans_or_restricts');

    await week();
    await settle();

    expect(readingsAsked()).toBe(2);
    expect((await getProject(db, INVITES))?.status).toBe('approved');
    expect(await listPolicyChanges(db, 'waiting')).toMatchObject([{ why: 'ban_unconfirmed' }]);
  });

  test('pauses nothing, and sends no second reading, when the model and the statements disagree on the tier', async () => {
    await listedAndRead();
    banCommitted();
    reads([statement('AI_POLICY.md', 3, BAN, 'bansAi')], 'allows_with_conditions');

    await week();
    await settle();

    expect(readingsAsked()).toBe(2);
    expect((await getProject(db, INVITES))?.status).toBe('approved');
    expect(await listPolicyChanges(db, 'waiting')).toMatchObject([{ why: 'ban_unconfirmed' }]);
  });

  test('pauses nothing when newer docs were staged for the repo before the second reading came back', async () => {
    await listedAndRead();
    banCommitted();
    reads([statement('AI_POLICY.md', 3, BAN, 'bansAi')], 'bans_or_restricts', 2);

    await week();
    await hourly();
    // The first reading comes back, and the second is sent.
    await hourly();
    expect(await listPending(db)).toMatchObject([{ step: 'second', batchId: expect.any(String) as unknown }]);
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${QUOTE}\n` });
    await consume([INVITES], true);
    await settle();

    expect((await getProject(db, INVITES))?.status).toBe('approved');
    // The second reading of the older docs decided nothing at all: no pause, and nothing sent to an admin.
    expect((await listPolicyChanges(db, 'waiting')).map((change) => change.why)).not.toContain('ban_unconfirmed');
    expect(logged.some((line) => line.includes("couldn't confirm"))).toBe(false);
  });

  test("pauses nothing when the second reading gives no verdict, keeps no docs hash, and counts it as a weekly read with no verdict", async () => {
    await listedAndRead();
    banCommitted();
    reads([statement('AI_POLICY.md', 3, BAN, 'bansAi')], 'bans_or_restricts');
    anthropic.answer({ kind: 'reading' }, { stop: 'refusal' });
    const before = await getModelRead(db, INVITES);

    await week();
    await settle();

    expect(readingsAsked()).toBe(3);
    expect((await getProject(db, INVITES))?.status).toBe('approved');
    expect(await listPolicyChanges(db, 'waiting')).toEqual([]);
    expect(await getModelRead(db, INVITES)).toMatchObject({ docsHash: before?.docsHash, noVerdicts: 1, banned: false });
  });

  test('a reading of other docs that still waits decides nothing once the docs read as the last weekly read again', async () => {
    await listedAndRead();
    const original = `# AI policy\n\n${QUOTE}\n\nDisclose it with an Assisted-by: trailer.\n`;
    banCommitted();
    reads([statement('AI_POLICY.md', 3, BAN, 'bansAi')], 'bans_or_restricts', 2);
    await week();
    // Back to the docs the last weekly read read, before the reading of the ban was sent.
    commit(INVITES, { 'AI_POLICY.md': original });
    await consume([INVITES], true);
    await settle();

    expect(readingsAsked()).toBe(1);
    expect(await listPending(db)).toEqual([]);
    expect((await getProject(db, INVITES))?.status).toBe('approved');
  });

  test('that only the rules read pauses nothing', async () => {
    await listedAndRead();
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${QUOTE}\n\n${BAN}\n` });
    reads([statement('AI_POLICY.md', 3, QUOTE, 'welcomesAgents')], 'invites_agents');

    const run = await week();
    await settle();

    expect(run.reread.paused).toEqual([]);
    expect((await getProject(db, INVITES))?.status).toBe('approved');
    expect(readingsAsked()).toBe(2);
  });

  test("pauses a registered project with two agreeing readings, and a disagreement is only a line in the log", async () => {
    await listedAndRead(INVITES, 'registered');
    banCommitted();
    reads([statement('AI_POLICY.md', 3, BAN, 'bansAi')], 'bans_or_restricts');
    reads([], 'no_policy');

    await week();
    await settle();

    expect((await getProject(db, INVITES))?.status).toBe('approved');
    expect(await listPolicyChanges(db, 'waiting')).toEqual([]);
    expect(logged.some((line) => line.includes(`read a move into a ban in ${INVITES}`))).toBe(true);

    banCommitted();
    commit(INVITES, { 'AGENTS.md': '# Agents\n\nRun the tests.\n' });
    reads([statement('AI_POLICY.md', 3, BAN, 'bansAi')], 'bans_or_restricts', 2);
    await week();
    await settle();
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'paused', statusReason: MODEL_BAN_REASON });
  });
});

describe('with the model deciding, a weekly read', () => {
  test("whose policy changed sends a policy change from the model's reading, with the rules' tier beside it when they differ", async () => {
    await listedAndRead();
    const more = 'Agents may open pull requests on their own, on issues labeled `agent ready` or `help wanted`.';
    commit(INVITES, { 'AI_POLICY.md': `# AI policy\n\n${more}\n\nDisclose it with an Assisted-by: trailer.\n` });
    reads([statement('AI_POLICY.md', 3, more, 'welcomesAi')], 'allows_with_conditions');

    await week();
    await settle();

    const [change] = await listPolicyChanges(db, 'waiting');
    expect(change).toMatchObject({
      madeBy: 'model',
      why: 'changed',
      rulesTier: 'invites_agents',
      policy: { quote: more, tier: 'allows_with_conditions' },
    });
  });

  test('with no verdict three times in a row sends a listing made from a policy to the admin queue once', async () => {
    await listedAndRead();
    anthropic.answer({ kind: 'reading' }, { stop: 'refusal' }, { times: Infinity });

    for (let i = 0; i < 4; i++) {
      commit(INVITES, { 'AGENTS.md': `# Agents\n\nRun the tests, round ${String(i)}.\n` });
      await week();
      await settle();
    }

    expect(await listPolicyChanges(db, 'waiting')).toMatchObject([{ repo: INVITES, why: 'no_verdict', madeBy: 'model', policy: null }]);
    expect((await getProject(db, INVITES))?.status).toBe('approved');
    const { text } = await queueItem('policy_change', INVITES);
    expect(text).toContain('no verdict on three weekly reads in a row');
  });
});

describe('with the model deciding, docs past the size cap', () => {
  test('on three weekly reads in a row send a listing made from a policy to the admin queue once, with no label read', async () => {
    await listedAndRead();
    const big = `# Notes\n\n${'Keep the build green. '.repeat(Math.floor(MAX_DOCS_BYTES / 4.5 / 22))}\n`;
    commit(INVITES, { 'AI-NOTES.md': big, 'AI-GUIDE.md': big, 'AI-FAQ.md': big, 'AI-USE.md': big, 'AI-MORE.md': big });

    for (let i = 0; i < 4; i++) {
      await week();
      await settle();
    }

    expect(await listPolicyChanges(db, 'waiting')).toMatchObject([{ why: 'no_verdict', policy: null }]);
    expect(readingsAsked()).toBe(1);
  });
});

describe('the switch from shadow to the model', () => {
  test('is listed before the switch, from the shadow readings, and a ban read in shadow pauses at the first weekly read after it', async () => {
    restore();
    restore = setEnv({ POLICY_READER: 'shadow', MODEL_DAILY_BUDGET_USD: '20' });
    await listing();
    reads([statement('AI_POLICY.md', 3, QUOTE, 'bansAi')], 'bans_or_restricts');
    await week();
    await settle();
    expect((await getProject(db, INVITES))?.status).toBe('approved');
    expect(logged.some((line) => line.includes(`Listed projects the switch to the model would pause, from their shadow readings: ${INVITES}.`))).toBe(true);

    restore();
    restore = setEnv({ POLICY_READER: 'model', MODEL_DAILY_BUDGET_USD: '20' });
    reads([statement('AI_POLICY.md', 3, QUOTE, 'bansAi')], 'bans_or_restricts');
    await week();
    await settle();

    // The kept reading of the same docs stood for the first, and only the second reading called the model.
    expect(readingsAsked()).toBe(2);
    expect(await getProject(db, INVITES)).toMatchObject({ status: 'paused', statusReason: MODEL_BAN_REASON });
  });

  test('a weekly reading staged in shadow and collected after the switch hands over the rules\' verdict too, so a ban the model read in shadow pauses', async () => {
    restore();
    restore = setEnv({ POLICY_READER: 'shadow', MODEL_DAILY_BUDGET_USD: '20' });
    await listing();
    reads([statement('AI_POLICY.md', 3, QUOTE, 'bansAi')], 'bans_or_restricts');
    await week();
    await settle();
    // The docs change in a way that says nothing new about AI, and a reading is staged in shadow.
    commit(INVITES, { 'AGENTS.md': '# Agents\n\nRun the tests.\n' });
    reads([statement('AI_POLICY.md', 3, QUOTE, 'bansAi')], 'bans_or_restricts', 3);
    await week();

    restore();
    restore = setEnv({ POLICY_READER: 'model', MODEL_DAILY_BUDGET_USD: '20' });
    await settle();

    expect(await getProject(db, INVITES)).toMatchObject({ status: 'paused', statusReason: MODEL_BAN_REASON });
    expect(await getModelRead(db, INVITES)).toMatchObject({ banned: true, readIn: 'model' });
  });
});
