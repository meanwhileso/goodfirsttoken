import Anthropic from '@anthropic-ai/sdk';
import { anthropicApiKey, anthropicUrl, modelDailyBudgetUsd } from '../anthropic';
import {
  awaitLabelCheck,
  awaitSecondReading,
  countNoVerdict,
  countUnsent,
  dayUse,
  dropBatch,
  dropPending,
  getPendingFor,
  getProject,
  getReaderState,
  keepModelLabels,
  keepModelReading,
  listBatches,
  listPendingInBatch,
  listShadowReads,
  listStale,
  listUnsent,
  markNoVerdictsReported,
  markSent,
  setReaderState,
  settlePending,
  stagedFiles,
  type KeptReading,
  type Pending,
} from '../db';
import { decideReread, decideSecond, reportNoVerdicts, writeModelFind, type DecideRun, type RereadDocs } from './decide';
import { readerStatus } from './model';
import {
  DayBudget,
  SHARE_NAMES,
  costOf,
  findTier,
  jsonOf,
  labelRequest,
  labelStatementOf,
  nextUtcDay,
  policyRequest,
  readLabelOutput,
  readPolicyOutput,
  readerFingerprint,
  readerSettings,
  reservationOf,
  storedReading,
  utcDay,
  type CheckedLabel,
  type LabelCheck,
  type LabelStatement,
  type ModelReading,
  type ReaderRequest,
} from './reader';
import type { PolicyFile } from './rules';

// The model policy reader's hourly run (docs/specs/model-policy-reader.md,
// under Where it runs, Cost and limits, and When it can't read). It runs on
// the crawler's cron, after the crawler queues its repos. First it asks
// after each batch it sent, and collects the ones that ended, by custom_id,
// which is the pending reading's ID: it checks each reading with the
// reader's core and keeps it. Then it drops the readings that kept failing
// for 7 days, and sends the pending readings as one batch, as many as the
// day's budget allows. It never calls GitHub: the crawl consumer staged
// everything a reading needs (src/crawl/model.ts).
//
// A seed's reading that would make a find stays pending as its label check,
// which goes in the batch after it, since it sends the reading's kept
// statements. The find is written once the check is back.
//
// The reading decides, under src/crawl/decide.ts: a seed's find is written
// once its label check is back, and a weekly
// reading sends a policy change or, on a move into a ban, a second reading
// of the same staged files in the next batch, which pauses the listing when
// it agrees. A result is acted on only while its docs are the newest staged
// for the repo.

/** The most readings one batch sends, which bounds the text one run holds. */
export const MAX_BATCH_READINGS = 50;
/** How long a pending reading may keep failing before it is dropped. */
export const DROP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a batch has to end, past which its readings count as failing. The API ends every batch in 24 hours. */
const BATCH_GIVE_UP_MS = 48 * 60 * 60 * 1000;
/** How long the reader stops after the API refused its key or its request. */
export const STOP_MS = 60 * 60 * 1000;
/** The most bytes of JSON a kept reading may hold, under D1's limit on a row. */
const MAX_KEPT_BYTES = 1_500_000;
/** Weekly reads in a row with no verdict before a listing made from a policy is reported. */
export const NO_VERDICTS_TO_REPORT = 3;

/** When the reader may call the API again, after a refusal that stops it. */
const STOPPED_UNTIL = 'stopped_until';

/** What one hourly run did, for its log line. */
export interface BatchRun {
  /** Batches that had ended and were collected. */
  collected: number;
  /** Batches still in progress. */
  inProgress: number;
  /** Readings that counted. */
  read: number;
  /** Label checks that counted, whose suggested tags were kept on the reading. */
  labelsRead: number;
  /** Readings with no verdict, by why. */
  noVerdict: Record<string, number>;
  /** Readings that go in a later batch. */
  retried: number;
  /** Readings dropped, since a newer one was staged for the repo. */
  replaced: number;
  /** Readings dropped after failing for 7 days. */
  dropped: string[];
  /** Readings sent in a new batch, and the ones left for a later run. */
  sent: number;
  waiting: number;
  /** Why readings that could be sent weren't. */
  held: 'budget' | 'stopped' | 'api' | null;
  /** Dollars the collected readings cost. */
  cost: number;
  /** Readings whose system prompt came from the API's cache. */
  promptCacheHits: number;
  /** The finds the model wrote, the listings it paused, and the ones it sent to the admin queue. */
  found: string[];
  paused: string[];
  changed: string[];
  /** Why the run stopped calling the API, or null. */
  stopped: string | null;
}

export function newBatchRun(): BatchRun {
  return {
    collected: 0,
    inProgress: 0,
    read: 0,
    labelsRead: 0,
    noVerdict: {},
    retried: 0,
    replaced: 0,
    dropped: [],
    sent: 0,
    waiting: 0,
    held: null,
    cost: 0,
    promptCacheHits: 0,
    found: [],
    paused: [],
    changed: [],
    stopped: null,
  };
}

export interface BatchDeps {
  db: D1Database;
  now: () => number;
}

/** The SDK's client for the reader, with the key and URL from the environment, and no retries of its own: the next hourly run is the retry. */
function client(key: string): Anthropic {
  return new Anthropic({
    apiKey: key,
    baseURL: anthropicUrl(),
    maxRetries: 0,
    timeout: 60_000,
    // The fetch of the moment, so a test's fakes answer.
    fetch: (input, init) => fetch(input, init),
  });
}

/** How the run goes on after the API answered with an error. */
type Refusal =
  /** The key or the request is refused. The reader stops for an hour. */
  | { stop: 'key' | 'request'; until: number; message: string }
  /** Out of credit, or the workspace's spend limit is reached. It waits for the next UTC day. */
  | { stop: 'billing'; until: number; message: string }
  /** Down, overloaded, or rate limited. The next hourly run tries again. */
  | { stop: null; message: string };

/** What an error from the API means for the run. Throws anything that isn't the API's. */
function refusalOf(error: unknown, now: number): Refusal {
  if (error instanceof Anthropic.APIConnectionError) return { stop: null, message: `the API couldn't be reached: ${error.message}` };
  if (!(error instanceof Anthropic.APIError)) throw error;
  const answered: unknown = error.status;
  const status = typeof answered === 'number' ? answered : 0;
  if (status === 401 || status === 403) {
    return {
      stop: 'key',
      until: now + STOP_MS,
      message: `the API refused the ANTHROPIC_API_KEY secret with ${String(status)}${status === 403 ? ', so it may not use the model' : ''}. Check the secret and the key's workspace`,
    };
  }
  if (status === 402) return { stop: 'billing', until: nextUtcDay(now), message: 'the account is out of credit, or the workspace reached its spend limit' };
  if (status === 400 || status === 404) {
    return { stop: 'request', until: now + STOP_MS, message: `the API refused the request with ${String(status)}, which is a bug in the request: ${error.message}` };
  }
  return { stop: null, message: `the API answered ${String(status)}` };
}

/** Stops the reader for the refusal, and says why in the log. */
async function stopFor(deps: BatchDeps, run: BatchRun, refusal: Refusal, doing: string): Promise<void> {
  run.stopped = refusal.message;
  if (refusal.stop === null) {
    console.warn(`The policy reader stopped ${doing} for this run: ${refusal.message}. The next hourly run tries again.`);
    return;
  }
  await setReaderState(deps.db, STOPPED_UNTIL, String(refusal.until));
  const log = refusal.stop === 'request' ? console.error : console.warn;
  log(`The policy reader stopped ${doing} until ${new Date(refusal.until).toISOString()}: ${refusal.message}.`);
}

// ---------------------------------------------------------------------------
// Acting on readings.

/**
 * Counts a weekly read the model gave no verdict for. After three in a row,
 * a listing made from a policy goes to the admin queue once, as a policy
 * change that says the reader can't read its docs, and a registered project
 * gets a line in the log.
 */
export async function countRereadNoVerdict(
  deps: BatchDeps,
  project: string,
  why: string,
  read: { run: DecideRun; docs: RereadDocs; files: readonly PolicyFile[] },
): Promise<void> {
  const { count, reported } = await countNoVerdict(deps.db, project);
  if (count < NO_VERDICTS_TO_REPORT || reported) return;
  await markNoVerdictsReported(deps.db, project);
  const listing = await getProject(deps.db, project);
  if (listing?.source === 'policy') await reportNoVerdicts(deps, read.run, read.docs, read.files);
  console.warn(
    listing?.source === 'policy'
      ? `The policy reader gave ${project} no verdict on ${String(count)} weekly reads in a row, the last for ${why}. It goes to the admin queue as a policy change.`
      : `The policy reader gave ${project} no verdict on ${String(count)} weekly reads in a row, the last for ${why}. Its docs stay its maintainers' call.`,
  );
}

/** What a weekly read's pending reading holds, for the decisions on it. */
function docsOf(pending: Pending): RereadDocs {
  return {
    repo: pending.repo,
    branch: pending.branch,
    facts: pending.facts,
    vouch: pending.vouch,
    labels: pending.labels,
    docsHash: pending.docsHash,
  };
}

/** Records a reading or a label check with no verdict: the log says why, and a weekly read counts it. */
async function noVerdict(deps: BatchDeps, run: BatchRun, pending: Pending, why: string): Promise<void> {
  const key = pending.step === 'labels' ? `labels: ${why}` : pending.step === 'second' ? `second reading: ${why}` : why;
  run.noVerdict[key] = (run.noVerdict[key] ?? 0) + 1;
  if (pending.step === 'labels') {
    console.warn(`The policy reader gave ${pending.repo}'s labels no verdict: ${why}. Its reading is kept without the model's suggested tags.`);
    return;
  }
  console.warn(
    pending.step === 'second'
      ? `The policy reader's second reading of ${pending.repo} gave no verdict: ${why}. It pauses nothing, and the docs hash isn't kept, so the next weekly read tries again.`
      : `The policy reader gave ${pending.repo} no verdict: ${why}.`,
  );
  if (pending.purpose === 'reread') {
    await countRereadNoVerdict(deps, pending.repo, why, { run, docs: docsOf(pending), files: await stagedFiles(deps.db, pending.id) });
  }
}

/**
 * Keeps a reading that counted, and acts on it. Returns 'labels' when it is a seed's reading that would
 * make a find, so its label check follows, and 'second' when it is a move
 * into a ban, so a second reading follows.
 */
async function counted(
  deps: BatchDeps,
  run: BatchRun,
  pending: Pending,
  files: readonly PolicyFile[],
  reading: ModelReading,
  output: unknown,
): Promise<'labels' | 'second' | null> {
  const fingerprint = await readerFingerprint(files, reading, pending.vouch);
  const stored = storedReading(reading, pending.docsHash);
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  if (bytes(stored) + bytes(output) > MAX_KEPT_BYTES) {
    await noVerdict(deps, run, pending, 'a reading too large to keep');
    return null;
  }
  await keepModelReading(deps.db, { repo: pending.repo, reading: stored, fingerprint, output }, deps.now());
  run.read += 1;
  if (pending.purpose === 'seed') return findTier(reading) !== null ? 'labels' : null;
  return (await decideReread(deps, run, docsOf(pending), files, reading)) === 'second' ? 'second' : null;
}

/**
 * Writes a seed's find, once its label check is settled, whatever its
 * verdict, from the reading and the check, or null for a check with no
 * verdict. Call it before the pending reading is settled, while its staged
 * files are kept.
 */
async function findWritten(deps: BatchDeps, run: BatchRun, pending: Pending, labels: LabelCheck | null): Promise<void> {
  const files = await stagedFiles(deps.db, pending.id);
  const read = readPolicyOutput(files, pending.readingOutput);
  if (!read.ok) return;
  const found = await writeModelFind(deps, pending, files, read.reading, labels);
  if (found !== null) run.found.push(found);
}

/** A find's label check, rebuilt from the staged files and the model's policy reading, so a send and a collect read the same statements. */
interface LabelCheckOf {
  reading: ModelReading;
  statements: LabelStatement[];
  sent: CheckedLabel[];
  request: ReaderRequest;
}

/** The label check for a pending reading waiting on one, or null when its reading no longer checks out against its files. */
async function labelCheckOf(deps: BatchDeps, pending: Pending): Promise<LabelCheckOf | null> {
  const read = readPolicyOutput(await stagedFiles(deps.db, pending.id), pending.readingOutput);
  if (!read.ok) return null;
  const statements = read.reading.statements.map(labelStatementOf);
  const labels = pending.labels.map((label) => ({ name: label.name, description: label.description ?? null, openIssues: label.openIssues }));
  const { request, sent } = labelRequest(labels, statements);
  return { reading: read.reading, statements, sent, request };
}

/**
 * Acts on a label check that came back: the Worker drops names the repo
 * doesn't have, keeps good first issue out of the tags, and keeps an only
 * label the only tag (readerSettings), then keeps the tags and suggested
 * tags on the kept reading of the same docs. With no verdict the reading
 * stays without them. Either way the find is written then, by the caller,
 * once the check is settled. Returns the check, or null with no verdict.
 */
async function collectLabels(deps: BatchDeps, run: BatchRun, pending: Pending, message: Anthropic.Messages.Message): Promise<LabelCheck | null> {
  const json = jsonOf(message);
  if (!json.ok) {
    await noVerdict(deps, run, pending, json.reason);
    return null;
  }
  const check = await labelCheckOf(deps, pending);
  const read = check === null ? null : readLabelOutput(check.sent, check.statements.length, json.json);
  if (check === null || read === null) {
    await noVerdict(deps, run, pending, 'a reading that no longer checks out against its files');
    return null;
  }
  if (!read.ok) {
    await noVerdict(deps, run, pending, `output that fails the checks (${read.reason})`);
    return null;
  }
  const { settings, suggestedTags } = readerSettings(check.reading, pending.labels, read.check, pending.vouch);
  const labels = { tags: settings.tags ?? [], suggestedTags, dropped: read.check.dropped };
  if (await keepModelLabels(deps.db, pending.repo, pending.docsHash, labels)) run.labelsRead += 1;
  else run.replaced += 1;
  return read.check;
}

/**
 * Acts on a second reading for a pause that came back: with the first
 * reading of the same staged files, it pauses the listing when both read the
 * ban, and leaves it live otherwise. With no verdict it pauses nothing, and
 * counts as a weekly read with no verdict.
 */
async function collectSecond(deps: BatchDeps, run: BatchRun, pending: Pending, message: Anthropic.Messages.Message): Promise<void> {
  const json = jsonOf(message);
  if (!json.ok) {
    await noVerdict(deps, run, pending, json.reason);
    return;
  }
  const files = await stagedFiles(deps.db, pending.id);
  const first = readPolicyOutput(files, pending.firstOutput);
  const second = readPolicyOutput(files, json.json);
  if (!first.ok) await noVerdict(deps, run, pending, 'a first reading that no longer checks out against its files');
  else if (!second.ok) await noVerdict(deps, run, pending, `output that fails the checks (${second.reason})`);
  else {
    run.read += 1;
    await decideSecond(deps, run, docsOf(pending), files, first.reading, second.reading);
  }
}

// ---------------------------------------------------------------------------
// Collecting.

type Result = Anthropic.Messages.MessageBatchResult;

/** Acts on one result. A pending reading that a newer one replaced is dropped, its cost settled. */
async function collectOne(deps: BatchDeps, run: BatchRun, pending: Pending, result: Result): Promise<void> {
  let cost = 0;
  if (result.type === 'succeeded') {
    cost = costOf(result.message.usage, { batch: true });
    run.cost += cost;
    if ((result.message.usage.cache_read_input_tokens ?? 0) > 0) run.promptCacheHits += 1;
  }
  // A newer reading of the repo was staged, so this one reads docs that changed since.
  const current = await getPendingFor(deps.db, pending.repo);
  if (pending.replaced || (current !== null && current.id !== pending.id)) {
    run.replaced += 1;
    await settlePending(deps.db, pending, cost, { retry: false });
    return;
  }
  switch (result.type) {
    case 'succeeded': {
      if (pending.step === 'labels') {
        const check = await collectLabels(deps, run, pending, result.message);
        await findWritten(deps, run, pending, check);
        await settlePending(deps.db, pending, cost, { retry: false });
        return;
      }
      if (pending.step === 'second') {
        await collectSecond(deps, run, pending, result.message);
        await settlePending(deps.db, pending, cost, { retry: false });
        return;
      }
      const json = jsonOf(result.message);
      let next: 'labels' | 'second' | null = null;
      if (!json.ok) await noVerdict(deps, run, pending, json.reason);
      else {
        const files = await stagedFiles(deps.db, pending.id);
        const read = readPolicyOutput(files, json.json);
        if (read.ok) next = await counted(deps, run, pending, files, read.reading, json.json);
        else await noVerdict(deps, run, pending, `output that fails the checks (${read.reason})`);
      }
      // A reading that would make a find waits for its label check, and a move into a ban for its second reading, in the next batch.
      if (next === 'labels' && json.ok) await awaitLabelCheck(deps.db, pending, cost, json.json);
      else if (next === 'second' && json.ok) await awaitSecondReading(deps.db, pending, cost, json.json);
      else await settlePending(deps.db, pending, cost, { retry: false });
      return;
    }
    case 'errored': {
      const type = result.error.error.type;
      // An invalid request would fail again, so it is no verdict. Anything else goes in a later batch.
      if (type === 'invalid_request_error' || type === 'not_found_error') {
        await noVerdict(deps, run, pending, `an error in the result, ${type}`);
        // A label check that won't run again: the find is written without the model's suggested tags.
        if (pending.step === 'labels') await findWritten(deps, run, pending, null);
        await settlePending(deps.db, pending, 0, { retry: false });
      } else {
        run.retried += 1;
        await settlePending(deps.db, pending, 0, { retry: true });
      }
      return;
    }
    case 'expired':
    case 'canceled':
      run.retried += 1;
      await settlePending(deps.db, pending, 0, { retry: true });
      return;
  }
}

/**
 * Asks after each batch sent, and collects the ones that ended. A reading
 * the batch held that has no result goes in a later batch. Returns false when
 * the API refused, and the run stops calling it.
 */
async function collect(deps: BatchDeps, run: BatchRun, api: Anthropic): Promise<boolean> {
  for (const batch of await listBatches(deps.db)) {
    try {
      const status = await api.messages.batches.retrieve(batch.id);
      if (status.processing_status !== 'ended') {
        run.inProgress += 1;
        continue;
      }
      const held = new Map((await listPendingInBatch(deps.db, batch.id)).map((pending) => [pending.id, pending]));
      for await (const line of await api.messages.batches.results(batch.id)) {
        const pending = held.get(line.custom_id);
        // A reading dropped since, after 7 days of failing.
        if (pending === undefined) continue;
        held.delete(line.custom_id);
        try {
          await collectOne(deps, run, pending, line.result);
        } catch (error) {
          // One result the Worker fails on can't hold back the rest, or every later run.
          if (error instanceof Anthropic.APIError) throw error;
          const labels = pending.step === 'labels';
          console.error(
            labels
              ? `The policy reader couldn't keep its label check of ${pending.repo}, so its labels are no verdict.`
              : `The policy reader couldn't keep its reading of ${pending.repo}, so it is no verdict.`,
            error,
          );
          const key = labels ? 'labels: an error keeping it' : 'an error keeping it';
          run.noVerdict[key] = (run.noVerdict[key] ?? 0) + 1;
          try {
            // A label check that failed to keep: the find is still written, without the model's suggested tags.
            if (labels) await findWritten(deps, run, pending, null);
          } catch (writing) {
            console.error(`The policy reader couldn't write the find for ${pending.repo}.`, writing);
          }
          try {
            await settlePending(deps.db, pending, 0, { retry: false });
          } catch (settling) {
            console.error(`The policy reader couldn't drop its ${labels ? 'label check' : 'reading'} of ${pending.repo}.`, settling);
          }
        }
      }
      for (const pending of held.values()) {
        run.retried += 1;
        await settlePending(deps.db, pending, 0, { retry: true });
      }
      await dropBatch(deps.db, batch.id);
      run.collected += 1;
    } catch (error) {
      if (error instanceof Anthropic.NotFoundError) {
        // The API has no such batch, so its readings go in a later batch.
        for (const pending of await listPendingInBatch(deps.db, batch.id)) await settlePending(deps.db, pending, 0, { retry: !pending.replaced });
        await dropBatch(deps.db, batch.id);
        console.warn(`The policy reader found no batch ${batch.id} at the API, so its readings go in a later batch.`);
        continue;
      }
      await stopFor(deps, run, refusalOf(error, deps.now()), 'collecting batches');
      return false;
    }
  }
  return true;
}

/** Drops the readings that kept failing for 7 days, with their files, and the log names them. */
async function dropStale(deps: BatchDeps, run: BatchRun): Promise<void> {
  const now = deps.now();
  const stale = await listStale(deps.db, now - DROP_AFTER_MS, now - BATCH_GIVE_UP_MS);
  for (const pending of stale) {
    if (pending.reservedDay !== null) await settlePending(deps.db, pending, 0, { retry: false });
    run.dropped.push(pending.repo);
  }
  await dropPending(
    deps.db,
    stale.map((pending) => pending.id),
  );
  if (stale.length > 0) {
    console.warn(
      `The policy reader dropped readings that kept failing for 7 days: ${run.dropped.join(', ')}. A seed is read again at its next monthly cycle, and a listing at its next weekly read.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Sending.

/**
 * Sends the pending readings as one batch, as many as each share of the
 * day's budget allows, each with its reservation. A reading past its share
 * waits for the next UTC day.
 */
async function send(deps: BatchDeps, run: BatchRun, api: Anthropic): Promise<void> {
  const now = deps.now();
  const day = utcDay(now);
  const budget = new DayBudget(modelDailyBudgetUsd(), await dayUse(deps.db, day), now);
  const unsent = await countUnsent(deps.db);
  const chosen: { pending: Pending; request: ReaderRequest; reservedUsd: number }[] = [];
  // Each share in turn, so one that is spent holds no other back. A share
  // stops at its first reading the budget can't hold, so the oldest goes first.
  for (const share of SHARE_NAMES) {
    const room = MAX_BATCH_READINGS - chosen.length;
    if (room <= 0) break;
    for (const pending of await listUnsent(deps.db, share, room)) {
      let request: ReaderRequest;
      if (pending.step === 'labels') {
        const check = await labelCheckOf(deps, pending);
        if (check === null) {
          // Can't happen for a reading that checked out when it came back, unless its files changed under it.
          await noVerdict(deps, run, pending, 'a reading that no longer checks out against its files');
          await findWritten(deps, run, pending, null);
          await settlePending(deps.db, pending, 0, { retry: false });
          continue;
        }
        request = check.request;
      } else {
        request = policyRequest(await stagedFiles(deps.db, pending.id));
      }
      const reservedUsd = reservationOf(request, { batch: true });
      if (!budget.reserve(share, reservedUsd)) {
        run.held = 'budget';
        break;
      }
      chosen.push({ pending, request, reservedUsd });
    }
  }
  run.waiting = unsent - chosen.length;
  if (chosen.length === 0) return;
  let batch;
  try {
    batch = await api.messages.batches.create({
      requests: chosen.map(({ pending, request }) => ({ custom_id: pending.id, params: request })),
    });
  } catch (error) {
    run.held = 'api';
    run.waiting = unsent;
    await stopFor(deps, run, refusalOf(error, now), 'sending a batch');
    return;
  }
  await markSent(
    deps.db,
    {
      id: batch.id,
      day,
      readings: chosen.map(({ pending, reservedUsd }) => ({ id: pending.id, share: pending.share, reservedUsd })),
    },
    now,
  );
  run.sent = chosen.length;
}

/** Whether a reading kept in the database reads a ban that may pause a listing: both tiers say ban, and a ban line checks out. */
function keptReadsBan(reading: KeptReading['reading']): boolean {
  return reading.agree && reading.tier === 'bans_or_restricts' && reading.statements.some((s) => s.about === 'bansAi' || s.about === 'refusesOutsidePrs');
}

/**
 * The listed projects whose last model reading was kept in shadow, before
 * the model decided, and read a ban, for the log each hourly run: a listing
 * made from a policy, whose rules' last read was no ban, and whose model
 * reading of the docs its last weekly read read reads a ban. These are the
 * ones the model reads that way at their next weekly read, which takes the
 * rules' last verdict as the model's, and pauses with a second reading that
 * agrees.
 */
export async function switchWouldPause(db: D1Database): Promise<string[]> {
  const reads = await listShadowReads(db);
  return reads
    .filter((read) => read.source === 'policy' && read.rulesBanned === false && read.docsMatch && read.reading !== null && keptReadsBan(read.reading))
    .map((read) => read.project);
}

/** Logs switchWouldPause. A failure to read it is a line in the log, and holds back nothing else in the run. */
async function logSwitchPauses(deps: BatchDeps): Promise<void> {
  let projects: string[];
  try {
    projects = await switchWouldPause(deps.db);
  } catch (error) {
    console.error("The policy reader couldn't list the projects whose shadow readings read a ban.", error);
    return;
  }
  if (projects.length > 0) {
    console.log(
      `Listed projects whose shadow readings read a ban, which the model pauses at their next weekly read when a second reading agrees: ${projects.join(', ')}.`,
    );
  }
}

/**
 * The hourly run: collects the batches that ended, drops what kept failing
 * for 7 days, and sends what is pending. With no key, or a budget of 0, it
 * calls nothing. While the API's refusal stops the
 * reader, it calls nothing until then.
 */
export async function runReader(deps: BatchDeps): Promise<BatchRun | null> {
  const now = deps.now();
  const run = newBatchRun();
  // First, and whatever else happens, so no staged docs are held past 7 days.
  await dropStale(deps, run);
  const status = await readerStatus(deps.db, now);
  if (!status.reads) return null;
  const key = anthropicApiKey();
  if (key === null) return null;
  const stoppedUntil = Number(await getReaderState(deps.db, STOPPED_UNTIL));
  if (Number.isFinite(stoppedUntil) && stoppedUntil > now) {
    run.held = 'stopped';
    run.stopped = `stopped until ${new Date(stoppedUntil).toISOString()}`;
  } else {
    const api = client(key);
    if (await collect(deps, run, api)) {
      await send(deps, run, api);
    } else {
      run.held = 'api';
    }
  }
  const list = (repos: string[]) => (repos.length === 0 ? 'none' : repos.join(', '));
  await logSwitchPauses(deps);
  const spent = await dayUse(deps.db, utcDay(now));
  console.log(
    `The policy reader collected ${String(run.collected)} batches, with ${String(run.inProgress)} still in progress. Readings that counted: ${String(run.read)}, label checks that counted: ${String(run.labelsRead)}. No verdict: ${JSON.stringify(run.noVerdict)}. Tried again later: ${String(run.retried)}, dropped for newer docs: ${String(run.replaced)}. Finds written: ${list(run.found)}, listings paused: ${list(run.paused)}, sent to the admin queue: ${list(run.changed)}. Sent: ${String(run.sent)}, waiting: ${String(run.waiting)}${run.held === null ? '' : `, held by ${run.held}`}. Cost: $${run.cost.toFixed(4)}, with ${String(run.promptCacheHits)} prompt cache hits. Used today: $${Object.values(spent).reduce((a, b) => a + b, 0).toFixed(4)} of $${modelDailyBudgetUsd().toFixed(2)}, ${JSON.stringify(spent)}.${run.stopped === null ? '' : ` Stopped: ${run.stopped}.`}`,
  );
  return run;
}
