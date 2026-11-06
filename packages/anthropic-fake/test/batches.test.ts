import type Anthropic from '@anthropic-ai/sdk';
import { expect, test } from 'vitest';
import { createAnthropicFake } from '../src/index.ts';
import { client, docsOf, readingRequest } from './requests.ts';

type Result = Anthropic.Messages.MessageBatchIndividualResponse;

async function resultsOf(sdk: Anthropic, id: string): Promise<Result[]> {
  const results: Result[] = [];
  for await (const result of await sdk.messages.batches.results(id)) results.push(result);
  return results;
}

const output = (result: Result | undefined) => {
  if (result?.result.type !== 'succeeded') throw new Error(`expected a succeeded result, got ${String(result?.result.type)}`);
  const text = result.result.message.content.find((block) => block.type === 'text');
  return JSON.parse(text?.type === 'text' ? text.text : '') as { tier: string };
};

test('a batch ends at once, and each result, by its custom_id, is the recorded reading', async () => {
  const fake = createAnthropicFake();
  const sdk = client(fake);
  const repos = ['sample-policies/bans-ai', 'sample-policies/invites-agents', 'sample-policies/silent'];

  const batch = await sdk.messages.batches.create({
    requests: repos.map((repo, i) => ({ custom_id: `reading-${String(i)}`, params: readingRequest(docsOf(repo)) })),
  });
  const ended = await sdk.messages.batches.retrieve(batch.id);
  const results = await resultsOf(sdk, batch.id);
  const byId = new Map(results.map((result) => [result.custom_id, result]));

  expect(batch.processing_status).toBe('ended');
  expect(ended.request_counts).toEqual({ processing: 0, succeeded: 3, errored: 0, canceled: 0, expired: 0 });
  expect(results.map((result) => result.custom_id)).toEqual(['reading-2', 'reading-1', 'reading-0']);
  expect(output(byId.get('reading-0')).tier).toBe('bans_or_restricts');
  expect(output(byId.get('reading-1')).tier).toBe('invites_agents');
  expect(output(byId.get('reading-2')).tier).toBe('no_policy');
  expect(byId.get('reading-0')?.result).toMatchObject({ message: { usage: { service_tier: 'batch' } } });
});

test('a request of the wrong shape in a batch errors as an invalid request, and the rest still run', async () => {
  const fake = createAnthropicFake();
  const sdk = client(fake);
  const good = readingRequest(docsOf('sample-policies/bans-ai'));

  const batch = await sdk.messages.batches.create({
    requests: [
      { custom_id: 'good', params: good },
      { custom_id: 'fallback', params: { ...good, fallbacks: 'default' } as typeof good },
      { custom_id: 'prefill', params: { ...good, messages: [...good.messages, { role: 'assistant', content: '{' }] } },
    ],
  });
  const results = new Map((await resultsOf(sdk, batch.id)).map((result) => [result.custom_id, result.result]));

  expect(batch.request_counts).toMatchObject({ succeeded: 1, errored: 2 });
  expect(results.get('good')?.type).toBe('succeeded');
  const fallback = results.get('fallback');
  expect(fallback).toMatchObject({ type: 'errored', error: { type: 'error', error: { type: 'invalid_request_error' } } });
  expect(fallback?.type === 'errored' ? fallback.error.error.message : '').toMatch(/not supported in the Message Batches API/);
  expect(results.get('prefill')).toMatchObject({ type: 'errored', error: { error: { type: 'invalid_request_error' } } });
});

test('a held batch stays in progress, has no results yet, and ends when the test says', async () => {
  const fake = createAnthropicFake();
  const sdk = client(fake);
  fake.holdBatches = true;

  const batch = await sdk.messages.batches.create({
    requests: [{ custom_id: 'one', params: readingRequest(docsOf('sample-policies/bans-ai')) }],
  });
  const early = await sdk.messages.batches.retrieve(batch.id);
  const tooSoon = await fake.fetch(`${fake.url}/v1/messages/batches/${batch.id}/results`, {
    headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
  });
  const readBeforeTheEnd = fake.requests.length;
  const ended = fake.endBatches();
  const later = await sdk.messages.batches.retrieve(batch.id);

  expect(early).toMatchObject({ processing_status: 'in_progress', results_url: null, request_counts: { processing: 1 } });
  expect(tooSoon.status).toBe(400);
  expect(readBeforeTheEnd).toBe(0);
  expect(ended).toBe(1);
  expect(later).toMatchObject({ processing_status: 'ended', request_counts: { succeeded: 1 } });
  expect(await resultsOf(sdk, batch.id)).toHaveLength(1);
});

test('canceling a batch in progress ends it with every request canceled', async () => {
  const fake = createAnthropicFake();
  const sdk = client(fake);
  fake.holdBatches = true;
  const batch = await sdk.messages.batches.create({
    requests: [{ custom_id: 'one', params: readingRequest(docsOf('sample-policies/bans-ai')) }],
  });

  const canceling = await sdk.messages.batches.cancel(batch.id);
  const ended = await sdk.messages.batches.retrieve(batch.id);

  expect(canceling.processing_status).toBe('canceling');
  expect(ended).toMatchObject({ processing_status: 'ended', request_counts: { canceled: 1 } });
  expect((await resultsOf(sdk, batch.id))[0]?.result).toEqual({ type: 'canceled' });
});

test('a test can make one request in a batch error, expire, or be canceled, by its custom_id', async () => {
  const fake = createAnthropicFake();
  const sdk = client(fake);
  fake.answer({ customId: 'overloaded' }, { error: 'overloaded_error' });
  fake.answer({ customId: 'server' }, { error: 'api_error' });
  fake.answer({ customId: 'expired' }, { result: 'expired' });
  fake.answer({ customId: 'canceled' }, { result: 'canceled' });
  const params = readingRequest(docsOf('sample-policies/bans-ai'));

  const batch = await sdk.messages.batches.create({
    requests: ['overloaded', 'server', 'expired', 'canceled', 'fine'].map((id) => ({ custom_id: id, params })),
  });
  const results = new Map((await resultsOf(sdk, batch.id)).map((result) => [result.custom_id, result.result]));

  expect(batch.request_counts).toEqual({ processing: 0, succeeded: 1, errored: 2, canceled: 1, expired: 1 });
  expect(results.get('overloaded')).toMatchObject({ type: 'errored', error: { error: { type: 'overloaded_error' } } });
  expect(results.get('server')).toMatchObject({ type: 'errored', error: { error: { type: 'api_error' } } });
  expect(results.get('expired')).toEqual({ type: 'expired' });
  expect(results.get('canceled')).toEqual({ type: 'canceled' });
  expect(results.get('fine')?.type).toBe('succeeded');
});

test('a batch with a repeated or malformed custom_id, or no requests, is refused whole', async () => {
  const fake = createAnthropicFake();
  const params = readingRequest(docsOf('sample-policies/bans-ai'));
  const send = (requests: unknown) =>
    fake.fetch(`${fake.url}/v1/messages/batches`, {
      method: 'POST',
      headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ requests }),
    });

  const repeated = await send([
    { custom_id: 'same', params },
    { custom_id: 'same', params },
  ]);
  const malformed = await send([{ custom_id: 'has spaces', params }]);
  const empty = await send([]);

  for (const response of [repeated, malformed, empty]) expect(response.status).toBe(400);
  expect(Object.keys(fake.state.batches)).toEqual([]);
});

test('listing batches gives the newest first', async () => {
  let clock = Date.parse('2026-11-05T12:00:00Z');
  const fake = createAnthropicFake({ now: () => new Date((clock += 1000)) });
  const sdk = client(fake);
  const params = readingRequest(docsOf('sample-policies/bans-ai'));

  const first = await sdk.messages.batches.create({ requests: [{ custom_id: 'a', params }] });
  const second = await sdk.messages.batches.create({ requests: [{ custom_id: 'b', params }] });
  const page = await sdk.messages.batches.list({ limit: 10 });

  expect(page.data.map((batch) => batch.id)).toEqual([second.id, first.id]);
});
