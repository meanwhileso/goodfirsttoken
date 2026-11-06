// Checks a Messages API request's shape the way the API does for Claude
// Opus 5.5, and the few things the policy reader's requests always carry,
// so a request the API would refuse fails a test before it costs anything.
//
// The API's own rules for Opus 5.5:
//   - Thinking is adaptive. Disabling it, or a thinking budget, is refused.
//   - No assistant prefill: the last message can't be the assistant's.
//   - No forced tool use: tool_choice can't be "any" or "tool".
//   - No temperature, top_p, or top_k.
//   - A system message in `messages` follows a user message, and is last or
//     followed by an assistant message.
//   - Every object in an output_config.format schema sets
//     additionalProperties to false.
//   - The Batches API takes no `fallbacks`.
//
// The reader's own rules, from docs/specs/model-policy-reader.md, which a
// message names as the fake's:
//   - Every request names the model, claude-opus-5-5.
//   - Every request sets output_config.effort, since Opus 5.5 defaults to
//     medium, and output_config.format, since the reader reads only JSON.
//   - No tools, no `fallbacks`, and no streaming.

import { ERROR_STATUS, type ApiError } from './http.ts';

export const MODEL = 'claude-opus-5-5';
export const MAX_OUTPUT_TOKENS = 128_000;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

// The API versions the fake takes in the anthropic-version header: the
// first, and the one the SDK sends from 1.0.
export const API_VERSIONS = ['2023-06-01', '2026-10-21'];

// Every top-level field of a Messages request. Anything else is refused, as
// the API refuses it.
const FIELDS = new Set([
  'model',
  'max_tokens',
  'messages',
  'system',
  'thinking',
  'output_config',
  'metadata',
  'stop_sequences',
  'stream',
  'cache_control',
  'tool_choice',
  'tools',
  'temperature',
  'top_p',
  'top_k',
  'service_tier',
  'container',
  'mcp_servers',
  'context_management',
  'fallbacks',
  'inference_geo',
]);

export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral'; ttl?: '5m' | '1h' };
}

export interface MessageParam {
  role: 'user' | 'assistant' | 'system';
  content: string | TextBlock[];
}

export interface MessageRequest {
  model: string;
  max_tokens: number;
  messages: MessageParam[];
  system?: string | TextBlock[];
  thinking?: { type: 'adaptive'; display?: string };
  output_config: { effort: (typeof EFFORTS)[number]; format: { type: 'json_schema'; schema: Record<string, unknown> } };
  cache_control?: { type: 'ephemeral'; ttl?: '5m' | '1h' };
  [field: string]: unknown;
}

export interface ShapeError extends ApiError {
  status: number;
}

const invalid = (message: string): ShapeError => ({ status: ERROR_STATUS.invalid_request_error, type: 'invalid_request_error', message });
const ours = (message: string): ShapeError => invalid(`The Anthropic fake: ${message} (docs/specs/model-policy-reader.md)`);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function checkCacheControl(value: unknown, where: string): ShapeError | null {
  if (value === undefined) return null;
  if (!isObject(value) || value.type !== 'ephemeral') return invalid(`${where}.type: Input should be 'ephemeral'`);
  if (value.ttl !== undefined && value.ttl !== '5m' && value.ttl !== '1h') return invalid(`${where}.ttl: Input should be '5m' or '1h'`);
  return null;
}

// Content as a string, or text blocks. The reader sends only text, so the
// fake takes no other block.
function checkContent(content: unknown, where: string): ShapeError | null {
  if (typeof content === 'string') return content === '' ? invalid(`${where}: text content blocks must be non-empty`) : null;
  if (!Array.isArray(content)) return invalid(`${where}: Input should be a valid list`);
  for (const [index, block] of content.entries()) {
    const at = `${where}.${String(index)}`;
    if (!isObject(block)) return invalid(`${at}: Input should be a valid dictionary`);
    if (block.type !== 'text') return ours(`${at}.type is "${String(block.type)}". The reader sends text blocks only.`);
    if (typeof block.text !== 'string' || block.text === '') return invalid(`${at}.text: text content blocks must be non-empty`);
    const cache = checkCacheControl(block.cache_control, `${at}.cache_control`);
    if (cache) return cache;
  }
  return null;
}

// Every object in a structured output schema has to set
// additionalProperties to false.
function checkSchema(schema: unknown, path: string): ShapeError | null {
  if (!isObject(schema)) return null;
  const isObjectSchema = schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object')) || 'properties' in schema;
  if (isObjectSchema && schema.additionalProperties !== false) {
    return invalid(`output_config.format.schema: For '${path}', 'additionalProperties' must be explicitly set to false`);
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && isObject(value)) {
      for (const [name, property] of Object.entries(value)) {
        const found = checkSchema(property, `${path}.${name}`);
        if (found) return found;
      }
    } else if (key === 'items' || key === 'additionalProperties') {
      const found = checkSchema(value, `${path}[]`);
      if (found) return found;
    } else if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
      for (const option of value) {
        const found = checkSchema(option, path);
        if (found) return found;
      }
    } else if ((key === '$defs' || key === 'definitions') && isObject(value)) {
      for (const [name, definition] of Object.entries(value)) {
        const found = checkSchema(definition, `${key}.${name}`);
        if (found) return found;
      }
    }
  }
  return null;
}

/**
 * The error the API, or the reader's contract, gives this request, or null
 * when it would run. `inBatch` is true for a request inside a Message Batch.
 */
export function checkRequest(body: unknown, { inBatch = false }: { inBatch?: boolean } = {}): ShapeError | null {
  if (!isObject(body)) return invalid('Input should be a valid dictionary');
  for (const field of Object.keys(body)) {
    if (!FIELDS.has(field)) return invalid(`${field}: Extra inputs are not permitted`);
  }

  if (typeof body.model !== 'string' || body.model === '') return invalid('model: Field required');
  if (body.model !== MODEL) {
    // The API names a model it doesn't know, or one this account can't use,
    // with a 404. The reader names only one.
    return { status: ERROR_STATUS.not_found_error, type: 'not_found_error', message: `model: ${body.model}` };
  }

  const maxTokens = body.max_tokens;
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens)) return invalid('max_tokens: Field required');
  if (maxTokens < 1) return invalid('max_tokens: Input should be greater than or equal to 1');
  if (maxTokens > MAX_OUTPUT_TOKENS) {
    return invalid(`max_tokens: ${String(maxTokens)} > ${String(MAX_OUTPUT_TOKENS)}, which is the maximum allowed number of output tokens for ${MODEL}`);
  }

  for (const sampling of ['temperature', 'top_p', 'top_k']) {
    if (body[sampling] !== undefined) return invalid(`${sampling}: is not supported for this model.`);
  }

  const thinking = body.thinking;
  if (thinking !== undefined) {
    if (!isObject(thinking)) return invalid('thinking: Input should be a valid dictionary');
    if (thinking.type === 'disabled') {
      return invalid('thinking.type: "disabled" is not supported for this model. Use output_config.effort to control thinking.');
    }
    if (thinking.type === 'enabled' || thinking.budget_tokens !== undefined) {
      return invalid('thinking.type.enabled is not supported for this model. Use thinking.type.adaptive and output_config.effort to control thinking.');
    }
    if (thinking.type !== 'adaptive') return invalid("thinking.type: Input should be 'adaptive'");
    if (thinking.display !== undefined && (typeof thinking.display !== 'string' || !['summarized', 'omitted', 'updates'].includes(thinking.display))) {
      return invalid("thinking.display: Input should be 'summarized' or 'omitted'");
    }
  }

  const toolChoice = body.tool_choice;
  if (isObject(toolChoice) && (toolChoice.type === 'any' || toolChoice.type === 'tool')) {
    return invalid('tool_choice: type "tool" and "any" are not supported for this model.');
  }

  if (body.fallbacks !== undefined) {
    if (inBatch) return invalid('fallbacks: is not supported in the Message Batches API.');
    return ours('the reader sends no `fallbacks`, since a reading from another model has not met the eval.');
  }

  const cache = checkCacheControl(body.cache_control, 'cache_control');
  if (cache) return cache;

  if (body.system !== undefined) {
    const system = checkContent(body.system, 'system');
    if (system) return system;
  }

  const messages = body.messages;
  if (!Array.isArray(messages)) return invalid('messages: Field required');
  if (messages.length === 0) return invalid('messages: at least one message is required');
  for (const [index, message] of messages.entries()) {
    const at = `messages.${String(index)}`;
    if (!isObject(message)) return invalid(`${at}: Input should be a valid dictionary`);
    for (const field of Object.keys(message)) {
      if (field !== 'role' && field !== 'content') return invalid(`${at}.${field}: Extra inputs are not permitted`);
    }
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') {
      return invalid(`${at}.role: Input should be 'user', 'assistant' or 'system'`);
    }
    const content = checkContent(message.content, `${at}.content`);
    if (content) return content;
    if (message.role === 'system') {
      const before = messages[index - 1] as Record<string, unknown> | undefined;
      const after = messages[index + 1] as Record<string, unknown> | undefined;
      if (index === 0 || before?.role !== 'user') {
        return invalid(`${at}: a system message must follow a user message.`);
      }
      if (after !== undefined && after.role !== 'assistant') {
        return invalid(`${at}: a system message must be the last message or be followed by an assistant message.`);
      }
    }
  }
  if ((messages[0] as Record<string, unknown>).role !== 'user') return invalid('messages.0.role: the first message must use the "user" role.');
  if ((messages.at(-1) as Record<string, unknown>).role === 'assistant') {
    return invalid('This model does not support assistant message prefill. The conversation must end with a user message.');
  }

  const output = body.output_config;
  if (output !== undefined && !isObject(output)) return invalid('output_config: Input should be a valid dictionary');
  const effort = output?.effort;
  if (effort !== undefined && !EFFORTS.includes(effort as (typeof EFFORTS)[number])) {
    return invalid(`output_config.effort: Input should be ${EFFORTS.map((level) => `'${level}'`).join(', ')}`);
  }
  const format = output?.format;
  if (format !== undefined) {
    if (!isObject(format) || format.type !== 'json_schema') return invalid("output_config.format.type: Input should be 'json_schema'");
    if (!isObject(format.schema)) return invalid('output_config.format.schema: Field required');
    const schema = checkSchema(format.schema, 'root');
    if (schema) return schema;
  }

  // The rest are the reader's, not the API's.
  if (effort === undefined) return ours('every request sets output_config.effort, since Opus 5.5 defaults to medium.');
  if (format === undefined) return ours('every request asks for structured output with output_config.format.');
  if (body.tools !== undefined) return ours('the reader gives the model no tools.');
  if (body.stream === true) return ours('the reader does not stream, and the fake answers whole messages only.');

  return null;
}

/** Which of the reader's calls a request is, from the schema it asks for. */
export type RequestKind = 'reading' | 'labels';

export function kindOf(request: MessageRequest): RequestKind | null {
  const properties = request.output_config.format.schema.properties;
  if (!isObject(properties)) return null;
  if ('statements' in properties && 'tier' in properties) return 'reading';
  if ('labels' in properties) return 'labels';
  return null;
}

function textOf(content: string | TextBlock[]): string {
  return typeof content === 'string' ? content : content.map((block) => block.text).join('\n');
}

/** Everything the request's messages say, which holds the repo's files or labels. */
export function messagesText(request: MessageRequest): string {
  return request.messages.map((message) => textOf(message.content)).join('\n');
}

/** The system prompt's text. */
export function systemText(request: MessageRequest): string {
  return request.system === undefined ? '' : textOf(request.system);
}
