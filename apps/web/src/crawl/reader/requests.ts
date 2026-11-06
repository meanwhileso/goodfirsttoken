import type Anthropic from '@anthropic-ai/sdk';
import type { PolicyFile } from '../rules';
import { CHECK_CLOSING, CHECK_SYSTEM, LABEL_CLOSING, LABEL_SYSTEM, POLICY_CLOSING, POLICY_SYSTEM } from './prompts';
import { CHECK_SCHEMA, LABEL_SCHEMA, POLICY_SCHEMA } from './schemas';
import { EFFORT, MAX_LABELS_SENT, MAX_TOKENS, MODEL } from './version';

// The requests the reader sends, built from the repo's files and labels
// with no network. The Worker sends them through the Message Batches API,
// and register_project's label check through the Messages API. The model
// gets no tools: its only output is the JSON its schema allows. There is
// no assistant prefill and no forced tool use, which Opus 5.5 rejects, and
// no fallback model, since a reading from another model hasn't met the eval.

export type ReaderRequest = Anthropic.Messages.MessageCreateParamsNonStreaming;

/** A label as the label check reads it. */
export interface CheckedLabel {
  name: string;
  description: string | null;
  openIssues: number;
}

/** A random value for the boundary lines, which no text in the request contains. */
export function newBoundary(texts: readonly string[]): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const value = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (!texts.some((text) => text.includes(value))) return value;
  }
}

/** A text with each line's number before it, starting at 1. */
export function numbered(text: string): string {
  return text
    .split('\n')
    .map((line, index) => `${String(index + 1)}| ${line}`)
    .join('\n');
}

/** The files as the user turn holds them, each between boundary lines. */
export function filesTurn(files: readonly PolicyFile[], boundary: string): string {
  const intro = `The repository's files follow, ${String(files.length)} in all. Each begins and ends with a boundary line that holds the value ${boundary}.`;
  const blocks = files.map((file) =>
    [`===== BEGIN FILE ${boundary} =====`, `path: ${JSON.stringify(file.path)}`, `kind: ${file.kind}`, numbered(file.text), `===== END FILE ${boundary} =====`].join('\n'),
  );
  return [intro, ...blocks].join('\n\n');
}

/** The system prompt, cached for an hour, since requests in a batch run in no set order or time. */
function system(text: string): Anthropic.Messages.TextBlockParam[] {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral', ttl: '1h' } }];
}

function request(options: {
  system: string;
  turn: string;
  closing: string;
  schema: Record<string, unknown>;
  effort: (typeof EFFORT)[keyof typeof EFFORT];
  maxTokens: number;
}): ReaderRequest {
  return {
    model: MODEL,
    max_tokens: options.maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort: options.effort, format: { type: 'json_schema', schema: options.schema } },
    system: system(options.system),
    messages: [
      { role: 'user', content: options.turn },
      // After the files, in the operator's voice.
      { role: 'system', content: options.closing },
    ],
  };
}

/** The policy reading's request for a repo's files, in the order the crawler reads them. */
export function policyRequest(files: readonly PolicyFile[], boundary = newBoundary(files.flatMap((f) => [f.text, f.path]))): ReaderRequest {
  return request({
    system: POLICY_SYSTEM,
    turn: filesTurn(files, boundary),
    closing: POLICY_CLOSING,
    schema: POLICY_SCHEMA,
    effort: EFFORT.policy,
    maxTokens: MAX_TOKENS.policy,
  });
}

/** The check reading's request for a requested repo: the same files, with a prompt of its own. */
export function checkRequest(files: readonly PolicyFile[], boundary = newBoundary(files.flatMap((f) => [f.text, f.path]))): ReaderRequest {
  return request({
    system: CHECK_SYSTEM,
    turn: filesTurn(files, boundary),
    closing: CHECK_CLOSING,
    schema: CHECK_SCHEMA,
    effort: EFFORT.check,
    maxTokens: MAX_TOKENS.check,
  });
}

/** A kept statement as the label check sends it: what it is about, its label, and its lines as the file has them. */
export interface LabelStatement {
  about: string;
  label: string | null;
  path: string;
  startLine: number;
  lines: string;
}

/**
 * Which labels the label check sends: up to MAX_LABELS_SENT, the most open
 * issues first, then every label a statement names that isn't among them,
 * so a label with no open issues the docs name still goes.
 */
export function labelsToSend(labels: readonly CheckedLabel[], statements: readonly LabelStatement[]): CheckedLabel[] {
  const sorted = [...labels].sort((a, b) => b.openIssues - a.openIssues || a.name.localeCompare(b.name));
  const sent = sorted.slice(0, MAX_LABELS_SENT);
  const named = new Set(statements.flatMap((s) => (s.label === null ? [] : [s.label.toLowerCase()])));
  const have = new Set(sent.map((label) => label.name.toLowerCase()));
  for (const label of sorted.slice(MAX_LABELS_SENT)) {
    const key = label.name.toLowerCase();
    if (named.has(key) && !have.has(key)) {
      sent.push(label);
      have.add(key);
    }
  }
  return sent;
}

/**
 * The label check's request: the labels, and for a find the kept
 * statements with their lines, numbered from 0. Labels alone, as
 * register_project sends them, have no statements.
 */
export function labelRequest(
  labels: readonly CheckedLabel[],
  statements: readonly LabelStatement[] = [],
  boundary?: string,
): { request: ReaderRequest; sent: CheckedLabel[] } {
  const sent = labelsToSend(labels, statements);
  const lines = sent.map((label) => JSON.stringify({ name: label.name, description: label.description, openIssues: label.openIssues }));
  const said = statements.map((s, index) =>
    JSON.stringify({ statement: index, about: s.about, label: s.label, path: s.path, startLine: s.startLine, lines: s.lines }),
  );
  const value = boundary ?? newBoundary([...lines, ...said]);
  const parts = [
    `The repository's labels follow, ${String(sent.length)} in all, between boundary lines that hold the value ${value}.`,
    [`===== BEGIN LABELS ${value} =====`, ...lines, `===== END LABELS ${value} =====`].join('\n'),
  ];
  if (said.length > 0) {
    parts.push(
      `What the repository's docs say about labels follows, ${String(said.length)} statements, between boundary lines that hold the same value.`,
      [`===== BEGIN STATEMENTS ${value} =====`, ...said, `===== END STATEMENTS ${value} =====`].join('\n'),
    );
  }
  return {
    request: request({
      system: LABEL_SYSTEM,
      turn: parts.join('\n\n'),
      closing: LABEL_CLOSING,
      schema: LABEL_SCHEMA,
      effort: EFFORT.labels,
      maxTokens: MAX_TOKENS.labels,
    }),
    sent,
  };
}

/** What a message's stop reason and text say: the parsed JSON, or why there is no verdict. */
export type MessageResult = { ok: true; json: unknown } | { ok: false; reason: string };

/**
 * The JSON a message holds. A reading counts only with `end_turn` and text
 * that parses. `max_tokens`, `refusal`, or anything else is no verdict.
 */
export function jsonOf(message: Pick<Anthropic.Messages.Message, 'stop_reason' | 'content'>): MessageResult {
  if (message.stop_reason !== 'end_turn') return { ok: false, reason: `stop reason ${message.stop_reason ?? 'none'}` };
  const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
  if (text.trim() === '') return { ok: false, reason: 'no text' };
  try {
    return { ok: true, json: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'output that does not parse' };
  }
}
