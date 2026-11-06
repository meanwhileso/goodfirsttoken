import type { AnthropicFake } from '@goodfirsttoken/anthropic-fake';
import type { CrawlMessage, Policy } from '@goodfirsttoken/core';
import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DROP_AFTER_MS, runReader, STOP_MS } from '../../src/crawl/batches';
import { fillCrawlQueue } from '../../src/crawl/producer';
import { readCrawlBatch, type CrawlRun } from '../../src/crawl/queue';
import { MAX_DOCS_BYTES } from '../../src/crawl/reader/docs';
import { READER_VERSION } from '../../src/crawl/reader/version';
import {
  addSeed,
  createProject,
  daySpend,
  decideCandidate,
  getModelRead,
  getModelReading,
  getProject,
  listCandidates,
  listPending,
  listPolicyChanges,
  savePerson,
} from '../../src/db';
import { startAnthropic } from '../anthropic';
import { setEnv, startGitHub } from '../auth/helpers';
import { db, emptyDatabase } from '../db/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from '../mcp/helpers';
import { knowServiceToken } from '../sync/helpers';

// The model policy reader in shadow, end to end: the crawl consumer reads a
// seed's or a listed project's docs from the GitHub fake, the rules decide
// as before, and the model's half stages the same docs. The reader's hourly
// run sends them to the Anthropic fake through the Message Batches API and
// collects the readings, which the admin queue shows beside the rules'. The
// fake ends a batch as soon as it is sent, so one run sends and the next
// collects. Nothing here calls the real API: every request goes to the
// fakes, and any other host fails the test. The repos are the GitHub fake's
// made-up sample-policies repos.

const INVITES = 'sample-policies/invites-agents';
const CONDITIONS = 'sample-policies/with-conditions';
const BANS_AI = 'sample-policies/bans-ai';
const COLLABORATORS = 'sample-policies/collaborators-only';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const ADMIN = { githubId: 1010, login: 'sample-admin' };
const MAINTAINER = { githubId: 1009, login: 'sample-maintainer' };
const configuredAdmins = env.ADMIN_GITHUB_IDS;

const QUOTE = 'Agents may open pull requests on their own, on issues labeled `agent ready`.';
const LISTED: Policy = { quote: QUOTE, url: `https://github.com/${INVITES}/blob/main/AI_POLICY.md`, tier: 'invites_agents' };

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
  restore = setEnv({ POLICY_READER: 'shadow', MODEL_DAILY_BUDGET_USD: '20' });
  env.ADMIN_GITHUB_IDS = String(ADMIN.githubId);
  vi.spyOn(env.MCP_LIMITER, 'limit').mockResolvedValue({ success: true });
  logged = [];
  const keep = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'warn').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
  // Midday UTC, so a few hours on is the same UTC day.
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

/** Runs the crawl consumer on these repos at the test's clock, as one message. */
async function consume(repos: string[], reread = false): Promise<CrawlRun> {
  const messages = [
    {
      id: 'm0',
      timestamp: new Date(),
      attempts: 1,
      body: reread ? { repos, reread: true } : { repos },
      ack: () => undefined,
      retry: () => undefined,
    },
  ];
  const batch = { queue: 'crawl', messages, ackAll: () => undefined, retryAll: () => undefined } as unknown as MessageBatch;
  const crawlQueue = { send: () => Promise.resolve() };
  const run = await readCrawlBatch(batch, { ...env, CRAWL_QUEUE: crawlQueue }, () => clock);
  if (run === null) throw new Error('the consumer read nothing');
  return run;
}

/** A seed an admin added, queued by the cron job and read by the consumer. */
async function crawlSeed(repo: string): Promise<CrawlRun> {
  await addSeed(db, { repo, addedBy: ADMIN.githubId }, clock);
  await fillCrawlQueue({ db, queue, now: () => clock });
  const seeds = sent.splice(0).filter((m) => m.reread !== true).flatMap((m) => m.repos);
  return consume(seeds);
}

/** One of the reader's hourly runs at the test's clock. */
function hourly() {
  return runReader({ db, now: () => clock });
}

/** Two hourly runs, an hour apart: the first sends, and the second collects. */
async function sendAndCollect() {
  const first = await hourly();
  clock += HOUR;
  const second = await hourly();
  return { first, second };
}

/** A project an admin listed from its policy, approved. */
async function listing(repo = INVITES, policy: Policy = LISTED) {
  const project = await createProject(
    db,
    { repo, status: 'approved', source: 'policy', policy, settings: { tags: ['agent ready'], prMode: 'automatic' }, addedBy: ADMIN.githubId },
    clock,
  );
  if (project === null) throw new Error(`${repo} is a project already`);
  return project;
}

/** A week on: the cron job queues the listed projects due, and the consumer reads them. */
async function week(): Promise<CrawlRun> {
  clock += WEEK;
  await fillCrawlQueue({ db, queue, now: () => clock });
  const rereads = sent.splice(0).filter((m) => m.reread === true).flatMap((m) => m.repos);
  return consume(rereads, true);
}

function commit(repo: string, files: Record<string, string | null>): void {
  github.commitFiles(repo, files, MAINTAINER.login);
}

/** Requests to the model so far, of the reader's policy readings. */
function readingsAsked(): number {
  return anthropic.requests.filter((r) => r.kind === 'reading').length;
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

/** Nothing the model did listed or paused anything: every project is as the test made it, and every find is the rules'. */
async function listedAndPaused() {
  const { results } = await db.prepare('SELECT repo, status FROM projects ORDER BY repo').all<{ repo: string; status: string }>();
  return { projects: results, finds: (await listCandidates(db, 'waiting')).map((c) => c.repo) };
}

describe('in shadow, a seed', () => {
  test('gets a model reading from the fake through a batch, and the rules make the find, which shows both readings', async () => {
    const run = await crawlSeed(INVITES);
    expect(run.proposed).toEqual([INVITES]);
    expect(run.reader.staged).toBe(1);
    expect(readingsAsked()).toBe(0);

    const { first, second } = await sendAndCollect();

    expect(first?.sent).toBe(1);
    expect(anthropic.requests.map((r) => ({ via: r.via, kind: r.kind, refused: r.refused }))).toEqual([{ via: 'batch', kind: 'reading', refused: null }]);
    expect(second).toMatchObject({ collected: 1, read: 1, agree: 1, disagree: 0 });
    const kept = await getModelReading(db, INVITES);
    expect(kept).toMatchObject({ readerVersion: READER_VERSION, reading: { tier: 'invites_agents', agree: true } });
    expect(await listPending(db)).toEqual([]);
    // The rules' find is the one in the queue, with the rules' policy, and the model's reading beside it.
    const [find] = await listCandidates(db, 'waiting');
    expect(find?.policy).toEqual(LISTED);
    expect(find?.docsHash).toBe(kept?.docsHash);
    const { item, text } = await queueItem('candidate', INVITES);
    expect(item.policy).toEqual(LISTED);
    expect(item.modelReading).toMatchObject({ tier: 'invites_agents', modelTier: 'invites_agents', agree: true });
    expect(text).toContain("the model policy reader's reading of the same docs");
    expect(text).toContain('It runs in shadow and decides nothing');
    expect(text).toContain(`      > ${QUOTE}`);
    expect(text).toContain("the model's summary, which it wrote from the repo's docs.");
    expect(logged.some((line) => line.includes('where the model and the rules agree on the tier: 1'))).toBe(true);
  });

  test("the rules' verdict is the one acted on: a ban the model reads as a welcome makes no find, and the log names it", async () => {
    // A model that reads a welcome where the rules read a ban.
    const welcome = 'Contributions written with AI tools are welcome.';
    commit(BANS_AI, { 'AGENTS.md': `# Agents\n\n${welcome}\n` });
    anthropic.answer(
      { kind: 'reading' },
      {
        output: {
          statements: [{ path: 'AGENTS.md', startLine: 3, endLine: 3, quote: welcome, about: 'welcomesAi', label: null, value: null, why: 'A welcome.' }],
          tier: 'allows_with_conditions',
          steering: [],
          summary: 'Welcomes AI help.',
        },
      },
    );

    const run = await crawlSeed(BANS_AI);
    await sendAndCollect();

    expect(run.tiers).toEqual({ bans_or_restricts: 1 });
    expect(await listCandidates(db, 'waiting')).toEqual([]);
    expect(await getModelReading(db, BANS_AI)).toMatchObject({ reading: { tier: 'allows_with_conditions' } });
    expect(logged.some((line) => line.includes(`Seeds the model would have found that the rules didn't: ${BANS_AI}`))).toBe(true);
  });

  test('read again with the same docs makes no model call, and its find still shows the kept reading', async () => {
    await crawlSeed(INVITES);
    await sendAndCollect();
    expect(readingsAsked()).toBe(1);
    const find = (await listCandidates(db, 'waiting'))[0];
    if (find === undefined) throw new Error('no find');
    await decideCandidate(db, find.id, { status: 'rejected', decidedBy: ADMIN.githubId, reason: 'Not now.' }, clock);

    const again = await consume([INVITES]);
    await sendAndCollect();

    expect(again.reader).toMatchObject({ staged: 0, cacheHits: 1 });
    expect(readingsAsked()).toBe(1);
  });

  test('a seed whose rejected find has the same docs stays out with no model call', async () => {
    restore();
    restore = setEnv({ POLICY_READER: 'rules', MODEL_DAILY_BUDGET_USD: '20' });
    await crawlSeed(INVITES);
    const find = (await listCandidates(db, 'waiting'))[0];
    if (find === undefined) throw new Error('no find');
    await decideCandidate(db, find.id, { status: 'rejected', decidedBy: ADMIN.githubId, reason: 'Not now.' }, clock);
    restore();
    restore = setEnv({ POLICY_READER: 'shadow', MODEL_DAILY_BUDGET_USD: '20' });

    const run = await consume([INVITES]);
    await sendAndCollect();

    expect(run.reader).toMatchObject({ staged: 0, rejectedSame: 1 });
    expect(readingsAsked()).toBe(0);
  });

  test('a seed that takes no outside pull requests is left out with no model call', async () => {
    const run = await crawlSeed(COLLABORATORS);
    await sendAndCollect();

    expect(run.reader).toMatchObject({ staged: 0, notListable: 1 });
    expect(readingsAsked()).toBe(0);
  });

  test('docs past 400 KB get no verdict from the model, and the log names the repo', async () => {
    // Five files just under the crawler's cap for one file, past the cap for all of them.
    const big = `# Notes\n\n${'Keep the build green. '.repeat(Math.floor(MAX_DOCS_BYTES / 4.5 / 22))}\n`;
    commit(CONDITIONS, { 'AI_POLICY.md': big, 'AI-NOTES.md': big, 'AI-GUIDE.md': big, 'AI-FAQ.md': big, 'AI-USE.md': big });

    const run = await consume([CONDITIONS]);
    await sendAndCollect();

    expect(run.reader.tooBig).toEqual([CONDITIONS]);
    expect(readingsAsked()).toBe(0);
    expect(logged.some((line) => line.includes(`The policy reader gave ${CONDITIONS} no verdict: its docs hold`))).toBe(true);
  });
});

describe('pending readings', () => {
  test('a newer reading of a repo replaces an older one that has not been sent', async () => {
    // The rules read a ban here, so they make no find, and the seed is read again.
    await consume([BANS_AI]);
    const older = await listPending(db);
    commit(BANS_AI, { 'AGENTS.md': '# Agents\n\nRun the tests before you open a pull request.\n' });
    await consume([BANS_AI]);

    const pending = await listPending(db);
    expect(older).toHaveLength(1);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).not.toBe(older[0]?.id);
    expect(pending[0]?.docsHash).not.toBe(older[0]?.docsHash);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM model_staged_files WHERE reading_id <> ?').bind(pending[0]?.id ?? '').first('n')).toBe(0);
  });

  test('an older reading that comes back after a newer one was staged is dropped, its cost settled', async () => {
    anthropic.holdBatches = true;
    await consume([BANS_AI]);
    await hourly();
    const older = (await listPending(db))[0];
    commit(BANS_AI, { 'AGENTS.md': '# Agents\n\nRun the tests before you open a pull request.\n' });
    await consume([BANS_AI]);
    anthropic.endBatches();
    clock += HOUR;

    const run = await hourly();

    expect(older?.batchId).not.toBeNull();
    expect(run).toMatchObject({ collected: 1, read: 0, replaced: 1 });
    expect(await getModelReading(db, BANS_AI)).toBeNull();
    const left = await listPending(db);
    expect(left.map((p) => p.id)).not.toContain(older?.id);
    expect(left).toHaveLength(1);
    expect((await daySpend(db, new Date(clock).toISOString().slice(0, 10))).spent).toBeGreaterThan(0);
  });

  test('a reading that keeps failing for 7 days is dropped with its files, and the log names it', async () => {
    await consume([INVITES]);
    anthropic.fail('createBatch', { status: 529 }, { times: Infinity });
    await hourly();
    clock += DROP_AFTER_MS + HOUR;

    const run = await hourly();

    expect(run?.dropped).toEqual([INVITES]);
    expect(await listPending(db)).toEqual([]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM model_staged_files').first('n')).toBe(0);
    expect(logged.some((line) => line.includes(`dropped readings that kept failing for 7 days: ${INVITES}`))).toBe(true);
  });
});

  test('staged docs are dropped after 7 days even while the reader reads nothing', async () => {
    await consume([BANS_AI]);
    restore();
    restore = setEnv({ POLICY_READER: 'rules', MODEL_DAILY_BUDGET_USD: '20' });
    clock += DROP_AFTER_MS + HOUR;

    await hourly();

    expect(await listPending(db)).toEqual([]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM model_staged_files').first('n')).toBe(0);
  });

describe('the budget', () => {
  test('reserves before it sends, and settles to what the result cost', async () => {
    await consume([INVITES]);
    const day = new Date(clock).toISOString().slice(0, 10);

    await hourly();
    const reserved = await daySpend(db, day);
    clock += HOUR;
    await hourly();
    const settled = await daySpend(db, day);

    expect(reserved.spent).toBe(0);
    // Its max_tokens alone, at the batch output price.
    expect(reserved.reserved).toBeGreaterThan(0.32);
    expect(settled.reserved).toBe(0);
    expect(settled.spent).toBeGreaterThan(0);
    expect(settled.spent).toBeLessThan(reserved.reserved);
  });

  test("a spent share sends nothing, lists nothing, and pauses nothing, and the reading waits for the next UTC day", async () => {
    // The seeds spent all but a few cents of their half of the day's $20.
    const today = new Date(clock).toISOString().slice(0, 10);
    await db.prepare("INSERT INTO model_spend (day, share, spent_usd, reserved_usd) VALUES (?, 'seeds', 9.9, 0)").bind(today).run();
    await consume([INVITES]);
    const before = await listedAndPaused();

    const first = await hourly();
    clock += HOUR;
    const second = await hourly();

    expect(first).toMatchObject({ sent: 0, waiting: 1, held: 'budget' });
    expect(second).toMatchObject({ sent: 0, waiting: 1, held: 'budget' });
    expect(anthropic.calls).toEqual([]);
    expect(await listedAndPaused()).toEqual(before);
    clock = Date.UTC(2100, 3, 2, 0, 30, 0);
    const nextDay = await hourly();
    expect(nextDay).toMatchObject({ sent: 1, waiting: 0 });
  });

  test('a reservation settles on the day it was made, when the result comes back the next UTC day', async () => {
    clock = Date.UTC(2100, 3, 1, 23, 30, 0);
    await consume([BANS_AI]);
    await hourly();
    clock = Date.UTC(2100, 3, 2, 0, 30, 0);

    await hourly();

    expect((await daySpend(db, '2100-04-01')).spent).toBeGreaterThan(0);
    expect(await daySpend(db, '2100-04-02')).toEqual({ spent: 0, reserved: 0 });
  });

  test("weekly reads can't take the seeds' half before the last hours of the UTC day", async () => {
    // A fifth of $2 holds one reservation, and half of it two.
    restore();
    restore = setEnv({ POLICY_READER: 'shadow', MODEL_DAILY_BUDGET_USD: '2' });
    await listing(INVITES);
    await listing(CONDITIONS, { ...LISTED, url: `https://github.com/${CONDITIONS}/blob/main/CONTRIBUTING.md`, tier: 'allows_with_conditions' });
    await week();
    // Nothing comes back, so nothing reserved is settled yet.
    anthropic.holdBatches = true;
    const weekly = await hourly();
    await consume([BANS_AI, 'sample-policies/mixed-signals']);
    clock += MINUTE;

    const seeds = await hourly();

    expect(weekly).toMatchObject({ sent: 1, waiting: 1, held: 'budget' });
    expect(seeds).toMatchObject({ sent: 2 });
  });

  test('a share that is spent holds no other share back, however many readings wait', async () => {
    await listing(INVITES);
    await week();
    const today = new Date(clock).toISOString().slice(0, 10);
    await db.prepare("INSERT INTO model_spend (day, share, spent_usd, reserved_usd) VALUES (?, 'seeds', 10, 0)").bind(today).run();
    const facts = JSON.stringify({ stars: 1, createdAt: 0, pushedAt: 0, ownerCreatedAt: 0 });
    const rows = Array.from({ length: 210 }, (_, i) =>
      db
        .prepare(
          `INSERT INTO model_pending (id, repo, purpose, share, docs_hash, rules_tier, commit_sha, branch, facts, vouch, labels, staged_at)
           VALUES (?, ?, 'seed', 'seeds', ?, 'no_policy', 'abc', 'main', ?, NULL, '[]', ?)`,
        )
        .bind(`rdg_seed${String(i)}`, `sample-bulk/seed-${String(i)}`, `docs-v1:${'0'.repeat(64)}`, facts, clock - DAY),
    );
    await db.batch(rows);

    const run = await hourly();

    expect(run).toMatchObject({ sent: 1, held: 'budget' });
    expect(anthropic.requests.filter((r) => r.kind === 'reading')).toHaveLength(1);
  });

  test("seeds may spend half the day and no more, and weekly reads may spend what the seeds' share leaves unspent", async () => {
    // Half of $1 is the seeds' share, enough for one reading's reservation and not two.
    restore();
    restore = setEnv({ POLICY_READER: 'shadow', MODEL_DAILY_BUDGET_USD: '1' });
    await consume([BANS_AI, 'sample-policies/mixed-signals']);
    const seeds = await hourly();
    expect(seeds).toMatchObject({ sent: 1, waiting: 1, held: 'budget' });
    await db.prepare('DELETE FROM model_pending').run();
    await db.prepare('DELETE FROM model_spend').run();
    // In the last hours of the UTC day.
    clock = Date.UTC(2100, 3, 1, 19, 0, 0);

    await listing(INVITES);
    await listing(CONDITIONS, { ...LISTED, url: `https://github.com/${CONDITIONS}/blob/main/CONTRIBUTING.md`, tier: 'allows_with_conditions' });
    await week();

    const run = await hourly();

    // 20% of $1 holds no reservation, but the seeds left the day's other 80% unspent.
    expect(run).toMatchObject({ sent: 2, waiting: 0 });
    // And no more than the day: with all but a few cents of it used, the next weekly read waits.
    commit(INVITES, { 'AGENTS.md': '# Agents\n\nRun the tests first.\n' });
    clock += HOUR;
    await hourly();
    await week();
    const day = new Date(clock).toISOString().slice(0, 10);
    await db.prepare("INSERT INTO model_spend (day, share, spent_usd, reserved_usd) VALUES (?1, 'seeds', 0.5, 0), (?1, 'weekly', 0.3, 0)").bind(day).run();
    const full = await hourly();
    expect(full).toMatchObject({ sent: 0, held: 'budget' });
  });
});

describe('when it can not read', () => {
  // A listing in every test here, so "pauses nothing" has something to pause.
  beforeEach(async () => {
    await listing(CONDITIONS, { ...LISTED, url: `https://github.com/${CONDITIONS}/blob/main/CONTRIBUTING.md`, tier: 'allows_with_conditions' });
  });

  test('with no key, nothing is staged, the log says so once a day, the hourly run calls nothing, and the rules still decide', async () => {
    restore();
    restore = setEnv({ POLICY_READER: 'shadow', MODEL_DAILY_BUDGET_USD: '20', ANTHROPIC_API_KEY: undefined });

    const before = await listedAndPaused();
    const run = await crawlSeed(INVITES);
    await consume([BANS_AI]);
    const weekly = await week();
    await sendAndCollect();

    expect(run.proposed).toEqual([INVITES]);
    expect(weekly.reread.read).toBe(1);
    expect(weekly.reader.staged).toBe(0);
    expect(await listedAndPaused()).toEqual({ ...before, finds: [INVITES] });
    expect(run.reader.staged).toBe(0);
    expect(await listPending(db)).toEqual([]);
    expect(anthropic.calls).toEqual([]);
    // Once on the seeds' UTC day, for two reads, and once on the weekly read's.
    expect(logged.filter((line) => line.includes('The ANTHROPIC_API_KEY secret is not set'))).toHaveLength(2);
  });

  test.each([
    [429, 'rate limited'],
    [500, 'a server error'],
    [529, 'overloaded'],
  ])('a batch the API refuses with %i (%s) stays pending for the next hourly run, and lists and pauses nothing', async (status) => {
    await consume([INVITES]);
    const before = await listedAndPaused();
    anthropic.fail('createBatch', { status });

    const failed = await hourly();
    clock += HOUR;
    const next = await hourly();

    expect(failed).toMatchObject({ sent: 0, waiting: 1, held: 'api' });
    expect(next).toMatchObject({ sent: 1 });
    expect(await listedAndPaused()).toEqual(before);
  });

  test.each([
    [401, 'ANTHROPIC_API_KEY'],
    [403, 'may not use the model'],
  ])('a key the API refuses with %i stops the reader for an hour, the log names the secret, and the reading stays pending', async (status, named) => {
    await consume([INVITES]);
    const before = await listedAndPaused();
    anthropic.fail('createBatch', { status });

    await hourly();
    const calls = anthropic.calls.length;
    clock += STOP_MS - MINUTE;
    const stopped = await hourly();
    const stoppedCalls = anthropic.calls.length;
    clock += 2 * MINUTE;
    const again = await hourly();

    expect(stopped).toMatchObject({ held: 'stopped', sent: 0 });
    expect(stoppedCalls).toBe(calls);
    expect(again).toMatchObject({ sent: 1 });
    expect(logged.some((line) => line.includes(named) && line.includes('stopped sending a batch'))).toBe(true);
    expect(await listedAndPaused()).toEqual(before);
  });

  test.each([400, 404])('a request the API refuses with %i stops the reader for an hour, with an error in the log', async (status) => {
    await consume([INVITES]);
    const before = await listedAndPaused();
    anthropic.fail('createBatch', { status });

    await hourly();
    clock += 30 * MINUTE;
    const stopped = await hourly();

    expect(stopped).toMatchObject({ held: 'stopped', sent: 0 });
    expect(await listPending(db)).toHaveLength(1);
    expect(logged.some((line) => line.includes('a bug in the request'))).toBe(true);
    expect(await listedAndPaused()).toEqual(before);
  });

  test('an account out of credit waits, as for a spent budget, until the next UTC day', async () => {
    await consume([INVITES]);
    const before = await listedAndPaused();
    anthropic.fail('createBatch', { status: 402 });

    await hourly();
    clock += 6 * HOUR;
    const sameDay = await hourly();
    clock = Date.UTC(2100, 3, 2, 0, 5, 0);
    const nextDay = await hourly();

    expect(sameDay).toMatchObject({ held: 'stopped', sent: 0 });
    expect(nextDay).toMatchObject({ sent: 1 });
    expect(await listedAndPaused()).toEqual(before);
  });

  test('a batch the API no longer knows sends its readings again', async () => {
    anthropic.holdBatches = true;
    await consume([BANS_AI]);
    await hourly();
    const batch = Object.keys(anthropic.state.batches)[0] ?? '';
    Reflect.deleteProperty(anthropic.state.batches, batch);
    anthropic.holdBatches = false;
    clock += HOUR;

    const run = await hourly();

    expect(run).toMatchObject({ collected: 0, sent: 1 });
    expect(logged.some((line) => line.includes(`found no batch ${batch}`))).toBe(true);
  });

  test.each([
    ['a server error', () => { anthropic.fail('getBatch', { status: 500 }); }],
    ['no answer', () => { anthropic.fail('getBatch', { status: 503 }); }],
  ])('asking after a batch that gets %s leaves it for the next hourly run, and lists and pauses nothing', async (_, failure) => {
    await consume([BANS_AI]);
    await hourly();
    const before = await listedAndPaused();
    failure();
    clock += HOUR;

    const failed = await hourly();
    clock += HOUR;
    const next = await hourly();

    expect(failed).toMatchObject({ collected: 0, read: 0, held: 'api' });
    expect(next).toMatchObject({ collected: 1, read: 1 });
    expect(await listedAndPaused()).toEqual(before);
  });

  test("an API that can't be reached while collecting leaves the batch for the next hourly run", async () => {
    await consume([BANS_AI]);
    await hourly();
    const network = fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      new Request(input, init).url.startsWith(anthropic.url) ? Promise.reject(new TypeError('Network connection lost.')) : network(input, init),
    );
    clock += HOUR;

    const failed = await hourly();
    vi.stubGlobal('fetch', network);
    clock += HOUR;
    const next = await hourly();

    expect(failed).toMatchObject({ collected: 0, held: 'api' });
    expect(failed?.stopped).toContain("couldn't be reached");
    expect(next).toMatchObject({ collected: 1, read: 1 });
  });

  test('one result that fails to keep is no verdict, and the rest of the run goes on', async () => {
    await consume([BANS_AI, 'sample-policies/mixed-signals']);
    await hourly();
    await consume([INVITES]);
    await db.prepare('ALTER TABLE model_readings RENAME TO model_readings_away').run();
    clock += HOUR;
    let run;
    try {
      run = await hourly();
    } finally {
      await db.prepare('ALTER TABLE model_readings_away RENAME TO model_readings').run();
    }

    expect(run).toMatchObject({ collected: 1, read: 0, sent: 1 });
    expect(Object.values(run?.noVerdict ?? {}).reduce((a, b) => a + b, 0)).toBe(2);
    expect(await listPending(db)).toHaveLength(1);
  });

  test('a reading in a batch that kept failing for 7 days is dropped, and its reservation released', async () => {
    anthropic.holdBatches = true;
    await consume([BANS_AI]);
    await hourly();
    const day = new Date(clock).toISOString().slice(0, 10);
    clock += DROP_AFTER_MS + HOUR;

    const run = await hourly();

    expect(run?.dropped).toEqual([BANS_AI]);
    expect(await listPending(db)).toEqual([]);
    expect((await daySpend(db, day)).reserved).toBe(0);
  });

  test('a batch that has not ended stays in progress, and its readings wait', async () => {
    anthropic.holdBatches = true;
    await consume([INVITES]);

    await hourly();
    clock += HOUR;
    const run = await hourly();

    expect(run).toMatchObject({ inProgress: 1, collected: 0, read: 0, sent: 0 });
    expect((await listPending(db))[0]?.batchId).not.toBeNull();
  });

  test.each([
    ['expired', { result: 'expired' as const }],
    ['canceled', { result: 'canceled' as const }],
    ['errored with an overload', { error: 'overloaded_error' as const }],
    ['errored with a server error', { error: 'api_error' as const }],
  ])('a request that %s goes in the next batch, and lists and pauses nothing', async (_, answer) => {
    await consume([INVITES]);
    const before = await listedAndPaused();
    anthropic.answer({ kind: 'reading', via: 'batch' }, answer);

    await hourly();
    clock += HOUR;
    const collected = await hourly();
    clock += HOUR;
    const read = await hourly();

    expect(collected).toMatchObject({ collected: 1, retried: 1, read: 0, sent: 1 });
    expect(read).toMatchObject({ collected: 1, read: 1 });
    expect(await listedAndPaused()).toEqual(before);
  });

  test.each([
    ['a refusal', { stop: 'refusal' as const }, 'stop reason refusal'],
    ['max_tokens', { stop: 'max_tokens' as const }, 'stop reason max_tokens'],
    ['an invalid request error in the result', { error: 'invalid_request_error' as const }, 'invalid_request_error'],
    ['output that does not parse', { text: 'not json' }, 'output that does not parse'],
    ['output that fails the checks', { output: { tier: 'invites_agents' } }, 'output that fails the checks'],
  ])('%s is no verdict: the log says why, nothing is kept, and nothing is listed or paused', async (_, answer, why) => {
    const run = await crawlSeed(INVITES);
    const before = await listedAndPaused();
    anthropic.answer({ kind: 'reading', via: 'batch' }, answer);

    const { second } = await sendAndCollect();

    expect(run.proposed).toEqual([INVITES]);
    expect(second?.read).toBe(0);
    expect(Object.keys(second?.noVerdict ?? {}).some((reason) => reason.includes(why))).toBe(true);
    expect(await getModelReading(db, INVITES)).toBeNull();
    expect(await listPending(db)).toEqual([]);
    expect(logged.some((line) => line.includes(`The policy reader gave ${INVITES} no verdict`) && line.includes(why))).toBe(true);
    expect(await listedAndPaused()).toEqual(before);
  });
});

describe('in shadow, a weekly read', () => {
  test('of docs that changed gets a model reading, and the rules still decide: their policy change shows both readings', async () => {
    await listing(INVITES);
    await week();
    await sendAndCollect();
    const asked = readingsAsked();
    commit(INVITES, {
      'AI_POLICY.md': '# AI policy\n\nAgents may open pull requests on their own, on issues labeled `agent ready` or `help wanted`.\n',
    });

    const run = await week();
    const { second } = await sendAndCollect();

    expect(run.reread.changed).toEqual([INVITES]);
    expect(run.reader.staged).toBe(1);
    expect(readingsAsked()).toBe(asked + 1);
    expect(second?.read).toBe(1);
    const [change] = await listPolicyChanges(db, 'waiting');
    const kept = await getModelReading(db, INVITES);
    expect(change?.docsHash).toBe(kept?.docsHash);
    const { item, text } = await queueItem('policy_change', INVITES);
    expect(item.modelReading).toMatchObject({ docsHash: kept?.docsHash });
    expect(text).toContain("the model policy reader's reading of the same docs");
    expect((await getProject(db, INVITES))?.status).toBe('approved');
  });

  test('of the docs the last weekly read read makes no model call, and decides nothing', async () => {
    await listing(INVITES);
    await week();
    await sendAndCollect();
    expect(readingsAsked()).toBe(1);

    const run = await week();
    await sendAndCollect();

    expect(run.reader).toMatchObject({ staged: 0, same: 1 });
    expect(readingsAsked()).toBe(1);
  });

  test("after GitHub renames the repo, the model's reading is kept under the project's name, and the policy change shows it", async () => {
    await listing(INVITES);
    await week();
    await sendAndCollect();
    const renamed = `${INVITES}-next`;
    github.renameRepo(INVITES, renamed);
    commit(renamed, { 'AI_POLICY.md': '# AI policy\n\nAgents may open pull requests on their own, on issues labeled `agent ready` or `help wanted`.\n' });

    const run = await week();
    await sendAndCollect();

    expect(run.reread.changed).toEqual([INVITES]);
    const kept = await getModelReading(db, INVITES);
    const [change] = await listPolicyChanges(db, 'waiting');
    expect(kept?.docsHash).toBe(change?.docsHash);
    expect((await getModelRead(db, INVITES))?.docsHash).toBe(change?.docsHash);
    const { item } = await queueItem('policy_change', INVITES);
    expect(item.modelReading).toMatchObject({ docsHash: change?.docsHash });
  });

  test('that the model reads as changed is named in the log', async () => {
    await listing(INVITES);
    await week();
    await sendAndCollect();
    commit(INVITES, { 'AGENTS.md': '# Agents\n\nRun the tests before you open a pull request.\n' });
    anthropic.answer(
      { kind: 'reading', via: 'batch' },
      {
        output: {
          statements: [{ path: 'AI_POLICY.md', startLine: 3, endLine: 3, quote: QUOTE, about: 'welcomesAi', label: null, value: null, why: 'A welcome.' }],
          tier: 'allows_with_conditions',
          steering: [],
          summary: 'Welcomes AI help.',
        },
      },
    );

    await week();
    const { second } = await sendAndCollect();

    expect(second?.wouldChange).toEqual([INVITES]);
  });

  test('that the model reads as a ban pauses nothing, and the log names it', async () => {
    await listing(INVITES);
    await week();
    await sendAndCollect();
    commit(INVITES, { 'AGENTS.md': '# Agents\n\nRun the tests before you open a pull request.\n' });
    anthropic.answer(
      { kind: 'reading', via: 'batch' },
      {
        output: {
          statements: [{ path: 'AI_POLICY.md', startLine: 3, endLine: 3, quote: QUOTE, about: 'bansAi', label: null, value: null, why: 'A ban.' }],
          tier: 'bans_or_restricts',
          steering: [],
          summary: 'Bans AI help.',
        },
      },
    );

    await week();
    const { second } = await sendAndCollect();

    expect(second?.wouldPause).toEqual([INVITES]);
    expect((await getProject(db, INVITES))?.status).toBe('approved');
    expect((await getModelRead(db, INVITES))?.banned).toBe(true);
  });

  test('with no verdict keeps no docs hash, so the next weekly read tries again, and three in a row are reported once', async () => {
    await listing(INVITES);
    anthropic.answer({ kind: 'reading', via: 'batch' }, { stop: 'refusal' }, { times: Infinity });

    for (let i = 0; i < 4; i++) {
      commit(INVITES, { 'AGENTS.md': `# Agents\n\nRun the tests, round ${String(i)}.\n` });
      await week();
      await sendAndCollect();
    }

    expect(readingsAsked()).toBe(4);
    expect(await getModelRead(db, INVITES)).toMatchObject({ docsHash: null, noVerdicts: 4, noVerdictsReported: true });
    expect(logged.filter((line) => line.includes(`gave ${INVITES} no verdict on`))).toHaveLength(1);
    expect((await getProject(db, INVITES))?.status).toBe('approved');
    expect(await listPolicyChanges(db, 'waiting')).toEqual([]);
  });
});
