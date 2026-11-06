// A fake of the Anthropic API's Messages API and Message Batches API, for
// tests and local development. It checks each request's shape the way the
// API does for Claude Opus 5.5 (shapes.ts), and answers the policy reader's
// two calls, a policy reading and a label check, from readings recorded for
// the GitHub fake's sample repos (recordings.ts). A batch ends as soon as it
// is sent, unless a test holds it.
//
// A test can script what the fake answers, for one request or many: any
// reading, output that doesn't parse, a refusal, a cut-off answer, an
// errored, expired, or canceled request in a batch, an HTTP error from any
// endpoint, a batch that hasn't ended, and a call that never answers. See
// answer(), fail(), and holdBatches below.
//
// In a test, hand `fake.fetch` to the code under test in place of the global
// fetch. It throws for any URL outside the fake's base URL, so nothing
// reaches the network. For `pnpm dev`, server.ts serves the same fake over
// HTTP.

import { ERROR_STATUS, errorResponse, errorTypeOf, json, newId, type ApiError, type ErrorType } from './http.ts';
import {
  readingFor,
  labelCheckFor,
  resolveRecordings,
  recordedLabels,
  type LabelMeaning,
  type Recording,
} from './recordings.ts';
import {
  API_VERSIONS,
  MODEL,
  checkRequest,
  kindOf,
  messagesText,
  systemText,
  type MessageRequest,
  type RequestKind,
  type ShapeError,
} from './shapes.ts';

export { MODEL, EFFORTS, checkRequest, kindOf, type MessageRequest, type RequestKind } from './shapes.ts';
export { ERROR_STATUS, type ErrorType } from './http.ts';
export type { LabelCheck, Reading, Recording, Statement, Tier, About, LabelMeaning } from './recordings.ts';

// A host under the reserved .test domain, which never resolves.
export const DEFAULT_URL = 'https://api.anthropic.test';

// How many thinking tokens the fake says each answer used. Thinking bills
// as output.
const THINKING_TOKENS = 400;

// The API's limit on requests in one batch.
const MAX_BATCH_REQUESTS = 100_000;
const CUSTOM_ID = /^[a-zA-Z0-9_-]{1,64}$/;
// A batch's results are kept for 29 days, and a batch expires 24 hours after
// it is made.
const BATCH_EXPIRES_MS = 24 * 60 * 60 * 1000;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
  service_tier: 'standard' | 'batch';
}

export interface Message {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ({ type: 'thinking'; thinking: string; signature: string } | { type: 'text'; text: string })[];
  stop_reason: 'end_turn' | 'max_tokens' | 'refusal';
  stop_sequence: null;
  stop_details: { type: 'refusal'; category: string | null; explanation: string | null } | null;
  usage: Usage;
}

export type BatchResult =
  | { type: 'succeeded'; message: Message }
  | { type: 'errored'; error: { type: 'error'; error: ApiError } }
  | { type: 'expired' }
  | { type: 'canceled' };

export interface MessageBatch {
  id: string;
  type: 'message_batch';
  processing_status: 'in_progress' | 'canceling' | 'ended';
  request_counts: { processing: number; succeeded: number; errored: number; canceled: number; expired: number };
  created_at: string;
  ended_at: string | null;
  expires_at: string;
  archived_at: null;
  cancel_initiated_at: string | null;
  results_url: string | null;
}

export interface StoredBatch {
  batch: MessageBatch;
  requests: { custom_id: string; params: unknown }[];
  // Each request's result, by its custom_id, once the batch has ended.
  results: { custom_id: string; result: BatchResult }[] | null;
}

export interface FakeState {
  version: 1;
  batches: Record<string, StoredBatch>;
  // The system prompts written to the prompt cache so far, by a hash of
  // their text, so a second request reads them from the cache.
  cached: string[];
}

/** The fake's endpoints, for fail(). */
export type Endpoint = 'messages' | 'createBatch' | 'getBatch' | 'listBatches' | 'batchResults' | 'cancelBatch' | 'deleteBatch';

export interface RecordedCall {
  method: string;
  url: string;
  endpoint: Endpoint | null;
  // 0 for a call that never answered.
  status: number;
}

/** One request to the model, through the Messages API or inside a batch. */
export interface ModelCall {
  via: 'messages' | 'batch';
  // The batch request's custom_id, or null for the Messages API.
  customId: string | null;
  // Which of the reader's calls it is, from its schema, or null when the
  // fake can't tell or the request was refused.
  kind: RequestKind | null;
  params: unknown;
  // Why the API would refuse it, or null.
  refused: ShapeError | null;
}

/** Which requests a scripted answer applies to. Every field given has to match. */
export interface Match {
  via?: 'messages' | 'batch';
  kind?: RequestKind;
  customId?: string;
  test?: (request: MessageRequest, call: { via: 'messages' | 'batch'; customId: string | null }) => boolean;
}

/**
 * What the model answers instead of the recording.
 *
 * - `output`: this JSON as the model's output, which ends its turn.
 * - `text`: this text as the output, like output that doesn't parse.
 * - `stop: 'refusal'`: a refusal, with no output.
 * - `stop: 'max_tokens'`: output cut off at max_tokens, the recorded output
 *   cut in half unless `text` is given.
 * - `error`: the Messages API answers with this error and its status. In a
 *   batch, the request errors with it.
 * - `result`: in a batch, the request expired or was canceled.
 * - `hang`: the Messages API never answers, until the caller aborts.
 */
export type Answer =
  | { output: unknown }
  | { text: string }
  | { stop: 'refusal'; category?: string | null; explanation?: string | null }
  | { stop: 'max_tokens'; text?: string }
  | { error: ErrorType; message?: string }
  | { result: 'expired' | 'canceled' }
  | { hang: true };

export interface Failure {
  status: number;
  type?: ErrorType;
  message?: string;
}

export interface AnthropicFakeOptions {
  // Where the fake answers the API, like https://api.anthropic.com.
  url?: string;
  // The one API key the fake takes. Without it, any key is taken.
  apiKey?: string;
  now?: () => Date;
  // Start from saved state, as the local server does.
  state?: FakeState;
  // Readings to answer from in place of the recorded ones.
  recordings?: Recording[];
  labels?: Record<string, { meaning: LabelMeaning; why: string }>;
}

export interface AnthropicFake {
  readonly url: string;
  readonly state: FakeState;
  // Every call so far, oldest first.
  readonly calls: RecordedCall[];
  // Every request to the model so far, oldest first.
  readonly requests: ModelCall[];
  // While true, a new batch stays in progress until endBatches().
  holdBatches: boolean;
  // Answers a request the way the API would. It has fetch's signature.
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  // The next `times` requests that match get this answer. `times` is 1
  // unless given, and Infinity answers every one. The first script that
  // matches answers.
  answer: (match: Match, answer: Answer, options?: { times?: number }) => void;
  // The next `times` calls to the endpoint, or to any endpoint, fail with
  // this status, before the key or the request is checked.
  fail: (endpoint: Endpoint | 'any', failure: Failure, options?: { times?: number }) => void;
  // Ends every batch in progress, and returns how many it ended.
  endBatches: () => number;
  // Back to no batches, no calls, and no scripts.
  reset: () => void;
}

interface Script {
  match: Match;
  answer: Answer;
  left: number;
}

interface FailScript {
  endpoint: Endpoint | 'any';
  failure: Failure;
  left: number;
}

type Outcome =
  | { kind: 'message'; message: Message }
  | { kind: 'error'; status: number; error: ApiError }
  | { kind: 'expired' }
  | { kind: 'canceled' }
  | { kind: 'hang' };

export function emptyState(): FakeState {
  return { version: 1, batches: {}, cached: [] };
}

// About four characters to a token, as the API counts English text.
const tokens = (text: string) => Math.ceil(text.length / 4);

// FNV-1a, enough to tell system prompts apart.
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}:${String(text.length)}`;
}

function relativePath(url: URL, base: URL): string | null {
  if (url.origin !== base.origin) return null;
  const basePath = base.pathname.replace(/\/+$/, '');
  if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return null;
  return url.pathname.slice(basePath.length) || '/';
}

function route(method: string, path: string): { endpoint: Endpoint; id: string | null } | null {
  if (path === '/v1/messages' && method === 'POST') return { endpoint: 'messages', id: null };
  if (path === '/v1/messages/batches') {
    if (method === 'POST') return { endpoint: 'createBatch', id: null };
    if (method === 'GET') return { endpoint: 'listBatches', id: null };
    return null;
  }
  const match = /^\/v1\/messages\/batches\/([^/]+)(\/results|\/cancel)?$/.exec(path);
  if (!match?.[1]) return null;
  const id = decodeURIComponent(match[1]);
  if (match[2] === '/results' && method === 'GET') return { endpoint: 'batchResults', id };
  if (match[2] === '/cancel' && method === 'POST') return { endpoint: 'cancelBatch', id };
  if (match[2] === undefined && method === 'GET') return { endpoint: 'getBatch', id };
  if (match[2] === undefined && method === 'DELETE') return { endpoint: 'deleteBatch', id };
  return null;
}

const usesMessages = (answer: Answer) => !('result' in answer);
const usesBatches = (answer: Answer) => !('hang' in answer);

export function createAnthropicFake(options: AnthropicFakeOptions = {}): AnthropicFake {
  const base = new URL(options.url ?? DEFAULT_URL);
  const url = base.toString().replace(/\/+$/, '');
  const now = options.now ?? (() => new Date());
  const recordings = options.recordings ?? resolveRecordings();
  const labels = options.labels ?? recordedLabels;
  let state = options.state ?? emptyState();
  const calls: RecordedCall[] = [];
  const requests: ModelCall[] = [];
  let scripts: Script[] = [];
  let failures: FailScript[] = [];
  let holdBatches = false;

  function usage(request: MessageRequest, outputTokens: number, via: 'messages' | 'batch'): Usage {
    const system = systemText(request);
    const blocks = Array.isArray(request.system) ? request.system : [];
    const breakpoint = blocks.find((block) => block.cache_control)?.cache_control ?? request.cache_control;
    let created = 0;
    let read = 0;
    let input = tokens(messagesText(request));
    if (breakpoint && system) {
      const key = hash(system);
      if (state.cached.includes(key)) read = tokens(system);
      else {
        created = tokens(system);
        state.cached.push(key);
      }
    } else {
      input += tokens(system);
    }
    const oneHour = breakpoint?.ttl === '1h';
    return {
      input_tokens: input,
      output_tokens: outputTokens,
      cache_creation_input_tokens: created,
      cache_read_input_tokens: read,
      cache_creation: { ephemeral_5m_input_tokens: oneHour ? 0 : created, ephemeral_1h_input_tokens: oneHour ? created : 0 },
      service_tier: via === 'batch' ? 'batch' : 'standard',
    };
  }

  function message(
    request: MessageRequest,
    via: 'messages' | 'batch',
    text: string | null,
    stop: Message['stop_reason'],
    details: Message['stop_details'] = null,
  ): Message {
    const outputTokens = stop === 'max_tokens' ? request.max_tokens : THINKING_TOKENS + tokens(text ?? '');
    return {
      id: newId('msg_'),
      type: 'message',
      role: 'assistant',
      model: MODEL,
      // Opus 5.5 thinks on every request, and leaves the thinking empty
      // unless asked to show it.
      content: [{ type: 'thinking', thinking: '', signature: newId('sig_') }, ...(text === null ? [] : [{ type: 'text' as const, text }])],
      stop_reason: stop,
      stop_sequence: null,
      stop_details: details,
      usage: usage(request, outputTokens, via),
    };
  }

  // What the model answers when nothing is scripted: the recording, or an
  // error naming the schema the fake doesn't know.
  function recorded(request: MessageRequest, kind: RequestKind | null): unknown {
    const text = messagesText(request);
    if (kind === 'reading') return readingFor(text, recordings).reading;
    if (kind === 'labels') return labelCheckFor(text, labels);
    return null;
  }

  function outcomeOf(params: unknown, via: 'messages' | 'batch', customId: string | null): Outcome {
    const refused = checkRequest(params, { inBatch: via === 'batch' });
    const request = params as MessageRequest;
    const kind = refused ? null : kindOf(request);
    requests.push({ via, customId, kind, params, refused });
    if (refused) return { kind: 'error', status: refused.status, error: { type: refused.type, message: refused.message } };

    const script = scripts.find(
      ({ match, answer, left }) =>
        left > 0 &&
        (via === 'messages' ? usesMessages(answer) : usesBatches(answer)) &&
        (match.via === undefined || match.via === via) &&
        (match.kind === undefined || match.kind === kind) &&
        (match.customId === undefined || match.customId === customId) &&
        (match.test === undefined || match.test(request, { via, customId })),
    );
    if (script) script.left -= 1;
    const answer = script?.answer;

    if (answer && 'hang' in answer) return { kind: 'hang' };
    if (answer && 'result' in answer) return { kind: answer.result };
    if (answer && 'error' in answer) {
      return { kind: 'error', status: ERROR_STATUS[answer.error], error: { type: answer.error, message: answer.message ?? `The Anthropic fake answered ${answer.error}.` } };
    }
    if (answer && 'stop' in answer && answer.stop === 'refusal') {
      const details = { type: 'refusal' as const, category: answer.category ?? null, explanation: answer.explanation ?? null };
      return { kind: 'message', message: message(request, via, null, 'refusal', details) };
    }
    if (answer && 'text' in answer && !('stop' in answer)) return { kind: 'message', message: message(request, via, answer.text, 'end_turn') };
    if (answer && 'output' in answer) return { kind: 'message', message: message(request, via, JSON.stringify(answer.output), 'end_turn') };

    const output = recorded(request, kind);
    if (output === null) {
      return {
        kind: 'error',
        status: 500,
        error: { type: 'api_error', message: 'The Anthropic fake has no recording for this schema. Script an answer with fake.answer().' },
      };
    }
    const text = JSON.stringify(output);
    if (answer && 'stop' in answer) {
      return { kind: 'message', message: message(request, via, answer.text ?? text.slice(0, Math.floor(text.length / 2)), 'max_tokens') };
    }
    return { kind: 'message', message: message(request, via, text, 'end_turn') };
  }

  const resultOf = (outcome: Outcome): BatchResult => {
    switch (outcome.kind) {
      case 'message':
        return { type: 'succeeded', message: outcome.message };
      case 'error':
        return { type: 'errored', error: { type: 'error', error: outcome.error } };
      case 'expired':
        return { type: 'expired' };
      case 'canceled':
      case 'hang':
        return { type: 'canceled' };
    }
  };

  function end(stored: StoredBatch, canceled: boolean): void {
    if (stored.batch.processing_status === 'ended') return;
    const at = now().toISOString();
    // Results come back in no set order, so the fake sends them last first,
    // which catches code that reads them by position.
    stored.results = stored.requests
      .map(({ custom_id, params }) => ({
        custom_id,
        result: canceled ? ({ type: 'canceled' } as const) : resultOf(outcomeOf(params, 'batch', custom_id)),
      }))
      .reverse();
    const counts = { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 };
    for (const { result } of stored.results) counts[result.type] += 1;
    stored.batch = {
      ...stored.batch,
      processing_status: 'ended',
      request_counts: counts,
      ended_at: at,
      results_url: `${url}/v1/messages/batches/${stored.batch.id}/results`,
    };
  }

  // A batch whose cancel was asked for ends, with every request canceled,
  // the next time anyone asks after it.
  function settle(stored: StoredBatch): StoredBatch {
    if (stored.batch.processing_status === 'canceling') end(stored, true);
    return stored;
  }

  function createBatch(body: unknown, at: Date): Response {
    const list = (body as { requests?: unknown } | null)?.requests;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return errorResponse(400, { message: 'Input should be a valid dictionary' });
    for (const field of Object.keys(body)) {
      if (field !== 'requests') return errorResponse(400, { message: `${field}: Extra inputs are not permitted` });
    }
    if (!Array.isArray(list)) return errorResponse(400, { message: 'requests: Field required' });
    if (list.length === 0) return errorResponse(400, { message: 'requests: List should have at least 1 item after validation, not 0' });
    if (list.length > MAX_BATCH_REQUESTS) {
      return errorResponse(400, { message: `requests: List should have at most ${String(MAX_BATCH_REQUESTS)} items after validation` });
    }
    const seen = new Set<string>();
    const items: StoredBatch['requests'] = [];
    for (const [index, item] of list.entries()) {
      const at = `requests.${String(index)}`;
      if (typeof item !== 'object' || item === null) return errorResponse(400, { message: `${at}: Input should be a valid dictionary` });
      const { custom_id: customId, params, ...rest } = item as Record<string, unknown>;
      const extra = Object.keys(rest)[0];
      if (extra !== undefined) return errorResponse(400, { message: `${at}.${extra}: Extra inputs are not permitted` });
      if (typeof customId !== 'string' || !CUSTOM_ID.test(customId)) {
        return errorResponse(400, { message: `${at}.custom_id: String should match pattern '^[a-zA-Z0-9_-]{1,64}$'` });
      }
      if (seen.has(customId)) return errorResponse(400, { message: `Duplicate custom_id: ${customId}. Each request in a batch needs its own.` });
      seen.add(customId);
      if (typeof params !== 'object' || params === null) return errorResponse(400, { message: `${at}.params: Field required` });
      items.push({ custom_id: customId, params });
    }
    const id = newId('msgbatch_');
    const stored: StoredBatch = {
      batch: {
        id,
        type: 'message_batch',
        processing_status: 'in_progress',
        request_counts: { processing: items.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
        created_at: at.toISOString(),
        ended_at: null,
        expires_at: new Date(at.getTime() + BATCH_EXPIRES_MS).toISOString(),
        archived_at: null,
        cancel_initiated_at: null,
        results_url: null,
      },
      requests: items,
      results: null,
    };
    state.batches[id] = stored;
    if (!holdBatches) end(stored, false);
    return json(stored.batch);
  }

  function listBatches(search: URLSearchParams): Response {
    const limit = Math.min(Math.max(Number(search.get('limit') ?? 20) || 20, 1), 1000);
    let all = Object.values(state.batches)
      .map((stored) => settle(stored).batch)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    const after = search.get('after_id');
    const before = search.get('before_id');
    if (after !== null) all = all.slice(all.findIndex((batch) => batch.id === after) + 1);
    if (before !== null) all = all.slice(0, Math.max(0, all.findIndex((batch) => batch.id === before)));
    const data = all.slice(0, limit);
    return json({ data, has_more: all.length > data.length, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
  }

  async function answer(request: Request, call: RecordedCall): Promise<Response> {
    const found = route(request.method, relativePath(new URL(request.url), base) ?? '');
    if (!found) return errorResponse(404, { type: 'not_found_error', message: 'Not Found' });
    call.endpoint = found.endpoint;

    const failure = failures.find((f) => f.left > 0 && (f.endpoint === 'any' || f.endpoint === found.endpoint));
    if (failure) {
      failure.left -= 1;
      return errorResponse(failure.failure.status, { type: failure.failure.type ?? errorTypeOf(failure.failure.status), message: failure.failure.message });
    }

    // The SDK sends the key as a bearer token from API version 2026-10-21,
    // and in x-api-key before it. The API takes either.
    const bearer = /^bearer\s+(\S+)$/i.exec(request.headers.get('authorization')?.trim() ?? '')?.[1];
    const key = request.headers.get('x-api-key') ?? bearer;
    if (!key) return errorResponse(401, { type: 'authentication_error', message: 'An x-api-key or Authorization header is required.' });
    if (options.apiKey !== undefined && key !== options.apiKey) return errorResponse(401, { type: 'authentication_error', message: 'invalid x-api-key' });
    const version = request.headers.get('anthropic-version');
    if (!version) return errorResponse(400, { message: 'anthropic-version: header is required' });
    if (!API_VERSIONS.includes(version)) return errorResponse(400, { message: `anthropic-version: "${version}" is not a valid version` });

    let body: unknown = null;
    if (request.method === 'POST' && found.endpoint !== 'cancelBatch') {
      try {
        body = JSON.parse(await request.text());
      } catch {
        return errorResponse(400, { message: 'There was an error parsing the body of your request. The body is not valid JSON.' });
      }
    }

    if (found.endpoint === 'messages') {
      const outcome = outcomeOf(body, 'messages', null);
      if (outcome.kind === 'hang') {
        const signal = request.signal;
        return new Promise<Response>((_, reject) => {
          const abort = () => {
            reject(signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError'));
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      }
      if (outcome.kind === 'error') return errorResponse(outcome.status, outcome.error);
      if (outcome.kind === 'message') return json(outcome.message);
      return errorResponse(500, { message: 'The Anthropic fake: an expired or canceled answer applies only in a batch.' });
    }
    if (found.endpoint === 'createBatch') return createBatch(body, now());
    if (found.endpoint === 'listBatches') return listBatches(new URL(request.url).searchParams);

    const stored = found.id === null ? undefined : state.batches[found.id];
    if (!stored) return errorResponse(404, { type: 'not_found_error', message: `No batch with the ID ${found.id ?? ''}.` });
    settle(stored);
    switch (found.endpoint) {
      case 'getBatch':
        return json(stored.batch);
      case 'cancelBatch':
        if (stored.batch.processing_status === 'in_progress') {
          stored.batch = { ...stored.batch, processing_status: 'canceling', cancel_initiated_at: now().toISOString() };
        }
        return json(stored.batch);
      case 'batchResults': {
        if (!stored.results) {
          return errorResponse(400, { message: `Message Batch ${stored.batch.id} has not finished processing. Its results are ready once it has ended.` });
        }
        const lines = stored.results.map((line) => JSON.stringify(line)).join('\n');
        return new Response(`${lines}\n`, { headers: { 'content-type': 'application/binary', 'request-id': newId('req_') } });
      }
      case 'deleteBatch':
        if (stored.batch.processing_status !== 'ended') {
          return errorResponse(400, { message: `Message Batch ${stored.batch.id} is still in progress. Cancel it, and delete it once it has ended.` });
        }
        Reflect.deleteProperty(state.batches, stored.batch.id);
        return json({ id: stored.batch.id, type: 'message_batch_deleted' });
    }
  }

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    if (relativePath(target, base) === null) {
      throw new TypeError(`The Anthropic fake answers only ${url}, and refused ${target.toString()}. Nothing in a test reaches the network.`);
    }
    const call: RecordedCall = { method: request.method, url: target.toString(), endpoint: null, status: 0 };
    calls.push(call);
    const response = await answer(request, call);
    call.status = response.status;
    return response;
  };

  return {
    url,
    get state() {
      return state;
    },
    calls,
    requests,
    get holdBatches() {
      return holdBatches;
    },
    set holdBatches(hold: boolean) {
      holdBatches = hold;
    },
    fetch,
    answer: (match, answer, { times = 1 } = {}) => {
      scripts.push({ match, answer, left: times });
    },
    fail: (endpoint, failure, { times = 1 } = {}) => {
      failures.push({ endpoint, failure, left: times });
    },
    endBatches: () => {
      const open = Object.values(state.batches).filter((stored) => stored.batch.processing_status === 'in_progress');
      for (const stored of open) end(stored, false);
      return open.length;
    },
    reset: () => {
      state = emptyState();
      calls.length = 0;
      requests.length = 0;
      scripts = [];
      failures = [];
      holdBatches = false;
    },
  };
}
