import { createGitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, expect, test, vi } from 'vitest';
import { ANTHROPIC_API, anthropicApiKey, anthropicUrl, modelDailyBudgetUsd, policyReader } from '../src/anthropic';
import { startAnthropic } from './anthropic';
import { setEnv } from './auth/helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});


// A policy reading shaped as docs/specs/model-policy-reader.md says the
// reader sends one, as the SDK sends it.
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const reading = (docs: string) => ({
  model: 'claude-opus-5-5',
  max_tokens: 32_000,
  output_config: {
    effort: 'high',
    format: {
      type: 'json_schema',
      schema: object({
        statements: { type: 'array', items: object({ path: { type: 'string' }, quote: { type: 'string' } }) },
        tier: { type: 'string' },
        steering: { type: 'array', items: object({ path: { type: 'string' } }) },
        summary: { type: 'string' },
      }),
    },
  },
  messages: [{ role: 'user', content: docs }],
});

test("the tests give the Worker a test-only Anthropic key and the fake's URL, never the API's", () => {
  expect(env.ANTHROPIC_API_KEY).toBe('test-only-anthropic-key');
  expect(env.ANTHROPIC_API_URL).toBe('https://api.anthropic.test');
  expect(anthropicUrl()).toBe('https://api.anthropic.test');
  expect(anthropicApiKey()).toBe('test-only-anthropic-key');
});

test("a call to the fake from inside the Worker's runtime gets the sample repo's reading", async () => {
  const anthropic = startAnthropic();

  const response = await fetch(`${anthropicUrl()}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${anthropicApiKey() ?? ''}`, 'anthropic-version': '2026-10-21', 'content-type': 'application/json' },
    body: JSON.stringify(reading('1: # Contributing\n2: We do not accept AI-generated pull requests.')),
  });
  const message = await response.json<{ content: { type: string; text?: string }[] }>();

  expect(response.status).toBe(200);
  expect(JSON.parse(message.content.find((block) => block.type === 'text')?.text ?? '')).toMatchObject({ tier: 'bans_or_restricts' });
  expect(anthropic.requests).toEqual([expect.objectContaining({ kind: 'reading', refused: null })]);
});

test('the fake takes only the test key, so a test sees a call made with another', async () => {
  startAnthropic();

  const response = await fetch(`${anthropicUrl()}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': 'another-key', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(reading('1: Hello.')),
  });

  expect(response.status).toBe(401);
});

test('a test that starts no fake reaches no host at all', async () => {
  await expect(fetch('https://api.anthropic.com/v1/messages', { method: 'POST' })).rejects.toThrow(/Nothing in a test reaches the network/);
  await expect(fetch('https://example.com/')).rejects.toThrow(/Nothing in a test reaches the network/);
});

test('a call to any host but the two fakes fails the test', async () => {
  const github = createGitHubFake({ apiUrl: env.GH_API_URL, webUrl: env.GH_WEB_URL });
  startAnthropic(github);

  await expect(fetch('https://api.anthropic.com/v1/messages', { method: 'POST' })).rejects.toThrow(TypeError);
  await expect(fetch('https://example.com/')).rejects.toThrow(TypeError);
  expect((await fetch(`${env.GH_API_URL}/repos/meanwhileso/goodfirsttoken`, { headers: { 'user-agent': 'test' } })).status).toBe(200);
});

test('an empty ANTHROPIC_API_URL means the Anthropic API', () => {
  const restore = setEnv({ ANTHROPIC_API_URL: '' });
  try {
    expect(anthropicUrl()).toBe(ANTHROPIC_API);
    expect(ANTHROPIC_API).toBe('https://api.anthropic.com');
  } finally {
    restore();
  }
});

test('with no key, the reader has none, except in development against the fake on this machine', () => {
  const cases: [Parameters<typeof setEnv>[0], 'none' | 'stand-in'][] = [
    [{ ANTHROPIC_API_KEY: undefined }, 'none'],
    [{ ANTHROPIC_API_KEY: '', ENVIRONMENT: 'production', ANTHROPIC_API_URL: '' }, 'none'],
    [{ ANTHROPIC_API_KEY: undefined, ENVIRONMENT: 'development', ANTHROPIC_API_URL: 'http://127.0.0.1:8945' }, 'stand-in'],
    [{ ANTHROPIC_API_KEY: undefined, ENVIRONMENT: 'development', ANTHROPIC_API_URL: '' }, 'none'],
    [{ ANTHROPIC_API_KEY: undefined, ENVIRONMENT: 'development', ANTHROPIC_API_URL: 'https://127.0.0.1:8945' }, 'none'],
    [{ ANTHROPIC_API_KEY: undefined, ENVIRONMENT: 'staging', ANTHROPIC_API_URL: 'http://127.0.0.1:8945' }, 'none'],
  ];
  for (const [settings, expected] of cases) {
    const restore = setEnv(settings);
    try {
      const key = anthropicApiKey();
      if (expected === 'none') expect(key, JSON.stringify(settings)).toBeNull();
      else expect(key, JSON.stringify(settings)).toMatch(/^local-only-/);
    } finally {
      restore();
    }
  }
  const restore = setEnv({ ENVIRONMENT: 'development', ANTHROPIC_API_URL: 'http://127.0.0.1:8945', ANTHROPIC_API_KEY: 'a-key-of-its-own' });
  try {
    expect(anthropicApiKey()).toBe('a-key-of-its-own');
  } finally {
    restore();
  }
});

test('POLICY_READER is rules, shadow, or model, and empty or anything else means rules', () => {
  const cases: [string | undefined, string][] = [
    ['rules', 'rules'],
    ['shadow', 'shadow'],
    ['model', 'model'],
    [' model ', 'model'],
    ['', 'rules'],
    [undefined, 'rules'],
    ['Model', 'rules'],
  ];
  for (const [value, expected] of cases) {
    const restore = setEnv({ POLICY_READER: value });
    try {
      expect(policyReader(), String(value)).toBe(expected);
    } finally {
      restore();
    }
  }
});

test('MODEL_DAILY_BUDGET_USD is a number of dollars, and empty or anything else means 0', () => {
  expect(modelDailyBudgetUsd()).toBe(5);
  const cases: [string | undefined, number][] = [
    ['20', 20],
    ['12.50', 12.5],
    ['0', 0],
    ['', 0],
    [undefined, 0],
    ['-5', 0],
    ['twenty', 0],
    ['1e3', 0],
  ];
  for (const [value, expected] of cases) {
    const restore = setEnv({ MODEL_DAILY_BUDGET_USD: value });
    try {
      expect(modelDailyBudgetUsd(), String(value)).toBe(expected);
    } finally {
      restore();
    }
  }
});
