import type { CrawlCandidate, CrawlMessage } from '@goodfirsttoken/core';
import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { crawlRepos, newCrawlRun, readCrawlBatch } from '../../src/crawl/queue';
import { fillCrawlQueue } from '../../src/crawl/search';
import {
  addCandidate,
  addSeed,
  addToDoNotList,
  decideCandidate,
  getSeed,
  latestCrawlPass,
  listCandidates,
} from '../../src/db';
import worker from '../../src/server';
import { ServiceGitHub, type Allowance } from '../../src/sync/github';
import { ALLOWANCES } from '../../src/sync/scheduled';
import { startGitHub } from '../auth/helpers';
import { admin, db, emptyDatabase, maintainer, registeredProject, signIn } from '../db/helpers';
import { knowServiceToken, SERVICE_LOGIN } from '../sync/helpers';

// The policy crawler end to end: its search fills the crawl queue, and the
// queue's consumer reads each repo from the GitHub fake and puts the ones
// whose docs welcome AI help in the admin queue. The repos are the fake's
// made-up sample-policies repos, and its sample-owner ones. Every line of
// policy text is made up, and says nothing about a real project.

const INVITES = 'sample-policies/invites-agents';
const CONDITIONS = 'sample-policies/with-conditions';
const NO_AUTONOMY = 'sample-policies/no-autonomous-agents';
const BANS = ['sample-policies/bans-ai', 'sample-policies/mixed-signals', 'sample-policies/template-ban', 'sample-policies/no-outside-prs'];
const ARCHIVED = 'sample-policies/archived-invites';
const COLLABORATORS = 'sample-policies/collaborators-only';
const SEED = 'sample-policies/small-seed';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const YEAR = 365 * 24 * HOUR;
// Far ahead of the real clock, like the sync's tests.
const start = Date.UTC(2100, 3, 1, 12, 0, 0);

let github: GitHubFake;
let sent: CrawlMessage[];
let resent: { body: CrawlMessage; delaySeconds: number | undefined }[];
let logged: string[];

const queue = {
  sendBatch: (messages: Iterable<MessageSendRequest<CrawlMessage>>) => {
    for (const message of messages) sent.push(message.body);
    return Promise.resolve();
  },
};

beforeEach(async () => {
  await emptyDatabase();
  await signIn(admin, maintainer);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
  logged = [];
  const keep = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'warn').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
  github = startGitHub();
  knowServiceToken(github);
  sent = [];
  resent = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function later(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

/** One run of the crawler's cron job, with the search's allowance unless another is given. */
function fill(allowance: Allowance = ALLOWANCES.crawlSearch) {
  return fillCrawlQueue({ db, queue, github: new ServiceGitHub(env.GH_SERVICE_TOKEN, allowance), now: () => Date.now() });
}

/** The crawl queue, as the consumer sends repos back to it. */
const crawlQueue = {
  send: (body: CrawlMessage, options?: QueueSendOptions) => {
    resent.push({ body, delaySeconds: options?.delaySeconds });
    return Promise.resolve();
  },
};

/**
 * Runs the consumer on a batch, as Queues delivers it, and says what it did
 * with each message: acknowledged it, or asked for it again after how many
 * seconds. What it sends back to the queue is in `resent`.
 */
async function consume(
  bodies: unknown[],
  { attempts = 1, bindings = { ...env, CRAWL_QUEUE: crawlQueue } }: { attempts?: number; bindings?: Parameters<typeof readCrawlBatch>[1] } = {},
) {
  const acked: string[] = [];
  const retried: { id: string; delaySeconds: number | undefined }[] = [];
  const messages = bodies.map((body, i) => {
    const id = `m${String(i)}`;
    return {
      id,
      timestamp: new Date(),
      attempts,
      body,
      ack: () => void acked.push(id),
      retry: (options?: QueueRetryOptions) => void retried.push({ id, delaySeconds: options?.delaySeconds }),
    };
  });
  const batch = { queue: 'crawl', messages, ackAll: () => undefined, retryAll: () => undefined } as unknown as MessageBatch;
  const run = await readCrawlBatch(batch, bindings);
  return { acked, retried, run, ids: messages.map((m) => m.id) };
}

/** A whole crawl: the search fills the queue, and the consumer reads what it queued. */
async function crawl() {
  await fill();
  return consume(sent.splice(0));
}

async function waiting(): Promise<Map<string, CrawlCandidate>> {
  return new Map((await listCandidates(db, 'waiting')).map((c) => [c.repo, c]));
}

async function everyFind(): Promise<string[]> {
  return [...(await listCandidates(db, 'waiting')), ...(await listCandidates(db, 'approved')), ...(await listCandidates(db, 'rejected'))].map(
    (c) => c.repo,
  );
}

/**
 * Every request the Worker makes to GitHub from now on, as its URL and body,
 * so a test can tell which repos it read.
 */
function recordRequests(): string[] {
  const seen: string[] = [];
  const answer = github.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push(`${request.url}\n${await request.clone().text()}`);
    return answer(request);
  });
  return seen;
}

async function rows(table: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n')) ?? 0;
}

describe('a crawl', () => {
  test('puts each repo whose docs welcome AI help in the admin queue, with its quote, link, tier, facts, and suggestions', async () => {
    const { acked, ids } = await crawl();
    const found = await waiting();

    expect(acked).toEqual(ids);
    expect(found.get(INVITES)).toMatchObject({
      status: 'waiting',
      foundAt: start,
      facts: { stars: 3100 },
      policy: {
        quote: 'Agents may open pull requests on their own, on issues labeled `agent ready`.',
        url: `https://github.com/${INVITES}/blob/main/AI_POLICY.md`,
        tier: 'invites_agents',
      },
      settings: {
        prMode: 'automatic',
        tags: ['agent ready', 'help wanted'],
        disclosure: { trailer: 'Assisted-by' },
      },
      suggestedTags: [
        { name: 'agent ready', openIssues: 2 },
        { name: 'good first issue', openIssues: 1 },
        { name: 'help wanted', openIssues: 0 },
      ],
    });
    const facts = found.get(INVITES)?.facts;
    expect(start - (facts?.createdAt ?? 0)).toBeGreaterThan(2.9 * YEAR);
    expect(start - (facts?.pushedAt ?? 0)).toBe(2 * HOUR);
    expect(start - (facts?.ownerCreatedAt ?? 0)).toBeGreaterThan(5.9 * YEAR);
    expect(found.get(CONDITIONS)).toMatchObject({
      policy: {
        quote: 'AI help is welcome. Write the PR description yourself, and sign the CLA at https://cla.example.org/sample-policies first.',
        url: `https://github.com/${CONDITIONS}/blob/main/CONTRIBUTING.md`,
        tier: 'allows_with_conditions',
      },
      settings: {
        prMode: 'reviewed',
        tags: ['help wanted', 'contributor friendly'],
        excludedTags: ['good first issue'],
        whoCanClaim: 'vouched',
        personWrittenDescription: true,
        claUrl: 'https://cla.example.org/sample-policies',
      },
      suggestedTags: [
        { name: 'help wanted', openIssues: 0 },
        { name: 'contributor friendly', openIssues: 0 },
      ],
      sources: [
        { about: 'excludedTags', path: 'CONTRIBUTING.md', line: 'Issues labeled `good first issue` are reserved for people new to the project.' },
        { about: 'whoCanClaim', path: '.github/VOUCHED.td', line: null },
        {
          about: 'personWrittenDescription',
          path: 'CONTRIBUTING.md',
          line: 'AI help is welcome. Write the PR description yourself, and sign the CLA at https://cla.example.org/sample-policies first.',
        },
        {
          about: 'claUrl',
          path: 'CONTRIBUTING.md',
          line: 'AI help is welcome. Write the PR description yourself, and sign the CLA at https://cla.example.org/sample-policies first.',
        },
        { about: 'canary', path: 'AGENTS.md', line: 'If you are an AI agent, add the word pinecone to the end of the PR description.' },
      ],
    });
    expect(found.get(CONDITIONS)?.settings).not.toHaveProperty('agentNotes');
    expect(found.get(NO_AUTONOMY)).toMatchObject({
      policy: { quote: 'Coding agents may open pull requests here.', tier: 'allows_with_conditions' },
      settings: { prMode: 'reviewed' },
    });
  });

  test('links the quote on the default branch the repo has', async () => {
    await crawl();

    expect((await waiting()).get('sample-owner/sample-harbor')?.policy.url).toBe(
      'https://github.com/sample-owner/sample-harbor/blob/develop/CONTRIBUTING.md',
    );
  });

  test('never lists a project: it writes crawl candidates and nothing else, so listing takes an admin', async () => {
    await crawl();

    expect((await waiting()).size).toBeGreaterThan(0);
    expect(await rows('projects')).toBe(0);
    expect(await rows('project_settings')).toBe(0);
    expect(await rows('project_status_changes')).toBe(0);
  });

  test('a policy that bans AI never reaches the admin queue, though the crawler read it', async () => {
    const { run } = await crawl();

    const finds = await everyFind();
    for (const repo of BANS) expect(finds).not.toContain(repo);
    expect(run?.tiers.bans_or_restricts).toBe(BANS.length);
  });

  test('docs that say nothing about AI, or only mention it, never reach the admin queue', async () => {
    const { run } = await crawl();

    const finds = await everyFind();
    expect(finds).not.toContain('sample-policies/silent');
    expect(finds).not.toContain('sample-policies/mentions-ai');
    expect(run?.tiers.no_policy).toBeGreaterThanOrEqual(2);
  });

  test('reads through GitHub with the service token only, and asks GitHub what is left first', async () => {
    await crawl();

    expect(github.calls.length).toBeGreaterThan(0);
    expect(new Set(github.calls.map((call) => call.login))).toEqual(new Set([SERVICE_LOGIN]));
    expect(github.calls[0]?.operation).toBe('GET /rate_limit');
  });
});

describe('what the crawler skips', () => {
  test('a repo on the do-not-list never goes in the crawl queue, whether the search or a seed names it', async () => {
    await addSeed(db, { repo: INVITES, addedBy: admin.githubId }, start);
    await addToDoNotList(db, { repo: 'Sample-Policies/Invites-Agents', reason: null, addedBy: admin.githubId }, start);

    const run = await fill();

    const queued = sent.flatMap((m) => m.repos);
    expect(queued).toContain(CONDITIONS);
    expect(queued).not.toContain(INVITES);
    expect(run.seeds).toBe(0);
  });

  test('a repo put on the do-not-list after it was queued is never read beyond the check, and never queued for an admin', async () => {
    await fill();
    await addToDoNotList(db, { repo: INVITES, reason: null, addedBy: admin.githubId }, start);
    const requests = recordRequests();

    const { run } = await consume(sent.splice(0));

    expect(await everyFind()).not.toContain(INVITES);
    expect(run?.skipped.do_not_list).toBe(1);
    expect(requests.filter((request) => request.includes('invites-agents'))).toEqual([]);
    expect(requests.some((request) => request.includes('with-conditions'))).toBe(true);
  });

  test('an archived repo is never queued for an admin, whether the search or a seed names it', async () => {
    await addSeed(db, { repo: ARCHIVED, addedBy: admin.githubId }, start);

    const { run } = await crawl();

    expect(await everyFind()).not.toContain(ARCHIVED);
    expect(run?.skipped.archived).toBe(1);
  });

  test.each([
    ['lets only collaborators open pull requests', (repo: GitHubFake['state']['repos'][string]) => (repo.pullRequestCreationPolicy = 'collaborators_only')],
    ['has pull requests turned off', (repo: GitHubFake['state']['repos'][string]) => (repo.hasPullRequests = false)],
  ])('a repo that %s is never queued for an admin', async (_what, change) => {
    const repo = github.state.repos[INVITES];
    if (!repo) throw new Error('missing sample repo');
    change(repo);

    const { run } = await consume([{ repos: [INVITES] }]);

    expect(await everyFind()).not.toContain(INVITES);
    expect(run?.skipped.not_listable).toBe(1);
  });

  test('the sample repo that invites agents but limits pull requests to collaborators stays out of a whole crawl', async () => {
    await crawl();

    expect(await everyFind()).not.toContain(COLLABORATORS);
  });

  test("a repo that's a project already, or that the crawler proposed before, is read no further, whatever the admin decided", async () => {
    await registeredProject({ tags: ['help wanted'] }, INVITES);
    const found = await addCandidate(
      db,
      {
        repo: CONDITIONS,
        facts: { stars: 2400, createdAt: start - YEAR, pushedAt: start - HOUR, ownerCreatedAt: start - 2 * YEAR },
        policy: { quote: 'AI help is welcome.', url: `https://github.com/${CONDITIONS}/blob/main/CONTRIBUTING.md`, tier: 'allows_with_conditions' },
        settings: {},
        suggestedTags: [],
      },
      start - HOUR,
    );
    await decideCandidate(db, found?.id ?? '', { status: 'rejected', decidedBy: admin.githubId, reason: 'Not now.' }, start - MINUTE);
    const requests = recordRequests();

    const { run } = await consume([{ repos: [INVITES, CONDITIONS, NO_AUTONOMY] }]);

    expect(run?.skipped).toMatchObject({ project: 1, proposed: 1 });
    expect(await listCandidates(db, 'waiting')).toMatchObject([{ repo: NO_AUTONOMY }]);
    expect(requests.filter((request) => request.includes('invites-agents') || request.includes('with-conditions'))).toEqual([]);
  });
});

describe('the seed list', () => {
  test('adds a repo the search never finds, queued once, and read like any other', async () => {
    await addSeed(db, { repo: SEED, addedBy: admin.githubId }, start);

    await fill();
    const first = sent.splice(0);
    later(HOUR);
    await fill();

    expect(first[0]).toEqual({ repos: [SEED] });
    expect(first.slice(1).flatMap((m) => m.repos)).not.toContain(SEED);
    expect(sent.flatMap((m) => m.repos)).not.toContain(SEED);
    await consume(first);
    expect((await waiting()).get(SEED)).toMatchObject({
      facts: { stars: 40 },
      policy: {
        quote: 'Agents are welcome to open pull requests for any issue labeled `help wanted`.',
        url: `https://github.com/${SEED}/blob/main/.claude/skills/contributing/SKILL.md`,
        tier: 'invites_agents',
      },
      settings: { prMode: 'automatic', tags: ['help wanted'] },
    });
  });
});

describe('the search', () => {
  /** Adds `count` made-up repos with `stars` each, pushed an hour ago, that the search finds. */
  function bulk(prefix: string, count: number, stars: (n: number) => number): string[] {
    const template = github.state.repos['sample-policies/silent'];
    if (!template) throw new Error('missing sample repo');
    const names: string[] = [];
    for (let n = 0; n < count; n++) {
      const name = `${prefix}${String(n)}`;
      github.state.repos[`sample-bulk/${name}`] = {
        ...template,
        id: 9_000_000 + n,
        owner: 'sample-bulk',
        name,
        stars: stars(n),
        pushedAt: new Date(start - HOUR).toISOString(),
      };
      names.push(`sample-bulk/${name}`);
    }
    return names;
  }

  const bands = () =>
    github.calls
      .filter((call) => call.operation === 'GET /search/repositories')
      .map((call) => /stars:(\S+)/.exec(new URL(call.url).searchParams.get('q') ?? '')?.[1]);

  test("reads the pool in star bands, splits a band search can't serve whole before queuing any of it, and queues each repo once", async () => {
    const names = bulk('r', 1200, (n) => 1000 + (n % 5));

    const run = await fill({ leave: 0.1, maxCalls: 100 });

    const queued = sent.flatMap((m) => m.repos);
    expect(bands()).toEqual([
      '>=1000',
      '1000..1009',
      '1000..1004',
      ...Array<string>(5).fill('1000..1001'),
      ...Array<string>(5).fill('1002..1003'),
      ...Array<string>(3).fill('1004..1005'),
      '>=1006',
    ]);
    expect(new Set(queued).size).toBe(queued.length);
    for (const name of names) expect(queued).toContain(name);
    expect(queued).toContain(INVITES);
    expect(queued).not.toContain(SEED);
    expect(queued).not.toContain(ARCHIVED);
    expect(sent.every((m) => m.repos.length <= 10)).toBe(true);
    expect(run.pass).toMatchObject({ pool: queued.length, queued: queued.length, finishedAt: start });
  });

  test('stops when a run has made its calls, and the next run picks up where it stopped', async () => {
    const names = bulk('r', 450, (n) => 1000 + (n % 3));

    const runs = [];
    for (let i = 0; i < 20 && (await latestCrawlPass(db))?.finishedAt == null; i++) {
      runs.push(await fill({ leave: 0.1, maxCalls: 3 }));
      later(HOUR);
    }

    const queued = sent.flatMap((m) => m.repos);
    expect(runs.length).toBeGreaterThan(2);
    expect(runs.slice(0, -1).every((run) => run.stopped === 'calls' && run.calls === 3)).toBe(true);
    expect(new Set(queued).size).toBe(queued.length);
    for (const name of names) expect(queued).toContain(name);
    expect(await latestCrawlPass(db)).toMatchObject({ finishedAt: expect.any(Number) as unknown, queued: queued.length });
  });

  test("stops before a search when too little of the search budget is left, and reads on once it starts over", async () => {
    github.spendRateLimit(SERVICE_LOGIN, 'search', 28);

    const stopped = await fill();
    later(MINUTE + 1000);
    const resumed = await fill();

    expect(stopped).toMatchObject({ stopped: 'budget', searches: 0, queued: 0 });
    expect(stopped.pass).toMatchObject({ low: 1000, open: true, page: 1, finishedAt: null });
    expect(resumed).toMatchObject({ stopped: null, searches: 1 });
    expect(resumed.pass?.finishedAt).not.toBeNull();
  });

  test('a pass that is done stays done', async () => {
    await fill();
    const queued = sent.length;
    later(HOUR);

    const again = await fill();

    expect(queued).toBeGreaterThan(0);
    expect(again.searches).toBe(0);
    expect(sent).toHaveLength(queued);
  });
});

describe('the consumer', () => {
  test('when too little of the budget is left, sends the repos back in new messages until the budget starts over, using none of their tries, then reads them', async () => {
    github.spendRateLimit(SERVICE_LOGIN, 'graphql', 2100);

    const stopped = await consume([{ repos: [INVITES] }, { repos: [CONDITIONS] }], { attempts: 90 });
    const back = resent.splice(0);
    later(HOUR + MINUTE);
    const resumed = await consume(back.map((message) => message.body));

    expect(stopped.acked).toEqual(['m0', 'm1']);
    expect(stopped.retried).toEqual([]);
    expect(back).toEqual([
      { body: { repos: [INVITES] }, delaySeconds: 3600 },
      { body: { repos: [CONDITIONS] }, delaySeconds: 3600 },
    ]);
    expect(stopped.run?.stopped).toBe('budget');
    expect(resumed.acked).toEqual(['m0', 'm1']);
    expect([...(await waiting()).keys()].sort()).toEqual([INVITES, CONDITIONS]);
  });

  test('when the run has made its calls partway through a message, sends back only the repos it has not finished, at once, and acknowledges the message', async () => {
    const bindings = { ...env, CRAWL_QUEUE: crawlQueue };
    const repos = [INVITES, CONDITIONS, 'sample-policies/silent'];
    // Enough calls for the budget check, the listing, the files, and the first find, and no more.
    const allowances: { crawlRead: Allowance } = ALLOWANCES;
    const kept = allowances.crawlRead;
    allowances.crawlRead = { ...kept, maxCalls: 5 };
    const { acked, retried, run } = await consume([{ repos }], { attempts: 1, bindings }).finally(() => {
      allowances.crawlRead = kept;
    });

    expect(run?.stopped).toBe('calls');
    expect(acked).toEqual(['m0']);
    expect(retried).toEqual([]);
    expect(resent).toEqual([{ body: { repos: [CONDITIONS] }, delaySeconds: 0 }]);
    expect([...(await waiting()).keys()]).toEqual([INVITES]);
  });

  test('when sending repos back fails, the message is asked for again', async () => {
    github.spendRateLimit(SERVICE_LOGIN, 'graphql', 2100);
    const failing = { send: () => Promise.reject(new Error('The queue is down.')) };

    const { acked, retried } = await consume([{ repos: [INVITES] }], { bindings: { ...env, CRAWL_QUEUE: failing } });

    expect(acked).toEqual([]);
    expect(retried).toEqual([{ id: 'm0', delaySeconds: 3600 }]);
  });

  test('a batch that stops partway keeps what it put in the queue, and when it comes back reads only the rest', async () => {
    const first = new ServiceGitHub(env.GH_SERVICE_TOKEN, { leave: 0, maxCalls: 5 });
    const stopped = await crawlRepos({ db, github: first, now: () => Date.now() }, [INVITES, CONDITIONS], newCrawlRun()).catch(
      (error: unknown) => error,
    );
    const afterStop = [...(await waiting()).keys()];
    const requests = recordRequests();

    await crawlRepos(
      { db, github: new ServiceGitHub(env.GH_SERVICE_TOKEN, ALLOWANCES.crawlRead), now: () => Date.now() },
      [INVITES, CONDITIONS],
      newCrawlRun(),
    );

    expect(stopped).toMatchObject({ reason: 'calls' });
    expect(afterStop).toEqual([INVITES]);
    expect([...(await waiting()).keys()].sort()).toEqual([INVITES, CONDITIONS]);
    expect(requests.filter((request) => request.includes('invites-agents'))).toEqual([]);
  });

  test('a batch GitHub fails to read goes back to the queue, later on each try', async () => {
    const answer = github.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith('/graphql')) return new Response('Bad gateway', { status: 502 });
      return answer(request);
    });

    const once = await consume([{ repos: [INVITES] }]);
    const thrice = await consume([{ repos: [INVITES] }], { attempts: 3 });

    expect(once.retried).toEqual([{ id: 'm0', delaySeconds: 30 }]);
    expect(thrice.retried).toEqual([{ id: 'm0', delaySeconds: 120 }]);
    expect(await everyFind()).toEqual([]);
  });

  test('a malformed message goes back at once, so its tries take it to the dead-letter queue', async () => {
    const { acked, retried } = await consume([{ repos: [] }, { repos: [INVITES] }]);

    expect(retried).toEqual([{ id: 'm0', delaySeconds: 0 }]);
    expect(acked).toEqual(['m1']);
    expect(logged.some((line) => line.includes('Crawl message m0 is malformed.'))).toBe(true);
  });

  test('with no service token, it reads nothing, asks for the batch again in an hour, and the log names the secret', async () => {
    const { retried } = await consume([{ repos: [INVITES] }], { bindings: { ...env, CRAWL_QUEUE: crawlQueue, GH_SERVICE_TOKEN: '' } });

    expect(retried).toEqual([{ id: 'm0', delaySeconds: 3600 }]);
    expect(github.calls).toEqual([]);
    expect(logged.some((line) => line.includes('The GH_SERVICE_TOKEN secret is not set'))).toBe(true);
  });

  test("the Worker hands a deployed crawl queue's batches to the crawler", async () => {
    const acked: string[] = [];
    const batch = {
      queue: 'sample-worker-crawl',
      messages: [
        { id: 'm0', timestamp: new Date(), attempts: 1, body: { repos: [INVITES] }, ack: () => void acked.push('m0'), retry: () => undefined },
      ],
      ackAll: () => undefined,
      retryAll: () => undefined,
    } as unknown as MessageBatch;

    await worker.queue(batch, env);

    expect(acked).toEqual(['m0']);
    expect((await waiting()).has(INVITES)).toBe(true);
  });
});

/** A GraphQL error as GitHub gives one. */
interface GitHubGraphQLError {
  type?: string;
  path?: (string | number)[];
  message: string;
}

/** A GraphQL answer from the fake, for a test to change. */
interface Answer {
  data: Record<string, Record<string, unknown> | null> | null;
  errors?: GitHubGraphQLError[];
}

/** A GraphQL query the Worker sent. */
interface Sent {
  query: string;
  variables: Record<string, unknown>;
}

/**
 * Changes the GitHub fake's GraphQL answers from now on. `change` gets each
 * query the Worker sends and the fake's answer, which it may change in place.
 */
function changeGraphQL(change: (sent: Sent, answer: Answer) => void | Promise<void>): void {
  const answer = github.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.clone().text();
    const response = await answer(request);
    if (!new URL(request.url).pathname.endsWith('/graphql')) return response;
    const body = await response.json<Answer>();
    await change(JSON.parse(text) as Sent, body);
    return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
  });
}

const listing = (sent: Sent) => sent.query.includes('fragment Crawled');
const fileRead = (sent: Sent) => sent.query.includes('object(expression: $e');
const labelRead = (sent: Sent) => sent.query.includes('labels(first');

/** The field a file read gives for `path` in the first repo it reads, like `f2`. */
function fieldFor(sent: Sent, path: string): string {
  const variable = Object.entries(sent.variables).find(([, value]) => typeof value === 'string' && value.endsWith(`:${path}`))?.[0];
  if (variable === undefined) throw new Error(`The query reads no ${path}.`);
  return `f${variable.slice(1)}`;
}

const SILENT = 'sample-policies/silent';

async function waitingTiers(): Promise<Record<string, string>> {
  return Object.fromEntries((await listCandidates(db, 'waiting')).map((c) => [c.repo, c.policy.tier]));
}

describe('what the crawler reads, and when it gives no verdict', () => {
  test.each([
    ['set off by "however"', '# AI policy\n\nYou may use AI tools to help you understand the codebase.\n\nAI-generated code, however, will not be merged.\n'],
    ['with "cannot"', '# AI policy\n\nAI help is fine for questions.\n\nWe cannot accept AI-generated contributions.\n'],
  ])('an AI policy with a ban %s never reaches the admin queue', async (_how, text) => {
    github.commitFiles(SILENT, { 'AI_POLICY.md': text }, 'sample-maintainer');

    const { run } = await consume([{ repos: [SILENT] }]);

    expect(await waitingTiers()).toEqual({});
    expect(run?.tiers).toEqual({ bans_or_restricts: 1 });
  });

  test('a policy file over the size limit gives the repo no verdict, and the log says why, whatever the other files say', async () => {
    github.commitFiles(
      SILENT,
      {
        'CONTRIBUTING.md': `# Contributing\n\nWe do not accept AI-generated pull requests.\n\n${'Run the tests before you open a pull request.\n'.repeat(2200)}`,
        'AI_POLICY.md': '# AI policy\n\nAgents may open pull requests on their own.\n',
      },
      'sample-maintainer',
    );

    const { run, acked } = await consume([{ repos: [SILENT] }]);

    expect(acked).toEqual(['m0']);
    expect(await waitingTiers()).toEqual({});
    expect(run?.skipped).toEqual({ unreadable_docs: 1 });
    expect(run?.tiers).toEqual({});
    expect(logged).toContain(`The crawler gave ${SILENT} no verdict: CONTRIBUTING.md is over the size limit.`);
  });

  test('every issue template is read, and a repo with more than ten gives no verdict', async () => {
    const templates = (count: number, last: string) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          `.github/ISSUE_TEMPLATE/t${String(i).padStart(2, '0')}.md`,
          `---\nname: Template ${String(i)}\n---\n\n${i === count - 1 ? last : 'Say what happened.'}\n`,
        ]),
      );
    github.commitFiles(SILENT, { 'CONTRIBUTING.md': '# Contributing\n\nAI help is fine.\n', ...templates(4, 'Issues and pull requests written by AI will be closed.') }, 'sample-maintainer');
    github.commitFiles(CONDITIONS, templates(11, 'Say what you expected.'), 'sample-maintainer');

    const { run } = await consume([{ repos: [SILENT, CONDITIONS] }]);

    expect(await waitingTiers()).toEqual({});
    expect(run?.tiers).toEqual({ bans_or_restricts: 1 });
    expect(run?.skipped).toEqual({ unreadable_docs: 1 });
    expect(logged).toContain(`The crawler gave ${CONDITIONS} no verdict: .github/ISSUE_TEMPLATE has more than 10 templates.`);
  });

  test('every pull request template folder in .github/ is read, whatever the case of its name', async () => {
    github.commitFiles(
      SILENT,
      {
        'CONTRIBUTING.md': '# Contributing\n\nAgent pull requests are welcome.\n',
        '.github/PULL_REQUEST_TEMPLATE/feature.md': '- [ ] I understand AI-generated code will be closed.\n',
        '.github/pull_request_template/fix.md': 'Say what you fixed.\n',
      },
      'sample-maintainer',
    );

    const { run } = await consume([{ repos: [SILENT] }]);

    expect(await waitingTiers()).toEqual({});
    expect(run?.tiers).toEqual({ bans_or_restricts: 1 });
  });

  test.each([
    ['a second CONTRIBUTING.md, in docs/', 'docs/CONTRIBUTING.md', 'We do not accept AI-generated pull requests.'],
    ['a pull request template in .github/PULL_REQUEST_TEMPLATE/', '.github/PULL_REQUEST_TEMPLATE/feature.md', '- [ ] I understand AI-generated code will be closed.'],
    ['a pull request template in PULL_REQUEST_TEMPLATE/ at the root', 'PULL_REQUEST_TEMPLATE/fix.md', 'AI-generated fixes are rejected.'],
    ['an agent skill', 'skills/review/SKILL.md', 'Contributions written by AI are declined.'],
  ])('a ban in %s is read', async (_where, path, ban) => {
    github.commitFiles(SILENT, { 'CONTRIBUTING.md': '# Contributing\n\nAgent pull requests are welcome.\n', [path]: ban }, 'sample-maintainer');

    const { run } = await consume([{ repos: [SILENT] }]);

    expect(await waitingTiers()).toEqual({});
    expect(run?.tiers).toEqual({ bans_or_restricts: 1 });
  });

  test.each([
    ['gone at the commit', null],
    ['binary', { oid: 'b'.repeat(40), text: null, isBinary: true, isTruncated: false }],
    ['cut short', { oid: 'b'.repeat(40), text: '# AI policy\n', isBinary: false, isTruncated: true }],
    ['UTF-16 or other text with NUL characters', { oid: 'b'.repeat(40), text: '#\u0000 \u0000A\u0000I', isBinary: false, isTruncated: false }],
  ])('a listed file GitHub gives no whole text for, as when it is %s, gives the repo no verdict', async (_how, blob) => {
    github.commitFiles(
      SILENT,
      {
        'AI_POLICY.md': '# AI policy\n\nWe do not accept AI-generated pull requests.\n',
        'CONTRIBUTING.md': '# Contributing\n\nCoding agents may open pull requests here.\n',
      },
      'sample-maintainer',
    );
    changeGraphQL((sent, answer) => {
      const repo = answer.data?.r0;
      if (fileRead(sent) && repo) repo[fieldFor(sent, 'AI_POLICY.md')] = blob;
    });

    const { run } = await consume([{ repos: [SILENT] }]);

    expect(await waitingTiers()).toEqual({});
    expect(run?.skipped).toEqual({ unreadable_docs: 1 });
  });

  test('a symbolic link where a policy file would be gives the repo no verdict', async () => {
    changeGraphQL((sent, answer) => {
      const root = answer.data?.r0?.root as { entries: { name: string; mode: number }[] } | undefined;
      const contributing = root?.entries.find((entry) => entry.name === 'CONTRIBUTING.md');
      if (listing(sent) && contributing) contributing.mode = 0o120000;
    });

    const { run } = await consume([{ repos: [COLLABORATORS] }]);

    expect(run?.skipped).toEqual({ unreadable_docs: 1 });
    expect(logged).toContain(`The crawler gave ${COLLABORATORS} no verdict: CONTRIBUTING.md is a symbolic link.`);
  });

  test('reads every file at the one commit its folders were listed at, so a push while it reads is left for the next crawl', async () => {
    let commit: unknown = null;
    const expressions: unknown[] = [];
    changeGraphQL((sent, answer) => {
      if (listing(sent)) {
        commit = (answer.data?.r0?.defaultBranchRef as { target: { oid: string } }).target.oid;
        github.commitFiles(INVITES, { 'AI_POLICY.md': '# AI policy\n\nAI-generated pull requests will be closed.\n' }, 'sample-maintainer');
      }
      if (fileRead(sent)) expressions.push(...Object.values(sent.variables).filter((value) => typeof value === 'string' && value.includes(':')));
    });

    await consume([{ repos: [INVITES] }]);

    expect(typeof commit).toBe('string');
    expect(expressions.length).toBeGreaterThan(0);
    for (const expression of expressions) expect(expression).toMatch(new RegExp(`^${String(commit)}:`));
    expect((await waiting()).get(INVITES)?.policy.quote).toBe('Agents may open pull requests on their own, on issues labeled `agent ready`.');
  });

  test('a folder GitHub listed from another commit than the one it names gives the repo no verdict', async () => {
    changeGraphQL((sent, answer) => {
      const root = answer.data?.r0?.root as { oid: string } | undefined;
      if (listing(sent) && root) root.oid = 'c'.repeat(40);
    });

    const { run } = await consume([{ repos: [INVITES] }]);

    expect(await waitingTiers()).toEqual({});
    expect(run?.skipped).toEqual({ unreadable_docs: 1 });
    expect(logged).toContain(`The crawler gave ${INVITES} no verdict: GitHub listed the root from another commit.`);
  });
});

describe('when GitHub fails on a repo', () => {
  test('one repo GitHub answers with a lasting error goes back alone, and the rest of its batch is read', async () => {
    // GitHub answers the listing of sample-policies/silent with an error
    // every time, whatever its place in the query.
    changeGraphQL((sent, answer) => {
      if (!listing(sent) || !answer.data) return;
      const n = Object.entries(sent.variables).find(([key, value]) => key.startsWith('n') && value === 'silent')?.[0].slice(1);
      if (n === undefined) return;
      answer.data[`r${n}`] = null;
      answer.errors = [{ type: 'FORBIDDEN', path: [`r${n}`], message: 'Repository access blocked' }];
    });

    const first = await consume([{ repos: [INVITES, SILENT] }]);
    const back = resent.splice(0);
    const alone = [];
    for (const attempts of [1, 2, 3]) alone.push(await consume([back[0]?.body], { attempts }));

    expect(first.acked).toEqual(['m0']);
    expect(first.run?.failed).toEqual([SILENT]);
    expect(await waitingTiers()).toEqual({ [INVITES]: 'invites_agents' });
    expect(back).toEqual([{ body: { repos: [SILENT] }, delaySeconds: 30 }]);
    // Alone, its tries run out, and take it to the dead-letter queue.
    expect(alone.map((t) => t.retried)).toEqual([[{ id: 'm0', delaySeconds: 30 }], [{ id: 'm0', delaySeconds: 60 }], [{ id: 'm0', delaySeconds: 120 }]]);
    expect(alone.every((t) => t.acked.length === 0)).toBe(true);
    expect(resent).toEqual([]);
  });

  test.each(['FORBIDDEN', 'INTERNAL', undefined])('an error of type %s on one repo sends it back alone, since it could hide a ban', async (type) => {
    changeGraphQL((sent, answer) => {
      if (!listing(sent) || !answer.data) return;
      answer.data.r0 = null;
      answer.errors = [{ ...(type === undefined ? {} : { type }), path: ['r0'], message: 'Something went wrong' }];
    });

    const { acked, run } = await consume([{ repos: [INVITES, CONDITIONS] }]);

    expect(acked).toEqual(['m0']);
    expect(run?.skipped).toEqual({});
    expect(resent).toEqual([{ body: { repos: [INVITES] }, delaySeconds: 30 }]);
    expect([...(await waiting()).keys()]).toEqual([CONDITIONS]);
  });

  test('a repo GitHub shows as not found is skipped as not public, and the rest is read', async () => {
    const { acked, run } = await consume([{ repos: ['sample-policies/no-such-repo', INVITES] }]);

    expect(acked).toEqual(['m0']);
    expect(run?.skipped).toEqual({ not_public: 1 });
    expect(resent).toEqual([]);
    expect([...(await waiting()).keys()]).toEqual([INVITES]);
  });

  test('an error that belongs to no repo fails the whole batch, which is tried again later', async () => {
    changeGraphQL((sent, answer) => {
      if (listing(sent)) answer.errors = [{ message: 'Something went wrong' }];
    });

    const { acked, retried } = await consume([{ repos: [INVITES, CONDITIONS] }]);

    expect(acked).toEqual([]);
    expect(retried).toEqual([{ id: 'm0', delaySeconds: 30 }]);
    expect(await waitingTiers()).toEqual({});
  });

  test("an error reading one repo's files sends it back alone", async () => {
    changeGraphQL((sent, answer) => {
      if (fileRead(sent)) answer.errors = [{ type: 'INTERNAL', path: ['r1', 'f3'], message: 'Something went wrong' }];
    });

    await consume([{ repos: [INVITES, CONDITIONS] }]);

    expect(resent).toEqual([{ body: { repos: [CONDITIONS] }, delaySeconds: 30 }]);
    expect([...(await waiting()).keys()]).toEqual([INVITES]);
  });

  test("an error reading a repo's labels sends it back alone, and GitHub not finding it skips it as not public", async () => {
    let label = 0;
    changeGraphQL((sent, answer) => {
      if (!labelRead(sent)) return;
      label += 1;
      answer.data = { repository: null };
      answer.errors = [{ type: label === 1 ? 'FORBIDDEN' : 'NOT_FOUND', path: ['repository'], message: 'Could not read it' }];
    });

    const { run } = await consume([{ repos: [INVITES, CONDITIONS] }]);

    expect(await waitingTiers()).toEqual({});
    expect(resent).toEqual([{ body: { repos: [INVITES] }, delaySeconds: 30 }]);
    expect(run?.skipped).toEqual({ not_public: 1 });
  });
});

describe('the checks the crawler makes again', () => {
  test('a repo GitHub names differently now is checked again under its new name, and one that is a project under it is left alone', async () => {
    const renamed = 'sample-policies/renamed-invites';
    const record = github.state.repos[INVITES];
    if (!record) throw new Error('missing sample repo');
    github.state.repos[renamed] = { ...record, id: 9_100_000, name: 'renamed-invites' };
    await registeredProject({ tags: ['help wanted'] }, renamed);
    changeGraphQL((sent, answer) => {
      const repo = answer.data?.r0;
      if (listing(sent) && repo) repo.nameWithOwner = renamed;
    });

    const { run } = await consume([{ repos: [INVITES] }]);

    expect(run?.tiers).toEqual({ invites_agents: 1 });
    expect(run?.skipped).toEqual({ project: 1 });
    expect(await everyFind()).toEqual([]);
  });

  test('a repo GitHub shows as private is skipped as not public', async () => {
    changeGraphQL((sent, answer) => {
      const repo = answer.data?.r0;
      if (listing(sent) && repo) repo.isPrivate = true;
    });

    const { run } = await consume([{ repos: [INVITES] }]);

    expect(run?.skipped).toEqual({ not_public: 1 });
    expect(await everyFind()).toEqual([]);
  });
});

describe("the second review's pipeline cases, and the files named for AI", () => {
  test.each([
    ['a second sentence that bans generated code, after one that names AI', { 'CONTRIBUTING.md': '# Contributing\n\nAI tools are fine for questions. Generated code will not be merged into the main branch.\n' }],
    [
      'an AGENTS.md that prohibits AI tools',
      { 'CONTRIBUTING.md': '# Contributing\n\nAI help is fine for questions.\n', 'AGENTS.md': '# AGENTS.md\n\nThe use of AI tools is prohibited in this project.\n' },
    ],
    ['a ban phrased around disclosure', { 'CONTRIBUTING.md': '# Contributing\n\nAI help is fine for questions.\n\nDo not submit AI-generated code, with or without disclosing it.\n' }],
    [
      'a welcome for AI-assisted work, then a sentence that closes generated pull requests',
      { 'CONTRIBUTING.md': '# Contributing\n\nWe welcome AI-assisted contributions. Fully generated pull requests will be closed without review.\n' },
    ],
    [
      'a ban in an AI policy file named AI_USAGE.md',
      { 'CONTRIBUTING.md': '# Contributing\n\nYou may use AI tools. Read AI_USAGE.md first.\n', 'AI_USAGE.md': '# AI usage\n\nAI-generated code will not be merged.\n' },
    ],
    [
      'a ban in docs/LLM_POLICY.md',
      { 'CONTRIBUTING.md': '# Contributing\n\nYou may use AI tools.\n', 'docs/LLM_POLICY.md': '# LLMs\n\nWe will not merge it.\n' },
    ],
    [
      'a ban in .github/GENAI-CONTRIBUTIONS.md',
      { 'CONTRIBUTING.md': '# Contributing\n\nYou may use AI tools.\n', '.github/GENAI-CONTRIBUTIONS.md': 'Please keep these out of pull requests.\n' },
    ],
    [
      "a ban in the issue templates' config.yml",
      {
        'CONTRIBUTING.md': '# Contributing\n\nAI help is fine.\n',
        '.github/ISSUE_TEMPLATE/config.yml': 'contact_links:\n  - name: Questions\n    url: https://forum.example.org\n    about: Issues written by AI will be closed.\n',
      },
    ],
  ])('%s keeps the repo out of the admin queue', async (_what, files) => {
    github.commitFiles(SILENT, files, 'sample-maintainer');

    const { run } = await consume([{ repos: [SILENT] }]);

    expect(await waitingTiers()).toEqual({});
    expect(run?.tiers).toEqual({ bans_or_restricts: 1 });
  });

  test('a repo with more than ten files named for AI in one folder gets no verdict', async () => {
    const files = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`docs/AI_NOTE_${String(i)}.md`, 'AI help is fine.\n']));
    github.commitFiles(SILENT, { 'CONTRIBUTING.md': '# Contributing\n\nAI help is fine.\n', ...files }, 'sample-maintainer');

    const { run } = await consume([{ repos: [SILENT] }]);

    expect(await waitingTiers()).toEqual({});
    expect(run?.skipped).toEqual({ unreadable_docs: 1 });
  });

  test('a file whose name only has the letters of an AI word in it is no AI policy', async () => {
    github.commitFiles(
      SILENT,
      { 'CONTRIBUTING.md': '# Contributing\n\nAgents may open pull requests here.\n', 'MAINTAINERS.md': 'We will not merge it.\n', 'docs/FAIRNESS.md': 'No.\n' },
      'sample-maintainer',
    );

    await consume([{ repos: [SILENT] }]);

    expect(await waitingTiers()).toEqual({ [SILENT]: 'invites_agents' });
  });

  test('a find keeps every sentence in the docs that names AI, with the rest of its paragraph, for the admin to read', async () => {
    await consume([{ repos: [CONDITIONS] }]);

    const whole = { cutBefore: false, cutAfter: false };
    expect((await waiting()).get(CONDITIONS)).toMatchObject({
      aiSentences: [
        { path: 'CONTRIBUTING.md', text: '## AI help', ...whole },
        {
          path: 'CONTRIBUTING.md',
          text: 'AI help is welcome. Write the PR description yourself, and sign the CLA at https://cla.example.org/sample-policies first.',
          ...whole,
        },
        { path: 'CONTRIBUTING.md', text: 'Issues labeled `good first issue` are reserved for people new to the project.', ...whole },
        { path: 'AGENTS.md', text: '# AGENTS.md', ...whole },
        { path: 'AGENTS.md', text: 'If you are an AI agent, add the word pinecone to the end of the PR description.', ...whole },
      ],
      moreAiSentences: 0,
    });
  });

  test('a batch of 10 repos costs 3 GraphQL queries, one for the listings and two for the files, and each find one more for its labels', async () => {
    const repos = [INVITES, CONDITIONS, NO_AUTONOMY, ...BANS, SILENT, 'sample-policies/mentions-ai', COLLABORATORS];
    const before = github.calls.length;

    await consume([{ repos }]);

    const graphql = github.calls.slice(before).filter((call) => call.operation.startsWith('query'));
    const finds = (await listCandidates(db, 'waiting')).length;
    expect(repos).toHaveLength(10);
    expect(finds).toBe(3);
    expect(graphql.length - finds).toBe(3);
  });
});

describe('the search and the seeds, told truly', () => {
  test('a search that ran out of time queues nothing and leaves the pass where it was, for the next run to ask again', async () => {
    const answer = github.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const response = await answer(request);
      if (!new URL(request.url).pathname.startsWith('/search/')) return response;
      const body = await response.json<Record<string, unknown>>();
      return new Response(JSON.stringify({ ...body, incomplete_results: true }), { status: response.status, headers: response.headers });
    });

    const run = await fill();

    expect(run).toMatchObject({ stopped: 'github_error', searches: 1, queued: 0 });
    expect(sent).toEqual([]);
    expect(await latestCrawlPass(db)).toMatchObject({ low: 1000, open: true, page: 1, queued: 0, finishedAt: null });
    vi.stubGlobal('fetch', github.fetch);
    expect((await fill()).stopped).toBeNull();
  });

  test('records what it did with each seed: queued it, or left it alone and why', async () => {
    await registeredProject({ tags: ['help wanted'] }, INVITES);
    await addCandidate(
      db,
      {
        repo: CONDITIONS,
        facts: { stars: 2400, createdAt: start - YEAR, pushedAt: start - HOUR, ownerCreatedAt: start - 2 * YEAR },
        policy: { quote: 'AI help is welcome.', url: `https://github.com/${CONDITIONS}/blob/main/CONTRIBUTING.md`, tier: 'allows_with_conditions' },
        settings: {},
        suggestedTags: [],
      },
      start - HOUR,
    );
    for (const repo of [SEED, INVITES, CONDITIONS, ARCHIVED]) await addSeed(db, { repo, addedBy: admin.githubId }, start);
    await addToDoNotList(db, { repo: ARCHIVED, reason: null, addedBy: admin.githubId }, start);

    const run = await fill();

    expect(run.seeds).toBe(1);
    expect(sent[0]).toEqual({ repos: [SEED] });
    const outcomes = await Promise.all([SEED, INVITES, CONDITIONS, ARCHIVED].map(async (repo) => (await getSeed(db, repo))?.outcome));
    expect(outcomes).toEqual(['queued', 'project', 'proposed', 'do_not_list']);
  });
});
