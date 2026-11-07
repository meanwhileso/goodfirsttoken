import type { CrawlMessage } from '@goodfirsttoken/core';
import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AUTO_APPROVED_REASON, approveStarredFinds } from '../../src/crawl/auto-approve';
import { runReader } from '../../src/crawl/batches';
import { fillCrawlQueue } from '../../src/crawl/producer';
import { readCrawlBatch } from '../../src/crawl/queue';
import { addRequest, getProject, listCandidates, listPending } from '../../src/db';
import { startAnthropic } from '../anthropic';
import { startGitHub } from '../auth/helpers';
import { admin, db, emptyDatabase, priya, signIn } from '../db/helpers';
import { knowServiceToken } from '../sync/helpers';

// A requested repo, end to end, to the approval on its own (#165): a donor
// requests it, the cron job queues it, the consumer reads its docs from the
// GitHub fake, the model policy reader reads them through the Anthropic
// fake, and the hourly approval lists a find whose repo has more than 100
// stars. A repo with 100 stars or fewer waits for an admin. The repos are
// the GitHub fake's made-up sample-policies repos, whose docs welcome AI
// help, and the Anthropic fake answers from the readings recorded for them.

const INVITES = 'sample-policies/invites-agents';
const CONDITIONS = 'sample-policies/with-conditions';
const SEED = 'sample-policies/small-seed';
const HOUR = 3_600_000;
const start = Date.UTC(2100, 3, 1, 12, 0, 0);
const configuredAdmins = env.ADMIN_GITHUB_IDS;

let github: GitHubFake;
let clock: number;
let sent: CrawlMessage[];

const queue = {
  sendBatch: (messages: Iterable<MessageSendRequest<CrawlMessage>>) => {
    for (const message of messages) sent.push(message.body);
    return Promise.resolve();
  },
};

beforeEach(async () => {
  await emptyDatabase();
  await signIn(admin, priya);
  github = startGitHub();
  knowServiceToken(github);
  startAnthropic(github);
  env.ADMIN_GITHUB_IDS = String(admin.githubId);
  clock = start;
  sent = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});

afterEach(() => {
  env.ADMIN_GITHUB_IDS = configuredAdmins;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function idOf(repo: string): number {
  const record = github.state.repos[repo.toLowerCase()];
  if (!record) throw new Error(`missing sample repo ${repo}`);
  return record.id;
}

/** Priya's request for each repo, the cron job, the consumer, and the reader's hourly runs until its readings are back. */
async function requestAndRead(repos: string[]): Promise<void> {
  for (const repo of repos) await addRequest(db, { repoId: idOf(repo), repo, githubId: priya.githubId }, clock);
  await fillCrawlQueue({ db, queue, now: () => clock });
  const messages = sent.splice(0).map((body, i) => ({
    id: `m${String(i)}`,
    timestamp: new Date(clock),
    attempts: 1,
    body,
    ack: () => undefined,
    retry: () => undefined,
  }));
  const batch = { queue: 'crawl', messages, ackAll: () => undefined, retryAll: () => undefined } as unknown as MessageBatch;
  await readCrawlBatch(batch, { ...env, CRAWL_QUEUE: { send: () => Promise.resolve() } }, () => clock);
  for (let i = 0; i < 6 && (await listPending(db)).length > 0; i++) {
    clock += HOUR;
    await runReader({ db, now: () => clock });
  }
  expect(await listPending(db)).toEqual([]);
}

function approve() {
  return approveStarredFinds({ db, token: env.GH_SERVICE_TOKEN, now: () => clock });
}

test('a requested repo with more than 100 stars and welcoming docs is read by the crawler and listed by the hourly approval', async () => {
  await requestAndRead([INVITES]);
  expect((await listCandidates(db, 'waiting')).map((find) => [find.repo, find.facts.stars])).toEqual([[INVITES, 3100]]);

  const run = await approve();

  expect(run?.approved).toEqual([INVITES]);
  // The listing takes the settings the crawler suggested, as an admin's approval does.
  expect(await getProject(db, INVITES)).toMatchObject({ status: 'approved', source: 'policy', addedBy: admin.githubId });
  expect(await listCandidates(db, 'approved')).toMatchObject([{ repo: INVITES, reason: AUTO_APPROVED_REASON }]);
});

test('a requested repo with 100 stars or fewer is read, and its find waits for an admin', async () => {
  const conditions = github.state.repos[CONDITIONS.toLowerCase()];
  if (!conditions) throw new Error(`missing sample repo ${CONDITIONS}`);
  conditions.stars = 100;
  await requestAndRead([SEED, CONDITIONS]);
  const found = (await listCandidates(db, 'waiting')).map((find) => [find.repo, find.facts.stars]);
  expect(found).toEqual(expect.arrayContaining([[SEED, 40], [CONDITIONS, 100]]));
  expect(found).toHaveLength(2);

  const run = await approve();

  expect(run?.approved ?? []).toEqual([]);
  expect(await getProject(db, SEED)).toBeNull();
  expect(await getProject(db, CONDITIONS)).toBeNull();
  expect((await listCandidates(db, 'waiting')).map((find) => find.repo).sort()).toEqual([CONDITIONS, SEED].sort());
});
