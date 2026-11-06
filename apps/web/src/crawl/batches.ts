import Anthropic from '@anthropic-ai/sdk';
import type { DocsHash } from '@goodfirsttoken/core';
import { anthropicApiKey, anthropicUrl, modelDailyBudgetUsd } from '../anthropic';
import {
  awaitLabelCheck,
  countNoVerdict,
  countUnsent,
  dayUse,
  dropBatch,
  dropPending,
  getModelRead,
  getPendingFor,
  getProject,
  getReaderState,
  keepModelLabels,
  keepModelRead,
  keepModelReading,
  listBatches,
  listPendingInBatch,
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
  policyTier,
  readLabelOutput,
  readPolicyOutput,
  readerFingerprint,
  readerSettings,
  readsBan,
  reservationOf,
  storedReading,
  utcDay,
  type CheckedLabel,
  type LabelStatement,
  type ModelReading,
  type ReaderRequest,
} from './reader';
import { READER_FINGERPRINT_VERSION } from './reader/fingerprint';

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
// With POLICY_READER=shadow the rules decide. A reading is kept, shown in
// the admin queue beside the rules' reading of the same docs, and counted
// in the log. The label check's suggested tags are kept on the reading, and
// shown beside the rules'. It lists nothing and pauses nothing.

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
  /** Readings whose tier the rules and the model agree on, and disagree on. */
  agree: number;
  disagree: number;
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
  /** Seeds the model would have found that the rules read as a ban, or as no policy. */
  wouldFind: string[];
  /** Listings the model reads as moved into a ban, or as changed, where the rules didn't. */
  wouldPause: string[];
  wouldChange: string[];
  /** Why the run stopped calling the API, or null. */
  stopped: string | null;
}

export function newBatchRun(): BatchRun {
  return {
    collected: 0,
    inProgress: 0,
    read: 0,
    labelsRead: 0,
    agree: 0,
    disagree: 0,
    noVerdict: {},
    retried: 0,
    replaced: 0,
    dropped: [],
    sent: 0,
    waiting: 0,
    held: null,
    cost: 0,
    promptCacheHits: 0,
    wouldFind: [],
    wouldPause: [],
    wouldChange: [],
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
// Acting on readings, in shadow.

/** The rules' tier and the model's, as the log counts their agreement. */
function countAgreement(run: BatchRun, rulesTier: string, reading: ModelReading): void {
  if (policyTier(reading) === rulesTier) run.agree += 1;
  else run.disagree += 1;
}

/**
 * What a weekly read's model reading would do, in shadow: it keeps the
 * reading's docs hash and fingerprint for the next weekly read, and the log
 * names a listing the model reads as moved into a ban, or as changed. The
 * fingerprint of another version compares with nothing, as the rules' does.
 */
export async function keepRereadReading(
  deps: BatchDeps,
  run: { wouldPause: string[]; wouldChange: string[] },
  project: string,
  kept: { docsHash: DocsHash; readerVersion: string; fingerprint: string; banned: boolean },
): Promise<void> {
  const last = await getModelRead(deps.db, project);
  if (last === null) return;
  const comparable = last.fingerprint?.startsWith(`v${String(READER_FINGERPRINT_VERSION)}:`) === true;
  if (kept.banned && last.banned !== true) run.wouldPause.push(project);
  else if (comparable && last.fingerprint !== kept.fingerprint) run.wouldChange.push(project);
  await keepModelRead(deps.db, project, kept);
}

/**
 * Counts a weekly read the model gave no verdict for. After three in a row,
 * a listing made from a policy would go to the admin queue once, as a policy
 * change that says the reader can't read its docs, and a registered project
 * gets a line in the log. In shadow both are a line in the log.
 */
export async function countRereadNoVerdict(deps: BatchDeps, project: string, why: string): Promise<void> {
  const { count, reported } = await countNoVerdict(deps.db, project);
  if (count < NO_VERDICTS_TO_REPORT || reported) return;
  await markNoVerdictsReported(deps.db, project);
  const listing = await getProject(deps.db, project);
  console.warn(
    listing?.source === 'policy'
      ? `The policy reader gave ${project} no verdict on ${String(count)} weekly reads in a row, the last for ${why}. In shadow the rules still read it. Once the model decides, it goes to the admin queue as a policy change.`
      : `The policy reader gave ${project} no verdict on ${String(count)} weekly reads in a row, the last for ${why}. Its docs stay its maintainers' call.`,
  );
}

/** A weekly read whose docs the model read before, with this reader version: the kept reading stands for the new read. */
export async function rereadFromKept(deps: BatchDeps, run: { wouldPause: string[]; wouldChange: string[] }, project: string, kept: KeptReading): Promise<void> {
  await keepRereadReading(deps, run, project, {
    docsHash: kept.docsHash,
    readerVersion: kept.readerVersion,
    fingerprint: kept.fingerprint,
    banned: kept.reading.agree && kept.reading.tier === 'bans_or_restricts' && kept.reading.statements.some((s) => s.about === 'bansAi' || s.about === 'refusesOutsidePrs'),
  });
}

/** Records a reading or a label check with no verdict: the log says why, and a weekly read counts it. */
async function noVerdict(deps: BatchDeps, run: BatchRun, pending: Pending, why: string): Promise<void> {
  const key = pending.step === 'labels' ? `labels: ${why}` : why;
  run.noVerdict[key] = (run.noVerdict[key] ?? 0) + 1;
  if (pending.step === 'labels') {
    console.warn(`The policy reader gave ${pending.repo}'s labels no verdict: ${why}. Its reading is kept without the model's suggested tags.`);
    return;
  }
  console.warn(`The policy reader gave ${pending.repo} no verdict: ${why}.`);
  if (pending.purpose === 'reread') await countRereadNoVerdict(deps, pending.repo, why);
}

/**
 * Keeps a reading that counted, and what it would do. Returns true when it
 * is a seed's reading that would make a find, so its label check follows.
 */
async function counted(deps: BatchDeps, run: BatchRun, pending: Pending, reading: ModelReading, output: unknown): Promise<boolean> {
  const files = await stagedFiles(deps.db, pending.id);
  const fingerprint = await readerFingerprint(files, reading, pending.vouch);
  const stored = storedReading(reading, pending.docsHash);
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  if (bytes(stored) + bytes(output) > MAX_KEPT_BYTES) {
    await noVerdict(deps, run, pending, 'a reading too large to keep');
    return false;
  }
  await keepModelReading(deps.db, { repo: pending.repo, reading: stored, fingerprint, output }, deps.now());
  run.read += 1;
  countAgreement(run, pending.rulesTier, reading);
  if (pending.purpose === 'seed') return findTier(reading) !== null;
  await keepRereadReading(deps, run, pending.repo, {
    docsHash: pending.docsHash,
    readerVersion: reading.readerVersion,
    fingerprint,
    banned: readsBan(reading),
  });
  return false;
}

/**
 * What a seed's find would be once its label check is done. In shadow the
 * rules write the finds, so the log names a seed the model would have found
 * that the rules didn't.
 */
function findWritten(run: BatchRun, pending: Pending): void {
  const rulesFind = pending.rulesTier === 'invites_agents' || pending.rulesTier === 'allows_with_conditions';
  if (!rulesFind) run.wouldFind.push(pending.repo);
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
 * once the check is settled.
 */
async function collectLabels(deps: BatchDeps, run: BatchRun, pending: Pending, message: Anthropic.Messages.Message): Promise<void> {
  const json = jsonOf(message);
  if (!json.ok) {
    await noVerdict(deps, run, pending, json.reason);
  } else {
    const check = await labelCheckOf(deps, pending);
    const read = check === null ? null : readLabelOutput(check.sent, check.statements.length, json.json);
    if (check === null || read === null) await noVerdict(deps, run, pending, 'a reading that no longer checks out against its files');
    else if (!read.ok) await noVerdict(deps, run, pending, `output that fails the checks (${read.reason})`);
    else {
      const { settings, suggestedTags } = readerSettings(check.reading, pending.labels, read.check, pending.vouch);
      const labels = { tags: settings.tags ?? [], suggestedTags, dropped: read.check.dropped };
      if (await keepModelLabels(deps.db, pending.repo, pending.docsHash, labels)) run.labelsRead += 1;
      else run.replaced += 1;
    }
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
        await collectLabels(deps, run, pending, result.message);
        await settlePending(deps.db, pending, cost, { retry: false });
        findWritten(run, pending);
        return;
      }
      const json = jsonOf(result.message);
      let labelsNext = false;
      if (!json.ok) await noVerdict(deps, run, pending, json.reason);
      else {
        const files = await stagedFiles(deps.db, pending.id);
        const read = readPolicyOutput(files, json.json);
        if (read.ok) labelsNext = await counted(deps, run, pending, read.reading, json.json);
        else await noVerdict(deps, run, pending, `output that fails the checks (${read.reason})`);
      }
      // A reading that would make a find waits for its label check, in the next batch.
      if (labelsNext && json.ok) await awaitLabelCheck(deps.db, pending, cost, json.json);
      else await settlePending(deps.db, pending, cost, { retry: false });
      return;
    }
    case 'errored': {
      const type = result.error.error.type;
      // An invalid request would fail again, so it is no verdict. Anything else goes in a later batch.
      if (type === 'invalid_request_error' || type === 'not_found_error') {
        await noVerdict(deps, run, pending, `an error in the result, ${type}`);
        await settlePending(deps.db, pending, 0, { retry: false });
        // A label check that won't run again: the find is written without the model's suggested tags.
        if (pending.step === 'labels') findWritten(run, pending);
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
            await settlePending(deps.db, pending, 0, { retry: false });
          } catch (settling) {
            console.error(`The policy reader couldn't drop its ${labels ? 'label check' : 'reading'} of ${pending.repo}.`, settling);
          }
          if (labels) findWritten(run, pending);
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
          findWritten(run, pending);
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

/**
 * The hourly run: collects the batches that ended, drops what kept failing
 * for 7 days, and sends what is pending. With no key, a budget of 0, or the
 * rules alone deciding, it calls nothing. While the API's refusal stops the
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
  const spent = await dayUse(deps.db, utcDay(now));
  console.log(
    `The policy reader collected ${String(run.collected)} batches, with ${String(run.inProgress)} still in progress. Readings that counted: ${String(run.read)}, label checks that counted: ${String(run.labelsRead)}, where the model and the rules agree on the tier: ${String(run.agree)}, disagree: ${String(run.disagree)}. No verdict: ${JSON.stringify(run.noVerdict)}. Tried again later: ${String(run.retried)}, dropped for newer docs: ${String(run.replaced)}. Seeds the model would have found that the rules didn't: ${list(run.wouldFind)}. Listings the model reads as moved into a ban: ${list(run.wouldPause)}, as changed: ${list(run.wouldChange)}. Sent: ${String(run.sent)}, waiting: ${String(run.waiting)}${run.held === null ? '' : `, held by ${run.held}`}. Cost: $${run.cost.toFixed(4)}, with ${String(run.promptCacheHits)} prompt cache hits. Used today: $${Object.values(spent).reduce((a, b) => a + b, 0).toFixed(4)} of $${modelDailyBudgetUsd().toFixed(2)}, ${JSON.stringify(spent)}.${run.stopped === null ? '' : ` Stopped: ${run.stopped}.`}`,
  );
  return run;
}
