import { MAX_TAGS, defaultDisclosure, type CandidateSource, type ProjectSettingsPatch, type SuggestedTag } from '@goodfirsttoken/core';
import { keptForPeople } from '../../projects/rules';
import { aiPassages, quoteOf, scan, type AiPassages, type CrawlTier, type PolicyFile, type RepoLabel, type SourceLine } from '../rules';
import type { LabelCheck } from './labels';
import { parsePolicyOutput, type ModelTier, type PolicyOutput, type StatementKind } from './schemas';
import { checkStatement, Files, type CheckedPointer, type CheckedStatement, type StatementFailure } from './statements';
import { READER_VERSION } from './version';

// What the Worker makes of a policy reading. The model points at lines,
// and the Worker decides what they say and what the admin sees: it checks
// each statement against the files, works out the tier from the ones that
// check out, checks the model's own tier against it, and maps the reading
// onto a PolicyReading and the settings a find suggests. The design
// is in docs/specs/model-policy-reader.md, under What the Worker does with
// it.

const LISTING: readonly CrawlTier[] = ['invites_agents', 'allows_with_conditions'];
const BANS: readonly StatementKind[] = ['bansAi', 'refusesOutsidePrs'];
const CONDITIONS: readonly StatementKind[] = ['noAutonomy', 'personInLoop', 'personWrittenDescription'];

export interface ModelReading {
  readerVersion: string;
  /** The statements that checked out, in the files' order, then by line. */
  statements: CheckedStatement[];
  /** The statements that failed a check, by their place in the model's list. */
  dropped: { index: number; about: StatementKind; failure: StatementFailure }[];
  /** The steering lines that checked out, for the top of a find. */
  steering: CheckedPointer[];
  /** How many steering lines failed a check. */
  droppedSteering: number;
  /** The tier the model gave. */
  modelTier: ModelTier;
  /** The tier the Worker works out from the statements that checked out. */
  tier: CrawlTier;
  /** Whether the two tiers agree. A reading whose tiers disagree can't pause a listing. */
  agree: boolean;
  /** The model's summary, for the admin, as text the model wrote. */
  summary: string;
}

export type ReadingResult = { ok: true; reading: ModelReading } | { ok: false; reason: string };

/** What a reading says the docs say, as the crawl queue and the weekly read act on it, with the admin's net from the word list. */
export interface PolicyReading extends AiPassages {
  tier: CrawlTier;
  /**
   * The first sentence of the first statement that invites agents, or else
   * of the first that welcomes AI help, with the text quoted around it.
   * Null unless the tier is one a listing can have.
   */
  welcome: { file: PolicyFile; sentence: string; quote: string } | null;
  /** The first ban line, when the tier is a ban. */
  ban: SourceLine | null;
  /** A line that keeps agents from working on their own, or null. */
  noAutonomy: SourceLine | null;
  /** A line that asks for a person in the loop, or null. */
  personInLoop: SourceLine | null;
  /** A line that asks contributors to write the PR description themselves, or null. */
  personWritten: SourceLine | null;
  /** A line in AGENTS.md or CLAUDE.md with instructions for an agent to prove it read the file, or null. */
  canary: SourceLine | null;
  /** Label names the docs keep away from AI or keep for people, as they spell them, each once, with its first line. */
  reserved: { name: string; source: SourceLine }[];
  /** Label names the docs keep agents to, as they spell them, each once, with its first line. */
  onlyLabels: { name: string; source: SourceLine }[];
}

/**
 * The tier from the statements that checked out, in today's order: a ban,
 * then an invitation with none of the three conditions, then any welcome,
 * then no policy.
 */
export function workOutTier(statements: readonly { about: StatementKind }[]): CrawlTier {
  const has = (kinds: readonly StatementKind[]) => statements.some((s) => kinds.includes(s.about));
  if (has(BANS)) return 'bans_or_restricts';
  if (has(['welcomesAgents']) && !has(CONDITIONS)) return 'invites_agents';
  if (has(['welcomesAgents', 'welcomesAi'])) return 'allows_with_conditions';
  return 'no_policy';
}

/** The reading of a model's JSON for the files it read, or why its output fails. */
export function readPolicyOutput(files: readonly PolicyFile[], json: unknown): ReadingResult {
  const parsed = parsePolicyOutput(json);
  if (!parsed.ok) return parsed;
  return { ok: true, reading: readingOf(files, parsed.output) };
}

function readingOf(files: readonly PolicyFile[], output: PolicyOutput): ModelReading {
  const sent = new Files(files);
  const statements: CheckedStatement[] = [];
  const dropped: ModelReading['dropped'] = [];
  output.statements.forEach((statement, index) => {
    const checked = checkStatement(sent, statement, index);
    if (checked.ok) statements.push(checked.statement);
    else dropped.push({ index, about: statement.about, failure: checked.failure });
  });
  const order = new Map(files.map((file, index) => [file.path, index]));
  statements.sort((a, b) => (order.get(a.file.path) ?? 0) - (order.get(b.file.path) ?? 0) || a.startLine - b.startLine || a.index - b.index);
  const steering: CheckedPointer[] = [];
  let droppedSteering = 0;
  for (const line of output.steering) {
    const checked = sent.check(line);
    if (checked.ok) steering.push(checked.pointer);
    else droppedSteering += 1;
  }
  const tier = workOutTier(statements);
  return {
    readerVersion: READER_VERSION,
    statements,
    dropped,
    steering,
    droppedSteering,
    modelTier: output.tier,
    tier,
    agree: tier === output.tier,
    summary: output.summary,
  };
}

/**
 * The tier a find takes, or null when the reading makes no find. A find is
 * made only when both tiers are ones a listing can have, and takes
 * allows_with_conditions when they differ, so its PR mode is reviewed. A
 * model that says bans_or_restricts with no ban line that checks out never
 * makes a find.
 */
export function findTier(reading: Pick<ModelReading, 'tier' | 'modelTier' | 'agree'>): CrawlTier | null {
  if (!LISTING.includes(reading.tier) || !LISTING.includes(reading.modelTier)) return null;
  return reading.agree ? reading.tier : 'allows_with_conditions';
}

/** Whether a reading reads a ban that may pause a listing: both tiers say ban, and a ban line checks out. */
export function readsBan(reading: ModelReading): boolean {
  return reading.agree && reading.tier === 'bans_or_restricts' && reading.statements.some((s) => BANS.includes(s.about));
}

/** Whether two readings of the same docs agree on a ban, as a pause needs. */
export function agreeOnBan(first: ModelReading, second: ModelReading): boolean {
  return readsBan(first) && readsBan(second);
}

/** The first statement of a kind, whose line is kept as its source. */
function first(reading: ModelReading, kinds: readonly StatementKind[]): CheckedStatement | null {
  return reading.statements.find((s) => kinds.includes(s.about)) ?? null;
}

const sourceOf = (statement: CheckedStatement | null): SourceLine | null => statement?.source ?? null;

/** Label names, each once without case, with the first line that names them. */
function labelsOf(reading: ModelReading, about: StatementKind): { name: string; source: SourceLine }[] {
  const seen = new Map<string, { name: string; source: SourceLine }>();
  for (const s of reading.statements) {
    if (s.about !== about || s.label === null) continue;
    const key = s.label.toLowerCase();
    if (!seen.has(key)) seen.set(key, { name: s.label, source: s.source });
  }
  return [...seen.values()];
}

/**
 * The tier a PolicyReading takes: the find's tier, or else the worked-out
 * tier. When the tiers disagree and the worked-out one is a listing tier,
 * it takes allows_with_conditions, so a reading the model and the
 * statements disagree on is never more open than reviewed pull requests.
 */
export function policyTier(reading: ModelReading): CrawlTier {
  const found = findTier(reading);
  if (found !== null) return found;
  return !reading.agree && LISTING.includes(reading.tier) ? 'allows_with_conditions' : reading.tier;
}

/**
 * The reading as a PolicyReading, which a find, a policy change, and a pause
 * are made from. What the admin sees comes from the files: each source line
 * is the line the first quoted sentence starts on, and the welcome's quote
 * is its paragraph, as quoteOf gives it. The sentences that name AI come
 * from the word list, whatever the model said, so a ban the model missed is
 * still in front of the admin.
 */
export function toPolicyReading(files: readonly PolicyFile[], reading: ModelReading): PolicyReading {
  const tier = policyTier(reading);
  const net = aiPassages(files);
  const welcomed = first(reading, ['welcomesAgents']) ?? first(reading, ['welcomesAi']);
  let welcome: PolicyReading['welcome'] = null;
  const sentence = welcomed?.sentences[0];
  if (welcomed !== null && sentence !== undefined && LISTING.includes(tier)) {
    const { paragraphs } = scan(welcomed.file.text);
    welcome = { file: welcomed.file, sentence: sentence.text, quote: quoteOf(welcomed.file.text, paragraphs, sentence) };
  }
  return {
    tier,
    welcome,
    ban: tier === 'bans_or_restricts' ? sourceOf(first(reading, BANS)) : null,
    noAutonomy: sourceOf(first(reading, ['noAutonomy'])),
    personInLoop: sourceOf(first(reading, ['personInLoop'])),
    personWritten: sourceOf(first(reading, ['personWrittenDescription'])),
    canary: sourceOf(first(reading, ['canary'])),
    reserved: labelsOf(reading, 'reservedLabel'),
    onlyLabels: labelsOf(reading, 'onlyLabel'),
    aiSentences: net.aiSentences,
    moreAiSentences: net.moreAiSentences,
  };
}

const lower = (text: string) => text.toLowerCase();

function unique(labels: readonly RepoLabel[]): RepoLabel[] {
  const seen = new Set<string>();
  return labels.filter((label) => {
    const key = lower(label.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function source(about: CandidateSource['about'], line: SourceLine): CandidateSource {
  return { about, path: line.file.path, line: line.line };
}

/**
 * The settings and tags a reading suggests, from its statements, with the
 * label check for the tags: excluded tags from reservedLabel, the only tag
 * from onlyLabel, the trailer, the CLA link, the person-written
 * description, the PR mode from the tier, and who can claim from the vouch
 * file. Nothing from the repo goes in a setting but a label name, a trailer
 * name, and a CLA link, each checked against the files. With no label
 * check, as for a policy change, no tags are suggested.
 */
export function readerSettings(
  reading: ModelReading,
  labels: readonly RepoLabel[],
  check: LabelCheck | null,
  vouch: string | null,
): { settings: ProjectSettingsPatch; suggestedTags: SuggestedTag[]; sources: CandidateSource[] } {
  const sources: CandidateSource[] = [];
  const reserved = labelsOf(reading, 'reservedLabel');
  const reservedNames = new Set(reserved.map((r) => lower(r.name)));
  const excluded = unique(labels.filter((label) => reservedNames.has(lower(label.name))));
  const open = labels.filter((label) => !reservedNames.has(lower(label.name)));
  const byName = new Map(open.map((label) => [lower(label.name), label]));
  const pick = (names: readonly RepoLabel[]) => names.flatMap((label) => byName.get(lower(label.name)) ?? []);

  const ready = pick([...(check?.ready ?? []), ...(check?.agentsOnly ?? [])]);
  // good first issue stays out of the tags and in the suggestions, as the plan names it as kept for people.
  let tags = unique(ready.filter((label) => !keptForPeople(label.name))).slice(0, MAX_TAGS);
  let suggested = unique([...ready, ...pick(check?.keptForPeople ?? [])]).slice(0, MAX_TAGS);
  // Docs that keep agents to issues with a label make it the only tag,
  // when the repo has it, and no tag when it doesn't.
  const only = labelsOf(reading, 'onlyLabel');
  if (only.length > 0) {
    tags = unique(only.flatMap(({ name }) => byName.get(lower(name)) ?? [])).slice(0, MAX_TAGS);
    suggested = tags;
    for (const label of only) sources.push(source(byName.has(lower(label.name)) ? 'tags' : 'labelMissing', label.source));
  }

  const tier = policyTier(reading);
  const settings: ProjectSettingsPatch = { prMode: tier === 'invites_agents' ? 'automatic' : 'reviewed' };
  if (tags.length > 0) settings.tags = tags.map((label) => label.name);
  if (excluded.length > 0) {
    const kept = excluded.slice(0, MAX_TAGS);
    settings.excludedTags = kept.map((label) => label.name);
    const keptNames = new Set(kept.map((label) => lower(label.name)));
    for (const r of reserved) if (keptNames.has(lower(r.name))) sources.push(source('excludedTags', r.source));
  }
  if (vouch !== null) {
    settings.whoCanClaim = 'vouched';
    sources.push({ about: 'whoCanClaim', path: vouch, line: null });
  }
  const trailer = first(reading, ['disclosureTrailer']);
  if (trailer?.value != null) {
    settings.disclosure = { ...defaultDisclosure, trailer: trailer.value };
    sources.push(source('disclosure', trailer.source));
  }
  const written = first(reading, ['personWrittenDescription']);
  if (written !== null) {
    settings.personWrittenDescription = true;
    sources.push(source('personWrittenDescription', written.source));
  }
  const cla = first(reading, ['cla']);
  if (cla?.value != null) {
    settings.claUrl = cla.value;
    sources.push(source('claUrl', cla.source));
  }
  for (const kind of ['noAutonomy', 'personInLoop'] as const) {
    const line = first(reading, [kind]);
    if (line !== null) sources.push(source('prMode', line.source));
  }
  const canary = first(reading, ['canary']);
  if (canary !== null) sources.push(source('canary', canary.source));
  return {
    settings,
    suggestedTags: suggested.map((label) => ({ name: label.name, openIssues: label.openIssues })),
    sources: dedupe(sources),
  };
}

function dedupe(sources: readonly CandidateSource[]): CandidateSource[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const key = `${s.about}\n${s.path}\n${s.line ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Whether a requested repo may be listed at once, as far as the reader can
 * say: both tiers agree on a listing tier, no statement was dropped, no
 * steering line checks out, and the check reading found nothing. The
 * Worker adds the rest: add-a-repo's own conditions, a docs hash that is
 * still the newest.
 */
export function readerListsAtOnce(reading: ModelReading, check: { clears: boolean } | null): boolean {
  return (
    reading.agree &&
    LISTING.includes(reading.tier) &&
    reading.dropped.length === 0 &&
    reading.droppedSteering === 0 &&
    reading.steering.length === 0 &&
    check?.clears === true
  );
}
