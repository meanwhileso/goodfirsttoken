import { newClaim } from '@goodfirsttoken/core';
import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { addPr, getPr, listIssues, saveClaim } from '../../src/db';
import { addConnection } from '../../src/mcp/connections';
import worker from '../../src/server';
import { LAPSED_CONNECTIONS_CRON } from '../../src/sync/scheduled';
import { startGitHub } from '../auth/helpers';
import { db, emptyDatabase, maintainer, priya, registeredProject, repo, sha, signIn } from '../db/helpers';
import { freshNumbers, knowServiceToken } from './helpers';

// The Worker's scheduled handler, run the way Cloudflare runs a cron trigger,
// for each cron in wrangler.jsonc. The project, claim, and PR are made up,
// in the GitHub fake's sample-app.

const { TEST_CRONS: crons } = env as Env & { TEST_CRONS: string[] };
const BY = 'sample-maintainer';

let github: GitHubFake;
let logged: string[];

beforeEach(async () => {
  await emptyDatabase();
  await signIn(maintainer, priya);
  github = startGitHub();
  freshNumbers(github, repo);
  knowServiceToken(github);
  logged = [];
  const keep = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'warn').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** An approved project, and a claim whose PR closed on GitHub, for the jobs to find. */
async function workToFind(): Promise<string> {
  await registeredProject();
  const issue = github.openIssue(repo, { title: 'Keep the hash in rewrites', labels: ['help wanted'], by: BY });
  const number = github.openPullRequest(repo, { title: 'Keep the hash', body: `Closes #${String(issue)}`, by: 'priya' });
  github.closePullRequest(repo, number, BY);
  const pr = { repo, number, url: `${github.webUrl}/${repo}/pull/${String(number)}` };
  const now = Date.now();
  await saveClaim(
    db,
    {
      id: 'c_scheduled',
      issue: `${repo}#${String(issue)}`,
      project: repo,
      githubId: priya.githubId,
      login: priya.login,
      agent: 'claude-code',
      ownProject: false,
      startCommit: sha,
      tokenEstimate: null,
      ...newClaim(now - 60_000),
      state: 'pr_opened',
      submittedAt: now - 30_000,
      pr,
    },
    1,
  );
  await addPr(db, { claimId: 'c_scheduled', pr, openedAt: now - 30_000 });
  return 'c_scheduled';
}

async function runCron(cron: string, bindings: Env = env): Promise<void> {
  await worker.scheduled(createScheduledController({ cron, scheduledTime: Date.now() }), bindings);
}

test('every cron trigger in wrangler.jsonc runs one job, and each job has a cron', async () => {
  const claimId = await workToFind();
  // An agent's connection whose grant ran out 40 days ago.
  const long = Date.now() - 40 * 24 * 60 * 60 * 1000;
  await addConnection({ githubId: priya.githubId, clientId: 'c-lapsed', clientName: 'Lapsed agent', gitHubToken: 'made-up-lapsed-token' }, long);
  await db.prepare('UPDATE connected_agents SET renewed_at = ?1').bind(long).run();
  const connections = () => db.prepare('SELECT COUNT(*) AS n FROM connected_agents').first<number>('n');
  const ran: string[][] = [];
  // The crawler's search fills a stand-in for the crawl queue, so no
  // consumer reads what it finds while the other jobs run.
  const queued: unknown[] = [];
  const bindings = { ...env, CRAWL_QUEUE: { sendBatch: (messages: unknown[]) => void queued.push(...messages) } } as unknown as Env;

  for (const cron of crons) {
    const synced = (await listIssues(db, repo)).length > 0;
    const followed = (await getPr(db, claimId))?.state !== 'open';
    const crawled = queued.length > 0;
    const connected = await connections();
    await runCron(cron, bindings);
    const jobs: string[] = [];
    if (!synced && (await listIssues(db, repo)).length > 0) jobs.push('sync');
    if (!followed && (await getPr(db, claimId))?.state !== 'open') jobs.push('prs');
    if (!crawled && queued.length > 0) jobs.push('crawl');
    if ((await connections()) !== connected) jobs.push('lapsed');
    ran.push(jobs);
  }

  expect(ran.map((jobs) => jobs.length)).toEqual(crons.map(() => 1));
  expect(ran.flat().sort()).toEqual(['crawl', 'lapsed', 'prs', 'sync']);
});

test('with no service token, no job reads GitHub, and the log of each job that reads names the secret', async () => {
  await workToFind();
  const reading = crons.filter((cron) => cron !== LAPSED_CONNECTIONS_CRON);

  for (const cron of crons) await runCron(cron, { ...env, GH_SERVICE_TOKEN: '' });

  expect(github.calls).toEqual([]);
  expect(reading).toHaveLength(crons.length - 1);
  expect(logged.filter((line) => line.includes('The GH_SERVICE_TOKEN secret is not set'))).toHaveLength(reading.length);
});

test('a cron no job answers to runs nothing, and says so', async () => {
  await workToFind();

  await runCron('0 3 * * *');

  expect(github.calls).toEqual([]);
  expect(logged).toEqual([expect.stringContaining('No job runs on the cron 0 3 * * *')]);
});
