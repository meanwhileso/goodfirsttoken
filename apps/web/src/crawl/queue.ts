import { crawlMessageSchema, describeProblems, validate, type CrawlMessage, type PolicyTier } from '@goodfirsttoken/core';
import { addCandidate, crawlerSkips, type CrawlerSkip } from '../db';
import { ServiceGitHub, SyncStopped, type StopReason } from '../sync/github';
import { ALLOWANCES, serviceToken } from '../sync/scheduled';
import { readFiles, readLabels, readRepos, RepoFailed, whyNotListable, type FoundRepo } from './reads';
import { readPolicy, suggestSettings, type CrawlTier, type PolicyFile, type PolicyReading } from './rules';

// The crawl queue's consumer (spec section 5). Each message holds a batch of
// repos, from the crawler's search or its seed list (src/crawl/search.ts).
// It reads each repo's docs from GitHub with the read-only service token,
// sorts it with the rules in src/crawl/rules.ts, and puts the repos whose
// docs welcome AI help in the admin queue as crawl candidates. It writes
// nothing else: an admin lists a project. When the budget runs low, the
// repos a message hasn't finished go back to the queue in a new message
// until the budget starts over, and the repos it put in the admin queue
// already are left alone when they come back. The rules are in
// docs/how-it-works.md, under The policy crawler.

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
  | 'unreadable'
  /**
   * A file that could hold its policy couldn't be read whole, like one over
   * the size limit, a symbolic link, or one GitHub gave no text for. It gets
   * no verdict.
   */
  | 'unreadable_docs';

/** What one batch did, for its log line. */
export interface CrawlRun {
  messages: number;
  repos: number;
  skipped: Partial<Record<Skip, number>>;
  tiers: Partial<Record<CrawlTier, number>>;
  proposed: string[];
  /** Repos GitHub answered with an error, sent back to the queue alone. */
  failed: string[];
  calls: number;
  stopped: StopReason | null;
}

export interface CrawlDeps {
  db: D1Database;
  github: ServiceGitHub;
  now: () => number;
}

/** Where one message's repos stand, by the names the message gave. It survives a stop. */
export interface CrawlProgress {
  /** Repos read to the end: put in the admin queue, sorted, or skipped. */
  done: Set<string>;
  /** Repos GitHub answered with an error, with the error. */
  failed: Map<string, string>;
}

export function newCrawlRun(): CrawlRun {
  return { messages: 0, repos: 0, skipped: {}, tiers: {}, proposed: [], failed: [], calls: 0, stopped: null };
}

export function newCrawlProgress(): CrawlProgress {
  return { done: new Set(), failed: new Map() };
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

/** How long repos wait after the run stopped: until the budget starts over, when that stopped it. */
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

/**
 * Whether a stop is the budget's, or the run's calls running out. The repos
 * wait for them in a new message, so the wait takes none of a message's
 * tries. Any other stop is a failure, and takes one.
 */
function waitsForBudget(stop: SyncStopped): boolean {
  return stop.reason === 'budget' || stop.reason === 'rate_limited' || stop.reason === 'calls';
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
 * help in the admin queue. `progress` says which repos it finished, and
 * which GitHub answered with an error. Throws SyncStopped when the run has
 * to stop, after writing the finds it made.
 */
export async function crawlRepos(
  deps: CrawlDeps,
  repos: readonly string[],
  run: CrawlRun,
  progress: CrawlProgress = newCrawlProgress(),
): Promise<void> {
  const { db, github } = deps;
  const skip = (asked: string, why: Skip) => {
    run.skipped[why] = (run.skipped[why] ?? 0) + 1;
    progress.done.add(asked);
  };
  const fail = (asked: string, why: string) => {
    progress.failed.set(asked, why);
    run.failed.push(asked);
    console.warn(`GitHub failed on ${asked}, so the crawler sends it back to the queue alone. ${why}`);
  };
  const noVerdict = (asked: string, why: string) => {
    skip(asked, 'unreadable_docs');
    console.warn(`The crawler gave ${asked} no verdict: ${why}.`);
  };
  run.repos += repos.length;

  // A repo on the do-not-list, a project, or one proposed before is read no further.
  const known = await crawlerSkips(db, repos);
  const toRead = repos.filter((repo) => {
    const why = known.get(repo.toLowerCase());
    if (why !== undefined) skip(repo, why);
    return why === undefined;
  });
  if (toRead.length === 0) return;

  const readable: FoundRepo[] = [];
  const listings = await readRepos(github, toRead);
  toRead.forEach((asked, i) => {
    const result = listings[i];
    if (result === undefined || 'gone' in result) skip(asked, 'not_public');
    else if ('failed' in result) fail(asked, result.failed);
    else if (result.found.private) skip(asked, 'not_public');
    else if (result.found.archived) skip(asked, 'archived');
    else if (result.found.standing === null) skip(asked, 'unreadable');
    else if (result.found.unreadable !== null) noVerdict(asked, result.found.unreadable);
    else readable.push(result.found);
  });

  const files = await readFiles(github, readable);
  const welcoming: { repo: FoundRepo; reading: PolicyReading; files: PolicyFile[] }[] = [];
  for (const repo of readable) {
    const result = files.get(repo) ?? { failed: `GitHub gave nothing for ${repo.name}.` };
    if ('failed' in result) {
      fail(repo.asked, result.failed);
      continue;
    }
    if ('unreadable' in result) {
      noVerdict(repo.asked, result.unreadable);
      continue;
    }
    const reading = readPolicy(result.files);
    run.tiers[reading.tier] = (run.tiers[reading.tier] ?? 0) + 1;
    if (listed(reading.tier) && reading.welcome !== null) welcoming.push({ repo, reading, files: result.files });
    else progress.done.add(repo.asked);
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
      skip(repo.asked, why);
      continue;
    }
    if ((await whyNotListable(github, repo.name)) !== null) {
      skip(repo.asked, 'not_listable');
      continue;
    }
    let labels;
    try {
      labels = await readLabels(github, repo.name);
    } catch (error) {
      if (!(error instanceof RepoFailed)) throw error;
      fail(repo.asked, error.message);
      continue;
    }
    if (labels === null || repo.standing === null || repo.branch === null || reading.welcome === null || !listed(reading.tier)) {
      skip(repo.asked, 'not_public');
      continue;
    }
    const { settings, suggestedTags, sources } = suggestSettings(reading, read, labels, repo.vouch);
    const policy = {
      quote: reading.welcome.quote,
      url: fileUrl(repo.name, repo.branch, reading.welcome.file.path),
      tier: reading.tier,
    };
    let candidate;
    try {
      candidate = await addCandidate(db, { repo: repo.name, facts: repo.standing, policy, settings, suggestedTags, sources }, deps.now());
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      console.error(`The crawler couldn't put ${repo.name} in the admin queue.`, error);
      skip(repo.asked, 'unreadable');
      continue;
    }
    // A find that didn't land met the do-not-list, or another find for the repo, at the same moment.
    if (candidate === null) skip(repo.asked, (await crawlerSkips(db, [repo.name])).get(repo.name.toLowerCase()) ?? 'proposed');
    else {
      run.proposed.push(candidate.repo);
      progress.done.add(repo.asked);
    }
  }
}

/** Whether a batch comes from the crawl queue: `crawl` locally, and `<WORKER_NAME>-crawl` deployed. */
export function isCrawlQueue(name: string): boolean {
  return name === 'crawl' || name.endsWith('-crawl');
}

/** The crawl queue, or a stand-in that takes messages the same way. */
export interface CrawlQueue {
  send: (body: CrawlMessage, options?: QueueSendOptions) => Promise<unknown>;
}

/**
 * Reads a batch from the crawl queue. It first asks GitHub what is left of
 * the budget. A message whose repos were all read is acknowledged.
 *
 * - When the budget runs low, or the run has made its calls, the repos a
 *   message hasn't finished go back to the queue in a new message, to wait
 *   until the budget starts over, and the message is acknowledged. So the
 *   wait takes none of the message's tries.
 * - A repo GitHub answers with an error of its own, like one whose access
 *   GitHub blocked, goes back alone, later each time, so it can't hold the
 *   rest of its batch. A message of that repo alone is tried again, and its
 *   tries take it to the dead-letter queue.
 * - Any other failure sends the message back, later each time.
 * - A malformed message goes back at once, so its tries take it to the
 *   dead-letter queue, where it can be read.
 */
export async function readCrawlBatch(
  batch: MessageBatch,
  env: Pick<Env, 'DB'> & Partial<Pick<Env, 'GH_SERVICE_TOKEN'>> & { CRAWL_QUEUE: CrawlQueue },
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

  /** Sends repos back in a new message, and acknowledges the old one, or asks for the old one again when that fails. */
  const sendBack = async (message: Message, repos: readonly string[], delaySeconds: number): Promise<boolean> => {
    if (repos.length === 0) return true;
    try {
      await env.CRAWL_QUEUE.send({ repos: [...repos] }, { delaySeconds });
      return true;
    } catch (error) {
      console.error(`The crawler couldn't send repos from crawl message ${message.id} back to the queue.`, error);
      message.retry({ delaySeconds: Math.max(delaySeconds, backoff(message.attempts)) });
      return false;
    }
  };

  for (const message of batch.messages) {
    const checked = validate(crawlMessageSchema, message.body, 'message');
    if (!checked.ok) {
      console.error(`Crawl message ${message.id} is malformed.\n${describeProblems(checked.problems)}`);
      message.retry({ delaySeconds: 0 });
      continue;
    }
    const repos = checked.value.repos;
    if (stop !== null) {
      if (!waitsForBudget(stop)) message.retry({ delaySeconds: waitAfter(stop, message.attempts, now()) });
      else if (await sendBack(message, repos, waitAfter(stop, message.attempts, now()))) message.ack();
      continue;
    }
    const progress = newCrawlProgress();
    try {
      await crawlRepos({ db: env.DB, github, now }, repos, run, progress);
    } catch (error) {
      if (!(error instanceof SyncStopped)) {
        console.error(`The crawler didn't finish crawl message ${message.id}. It will be tried again.`, error);
        message.retry({ delaySeconds: backoff(message.attempts) });
        continue;
      }
      stop = error;
    }
    const failed = [...progress.failed.keys()];
    const rest = repos.filter((repo) => !progress.done.has(repo) && !progress.failed.has(repo));
    // A message of one repo GitHub keeps failing on is tried again, until its tries run out.
    if (repos.length === 1 && failed.length === 1) {
      message.retry({ delaySeconds: backoff(message.attempts) });
      continue;
    }
    if (stop !== null && rest.length > 0 && !waitsForBudget(stop)) {
      message.retry({ delaySeconds: waitAfter(stop, message.attempts, now()) });
      continue;
    }
    let sent = true;
    for (const repo of failed) sent &&= await sendBack(message, [repo], backoff(1));
    if (sent && stop !== null) sent = await sendBack(message, rest, waitAfter(stop, message.attempts, now()));
    if (!sent) continue;
    if (stop === null) run.messages += 1;
    message.ack();
  }
  run.stopped = stop?.reason ?? null;
  run.calls = github.calls;
  if (stop !== null) console.warn(`The crawler stopped. ${stop.message}`);
  console.log(
    `The crawler read ${String(run.messages)} of ${String(batch.messages.length)} messages, with repos: ${String(run.repos)}, skipped: ${JSON.stringify(run.skipped)}, tiers: ${JSON.stringify(run.tiers)}, put in the admin queue: ${run.proposed.length === 0 ? 'none' : run.proposed.join(', ')}, sent back alone after GitHub failed on them: ${run.failed.length === 0 ? 'none' : run.failed.join(', ')}, calls to GitHub: ${String(run.calls)}. Left: ${JSON.stringify(github.left())}.${run.stopped === null ? '' : ` Stopped: ${run.stopped}.`}`,
  );
  return run;
}
