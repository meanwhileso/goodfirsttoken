import { MAX_FINDINGS, MAX_STATEMENTS, MAX_STEERING, MAX_SUMMARY, MAX_WHY } from './version';

// The output schemas the reader asks for, through output_config.format, and
// the checks of their shape after the model's JSON is parsed. Every object
// has additionalProperties false, as structured output requires. Limits a
// schema can't hold there, like counts and string lengths, are checked
// here. More statements than MAX_STATEMENTS fail the output, since the
// tier rests on all of them. Steering lines and findings past their limits
// are cut, since one is enough to stop a listing at once. A note over its
// length is cut.

export const STATEMENT_KINDS = [
  'welcomesAgents',
  'welcomesAi',
  'bansAi',
  'refusesOutsidePrs',
  'noAutonomy',
  'personInLoop',
  'personWrittenDescription',
  'reservedLabel',
  'onlyLabel',
  'disclosureTrailer',
  'cla',
  'canary',
] as const;
export type StatementKind = (typeof STATEMENT_KINDS)[number];

export const MODEL_TIERS = ['invites_agents', 'allows_with_conditions', 'bans_or_restricts', 'no_policy'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const LABEL_MEANINGS = ['readyForOutsideHelp', 'keptForPeople', 'agentsOnly'] as const;
export type LabelMeaning = (typeof LABEL_MEANINGS)[number];

export const LABEL_EVIDENCE = ['name', 'description', 'statement'] as const;
export type LabelEvidence = (typeof LABEL_EVIDENCE)[number];

export const FINDING_KINDS = ['bansAi', 'refusesOutsidePrs', 'noAutonomy', 'personInLoop', 'canary', 'steering', 'quotedPolicy'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/** Lines in one file, as the request numbered them, and the words the model says are there. */
export interface Pointer {
  path: string;
  startLine: number;
  endLine: number;
  quote: string;
}

export interface Statement extends Pointer {
  about: StatementKind;
  label: string | null;
  value: string | null;
  why: string;
}

export interface PolicyOutput {
  statements: Statement[];
  tier: ModelTier;
  steering: Pointer[];
  summary: string;
}

export interface LabelOutput {
  labels: { name: string; meaning: LabelMeaning; evidence: LabelEvidence; statement: number | null; why: string }[];
}

export interface Finding extends Pointer {
  kind: FindingKind;
  why: string;
}

export interface CheckOutput {
  findings: Finding[];
  summary: string;
}

// ---------------------------------------------------------------------------
// The JSON schemas, as the API takes them.

const string = { type: 'string' } as const;
const integer = { type: 'integer' } as const;
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
const object = (properties: Record<string, object>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const pointerProperties = { path: string, startLine: integer, endLine: integer, quote: string };

export const POLICY_SCHEMA = object({
  statements: {
    type: 'array',
    items: object({
      ...pointerProperties,
      about: { type: 'string', enum: [...STATEMENT_KINDS] },
      label: nullable(string),
      value: nullable(string),
      why: string,
    }),
  },
  tier: { type: 'string', enum: [...MODEL_TIERS] },
  steering: { type: 'array', items: object(pointerProperties) },
  summary: string,
});

export const LABEL_SCHEMA = object({
  labels: {
    type: 'array',
    items: object({
      name: string,
      meaning: { type: 'string', enum: [...LABEL_MEANINGS] },
      evidence: { type: 'string', enum: [...LABEL_EVIDENCE] },
      statement: nullable(integer),
      why: string,
    }),
  },
});

export const CHECK_SCHEMA = object({
  findings: {
    type: 'array',
    items: object({ kind: { type: 'string', enum: [...FINDING_KINDS] }, ...pointerProperties, why: string }),
  },
  summary: string,
});

// ---------------------------------------------------------------------------
// Checking the parsed JSON.

/** Why an output failed: its shape, or a count over a limit. */
export type ShapeFailure = { ok: false; reason: string };
type Parsed<T> = { ok: true; output: T } | ShapeFailure;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isLine = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value);
/** Exactly these keys, as additionalProperties false and required hold them. */
const hasKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

/** A note cut to its length. */
export const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

function pointerOf(value: unknown, extra: readonly string[]): Pointer | null {
  if (!isObject(value) || !hasKeys(value, ['path', 'startLine', 'endLine', 'quote', ...extra])) return null;
  const { path, startLine, endLine, quote } = value;
  if (!isString(path) || !isLine(startLine) || !isLine(endLine) || !isString(quote)) return null;
  return { path, startLine, endLine, quote };
}

/** The policy reading's output, or why its shape fails. */
export function parsePolicyOutput(json: unknown): Parsed<PolicyOutput> {
  if (!isObject(json) || !hasKeys(json, ['statements', 'tier', 'steering', 'summary'])) return { ok: false, reason: 'shape' };
  const { statements, tier, steering, summary } = json;
  if (!Array.isArray(statements) || !Array.isArray(steering) || !oneOf(MODEL_TIERS, tier) || !isString(summary)) return { ok: false, reason: 'shape' };
  if (statements.length > MAX_STATEMENTS) return { ok: false, reason: 'too many statements' };
  const parsed: Statement[] = [];
  for (const item of statements) {
    const pointer = pointerOf(item, ['about', 'label', 'value', 'why']);
    if (pointer === null || !isObject(item)) return { ok: false, reason: 'shape' };
    const { about, label, value, why } = item;
    if (!oneOf(STATEMENT_KINDS, about) || !isNullableString(label) || !isNullableString(value) || !isString(why)) return { ok: false, reason: 'shape' };
    parsed.push({ ...pointer, about, label, value, why: cut(why, MAX_WHY) });
  }
  const lines: Pointer[] = [];
  for (const item of steering) {
    const pointer = pointerOf(item, []);
    if (pointer === null) return { ok: false, reason: 'shape' };
    if (lines.length < MAX_STEERING) lines.push(pointer);
  }
  return { ok: true, output: { statements: parsed, tier, steering: lines, summary: cut(summary, MAX_SUMMARY) } };
}

/** The label check's output, or why its shape fails. */
export function parseLabelOutput(json: unknown, maxLabels: number): Parsed<LabelOutput> {
  if (!isObject(json) || !hasKeys(json, ['labels']) || !Array.isArray(json.labels)) return { ok: false, reason: 'shape' };
  if (json.labels.length > maxLabels) return { ok: false, reason: 'too many labels' };
  const labels: LabelOutput['labels'] = [];
  for (const item of json.labels) {
    if (!isObject(item) || !hasKeys(item, ['name', 'meaning', 'evidence', 'statement', 'why'])) return { ok: false, reason: 'shape' };
    const { name, meaning, evidence, statement, why } = item;
    if (!isString(name) || !oneOf(LABEL_MEANINGS, meaning) || !oneOf(LABEL_EVIDENCE, evidence) || !(statement === null || isLine(statement)) || !isString(why)) {
      return { ok: false, reason: 'shape' };
    }
    labels.push({ name, meaning, evidence, statement, why: cut(why, MAX_WHY) });
  }
  return { ok: true, output: { labels } };
}

/** The check reading's output, or why its shape fails. */
export function parseCheckOutput(json: unknown): Parsed<CheckOutput> {
  if (!isObject(json) || !hasKeys(json, ['findings', 'summary']) || !Array.isArray(json.findings) || !isString(json.summary)) return { ok: false, reason: 'shape' };
  const findings: Finding[] = [];
  for (const item of json.findings) {
    const pointer = pointerOf(item, ['kind', 'why']);
    if (pointer === null || !isObject(item)) return { ok: false, reason: 'shape' };
    const { kind, why } = item;
    if (!oneOf(FINDING_KINDS, kind) || !isString(why)) return { ok: false, reason: 'shape' };
    if (findings.length < MAX_FINDINGS) findings.push({ ...pointer, kind, why: cut(why, MAX_WHY) });
  }
  return { ok: true, output: { findings, summary: cut(json.summary, MAX_SUMMARY) } };
}
