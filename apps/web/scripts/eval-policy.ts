// The model policy reader's eval: every case in test/crawl/corpus/ and each
// real repo in it, three times, through the reader's core in
// src/crawl/reader/, with the Message Batches API, as the crawler will send
// them. It reports per case, per run, the totals against the pass bar in
// docs/specs/model-policy-reader.md, and what the run cost. It writes full
// results to apps/web/.eval/policy/, which git ignores, and a summary to
// commit to apps/web/evals/policy-reader.json: scores and failed case IDs,
// with no text from real repos.
//
//   pnpm eval:policy --dry-run         print every request and the estimated cost, and send nothing
//   pnpm eval:policy                   run it, after showing the estimate and asking
//   pnpm eval:policy --yes             run it without asking
//   pnpm eval:policy --runs 1          run each case once
//   pnpm eval:policy --only ban/,model/  run the cases whose IDs start with these
//   pnpm eval:policy --resume <folder> pick up a run whose batches were sent
//
// A real run needs ANTHROPIC_API_KEY in the shell and costs about $60 to
// $100. It never runs in CI or in pnpm test. A dry run needs no key and no
// network: it swaps fetch for one that throws, so anything that tried to
// send would fail.

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  checkRequest,
  costOf,
  estimateTokens,
  jsonOf,
  labelRequest,
  labelStatementOf,
  MODEL,
  PRICES,
  policyRequest,
  READER_VERSION,
  readCheckOutput,
  readLabelOutput,
  readPolicyOutput,
  type CheckedLabel,
  type ModelReading,
  type ReaderRequest,
} from '../src/crawl/reader/index.ts';
import type { PolicyFile } from '../src/crawl/rules.ts';
import { CASES, REAL_REPOS, type PolicyCase } from '../test/crawl/corpus/index.ts';
import { failuresOf, passBar, type CaseOutcome, type RunOutcome } from './eval/score.ts';

const APP = new URL('../', import.meta.url);
const RESULTS = new URL('.eval/policy/', APP);
const SUMMARY = new URL('evals/policy-reader.json', APP);

/** The output a call is guessed to write, thinking included, for the estimate. The shadow run measures it. */
const OUTPUT_GUESS = { policy: 6_000, check: 6_000, labels: 1_500 } as const;
/** The size a real repo's files are guessed at in a dry run, which can't fetch them. */
const REAL_REPO_GUESS_CHARS = 60_000;
const POLL_MS = 60_000;

type Kind = keyof typeof OUTPUT_GUESS;

interface Planned {
  customId: string;
  caseIndex: number;
  run: number;
  kind: Kind;
  params: ReaderRequest;
  /** For a label check, the labels it sent. */
  sent?: CheckedLabel[];
  statements?: number;
}

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    runs: { type: 'string', default: '3' },
    only: { type: 'string' },
    resume: { type: 'string' },
  },
});
const RUNS = Number(args.runs);
if (!Number.isInteger(RUNS) || RUNS < 1 || RUNS > 5) throw new Error('--runs takes a whole number from 1 to 5');
const dryRun = args['dry-run'];

if (dryRun) {
  globalThis.fetch = () => Promise.reject(new Error('A dry run sends nothing.'));
}

// ---------------------------------------------------------------------------
// The cases.

/** A real repo as a case, with its files fetched, or guessed at in a dry run. */
async function realCases(): Promise<PolicyCase[]> {
  const cases: PolicyCase[] = [];
  for (const repo of REAL_REPOS) {
    const files: PolicyFile[] = [];
    for (const { kind, path } of repo.files) {
      let text: string;
      if (dryRun) {
        text = `(${path} at ${repo.commit}, fetched when the eval runs)\n`.padEnd(Math.round(REAL_REPO_GUESS_CHARS / repo.files.length), '.');
      } else {
        const response = await fetch(`https://raw.githubusercontent.com/${repo.repo}/${repo.commit}/${path}`);
        if (!response.ok) throw new Error(`${repo.repo}: ${path} at ${repo.commit} gave ${String(response.status)}`);
        text = await response.text();
      }
      files.push({ kind, path, text });
    }
    cases.push({ id: `real/${repo.repo}`, group: 'realRepo', files, expect: { tier: repo.tiers }, note: repo.verdict });
  }
  return cases;
}

function chosen(cases: PolicyCase[]): PolicyCase[] {
  const prefixes = args.only?.split(',').map((p) => p.trim()).filter((p) => p !== '');
  return prefixes === undefined ? cases : cases.filter((c) => prefixes.some((p) => c.id.startsWith(p)));
}

// ---------------------------------------------------------------------------
// The requests.

/** The first round: each case's policy reading, its check reading, and a label check of labels alone. */
function roundOne(cases: readonly PolicyCase[]): Planned[] {
  const planned: Planned[] = [];
  cases.forEach((c, caseIndex) => {
    for (let run = 0; run < RUNS; run++) {
      const id = (kind: string) => `${kind}-${String(caseIndex)}-${String(run)}`;
      if (c.files.length > 0) planned.push({ customId: id('p'), caseIndex, run, kind: 'policy', params: policyRequest(c.files) });
      if (c.expect.check !== undefined) planned.push({ customId: id('c'), caseIndex, run, kind: 'check', params: checkRequest(c.files) });
      if (c.labels !== undefined && c.files.length === 0) {
        const { request, sent } = labelRequest(c.labels);
        planned.push({ customId: id('l'), caseIndex, run, kind: 'labels', params: request, sent, statements: 0 });
      }
    }
  });
  return planned;
}

/** The second round: a label check with the statements each run's reading kept, as a find sends it. */
function roundTwo(cases: readonly PolicyCase[], readings: ReadonlyMap<string, ModelReading>): Planned[] {
  const planned: Planned[] = [];
  cases.forEach((c, caseIndex) => {
    if (c.labels === undefined || c.files.length === 0) return;
    for (let run = 0; run < RUNS; run++) {
      const reading = readings.get(`${String(caseIndex)}-${String(run)}`);
      const statements = reading?.statements.map(labelStatementOf) ?? [];
      const { request, sent } = labelRequest(c.labels, statements);
      planned.push({ customId: `l-${String(caseIndex)}-${String(run)}`, caseIndex, run, kind: 'labels', params: request, sent, statements: statements.length });
    }
  });
  return planned;
}

function systemText(params: ReaderRequest): string {
  return typeof params.system === 'string' ? params.system : (params.system ?? []).map((block) => block.text).join('\n');
}

/** What a request is guessed to cost at batch prices, and the most it could cost. */
function estimate(planned: Planned): { likely: number; most: number } {
  const price = PRICES[MODEL];
  if (price === undefined) throw new Error(`No price for ${MODEL}`);
  const system = estimateTokens(systemText(planned.params));
  const rest = estimateTokens(JSON.stringify(planned.params.messages));
  const input = system * price.cacheWrite1h + rest * price.input;
  const cost = (output: number) => ((input + output * price.output) / 1_000_000) * 0.5;
  return { likely: cost(OUTPUT_GUESS[planned.kind]), most: cost(planned.params.max_tokens) };
}

function printEstimate(round1: readonly Planned[], round2: readonly Planned[]): number {
  const all = [...round1, ...round2];
  const byKind = new Map<Kind, { count: number; likely: number; most: number }>();
  for (const planned of all) {
    const { likely, most } = estimate(planned);
    const sum = byKind.get(planned.kind) ?? { count: 0, likely: 0, most: 0 };
    byKind.set(planned.kind, { count: sum.count + 1, likely: sum.likely + likely, most: sum.most + most });
  }
  const dollars = (value: number) => `$${value.toFixed(2)}`;
  let likely = 0;
  let most = 0;
  console.log(`\nEstimated cost at batch prices, for ${String(RUNS)} runs of each case, with no cache hits:`);
  for (const [kind, sum] of byKind) {
    console.log(`  ${kind.padEnd(7)} ${String(sum.count).padStart(5)} requests  likely ${dollars(sum.likely).padStart(9)}  at most ${dollars(sum.most)}`);
    likely += sum.likely;
    most += sum.most;
  }
  console.log(`  total   ${String(all.length).padStart(5)} requests  likely ${dollars(likely).padStart(9)}  at most ${dollars(most)}`);
  console.log(
    `  The guess counts a token for every 3 characters, the system prompt as a one-hour cache write, and ${String(OUTPUT_GUESS.policy)} output tokens a reading, ${String(OUTPUT_GUESS.labels)} a label check. "At most" counts max_tokens.`,
  );
  if (round2.length > 0) console.log(`  ${String(round2.length)} label checks go in a second batch, with the statements each run's reading kept.`);
  return likely;
}

// ---------------------------------------------------------------------------
// A dry run.

function printRequests(cases: readonly PolicyCase[], round1: readonly Planned[], round2: readonly Planned[]): void {
  const systems = new Map<string, string>();
  const nameOf = (text: string) => {
    let name = systems.get(text);
    if (name === undefined) {
      name = `system prompt ${String(systems.size + 1)}`;
      systems.set(text, name);
    }
    return name;
  };
  const lines = [...round1.map((p) => [1, p] as const), ...round2.map((p) => [2, p] as const)].map(([round, planned]) => {
    const { system, ...rest } = planned.params;
    const cached = Array.isArray(system) ? system[0]?.cache_control : undefined;
    return JSON.stringify({
      round,
      custom_id: planned.customId,
      case: cases[planned.caseIndex]?.id,
      run: planned.run + 1,
      kind: planned.kind,
      ...(round === 2 ? { note: 'Built here with no statements. A real run sends the statements its reading kept.' } : {}),
      params: { ...rest, system: `<${nameOf(systemText(planned.params))}, cache_control ${JSON.stringify(cached)}>` },
    });
  });
  for (const [text, name] of systems) console.log(`===== ${name} =====\n${text}\n`);
  console.log('===== requests, one JSON object a line =====');
  for (const line of lines) console.log(line);
}

// ---------------------------------------------------------------------------
// A real run.

interface State {
  readerVersion: string;
  runs: number;
  cases: string;
  batches: Partial<Record<'round1' | 'round2', string>>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendBatch(client: Anthropic, planned: readonly Planned[]): Promise<string> {
  const batch = await client.messages.batches.create({ requests: planned.map((p) => ({ custom_id: p.customId, params: p.params })) });
  console.log(`Sent batch ${batch.id} with ${String(planned.length)} requests.`);
  return batch.id;
}

type BatchResult = Anthropic.Messages.Batches.MessageBatchResult;

async function collect(client: Anthropic, id: string): Promise<Map<string, BatchResult>> {
  for (;;) {
    const batch = await client.messages.batches.retrieve(id);
    const { processing, succeeded, errored, canceled, expired } = batch.request_counts;
    console.log(`Batch ${id}: ${batch.processing_status}, ${String(processing)} processing, ${String(succeeded)} succeeded, ${String(errored + canceled + expired)} did not.`);
    if (batch.processing_status === 'ended') break;
    await sleep(POLL_MS);
  }
  const results = new Map<string, BatchResult>();
  for await (const entry of await client.messages.batches.results(id)) results.set(entry.custom_id, entry.result);
  return results;
}

/** The message a result holds, or why there is none. */
function messageOf(result: BatchResult | undefined): { ok: true; message: Anthropic.Messages.Message } | { ok: false; reason: string } {
  if (result === undefined) return { ok: false, reason: 'no result' };
  if (result.type === 'succeeded') return { ok: true, message: result.message };
  if (result.type === 'errored') return { ok: false, reason: `errored: ${result.error.error.type}` };
  return { ok: false, reason: result.type };
}

async function confirm(likely: number): Promise<void> {
  if (args.yes) return;
  if (!process.stdin.isTTY) throw new Error('A real run costs money. Pass --yes to run it without a terminal to ask in.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nThis run is likely to cost about $${likely.toFixed(2)}. Type yes to send it: `);
  rl.close();
  if (answer.trim() !== 'yes') throw new Error('Nothing sent.');
}

async function main(): Promise<void> {
  const cases = chosen([...CASES, ...(await realCases())]);
  if (cases.length === 0) throw new Error('No case matches --only.');
  const round1 = roundOne(cases);
  const preview = roundTwo(cases, new Map());
  console.log(`${String(cases.length)} cases, ${String(RUNS)} runs each, reader ${READER_VERSION}.`);

  if (dryRun) {
    printRequests(cases, round1, preview);
    printEstimate(round1, preview);
    console.log('\nA dry run sends nothing.');
    return;
  }

  if (process.env.ANTHROPIC_API_KEY === undefined || process.env.ANTHROPIC_API_KEY === '') {
    throw new Error('A real run needs ANTHROPIC_API_KEY in the shell. A dry run, with --dry-run, needs none.');
  }
  const likely = printEstimate(round1, preview);

  const casesKey = createHash('sha256').update(cases.map((c) => c.id).join('\n')).digest('hex');
  const folder = args.resume === undefined ? new URL(`${new Date().toISOString().replace(/[:.]/g, '-')}/`, RESULTS) : new URL(args.resume.replace(/\/?$/, '/'), `file://${process.cwd()}/`);
  const stateFile = new URL('state.json', folder);
  let state: State = { readerVersion: READER_VERSION, runs: RUNS, cases: casesKey, batches: {} };
  if (args.resume !== undefined) {
    if (!existsSync(stateFile)) throw new Error(`No run to resume in ${fileURLToPath(folder)}`);
    state = JSON.parse(readFileSync(stateFile, 'utf8')) as State;
    if (state.readerVersion !== READER_VERSION || state.runs !== RUNS || state.cases !== casesKey) {
      throw new Error('That run was made with another reader version, number of runs, or set of cases.');
    }
  } else await confirm(likely);
  mkdirSync(folder, { recursive: true });
  const save = () => { writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`); };
  save();

  const client = new Anthropic();
  state.batches.round1 ??= await sendBatch(client, round1);
  save();
  const first = await collect(client, state.batches.round1);

  const outcomes: CaseOutcome[] = cases.map((c) => ({ case: c, runs: Array.from({ length: RUNS }, (): RunOutcome => ({})) }));
  const readings = new Map<string, ModelReading>();
  const raw: Record<string, unknown> = {};
  let cost = 0;
  const read = (planned: Planned, result: BatchResult | undefined) => {
    raw[planned.customId] = result;
    const c = cases[planned.caseIndex];
    const outcome = outcomes[planned.caseIndex]?.runs[planned.run];
    if (c === undefined || outcome === undefined) return;
    const got = messageOf(result);
    if (got.ok) cost += costOf(got.message.usage, { batch: true });
    const json = got.ok ? jsonOf(got.message) : got;
    if (planned.kind === 'policy') {
      const result = json.ok ? readPolicyOutput(c.files, json.json) : json;
      if (!result.ok) outcome.reading = { ok: false, reason: result.reason };
      else {
        const r = result.reading;
        readings.set(`${String(planned.caseIndex)}-${String(planned.run)}`, r);
        outcome.reading = {
          ok: true,
          tier: r.tier,
          modelTier: r.modelTier,
          agree: r.agree,
          statements: r.statements.map((s) => ({ about: s.about, path: s.file.path, startLine: s.startLine, endLine: s.endLine, label: s.label, value: s.value })),
          dropped: r.dropped.length,
          steering: r.steering.map((s) => ({ path: s.file.path, startLine: s.startLine, endLine: s.endLine })),
        };
      }
    } else if (planned.kind === 'check') {
      const result = json.ok ? readCheckOutput(c.files, json.json) : json;
      outcome.check = result.ok ? { ok: true, clears: result.check.clears, kinds: result.check.findings.map((f) => f.kind) } : { ok: false, reason: result.reason };
    } else {
      const result = json.ok ? readLabelOutput(planned.sent ?? [], planned.statements ?? 0, json.json) : json;
      outcome.labels = result.ok
        ? { ok: true, ready: result.check.ready.map((l) => l.name), keptForPeople: result.check.keptForPeople.map((l) => l.name), agentsOnly: result.check.agentsOnly.map((l) => l.name) }
        : { ok: false, reason: result.reason };
    }
  };
  for (const planned of round1) read(planned, first.get(planned.customId));

  const round2 = roundTwo(cases, readings);
  if (round2.length > 0) {
    state.batches.round2 ??= await sendBatch(client, round2);
    save();
    const second = await collect(client, state.batches.round2);
    for (const planned of round2) read(planned, second.get(planned.customId));
  }

  report(outcomes, cost);
  writeFileSync(new URL('results.json', folder), `${JSON.stringify({ readerVersion: READER_VERSION, outcomes, raw }, null, 2)}\n`);
  console.log(`\nFull results: ${fileURLToPath(new URL('results.json', folder))}`);
}

function report(outcomes: readonly CaseOutcome[], cost: number): void {
  console.log('\nPer case, per run:');
  for (const o of outcomes) {
    const runs = o.runs.map((run, index) => {
      const failures = failuresOf(o.case, run);
      const tier = run.reading?.ok === true ? run.reading.tier : '';
      return `${String(index + 1)}:${failures.length === 0 ? 'pass' : `FAIL (${failures.join(', ')})`}${tier === '' ? '' : ` ${tier}`}`;
    });
    console.log(`  ${o.case.id.padEnd(44)} ${runs.join('  ')}`);
  }
  const bar = passBar(outcomes);
  console.log('\nThe pass bar:');
  for (const line of bar) console.log(`  ${String(line.bar)}. ${line.name.padEnd(11)} ${line.pass ? 'pass' : 'FAIL'}  ${line.score}`);
  const passes = bar.every((line) => line.pass);
  console.log(`\n${passes ? 'The reader meets the pass bar.' : 'The reader does not meet the pass bar.'} The run cost $${cost.toFixed(2)}.`);
  const summary = {
    readerVersion: READER_VERSION,
    ranAt: new Date().toISOString(),
    runs: RUNS,
    cases: outcomes.length,
    passes,
    cost: Number(cost.toFixed(2)),
    bar: bar.map(({ bar: number, name, pass, score, failed }) => ({ bar: number, name, pass, score, failed: [...new Set(failed)].sort() })),
  };
  mkdirSync(new URL('./', SUMMARY), { recursive: true });
  writeFileSync(SUMMARY, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Summary to commit: ${fileURLToPath(SUMMARY)}`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

