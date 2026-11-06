import Anthropic from '@anthropic-ai/sdk';
import { expect, test } from 'vitest';
import { createAnthropicFake } from '../src/index.ts';
import { KEY, client, docsOf, labelRequest, outputOf, readingRequest } from './requests.ts';

test("a policy reading through the SDK gets the sample repo's recorded reading, after an empty thinking block", async () => {
  const fake = createAnthropicFake({ apiKey: KEY });

  const message = await client(fake).messages.create(readingRequest(docsOf('sample-policies/bans-ai')));

  expect(message.model).toBe('claude-opus-5-5');
  expect(message.stop_reason).toBe('end_turn');
  expect(message.content[0]).toMatchObject({ type: 'thinking', thinking: '' });
  expect(JSON.parse(outputOf(message))).toEqual({
    statements: [
      {
        path: 'CONTRIBUTING.md',
        startLine: 7,
        endLine: 7,
        quote: 'We do not accept AI-generated pull requests.',
        about: 'bansAi',
        label: null,
        value: null,
        why: 'Refuses AI-generated pull requests.',
      },
    ],
    tier: 'bans_or_restricts',
    steering: [],
    summary: 'Refuses AI-generated pull requests.',
  });
  expect(fake.requests).toEqual([expect.objectContaining({ via: 'messages', kind: 'reading', refused: null })]);
  expect(message.usage).toMatchObject({ output_tokens_details: { thinking_tokens: 400 }, inference_geo: 'global', server_tool_use: null });
  expect(message).toMatchObject({ container: null, diagnostics: null });
});

test('a streamed label check, as register_project sends it, gets the recorded answer as server-sent events', async () => {
  const fake = createAnthropicFake();

  const streamed = await client(fake).messages.stream(labelRequest(['help wanted', 'bug'])).finalMessage();
  const whole = await client(fake).messages.create(labelRequest(['help wanted', 'bug']));

  expect(streamed.stop_reason).toBe('end_turn');
  expect(streamed.content[0]).toMatchObject({ type: 'thinking', thinking: '' });
  expect(JSON.parse(outputOf(streamed))).toEqual(JSON.parse(outputOf(whole)));
  expect(streamed.usage).toMatchObject({ output_tokens: whole.usage.output_tokens, output_tokens_details: { thinking_tokens: 400 } });
});

test('a streamed refusal says so, with its category', async () => {
  const fake = createAnthropicFake();
  fake.answer({}, { stop: 'refusal', category: 'cyber' });

  const refused = await client(fake).messages.stream(labelRequest(['help wanted'])).finalMessage();

  expect(refused).toMatchObject({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } });
  expect(outputOf(refused)).toBe('');
});

test('docs the fake has no recording for get a no_policy reading', async () => {
  const fake = createAnthropicFake();

  const message = await client(fake).messages.create(readingRequest('=== file README.md\n1: # A repo\n2: It sorts things.\n'));

  expect(JSON.parse(outputOf(message))).toMatchObject({ statements: [], tier: 'no_policy', steering: [] });
});

test('a label check names the labels the recordings give a meaning, and no others', async () => {
  const fake = createAnthropicFake();

  const message = await client(fake).messages.create(labelRequest(['bug', 'agent ready', 'good first issue', 'documentation']));

  expect(JSON.parse(outputOf(message))).toEqual({
    labels: [
      expect.objectContaining({ name: 'good first issue', meaning: 'keptForPeople', evidence: 'name', statement: null }),
      expect.objectContaining({ name: 'agent ready', meaning: 'readyForOutsideHelp', evidence: 'name', statement: null }),
    ],
  });
});

test('the system prompt is written to the cache once, and read from it after', async () => {
  const fake = createAnthropicFake();
  const sdk = client(fake);

  const first = await sdk.messages.create(readingRequest(docsOf('sample-policies/silent')));
  const second = await sdk.messages.create(readingRequest(docsOf('sample-policies/bans-ai')));

  expect(first.usage.cache_creation_input_tokens).toBeGreaterThan(0);
  expect(first.usage.cache_creation).toMatchObject({ ephemeral_5m_input_tokens: 0 });
  expect(first.usage.cache_read_input_tokens).toBe(0);
  expect(second.usage.cache_creation_input_tokens).toBe(0);
  expect(second.usage.cache_read_input_tokens).toBe(first.usage.cache_creation_input_tokens);
  expect(second.usage.output_tokens).toBeGreaterThan(0);
});

// Each change makes a request the API, or the reader's contract, refuses,
// from a request that runs.
const wrongShapes: [string, (request: Record<string, unknown>) => void, RegExp, number?][] = [
  ['another model', (r) => (r.model = 'claude-opus-5'), /model: claude-opus-5/, 404],
  ['thinking turned off', (r) => (r.thinking = { type: 'disabled' }), /"disabled" is not supported/],
  ['a thinking budget', (r) => (r.thinking = { type: 'enabled', budget_tokens: 4000 }), /thinking\.type\.enabled is not supported/],
  ['an assistant prefill', (r) => (r.messages = [...(r.messages as unknown[]), { role: 'assistant', content: '{' }]), /prefill/],
  ['forced tool use', (r) => (r.tool_choice = { type: 'any' }), /tool_choice: type "tool" and "any" are not supported/],
  ['a forced tool', (r) => (r.tool_choice = { type: 'tool', name: 'read' }), /tool_choice: type "tool" and "any" are not supported/],
  ['a temperature', (r) => (r.temperature = 0), /temperature: is not supported/],
  ['a top_p', (r) => (r.top_p = 0.9), /top_p: is not supported/],
  ['a top_k', (r) => (r.top_k = 5), /top_k: is not supported/],
  ['thinking shown as updates, a beta the reader lacks', (r) => (r.thinking = { type: 'adaptive', display: 'updates' }), /thinking\.display/],
  [
    'a system message before a user message',
    (r) => (r.messages = [...(r.messages as unknown[]), { role: 'user', content: 'More.' }]),
    /a system message must be the last message or be followed by an assistant message/,
  ],
  [
    'a cache lifetime the API lacks',
    (r) => (r.system = [{ type: 'text', text: 'Read this.', cache_control: { type: 'ephemeral', ttl: '10m' } }]),
    /cache_control\.ttl/,
  ],
  [
    'five cache breakpoints',
    (r) => (r.system = Array.from({ length: 5 }, (_, i) => ({ type: 'text', text: `Part ${String(i)}.`, cache_control: { type: 'ephemeral' } }))),
    /A maximum of 4 blocks with cache_control may be provided\. Found 5\./,
  ],
  [
    'an image',
    (r) => (r.messages = [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }] }]),
    /The reader sends text blocks only/,
  ],
  ['empty content', (r) => (r.messages = [{ role: 'user', content: '' }]), /text content blocks must be non-empty/],
  ['no effort', (r) => (r.output_config = { format: (r.output_config as { format: unknown }).format }), /output_config\.effort/],
  ['an effort the API lacks', (r) => (r.output_config = { ...(r.output_config as object), effort: 'extreme' }), /output_config\.effort: Input should be/],
  ['no structured output', (r) => (r.output_config = { effort: 'high' }), /output_config\.format/],
  [
    'a schema object open to more properties',
    (r) =>
      (r.output_config = {
        effort: 'high',
        format: { type: 'json_schema', schema: { type: 'object', properties: { tier: { type: 'string' } } } },
      }),
    /'additionalProperties' must be explicitly set to false/,
  ],
  [
    'a nested schema object open to more properties',
    (r) =>
      (r.output_config = {
        effort: 'high',
        format: {
          type: 'json_schema',
          schema: { type: 'object', additionalProperties: false, properties: { statements: { type: 'array', items: { type: 'object', properties: {} } } } },
        },
      }),
    /For 'root\.statements\[\]'/,
  ],
  ['a fallback model', (r) => (r.fallbacks = 'default'), /fallbacks/],
  ['tools', (r) => (r.tools = [{ name: 'read', input_schema: { type: 'object' } }]), /no tools/],
  ['a system message first', (r) => (r.messages = [{ role: 'system', content: 'Read this.' }, ...(r.messages as unknown[])]), /a system message must follow a user message/],
  ['a field the API lacks', (r) => (r.prefill = '{'), /prefill: Extra inputs are not permitted/],
  ['too many output tokens', (r) => (r.max_tokens = 200_000), /maximum allowed number of output tokens/],
];

test.each(wrongShapes)('the fake refuses a request with %s', async (_, change, message, status = 400) => {
  const fake = createAnthropicFake();
  const request = readingRequest(docsOf('sample-policies/bans-ai')) as unknown as Record<string, unknown>;
  change(request);

  const refused = await client(fake)
    .messages.create(request as unknown as Anthropic.MessageCreateParamsNonStreaming)
    .catch((error: unknown) => error);

  if (!(refused instanceof Anthropic.APIError)) throw new Error('the fake ran a request it should refuse');
  expect(refused.status).toBe(status);
  expect((refused.error as { error?: { message?: string } } | undefined)?.error?.message).toMatch(message);
  expect(fake.requests[0]?.refused?.message).toMatch(message);
});

test('the fake refuses a call with no key, a key it was not given, or no API version', async () => {
  const fake = createAnthropicFake({ apiKey: KEY });
  const request = JSON.stringify(readingRequest(docsOf('sample-policies/silent')));
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': KEY };
  const send = (change: Record<string, string | null>) => {
    const sent = new Headers(headers);
    for (const [name, value] of Object.entries(change)) {
      if (value === null) sent.delete(name);
      else sent.set(name, value);
    }
    return fake.fetch(`${fake.url}/v1/messages`, { method: 'POST', body: request, headers: sent });
  };

  const keyless = await send({ 'x-api-key': null });
  const wrongKey = await send({ 'x-api-key': 'another-key' });
  const versionless = await send({ 'anthropic-version': null });
  const good = await send({});

  expect(keyless.status).toBe(401);
  expect(await keyless.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
  expect(wrongKey.status).toBe(401);
  expect(versionless.status).toBe(400);
  expect(good.status).toBe(200);
});

test('a fake given no key takes any key as a bearer token or in x-api-key, and still refuses a call with none', async () => {
  const fake = createAnthropicFake();
  const body = JSON.stringify(readingRequest(docsOf('sample-policies/silent')));
  const send = (headers: Record<string, string>) =>
    fake.fetch(`${fake.url}/v1/messages`, { method: 'POST', body, headers: { 'anthropic-version': '2026-10-21', ...headers } });

  expect((await send({ authorization: 'Bearer any-key' })).status).toBe(200);
  expect((await send({ 'x-api-key': 'another-key' })).status).toBe(200);
  expect((await send({})).status).toBe(401);
});

test('the fake refuses any URL outside its own, so code under test cannot reach the network', async () => {
  const fake = createAnthropicFake();

  await expect(fake.fetch('https://api.anthropic.com/v1/messages', { method: 'POST' })).rejects.toThrow(
    /refused https:\/\/api\.anthropic\.com\/v1\/messages/,
  );
  await expect(fake.fetch('https://api.anthropic.test.example.com/v1/messages')).rejects.toThrow(TypeError);
  expect(fake.calls).toEqual([]);
});
