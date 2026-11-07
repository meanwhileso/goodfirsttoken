import type { DocsHash, ProjectRecord, RepoFacts } from '@goodfirsttoken/core';
import {
  addCandidate,
  addPolicyChange,
  adoptRulesRead,
  crawlerSkips,
  getModelRead,
  getPolicyRead,
  getProject,
  hasApprovedFind,
  keepModelRead,
  lastRejectedFind,
  rejectedPolicyLink,
  setFindFingerprint,
} from '../db';
import { MODEL_BAN_REASON, pauseForCrawler } from './pause';
import { findTier, readerFingerprint, readerSettings, readsBan, toPolicyReading, type LabelCheck, type ModelReading, type PolicyReading } from './reader';
import { READER_FINGERPRINT_VERSION } from './reader/fingerprint';
import { fileUrl } from './reads';
import { compare, welcomeMoved } from './reread';
import { aiPassages, type AiPassages, type PolicyFile, type RepoLabel } from './rules';

// What the model policy reader decides (docs/specs/model-policy-reader.md,
// under Pausing a listing and When it can't read): the find a seed's reading
// makes, and what a listed project's weekly reading does.
//
// A move into a ban pauses a listing only when the worked-out tier and the
// model's tier both read a ban, a ban line checks out in the file, a second
// reading of the same staged docs agrees, and those docs are still the
// newest staged for the repo, which the hourly run checks before it acts on
// a result. When the first reading's ban doesn't check out, or the second
// reading doesn't agree, the listing stays live: a listing made from a
// policy goes to the admin queue once, and a registered project gets a line
// in the log. The weekly read keeps the docs hash either way, so the same
// docs aren't read again.

/** What the decisions in one run did, for its log line. */
export interface DecideRun {
  paused: string[];
  changed: string[];
}

/** What a weekly read needs to act on a reading, as the crawl consumer staged it. */
export interface RereadDocs {
  /** The project's name, which a rename on GitHub doesn't change. */
  repo: string;
  branch: string;
  facts: RepoFacts;
  vouch: string | null;
  labels: RepoLabel[];
  docsHash: DocsHash;
}

export interface DecideDeps {
  db: D1Database;
  now: () => number;
}

/** Whether a fingerprint is of the reader's version, so a change to it is a change in the docs. */
function readerComparable(fingerprint: string | null): boolean {
  return fingerprint?.startsWith(`v${String(READER_FINGERPRINT_VERSION)}:`) === true;
}

function passages(reading: AiPassages) {
  return reading.aiSentences.map(({ file, ...passage }) => ({ path: file.path, ...passage }));
}

function listedOrPaused(project: ProjectRecord | null): project is ProjectRecord {
  return project !== null && (project.status === 'approved' || project.status === 'paused');
}

/**
 * Writes the find a seed's reading makes, once its label check is settled,
 * whatever the check's verdict. Before it writes, it checks the do-not-list,
 * the projects, and the earlier finds again, as the crawl consumer does. A
 * rejected find comes back only when its docs read differently: one with
 * the same docs, or the same fingerprint, stays out, and one with an older
 * fingerprint, as the finds the crawler's rules made have, takes the reader's
 * and stays out.
 * Returns the repo when it wrote the find.
 */
export async function writeModelFind(
  deps: DecideDeps,
  seed: { repo: string; branch: string; facts: RepoFacts; vouch: string | null; labels: RepoLabel[]; docsHash: DocsHash },
  files: readonly PolicyFile[],
  reading: ModelReading,
  check: LabelCheck | null,
): Promise<string | null> {
  const { db } = deps;
  const tier = findTier(reading);
  const policyReading = toPolicyReading(files, reading);
  const welcome = policyReading.welcome;
  if ((tier !== 'invites_agents' && tier !== 'allows_with_conditions') || welcome === null) return null;
  const skip = (await crawlerSkips(db, [seed.repo], { readRejected: true })).get(seed.repo.toLowerCase());
  if (skip !== undefined) {
    console.log(`The policy reader wrote no find for ${seed.repo}, since the crawler leaves it alone: ${skip}.`);
    return null;
  }
  const fingerprint = await readerFingerprint(files, reading, seed.vouch);
  const rejected = await lastRejectedFind(db, seed.repo);
  if (rejected !== null && (rejected.docsHash === seed.docsHash || !readerComparable(rejected.fingerprint) || rejected.fingerprint === fingerprint)) {
    if (rejected.fingerprint !== fingerprint) await setFindFingerprint(db, rejected.id, fingerprint, seed.docsHash);
    console.log(`The policy reader wrote no find for ${seed.repo}, since an admin rejected one for docs that read the same.`);
    return null;
  }
  const { settings, suggestedTags, sources } = readerSettings(reading, seed.labels, check, seed.vouch);
  const candidate = await addCandidate(
    db,
    {
      repo: seed.repo,
      facts: seed.facts,
      policy: { quote: welcome.quote, url: fileUrl(seed.repo, seed.branch, welcome.file.path), tier },
      settings,
      suggestedTags,
      sources,
      aiSentences: passages(policyReading),
      moreAiSentences: policyReading.moreAiSentences,
      fingerprint,
      docsHash: seed.docsHash,
      madeBy: 'model',
    },
    deps.now(),
  );
  return candidate?.repo ?? null;
}

/**
 * Sends a listing made from a policy to the admin queue as a policy change
 * from the model's reading, with why. A registered project's docs stay its
 * maintainers' call, so it gets no policy change.
 */
async function sendChange(
  deps: DecideDeps,
  run: DecideRun,
  docs: RereadDocs,
  files: readonly PolicyFile[],
  reading: ModelReading | null,
  why: 'changed' | 'ban_unconfirmed' | 'no_verdict',
): Promise<void> {
  const policyReading: PolicyReading | null = reading === null ? null : toPolicyReading(files, reading);
  // With no reading, the admin sees the sentences that name AI, from the word list.
  const net = policyReading ?? aiPassages(files);
  const welcome = policyReading?.welcome ?? null;
  const tier = policyReading?.tier;
  const policy =
    welcome !== null && (tier === 'invites_agents' || tier === 'allows_with_conditions')
      ? { quote: welcome.quote, url: fileUrl(docs.repo, docs.branch, welcome.file.path), tier }
      : null;
  const change = await addPolicyChange(
    deps.db,
    {
      repo: docs.repo,
      facts: docs.facts,
      policy,
      sources: reading === null ? [] : readerSettings(reading, docs.labels, null, docs.vouch).sources,
      aiSentences: passages(net),
      moreAiSentences: net.moreAiSentences,
      docsHash: docs.docsHash,
      madeBy: 'model',
      why,
    },
    deps.now(),
  );
  if (change !== null) run.changed.push(docs.repo);
}

/**
 * A move into a ban the reader couldn't confirm: the listing stays live. A
 * listing made from a policy goes to the admin queue once, as a policy
 * change that says why, and a registered project gets a line in the log.
 * Either way the weekly read keeps the docs hash and the first reading, as
 * one that read no ban.
 */
async function unconfirmedBan(
  deps: DecideDeps,
  run: DecideRun,
  project: ProjectRecord,
  docs: RereadDocs,
  files: readonly PolicyFile[],
  first: ModelReading,
  why: string,
): Promise<void> {
  if (project.source === 'policy') {
    await sendChange(deps, run, docs, files, first, 'ban_unconfirmed');
    console.warn(`The policy reader read a move into a ban in ${docs.repo} that it couldn't confirm: ${why}. The listing stays live, and an admin reads its docs.`);
  } else {
    console.warn(
      `The policy reader read a move into a ban in ${docs.repo} that it couldn't confirm: ${why}. The listing stays live, and its docs stay its maintainers' call.`,
    );
  }
  await keepModelRead(deps.db, docs.repo, {
    docsHash: docs.docsHash,
    readerVersion: first.readerVersion,
    fingerprint: await readerFingerprint(files, first, docs.vouch),
    banned: false,
    readIn: 'model',
  });
}

/**
 * Acts on the model's reading of a listed project's docs at a weekly read:
 * compares it with the last read. A
 * listing whose policy changed goes to the admin queue as a policy change.
 * A move into a ban that both tiers read, with a ban line that checks out,
 * returns 'second', and the caller stages a second reading of the same docs.
 * One that doesn't check out leaves the listing live. Otherwise it keeps the
 * reading for the next weekly read and returns 'kept'.
 */
export async function decideReread(
  deps: DecideDeps,
  run: DecideRun,
  docs: RereadDocs,
  files: readonly PolicyFile[],
  reading: ModelReading,
): Promise<'second' | 'kept'> {
  const { db } = deps;
  const project = await getProject(db, docs.repo);
  if (!listedOrPaused(project)) return 'kept';
  const fingerprint = await readerFingerprint(files, reading, docs.vouch);
  let last = await getModelRead(db, docs.repo);
  if (last !== null && last.readIn !== 'model') {
    // Staged in shadow and collected after the switch: the rules decided that weekly read, so their
    // reading of it, the one acted on, is the model's last read, as the weekly read's handover makes it.
    const rules = await getPolicyRead(db, docs.repo);
    await adoptRulesRead(db, docs.repo, { fingerprint: rules?.fingerprint ?? null, banned: rules?.banned ?? null });
    last = await getModelRead(db, docs.repo);
  }
  const policyReading = toPolicyReading(files, reading);
  // Either tier reading a ban is a move into one, so a ban the two disagree on still reaches an admin.
  const banned = reading.tier === 'bans_or_restricts' || reading.modelTier === 'bans_or_restricts';
  const fromFind = last?.banned == null && project.source === 'policy' && (await hasApprovedFind(db, project.repo));
  const { changed, intoBan } = compare(
    project,
    last === null ? null : { fingerprint: last.fingerprint, banned: last.banned },
    policyReading,
    fingerprint,
    fromFind,
    { sameVersion: readerComparable(last?.fingerprint ?? null), banned, welcomeMoved: await movedWelcome(db, project, docs, files, policyReading) },
  );
  if (intoBan) {
    if (readsBan(reading)) return 'second';
    // Both tiers reading a ban needs a ban line that checks out, so a ban it can't confirm is one the two tiers disagree on.
    const why =
      reading.modelTier === 'bans_or_restricts'
        ? 'the model read a ban, but no ban line it pointed at checked out in the file'
        : "the statements read a ban, but the model's own tier didn't";
    await unconfirmedBan(deps, run, project, docs, files, reading, why);
    return 'kept';
  }
  if (changed && project.source === 'policy') await sendChange(deps, run, docs, files, reading, 'changed');
  await keepModelRead(db, docs.repo, { docsHash: docs.docsHash, readerVersion: reading.readerVersion, fingerprint, banned: readsBan(reading), readIn: 'model' });
  return 'kept';
}

/**
 * Whether the project's welcome moved to another file, as welcomeMoved says,
 * and an admin hasn't already kept the listing as it is rather than list it
 * from the policy at the new link. A rejected move stays rejected until the
 * welcome moves again.
 */
async function movedWelcome(db: D1Database, project: ProjectRecord, docs: RereadDocs, files: readonly PolicyFile[], policy: PolicyReading): Promise<boolean> {
  const welcome = policy.welcome;
  if (welcome === null || !welcomeMoved(project.policy, docs.repo, docs.branch, files, true)) return false;
  return !(await rejectedPolicyLink(db, docs.repo, fileUrl(docs.repo, docs.branch, welcome.file.path)));
}

/**
 * Acts on the second reading of docs whose first reading moved into a ban.
 * When both read the ban, the listing pauses, naming no one, with the new
 * reason and the ban's line from the file. Otherwise the listing stays live,
 * as unconfirmedBan says.
 */
export async function decideSecond(
  deps: DecideDeps,
  run: DecideRun,
  docs: RereadDocs,
  files: readonly PolicyFile[],
  first: ModelReading,
  second: ModelReading,
): Promise<void> {
  const project = await getProject(deps.db, docs.repo);
  if (!listedOrPaused(project)) return;
  if (!readsBan(first) || !readsBan(second)) {
    await unconfirmedBan(deps, run, project, docs, files, first, "a second reading of the same docs didn't agree");
    return;
  }
  const policyReading = toPolicyReading(files, second);
  const ban = policyReading.ban;
  const why = {
    ban: ban === null ? null : { path: ban.file.path, line: ban.line || null, url: fileUrl(docs.repo, docs.branch, ban.file.path) },
    aiSentences: passages(policyReading),
    moreAiSentences: policyReading.moreAiSentences,
  };
  if (await pauseForCrawler(deps, project.repo, MODEL_BAN_REASON, why, true)) run.paused.push(project.repo);
  await keepModelRead(deps.db, docs.repo, {
    docsHash: docs.docsHash,
    readerVersion: first.readerVersion,
    fingerprint: await readerFingerprint(files, first, docs.vouch),
    banned: true,
    readIn: 'model',
  });
}

/**
 * Three weekly reads in a row with no verdict, once the model decides: a
 * listing made from a policy goes to the admin queue once, as a policy
 * change that says the reader can't read its docs, with the sentences that
 * name AI by the word list when the files are at hand.
 */
export async function reportNoVerdicts(deps: DecideDeps, run: DecideRun, docs: RereadDocs, files: readonly PolicyFile[]): Promise<void> {
  await sendChange(deps, run, docs, files, null, 'no_verdict');
}
