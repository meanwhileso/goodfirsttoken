import Anthropic from '@anthropic-ai/sdk';
import { MAX_TAGS } from '@goodfirsttoken/core';
import { anthropicApiKey, anthropicUrl, modelDailyBudgetUsd } from '../anthropic';
import { reserveSpend, settleSpend, getRegisterLabelCheck, keepRegisterLabelCheck, countRegisterLabelCheck } from '../db';
import { costOf, jsonOf, labelRequest, readLabelOutput, reservationOf, SHARES, utcDay } from '../crawl/reader';
import { READER_VERSION } from '../crawl/reader/version';
import type { RepoLabel } from '../crawl/rules';
import { keptForPeople } from './rules';

// The label check register_project makes (docs/specs/model-policy-reader.md,
// under In register_project): the model reads the repo's labels, with their
// descriptions and open issue counts, and says which mean ready for outside
// help. A maintainer's agent waits on it, so it goes to the Messages API
// directly, streamed, at medium effort, within LABEL_CHECK.timeoutMs, with
// the SDK's two retries inside that time. It only suggests: the maintainer
// confirms or changes every tag before anything saves.
//
// It runs only with a key. One check is kept per
// label set, by a hash of the repo, its label names and descriptions, and
// the reader version. One caller gets at most 10 checks a UTC day, and one
// repo at most 3. It spends from register_project's share of the day's
// budget, at most 10%, and reserves the most the call could cost before it
// calls. When it can't run, for any of these or because the call fails,
// times out, or gives no verdict, the proposal falls back to meansReady.

export const LABEL_CHECK = {
  /** How long a proposal waits on the check, retries included. Tests shorten it. */
  timeoutMs: 90_000,
  /** The SDK's retries, inside the timeout. */
  retries: 2,
  /** The most checks one caller makes in a UTC day, and one repo. */
  perCaller: 10,
  perRepo: 3,
};

/** What the label check gave: the tags, or why it didn't run, for the proposal's reason. */
export type LabelCheckOutcome = { tags: string[] } | { fallback: string };

/** The key a label set's check is kept by: the reader version, the repo, and each label's name and description, sorted. */
async function keyOf(repo: string, labels: readonly RepoLabel[]): Promise<string> {
  const set = labels.map((label) => [label.name, label.description ?? null] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const text = JSON.stringify([READER_VERSION, repo.toLowerCase(), set]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The tags from what the model read: the labels ready for outside help or for agents only, good first issue left out, each once. */
function tagsOf(check: { ready: readonly RepoLabel[]; agentsOnly: readonly RepoLabel[] }): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const label of [...check.ready, ...check.agentsOnly]) {
    const key = label.name.toLowerCase();
    if (keptForPeople(label.name) || seen.has(key)) continue;
    seen.add(key);
    tags.push(label.name);
  }
  return tags.slice(0, MAX_TAGS);
}

/**
 * The tags the model reads as ready for outside help in the repo's labels,
 * for register_project's proposal, or why it falls back to meansReady.
 */
export async function checkLabels(
  db: D1Database,
  ask: { caller: number; repo: string; labels: readonly RepoLabel[]; now: number },
): Promise<LabelCheckOutcome> {
  const apiKey = anthropicApiKey();
  if (apiKey === null) return { fallback: 'the model reader has no key' };
  const budget = modelDailyBudgetUsd();
  if (budget <= 0) return { fallback: 'the model reader has no budget' };
  if (ask.labels.length === 0) return { fallback: 'the repo has no labels to check' };
  const key = await keyOf(ask.repo, ask.labels);
  const kept = await getRegisterLabelCheck(db, key);
  if (kept !== null) return { tags: kept };

  const day = utcDay(ask.now);
  const { request, sent } = labelRequest(ask.labels.map((label) => ({ name: label.name, description: label.description ?? null, openIssues: label.openIssues })));
  const reserved = reservationOf(request, { batch: false });
  if (!(await reserveSpend(db, { day, share: 'register', cost: reserved, budget, shareBudget: budget * SHARES.register }))) {
    return { fallback: "the model reader spent its share of today's budget for registrations" };
  }

  let spent = 0;
  try {
    // Counted only once the share holds it, so a check that never calls the model takes none of the limits.
    const counted = await countRegisterLabelCheck(
      db,
      { day, caller: ask.caller, repo: ask.repo, perCaller: LABEL_CHECK.perCaller, perRepo: LABEL_CHECK.perRepo },
      ask.now,
    );
    if (!counted) return { fallback: 'the model reader checked labels as many times today as one maintainer or one repo may' };
    const client = new Anthropic({
      apiKey,
      baseURL: anthropicUrl(),
      maxRetries: LABEL_CHECK.retries,
      timeout: LABEL_CHECK.timeoutMs,
      // The fetch of the moment, so a test's fakes answer.
      fetch: (input, init) => fetch(input, init),
    });
    // Streamed, so a long answer doesn't time out mid-way, and cut off at the timeout whatever the retries.
    const message = await client.messages.stream(request, { signal: AbortSignal.timeout(LABEL_CHECK.timeoutMs) }).finalMessage();
    spent = costOf(message.usage, { batch: false });
    const json = jsonOf(message);
    if (!json.ok) {
      console.warn(`register_project's label check of ${ask.repo} gave no verdict: ${json.reason}. The proposal reads the labels by name.`);
      return { fallback: 'the model reader gave no verdict on the labels' };
    }
    const read = readLabelOutput(sent, 0, json.json);
    if (!read.ok) {
      console.warn(`register_project's label check of ${ask.repo} failed the checks: ${read.reason}. The proposal reads the labels by name.`);
      return { fallback: 'the model reader gave no verdict on the labels' };
    }
    const tags = tagsOf(read.check);
    await keepRegisterLabelCheck(db, { key, repo: ask.repo, tags }, ask.now);
    return { tags };
  } catch (error) {
    // The API's errors, a timeout, or anything else: the proposal never waits on the model, or fails for it.
    // An error the API answered with bills nothing. A timeout, or a stream cut off, may have, so it counts what was reserved.
    if (!(error instanceof Anthropic.APIError) || error instanceof Anthropic.APIConnectionError || error instanceof Anthropic.APIUserAbortError) spent = reserved;
    const log = error instanceof Anthropic.APIError ? console.warn : console.error;
    log(`register_project's label check of ${ask.repo} failed, so the proposal reads the labels by name.`, error instanceof Error ? error.message : error);
    return { fallback: "the model reader's check of the labels failed" };
  } finally {
    await settleSpend(db, { day, share: 'register', reserved, spent });
  }
}
