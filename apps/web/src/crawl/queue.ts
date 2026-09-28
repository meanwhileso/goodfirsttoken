import { crawlMessageSchema, describeProblems, validate, type PolicyTier } from '@goodfirsttoken/core';
import { addCandidate, crawlerSkips, type CrawlerSkip } from '../db';
import { ServiceGitHub, SyncStopped, type StopReason } from '../sync/github';
import { ALLOWANCES, serviceToken } from '../sync/scheduled';
import { readFiles, readLabels, readRepos, whyNotListable, type FoundRepo } from './reads';
import { readPolicy, suggestSettings, type CrawlTier, type PolicyFile, type PolicyReading } from './rules';

// The crawl queue's consumer (spec section 5). Each message holds a batch of
// repos, from the crawler's search or its seed list (src/crawl/search.ts).
// It reads each repo's docs from GitHub with the read-only service token,
// sorts it with the rules in src/crawl/rules.ts, and puts the repos whose
// docs welcome AI help in the admin queue as crawl candidates. It writes
// nothing else: an admin lists a project. When the budget runs low, a
// message goes back to the queue until the budget starts over, and the
// repos it put in the admin queue already are left alone when it comes
// back. The rules are in docs/how-it-works.md, under The policy crawler.

/** Why the crawler read a repo no further. */
export type Skip =
  | CrawlerSkip
  /** GitHub shows it archived. */
  | 'archived'
  /** GitHub shows no public repo by that name. */
  | 'not_public'
  /** It has pull requests turned off, lets only collaborators open them, or GitHub didn't say. */
  | 'not_listable'
  /** GitHub described it in a form the crawler can't use. */
  | 'unreadable';

/** What one batch did, for its log line. */
export interface CrawlRun {
  messages: number;
  repos: number;
  skipped: Partial<Record<Skip, number>>;
  tiers: Partial<Record<CrawlTier, number>>;
  proposed: string[];
  calls: number;
  stopped: StopReason | null;
}

export interface CrawlDeps {
  db: D1Database;
  github: ServiceGitHub;
  now: () => number;
}

export function newCrawlRun(): CrawlRun {
  return { messages: 0, repos: 0, skipped: {}, tiers: {}, proposed: [], calls: 0, stopped: null };
}

/** How long a message waits before its first retry after a failure. Each later wait is twice as long. */
const RETRY_FIRST_SECONDS = 30;
/** The longest wait between two tries of a message. */
const RETRY_MAX_SECONDS = 60 * 60;
/** The wait for the budget to start over when GitHub didn't say when it does. */
const BUDGET_WAIT_SECONDS = 15 * 60;

function backoff(attempts: number): number {
  return Math.min(RETRY_FIRST_SECONDS * 2 ** Math.min(Math.max(attempts, 1) - 1, 20), RETRY_MAX_SECONDS);
}

/** How long a message waits after the run stopped: until the budget starts over, when that stopped it. */
function waitAfter(stop: SyncStopped, attempts: number, now: number): number {
  switch (stop.reason) {
    case 'budget':
    case 'rate_limited':
      if (stop.resetAt === null) return BUDGET_WAIT_SECONDS;
      return Math.min(Math.max(Math.ceil((stop.resetAt - now) / 1000), 60), RETRY_MAX_SECONDS);
    case 'calls':
      return 0;
    default:
      return backoff(attempts);
  }
}

/** The file on github.com, on the repo's default branch. */
function fileUrl(repo: string, branch: string, path: string): string {
  const encoded = (text: string) => text.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${repo}/blob/${encoded(branch)}/${encoded(path)}`;
}

function listed(tier: CrawlTier): tier is PolicyTier {
  return tier === 'invites_agents' || tier === 'allows_with_conditions';
}

/**
 * Reads the repos of one message, and puts the ones whose docs welcome AI
 * help in the admin queue. Throws SyncStopped when the run has to stop,
 * after writing the finds it made.
 */
export async function crawlRepos(deps: CrawlDeps, repos: readonly string[], run: CrawlRun): Promise<void> {
  const { db, github } = deps;
  const skip = (why: Skip) => {
    run.skipped[why] = (run.skipped[why] ?? 0) + 1;
  };
  run.repos += repos.length;

  // A repo on the do-not-list, a project, or one proposed before is read no further.
  const known = await crawlerSkips(db, repos);
  const toRead = repos.filter((repo) => {
    const why = known.get(repo.toLowerCase());
    if (why !== undefined) skip(why);
    return why === undefined;
  });
  if (toRead.length === 0) return;

  const readable: FoundRepo[] = [];
  for (const found of await readRepos(github, toRead)) {
    if (found === null || found.private) skip('not_public');
    else if (found.archived) skip('archived');
    else if (found.standing === null) skip('unreadable');
    else readable.push(found);
  }

  const files = await readFiles(github, readable);
  const welcoming: { repo: FoundRepo; reading: PolicyReading; files: PolicyFile[] }[] = [];
  for (const repo of readable) {
    const read = files.get(repo) ?? [];
    const reading = readPolicy(read);
    run.tiers[reading.tier] = (run.tiers[reading.tier] ?? 0) + 1;
    if (listed(reading.tier) && reading.welcome !== null) welcoming.push({ repo, reading, files: read });
  }
  if (welcoming.length === 0) return;

  // Checked again under the names GitHub gives now, which differ after a
  // rename, and for anything that changed while the files were read.
  const now = await crawlerSkips(
    db,
    welcoming.map(({ repo }) => repo.name),
  );
  for (const { repo, reading, files: read } of welcoming) {
    const why = now.get(repo.name.toLowerCase());
    if (why !== undefined) {
      skip(why);
      continue;
    }
    if ((await whyNotListable(github, repo.name)) !== null) {
      skip('not_listable');
      continue;
    }
    const labels = await readLabels(github, repo.name);
    if (labels === null || repo.standing === null || repo.branch === null || reading.welcome === null || !listed(reading.tier)) {
      skip('not_public');
      continue;
    }
    const { settings, suggestedTags } = suggestSettings(reading, read, labels, repo.vouched);
    const policy = {
      quote: reading.welcome.quote,
      url: fileUrl(repo.name, repo.branch, reading.welcome.file.path),
      tier: reading.tier,
    };
    let candidate;
    try {
      candidate = await addCandidate(db, { repo: repo.name, facts: repo.standing, policy, settings, suggestedTags }, deps.now());
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      console.error(`The crawler couldn't put ${repo.name} in the admin queue.`, error);
      skip('unreadable');
      continue;
    }
    // A find that didn't land met the do-not-list, or another find for the repo, at the same moment.
    if (candidate === null) skip((await crawlerSkips(db, [repo.name])).get(repo.name.toLowerCase()) ?? 'proposed');
    else run.proposed.push(candidate.repo);
  }
}

/** Whether a batch comes from the crawl queue: `crawl` locally, and `<WORKER_NAME>-crawl` deployed. */
export function isCrawlQueue(name: string): boolean {
  return name === 'crawl' || name.endsWith('-crawl');
}

/**
 * Reads a batch from the crawl queue. It first asks GitHub what is left of
 * the budget. A message whose repos were all read is acknowledged. When the
 * run has to stop, the message it was on, and every one after it, goes back
 * to the queue until the budget starts over, or later each time when GitHub
 * failed. A malformed message goes back at once, so its tries take it to the
 * dead-letter queue, where it can be read.
 */
export async function readCrawlBatch(
  batch: MessageBatch,
  env: Pick<Env, 'DB'> & Partial<Pick<Env, 'GH_SERVICE_TOKEN'>>,
  now: () => number = Date.now,
): Promise<CrawlRun | null> {
  const token = serviceToken(env);
  if (token === null) {
    console.error('The crawler read nothing. The GH_SERVICE_TOKEN secret is not set. docs/self-hosting.md lists the Worker\'s secrets.');
    for (const message of batch.messages) message.retry({ delaySeconds: RETRY_MAX_SECONDS });
    return null;
  }
  const github = new ServiceGitHub(token, ALLOWANCES.crawlRead, now);
  const run = newCrawlRun();
  let stop: SyncStopped | null = null;
  try {
    await github.checkGitHub();
  } catch (error) {
    if (!(error instanceof SyncStopped)) throw error;
    stop = error;
  }
  for (const message of batch.messages) {
    if (stop !== null) {
      message.retry({ delaySeconds: waitAfter(stop, message.attempts, now()) });
      continue;
    }
    const checked = validate(crawlMessageSchema, message.body, 'message');
    if (!checked.ok) {
      console.error(`Crawl message ${message.id} is malformed.\n${describeProblems(checked.problems)}`);
      message.retry({ delaySeconds: 0 });
      continue;
    }
    try {
      await crawlRepos({ db: env.DB, github, now }, checked.value.repos, run);
      run.messages += 1;
      message.ack();
    } catch (error) {
      if (error instanceof SyncStopped) {
        stop = error;
        message.retry({ delaySeconds: waitAfter(error, message.attempts, now()) });
        continue;
      }
      console.error(`The crawler didn't finish crawl message ${message.id}. It will be tried again.`, error);
      message.retry({ delaySeconds: backoff(message.attempts) });
    }
  }
  run.stopped = stop?.reason ?? null;
  run.calls = github.calls;
  if (stop !== null) console.warn(`The crawler stopped. ${stop.message}`);
  console.log(
    `The crawler read ${String(run.messages)} of ${String(batch.messages.length)} messages, with repos: ${String(run.repos)}, skipped: ${JSON.stringify(run.skipped)}, tiers: ${JSON.stringify(run.tiers)}, put in the admin queue: ${run.proposed.length === 0 ? 'none' : run.proposed.join(', ')}, calls to GitHub: ${String(run.calls)}. Left: ${JSON.stringify(github.left())}.${run.stopped === null ? '' : ` Stopped: ${run.stopped}.`}`,
  );
  return run;
}
