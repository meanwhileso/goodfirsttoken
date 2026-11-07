import type { Policy, ProjectRecord } from '@goodfirsttoken/core';
import { adoptRulesRead, getModelRead, getModelReading, getDoNotListEntry, getIssueSync, getPolicyRead, getProject } from '../db';
import { whyNotEligible, type RepoFacts } from '../projects/repo';
import { isProjectRepo } from '../projects/repo-id';
import { countRereadNoVerdict } from './batches';
import { decideReread, type RereadDocs } from './decide';
import { wordsOf } from './fingerprint';
import { readerStatus, sharedReads, stageReread, stageSecondReading, type ReaderRun, type ReaderStatus } from './model';
import { pauseForCrawler } from './pause';
import { readPolicyOutput, type PolicyReading } from './reader';
import { docsHash } from './reader/docs';
import type { CrawlDeps, CrawlProgress, CrawlRun } from './queue';
import { readFiles, readLabels, readRepoFacts, readRepos, RepoFailed, type FoundRepo } from './reads';
import type { PolicyFile } from './rules';

// Keeping listings current (spec section 5): the crawl queue's consumer
// reads each listed project's docs again every week, with the same reads as
// a crawl, and stages them for the model policy reader, whose reading is
// compared with the last read (src/crawl/decide.ts). The crawler's cron job
// queues them (src/crawl/producer.ts).
//
// - Docs that move into a ban on AI help, from a last read that wasn't one,
//   pause the project, once a second reading agrees. A ban the docs had at
//   the first read of a registered project, or of a listing an admin made
//   by hand, is taken as it is. So is one a new reader version reads in a
//   registered project.
// - A repo that now lets only collaborators open pull requests, or has them
//   turned off, pauses an approved project at once, with or without the
//   model.
// - A listing made from a policy whose policy reads differently otherwise
//   goes back to the admin queue as a policy change, and stays listed while
//   it waits. A listing made from a maintainer's post on X stands on the
//   post, so its first read sends nothing while its docs name no AI, and a
//   ban then pauses it.
// - Without an ANTHROPIC_API_KEY, the weekly read runs only the pull request
//   check.
//
// Each pause is the one the sync makes: a pause that names no one, so only
// an admin lifts it, kept in the status history. The admin queue shows every
// such pause, with the line the model read as a ban. A repo GitHub shows
// archived, private, or gone is the sync's, which pauses and delists it, so
// the crawler leaves it alone. So is another repo under the project's name,
// by its GitHub ID, as src/projects/repo-id.ts says. Nothing here approves,
// lists, or adds a project: the only status it writes is a pause. The rules
// are in docs/how-it-works.md, under Keeping listings current.

export { BAN_REASON, MODEL_BAN_REASON } from './pause';

/** Why the weekly read left a listed project alone. */
export type RereadSkip =
  /** It is no longer a project that is approved or paused. */
  | 'not_listed'
  /** Its repo or issue repo is on the do-not-list. */
  | 'do_not_list'
  /** The sync delisted it, since GitHub showed its repo or issue repo private, archived, blocked, or gone. */
  | 'delisted'
  /**
   * GitHub shows its repo archived, private, or gone now, or another repo
   * under its name, by its GitHub ID, which the sync reads and acts on.
   */
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

/**
 * What the model reads now, against the last whole read: whether it changed,
 * and whether it moved into the ban tier.
 *
 * - It moved into a ban when it reads a ban now and the last read didn't.
 *   Across a new reader version, that holds for a listing made from a
 *   policy, since a missed ban is the worse error and an admin reviews the
 *   pause. A registered project takes its docs as the new reader reads
 *   them, as at its first read.
 * - When no read kept whether it was a ban, as before the first, only a
 *   listing made from a crawler find moved into one, `fromFind`: the find
 *   read its docs as a welcome. A listing an admin made by hand, and a
 *   registered project, take their docs as they are, since an admin or its
 *   maintainers listed it with its docs as they were.
 * - With a last read of this version, it changed when the hashes differ.
 * - With a last read of another version, as after a new reader version, it
 *   takes the new one and reads as no change, so a new reader sends nothing
 *   back to the queue.
 * - With no last read, a listing made from a policy compares with the policy
 *   it was listed from, and a registered project reads as no change.
 * - A listing made from a maintainer's post reads as no change at its first
 *   read while its docs name no AI at all, and a ban then is a move into
 *   one. Later reads compare hashes, as for any listing.
 *
 * `read` says whether the last read is of the reader's version, and whether
 * either of the reading's tiers reads a ban.
 */
export function compare(
  project: ProjectRecord,
  last: { fingerprint: string | null; banned: boolean | null } | null,
  reading: PolicyReading,
  fingerprint: string,
  fromFind: boolean,
  read: { sameVersion: boolean; banned: boolean },
): { changed: boolean; intoBan: boolean } {
  // A listing made from a maintainer's post stood on docs that said nothing
  // about AI, so a ban at its first read is a move into one, as for a find.
  const fromPost = project.policy?.maintainerPost !== undefined;
  const intoBan =
    read.banned && (last?.banned == null ? fromFind || fromPost : !last.banned && (read.sameVersion || project.source === 'policy'));
  if (last?.fingerprint == null) {
    // Its first read is no change while the docs still name no AI at all.
    // Docs that name it, even to restrict agents without a ban, go to an
    // admin once, and later reads compare hashes as for any listing.
    if (fromPost && reading.tier === 'no_policy' && reading.aiSentences.length === 0) return { changed: false, intoBan };
    return { changed: readsOtherwise(project.policy, reading), intoBan };
  }
  if (!read.sameVersion) return { changed: false, intoBan };
  return { changed: last.fingerprint !== fingerprint, intoBan };
}

/**
 * Pauses an approved project whose pull requests are limited to
 * collaborators, then stages the docs for the model, whose reading decides
 * the rest (src/crawl/decide.ts): docs that move into a ban pause the
 * project once a second reading agrees, and a listing whose policy changed
 * otherwise goes back to the admin queue. Without the key, only the pull
 * request check runs. Throws RepoFailed when GitHub fails on the repo's
 * labels, which a reading needs.
 */
async function keepCurrent(
  deps: CrawlDeps,
  project: ProjectRecord,
  repo: FoundRepo & { branch: string; standing: NonNullable<FoundRepo['standing']> },
  files: PolicyFile[],
  facts: RepoFacts,
  run: RereadRun,
  model: { status: ReaderStatus; run: ReaderRun },
): Promise<'read' | 'gone'> {
  const { db, github, now } = deps;
  const pullRequests = pullRequestsFrom(facts);
  if (pullRequests === 'unknown') {
    console.warn(`GitHub didn't say who can open pull requests on ${repo.name}, so the crawler's weekly read paused nothing for them.`);
  } else if (pullRequests !== 'open') {
    const why = { ban: null, aiSentences: [], moreAiSentences: 0 };
    if (await pauseForCrawler(deps, project.repo, pullRequests.limited, why, false)) run.paused.push(project.repo);
  }
  if (!model.status.reads) return 'read';

  // At a project's first weekly read with the model deciding, the rules' last verdict, the one acted on, is the model's last read.
  if ((await getModelRead(db, project.repo))?.readIn !== 'model') {
    const last = await getPolicyRead(db, project.repo);
    await adoptRulesRead(db, project.repo, { fingerprint: last?.fingerprint ?? null, banned: last?.banned ?? null });
  }
  const hash = await docsHash(files, repo.vouch);
  const reads = sharedReads({ listable: () => Promise.resolve(null), labels: (name) => readLabels(github, name) });
  const stage = { db, now, calls: () => github.calls };
  const what = { project: project.repo, repo, files, hash };
  const docs = (labels: RereadDocs['labels']): RereadDocs => ({
    repo: project.repo,
    branch: repo.branch,
    facts: repo.standing,
    vouch: repo.vouch,
    labels,
    docsHash: hash,
  });
  const staged = await stageReread(stage, model.run, reads, what);
  if (staged === 'cached') {
    const kept = await getModelReading(db, project.repo);
    const read = kept === null ? null : readPolicyOutput(files, kept.output);
    if (read?.ok === true && kept !== null) {
      // The kept reading of the same docs stands for the first reading, and a move into a ban stages the second.
      const labels = await reads.labels(repo.name);
      if (labels === null) return 'gone';
      if ((await decideReread(deps, run, docs(labels), files, read.reading)) === 'second') {
        await stageSecondReading(stage, model.run, reads, { ...what, firstOutput: kept.output });
      }
    }
  } else if (staged === 'too_big') {
    // A report of docs it can't read needs no labels, so this reads none from GitHub.
    await countRereadNoVerdict(deps, project.repo, 'docs past the size cap', { run, docs: docs([]), files });
  }
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
  for (const [i, asked] of toRead.entries()) {
    const result = listings[i];
    const project = listed.get(asked);
    if (result === undefined || project === undefined || 'gone' in result) skip(asked, 'left_for_sync');
    else if ('failed' in result) fail(asked, result.failed);
    else if (result.found.private || result.found.archived) skip(asked, 'left_for_sync');
    else if (result.found.identity === null || result.found.standing === null || result.found.branch === null) skip(asked, 'unreadable');
    // Another repo under the project's name is the sync's to delist, as a gone one is.
    else if (!(await isProjectRepo(db, project.repo, project.repo, result.found.identity))) skip(asked, 'left_for_sync');
    else if (result.found.unreadable !== null) noVerdict(asked, result.found.unreadable);
    else readable.push({ ...result.found, branch: result.found.branch, standing: result.found.standing });
  }

  const read = await readFiles(github, readable);
  const model = { status: await readerStatus(db, deps.now()), run: run.reader };
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
      outcome = await keepCurrent(deps, project, repo, result.files, facts, run.reread, model);
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
