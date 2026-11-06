import type { DocsHash, RepoFacts } from '@goodfirsttoken/core';
import { anthropicApiKey, modelDailyBudgetUsd, policyReader } from '../anthropic';
import {
  getModelRead,
  getModelReading,
  getReaderState,
  lastRejectedFind,
  setReaderState,
  stagePending,
  type ReadingPurpose,
} from '../db';
import { readsSame, docsBytes, MAX_DOCS_BYTES, utcDay, type Share } from './reader';
import { READER_VERSION } from './reader/version';
import { RepoFailed } from './reads';
import type { CrawlTier, PolicyFile, RepoLabel } from './rules';

// The crawl consumer's half of the model policy reader
// (docs/specs/model-policy-reader.md, under When the model reads and Where it
// runs). After the rules read a repo's docs, this decides whether the model
// reads them too, and if so stages them in D1, with the repo's labels, for
// the hourly run to send through the Message Batches API
// (src/crawl/batches.ts). It makes every GitHub read the reading needs, so
// the batch job never calls GitHub.
//
// With POLICY_READER=shadow the rules decide, as before, and the model's
// reading is kept and shown beside theirs. `model` reads the same way until
// the model may decide, in its own issue. Nothing is staged without an
// ANTHROPIC_API_KEY, or with a budget of 0.

/** What the model's half of one crawl run did, for its log line. */
export interface ReaderRun {
  /** Readings staged for the next batch. */
  staged: number;
  /** Docs the model read before, with this reader version, so no model call. */
  cacheHits: number;
  /** Weekly reads of docs the last weekly read read, which decide nothing. */
  same: number;
  /** Seeds whose rejected find has the same docs, which stay out with no model call. */
  rejectedSame: number;
  /** Seeds that take no outside pull requests, left out with no model call. */
  notListable: number;
  /** Repos whose docs are past the size cap, which get no verdict. */
  tooBig: string[];
  /** Repos whose labels GitHub didn't give, so nothing was staged. */
  noLabels: string[];
  /** Calls to GitHub the model's half made for its staging. */
  githubCalls: number;
  /** Listings whose docs the model read before, which it reads as moved into a ban, or as changed, where the rules may not. */
  wouldPause: string[];
  wouldChange: string[];
}

export function newReaderRun(): ReaderRun {
  return { staged: 0, cacheHits: 0, same: 0, rejectedSame: 0, notListable: 0, tooBig: [], noLabels: [], githubCalls: 0, wouldPause: [], wouldChange: [] };
}

/** Whether the model reads, and when it doesn't, why. */
export type ReaderStatus = { reads: true } | { reads: false; why: 'rules' | 'no_key' | 'no_budget' };

/** The last UTC day the log said the reader has no key or no budget, so it says so once a day. */
const SAID_WAITING = 'said_waiting_on';

/**
 * Whether the model reads in this run: POLICY_READER is shadow or model,
 * the key is set, and the day's budget is more than 0. Without the key or
 * the budget, the log says so once a UTC day.
 */
export async function readerStatus(db: D1Database, now: number): Promise<ReaderStatus> {
  if (policyReader() === 'rules') return { reads: false, why: 'rules' };
  const why = anthropicApiKey() === null ? 'no_key' : modelDailyBudgetUsd() <= 0 ? 'no_budget' : null;
  if (why === null) return { reads: true };
  const day = utcDay(now);
  if ((await getReaderState(db, SAID_WAITING)) !== day) {
    await setReaderState(db, SAID_WAITING, day);
    console.warn(
      why === 'no_key'
        ? 'The policy reader read nothing with the model. The ANTHROPIC_API_KEY secret is not set, so seeds wait for an admin to list them by hand, and weekly reads run the rules and the pull request check. docs/self-hosting.md says how to set it.'
        : 'The policy reader read nothing with the model. MODEL_DAILY_BUDGET_USD is 0 or not set, so the model may spend nothing. docs/self-hosting.md says how to set it.',
    );
  }
  return { reads: false, why };
}

/** A repo read whole, with what the staging needs. */
export interface ReadRepo {
  name: string;
  branch: string | null;
  commit: string | null;
  standing: RepoFacts | null;
  vouch: string | null;
}

/** GitHub reads that the rules may make too, made once for both. */
export interface SharedReads {
  /** Why the repo can't be listed, or null when it can. */
  listable: (repo: string) => Promise<string | null>;
  /** The repo's labels, or null when GitHub doesn't show it. Throws RepoFailed. */
  labels: (repo: string) => Promise<RepoLabel[] | null>;
}

/** Each read once per repo, with its answer, or its failure, kept for the next ask. */
export function sharedReads(reads: SharedReads): SharedReads {
  const listable = new Map<string, Promise<string | null>>();
  const labels = new Map<string, Promise<RepoLabel[] | null>>();
  const once = <T>(cache: Map<string, Promise<T>>, read: (repo: string) => Promise<T>) => (repo: string) => {
    const key = repo.toLowerCase();
    let found = cache.get(key);
    if (found === undefined) {
      found = read(repo);
      cache.set(key, found);
    }
    return found;
  };
  return { listable: once(listable, reads.listable), labels: once(labels, reads.labels) };
}

export interface StageDeps {
  db: D1Database;
  now: () => number;
  /** How many calls the run made to GitHub so far, to count the staging's. */
  calls: () => number;
}

interface Stage {
  purpose: ReadingPurpose;
  share: Share;
  repo: ReadRepo;
  files: readonly PolicyFile[];
  hash: DocsHash;
  rulesTier: CrawlTier;
}

/** Stages a reading, with the repo's labels. False when GitHub didn't give the labels. */
async function stage(deps: StageDeps, run: ReaderRun, reads: SharedReads, what: Stage): Promise<boolean> {
  const { repo } = what;
  if (repo.commit === null || repo.branch === null || repo.standing === null) return false;
  let labels: RepoLabel[] | null;
  try {
    labels = await reads.labels(repo.name);
  } catch (error) {
    if (!(error instanceof RepoFailed)) throw error;
    labels = null;
  }
  if (labels === null) {
    run.noLabels.push(repo.name);
    console.warn(`The policy reader staged nothing for ${repo.name}, since GitHub didn't give its labels. It reads it at its next read.`);
    return false;
  }
  await stagePending(
    deps.db,
    {
      repo: repo.name,
      purpose: what.purpose,
      share: what.share,
      docsHash: what.hash,
      rulesTier: what.rulesTier,
      commit: repo.commit,
      branch: repo.branch,
      facts: repo.standing,
      vouch: repo.vouch,
      labels,
      files: what.files,
    },
    deps.now(),
  );
  run.staged += 1;
  return true;
}

/** Whether the files are past the size cap, which the log names. */
function tooBig(run: ReaderRun, repo: string, files: readonly PolicyFile[]): boolean {
  const bytes = docsBytes(files);
  if (bytes <= MAX_DOCS_BYTES) return false;
  run.tooBig.push(repo);
  console.warn(
    `The policy reader gave ${repo} no verdict: its docs hold ${bytes.toLocaleString('en-US')} bytes of text, past the ${MAX_DOCS_BYTES.toLocaleString('en-US')} the model reads.`,
  );
  return true;
}

/**
 * Decides whether the model reads a seed's docs, and stages them when it
 * does. Docs it read before with this reader version cost nothing. A seed
 * whose rejected find has the same docs stays out. Past the size cap, or for
 * a seed that takes no outside pull requests, the model reads nothing. Then
 * it reads the labels, which the rules' find reads too, and stages both.
 */
export async function stageSeed(
  deps: StageDeps,
  run: ReaderRun,
  reads: SharedReads,
  what: { repo: ReadRepo; files: readonly PolicyFile[]; hash: DocsHash; rulesTier: CrawlTier },
): Promise<void> {
  const before = deps.calls();
  try {
    const { repo, files, hash } = what;
    if (files.length === 0) return;
    if (tooBig(run, repo.name, files)) return;
    if (readsSame(await getModelReading(deps.db, repo.name), hash)) {
      run.cacheHits += 1;
      return;
    }
    if ((await lastRejectedFind(deps.db, repo.name))?.docsHash === hash) {
      run.rejectedSame += 1;
      return;
    }
    if ((await reads.listable(repo.name)) !== null) {
      run.notListable += 1;
      return;
    }
    await stage(deps, run, reads, { ...what, purpose: 'seed', share: 'seeds' });
  } finally {
    run.githubCalls += deps.calls() - before;
  }
}

/** What the model's half of a weekly read did with the docs. */
export type RereadStage =
  /** Staged for the next batch. */
  | 'staged'
  /** Read before with this reader version, so the kept reading stands for them. */
  | 'cached'
  /** The docs the last weekly read read, which decide nothing. */
  | 'same'
  /** Past the size cap, which is no verdict. */
  | 'too_big'
  /** Nothing staged: no files, or no labels from GitHub. */
  | 'none';

/**
 * Decides whether the model reads a listed project's docs on its weekly
 * read, and stages them when it does. The docs the last weekly read read,
 * with this reader version, decide nothing. Docs it read before cost no
 * call. Past the size cap is no verdict. Docs whose hash changed get their
 * labels read and are staged.
 */
export async function stageReread(
  deps: StageDeps,
  run: ReaderRun,
  reads: SharedReads,
  what: { project: string; repo: ReadRepo; files: readonly PolicyFile[]; hash: DocsHash; rulesTier: CrawlTier },
): Promise<RereadStage> {
  const before = deps.calls();
  try {
    const { repo, files, hash } = what;
    if (files.length === 0) return 'none';
    const last = await getModelRead(deps.db, what.project);
    if (last !== null && last.docsHash === hash && last.readerVersion === READER_VERSION) {
      run.same += 1;
      return 'same';
    }
    if (tooBig(run, repo.name, files)) return 'too_big';
    if (readsSame(await getModelReading(deps.db, repo.name), hash)) {
      run.cacheHits += 1;
      return 'cached';
    }
    return (await stage(deps, run, reads, { ...what, purpose: 'reread', share: 'weekly' })) ? 'staged' : 'none';
  } finally {
    run.githubCalls += deps.calls() - before;
  }
}
