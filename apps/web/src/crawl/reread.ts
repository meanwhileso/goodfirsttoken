import type { AiSentence, BanLine, Policy, PolicyTier, ProjectRecord } from '@goodfirsttoken/core';
import {
  addPolicyChange,
  getDoNotListEntry,
  getIssueSync,
  getPolicyRead,
  getProject,
  keepCrawlerPause,
  keepFingerprint,
  setProjectStatusFrom,
} from '../db';
import { whyNotEligible, type RepoFacts } from '../projects/repo';
import { comparable, policyFingerprint, wordsOf } from './fingerprint';
import type { CrawlDeps, CrawlProgress, CrawlRun } from './queue';
import { fileUrl, readFiles, readLabels, readRepoFacts, readRepos, RepoFailed, type FoundRepo } from './reads';
import { readPolicy, suggestSettings, type CrawlTier, type PolicyFile, type PolicyReading } from './rules';

// Keeping listings current (spec section 5): the crawl queue's consumer
// reads each listed project's docs again every week, with the same reads and
// the same rules as a crawl, and compares what the rules read with the last
// read. The crawler's cron job queues them (src/crawl/search.ts).
//
// - Docs that now read as a ban on AI help pause the project at once.
// - A repo that now lets only collaborators open pull requests, or has them
//   turned off, pauses an approved project at once.
// - A listing made from a policy whose policy reads differently goes back to
//   the admin queue as a policy change, and stays listed while it waits.
//
// Each pause is the one the sync makes: a pause that names no one, so only
// an admin lifts it, kept in the status history. The admin queue shows every
// such pause, with the line the rules read as a ban. A repo GitHub shows
// archived, private, or gone is the sync's, which pauses and delists it, so
// the crawler leaves it alone. Nothing here approves, lists, or adds a
// project: the only status it writes is a pause. The rules are in
// docs/how-it-works.md, under Keeping listings current.

/** The reason for a pause on a ban. The project's maintainers read it with project_status. It holds no text of the repo's. */
export const BAN_REASON =
  "Its docs now read as a ban on AI help, by the policy crawler's rules. An admin checks them before agents can claim its issues again.";

/** Why the weekly read left a listed project alone. */
export type RereadSkip =
  /** It is no longer a project that is approved or paused. */
  | 'not_listed'
  /** Its repo or issue repo is on the do-not-list. */
  | 'do_not_list'
  /** The sync delisted it, since GitHub showed its repo or issue repo private, archived, blocked, or gone. */
  | 'delisted'
  /** GitHub shows its repo archived, private, or gone now, which the sync reads and acts on. */
  | 'left_for_sync'
  /** GitHub described it in a form the crawler can't use. */
  | 'unreadable'
  /** A file that could hold its policy couldn't be read whole, so the read gives no verdict. */
  | 'unreadable_docs';

/** What one run's weekly reads did, for its log line. */
export interface RereadRun {
  /** Projects whose docs it read whole. */
  read: number;
  /** Listings whose policy read differently, put in the admin queue. */
  changed: string[];
  /** Projects it paused. */
  paused: string[];
  skipped: Partial<Record<RereadSkip, number>>;
}

export function newRereadRun(): RereadRun {
  return { read: 0, changed: [], paused: [], skipped: {} };
}

/** How many times a pause is decided again when the status changed while it ran. */
const PAUSE_ATTEMPTS = 3;

function listedTier(tier: CrawlTier): tier is PolicyTier {
  return tier === 'invites_agents' || tier === 'allows_with_conditions';
}

/** Why the weekly read leaves the project alone, or null when it reads it. */
async function whyNotRead(db: D1Database, project: ProjectRecord | null): Promise<RereadSkip | null> {
  if (project === null || (project.status !== 'approved' && project.status !== 'paused')) return 'not_listed';
  for (const repo of new Set([project.repo, project.settings.issueRepo ?? project.repo])) {
    if ((await getDoNotListEntry(db, repo)) !== null) return 'do_not_list';
  }
  if ((await getIssueSync(db, project.repo))?.delisted != null) return 'delisted';
  return null;
}

/**
 * Whether the policy a project was listed from reads otherwise now, for the
 * first read, which has no earlier one to compare with: another tier, or a
 * quote with other words. A registered project has no policy, and reads the
 * same.
 */
function readsOtherwise(policy: Policy | null, reading: PolicyReading): boolean {
  if (policy === null) return false;
  if (reading.tier !== policy.tier || reading.welcome === null) return true;
  return wordsOf(reading.welcome.quote) !== wordsOf(policy.quote);
}

/**
 * Whether anyone can open a pull request on the repo: `open` when anyone
 * can, the reason when they are turned off or only collaborators can open
 * them, and `unknown` when GitHub didn't say, which pauses nothing, since a
 * field GitHub left out says nothing about the repo.
 */
function pullRequestsFrom(facts: RepoFacts): 'open' | 'unknown' | { limited: string } {
  const limited = () => ({ limited: whyNotEligible(facts, 'list') ?? `${facts.fullName} takes no pull requests from anyone.` });
  if (facts.hasPullRequests === false) return limited();
  if (facts.hasPullRequests === null || facts.pullRequestCreationPolicy === null) return 'unknown';
  return facts.pullRequestCreationPolicy === 'all' ? 'open' : limited();
}

function passages(reading: PolicyReading): AiSentence[] {
  return reading.aiSentences.map(({ file, ...passage }) => ({ path: file.path, ...passage }));
}

/**
 * Pauses the project for Good First Token with `reason`, naming no one, and
 * keeps why for the admin queue. It lands only on the status it was decided
 * on, so a change someone made meanwhile is decided on again. With
 * `anyPause`, a pause someone else made becomes this one: a maintainer's, an
 * admin's, or one Good First Token made for another reason. Without it, only
 * an approved project is paused. True when it paused the project.
 */
async function pauseForCrawler(
  deps: CrawlDeps,
  repo: string,
  reason: string,
  why: { ban: BanLine | null; aiSentences: AiSentence[]; moreAiSentences: number },
  anyPause: boolean,
): Promise<boolean> {
  const { db, now } = deps;
  let current = await getProject(db, repo);
  for (let attempt = 0; attempt < PAUSE_ATTEMPTS; attempt++) {
    if (current === null) return false;
    const open = current.status === 'approved' || (anyPause && current.status === 'paused');
    if (!open) return false;
    if (current.status === 'paused' && current.statusChangedBy === null && current.statusReason === reason) {
      // Paused for this already. The admins see the latest reading.
      await keepCrawlerPause(db, current.repo, { pausedAt: current.statusChangedAt, ...why }, now());
      return false;
    }
    const paused = await setProjectStatusFrom(db, current, { status: 'paused', reason, changedBy: null }, now());
    if (paused !== null) {
      await keepCrawlerPause(db, paused.repo, { pausedAt: paused.statusChangedAt, ...why }, now());
      console.warn(`The policy crawler paused ${paused.repo}: ${reason}`);
      return true;
    }
    current = await getProject(db, repo);
  }
  return false;
}

/**
 * Compares what the rules read in a listed project's docs now with the last
 * read, and acts on it: a ban pauses the project, a listing whose policy
 * changed goes back to the admin queue, and pull requests limited to
 * collaborators pause an approved project. Then it keeps what they read now
 * for the next read. Throws RepoFailed when GitHub fails on the repo's
 * labels, which a change reads.
 */
async function keepCurrent(
  deps: CrawlDeps,
  project: ProjectRecord,
  repo: FoundRepo & { branch: string; standing: NonNullable<FoundRepo['standing']> },
  files: PolicyFile[],
  facts: RepoFacts,
  run: RereadRun,
): Promise<'read' | 'gone'> {
  const { db, github, now } = deps;
  const reading = readPolicy(files);
  const fingerprint = await policyFingerprint(reading, files, repo.vouch);
  const before = (await getPolicyRead(db, project.repo))?.fingerprint ?? null;
  // With no earlier read to compare with, a listing compares with the policy it was listed from.
  const changed = comparable(before) ? before !== fingerprint : readsOtherwise(project.policy, reading);

  if (changed && reading.tier === 'bans_or_restricts') {
    const ban =
      reading.ban === null
        ? null
        : { path: reading.ban.file.path, line: reading.ban.line || null, url: fileUrl(repo.name, repo.branch, reading.ban.file.path) };
    const why = { ban, aiSentences: passages(reading), moreAiSentences: reading.moreAiSentences };
    if (await pauseForCrawler(deps, project.repo, BAN_REASON, why, true)) run.paused.push(project.repo);
  } else if (changed && project.source === 'policy') {
    const labels = await readLabels(github, repo.name);
    if (labels === null) return 'gone';
    const welcome = reading.welcome;
    const policy =
      listedTier(reading.tier) && welcome !== null
        ? { quote: welcome.quote, url: fileUrl(repo.name, repo.branch, welcome.file.path), tier: reading.tier }
        : null;
    const { sources } = suggestSettings(reading, files, labels, repo.vouch);
    const change = await addPolicyChange(
      db,
      { repo: project.repo, facts: repo.standing, policy, sources, aiSentences: passages(reading), moreAiSentences: reading.moreAiSentences },
      now(),
    );
    if (change !== null) run.changed.push(project.repo);
  }

  const pullRequests = pullRequestsFrom(facts);
  if (pullRequests === 'unknown') {
    console.warn(`GitHub didn't say who can open pull requests on ${repo.name}, so the crawler's weekly read paused nothing for them.`);
  } else if (pullRequests !== 'open') {
    const why = { ban: null, aiSentences: [], moreAiSentences: 0 };
    if (await pauseForCrawler(deps, project.repo, pullRequests.limited, why, false)) run.paused.push(project.repo);
  }
  await keepFingerprint(db, project.repo, fingerprint, now());
  return 'read';
}

/**
 * Reads the docs of the listed projects in one message of the crawl queue,
 * each at one commit of its default branch, with the reads a crawl makes,
 * and keeps each listing current. `progress` says which it finished, and
 * which GitHub answered with an error, as for a crawl. Throws SyncStopped
 * when the run has to stop, after acting on what it read.
 */
export async function rereadRepos(deps: CrawlDeps, repos: readonly string[], run: CrawlRun, progress: CrawlProgress): Promise<void> {
  const { db, github } = deps;
  const skip = (asked: string, why: RereadSkip) => {
    run.reread.skipped[why] = (run.reread.skipped[why] ?? 0) + 1;
    progress.done.add(asked);
  };
  const fail = (asked: string, why: string) => {
    progress.failed.set(asked, why);
    run.failed.push(asked);
    console.warn(`GitHub failed on ${asked}, so the crawler sends its weekly read back to the queue alone. ${why}`);
  };
  const noVerdict = (asked: string, why: string) => {
    skip(asked, 'unreadable_docs');
    console.warn(`The crawler's weekly read of ${asked} gave no verdict: ${why}.`);
  };
  run.repos += repos.length;

  const listed = new Map<string, ProjectRecord>();
  for (const asked of repos) {
    const project = await getProject(db, asked);
    const why = await whyNotRead(db, project);
    if (why !== null || project === null) skip(asked, why ?? 'not_listed');
    else listed.set(asked, project);
  }
  if (listed.size === 0) return;

  const toRead = [...listed.keys()];
  const listings = await readRepos(github, toRead);
  const readable: (FoundRepo & { branch: string; standing: NonNullable<FoundRepo['standing']> })[] = [];
  toRead.forEach((asked, i) => {
    const result = listings[i];
    if (result === undefined || 'gone' in result) skip(asked, 'left_for_sync');
    else if ('failed' in result) fail(asked, result.failed);
    else if (result.found.private || result.found.archived) skip(asked, 'left_for_sync');
    else if (result.found.standing === null || result.found.branch === null) skip(asked, 'unreadable');
    else if (result.found.unreadable !== null) noVerdict(asked, result.found.unreadable);
    else readable.push({ ...result.found, branch: result.found.branch, standing: result.found.standing });
  });

  const read = await readFiles(github, readable);
  for (const repo of readable) {
    const project = listed.get(repo.asked);
    const result = read.get(repo) ?? { failed: `GitHub gave nothing for ${repo.name}.` };
    if (project === undefined) continue;
    if ('failed' in result) {
      fail(repo.asked, result.failed);
      continue;
    }
    if ('unreadable' in result) {
      noVerdict(repo.asked, result.unreadable);
      continue;
    }
    const facts = await readRepoFacts(github, repo.name);
    if ('failed' in facts) {
      // A repo GitHub no longer shows, or blocks, is the sync's to delist.
      if (facts.status === 404 || facts.status === 451) skip(repo.asked, 'left_for_sync');
      else fail(repo.asked, facts.failed);
      continue;
    }
    // Archived since the first read of this run. Still the sync's.
    if (facts.private || facts.archived) {
      skip(repo.asked, 'left_for_sync');
      continue;
    }
    let outcome;
    try {
      outcome = await keepCurrent(deps, project, repo, result.files, facts, run.reread);
    } catch (error) {
      if (!(error instanceof RepoFailed)) throw error;
      fail(repo.asked, error.message);
      continue;
    }
    if (outcome === 'gone') {
      skip(repo.asked, 'left_for_sync');
      continue;
    }
    run.reread.read += 1;
    progress.done.add(repo.asked);
  }
}
