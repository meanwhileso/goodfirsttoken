import type { AnthropicFake } from '@goodfirsttoken/anthropic-fake';
import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { utcDay } from '../../src/crawl/reader';
import { daySpend, dayUse } from '../../src/db';
import { checkLabels, LABEL_CHECK } from '../../src/projects/label-check';
import { startAnthropic } from '../anthropic';
import { setEnv, startGitHub } from '../auth/helpers';
import { db, emptyDatabase } from '../db/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from './helpers';

// register_project's label check, with the model deciding: the maintainer's
// agent asks for a proposal, the Worker reads the repo's labels with the
// maintainer's token through GitHub's GraphQL API, with their descriptions
// and open counts, and the model reads them through the Messages API of the
// Anthropic fake, streamed. Its tags replace the ones meansReady gives, and
// whenever the check can't run the proposal falls back to meansReady. The
// repos and labels are the GitHub fake's made-up sample data.

const HARBOR = 'sample-owner/sample-harbor';
const MAINTAINER = 'octo-maintainer';
const MAINTAINER_ID = 1008;

let github: GitHubFake;
let anthropic: AnthropicFake;
let restore: () => void;
const timing = { ...LABEL_CHECK };

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
  anthropic = startAnthropic(github);
  restore = setEnv({ POLICY_READER: 'model', MODEL_DAILY_BUDGET_USD: '20' });
  vi.spyOn(env.MCP_LIMITER, 'limit').mockResolvedValue({ success: true });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const harbor = github.state.repos[HARBOR];
  if (!harbor) throw new Error('missing sample repo');
  harbor.labels.push({ id: 8_000_001, name: 'up-for-grabs', color: 'ededed', description: 'Anyone may take this one', default: false });
});

afterEach(() => {
  restore();
  Object.assign(LABEL_CHECK, timing);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Result {
  content: { type: string; text: string }[];
  structuredContent?: { settings?: { tags?: string[] }; reasons?: { setting: string; reason: string }[] };
  isError?: boolean;
}

async function propose(agent?: ConnectedAgent): Promise<Result> {
  const caller = agent ?? (await connectAgent(github, MAINTAINER));
  return (await caller.client.callTool({ name: 'register_project', arguments: { repo: HARBOR } })) as Result;
}

function tagReason(result: Result): string {
  return result.structuredContent?.reasons?.find((r) => r.setting === 'tags')?.reason ?? '';
}

/** The model's answer to the next label check. */
function labelsAnswer(labels: { name: string; meaning: string }[], times = 1): void {
  anthropic.answer(
    { kind: 'labels', via: 'messages' },
    { output: { labels: labels.map((label) => ({ ...label, evidence: 'description', statement: null, why: 'It says so.' })) } },
    { times },
  );
}

function checks(): number {
  return anthropic.requests.filter((r) => r.kind === 'labels').length;
}

describe('register_project, with the model deciding', () => {
  test("proposes the model's tags from a streamed label check at medium effort, with each label's description and open count, and good first issue left out", async () => {
    labelsAnswer([
      { name: 'up-for-grabs', meaning: 'readyForOutsideHelp' },
      { name: 'good first issue', meaning: 'readyForOutsideHelp' },
    ]);

    const result = await propose();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.settings?.tags).toEqual(['up-for-grabs']);
    expect(tagReason(result)).toBe('a label the model reader read as ready for outside help, from their names and descriptions');
    const [request] = anthropic.requests;
    expect(request).toMatchObject({ via: 'messages', kind: 'labels', refused: null });
    expect(request?.params).toMatchObject({ stream: true, max_tokens: 16_000, output_config: { effort: 'medium' } });
    const turn = (request?.params as { messages: { content: string }[] }).messages[0]?.content ?? '';
    expect(turn).toContain(JSON.stringify({ name: 'up-for-grabs', description: 'Anyone may take this one', openIssues: 0 }));
    expect(turn).toContain('"name":"help wanted","description":"Extra attention is needed","openIssues":1');
    // The labels came from one GraphQL call with the maintainer's token, not the REST list.
    expect(github.calls.filter((call) => call.operation === 'GET /repos/{owner}/{repo}/labels')).toEqual([]);
    // It spent from register_project's share, and holds nothing reserved.
    expect((await dayUse(db, utcDay(Date.now()))).register).toBeGreaterThan(0);
    expect((await daySpend(db, utcDay(Date.now()))).reserved).toBe(0);
  });

  test('a second proposal for the same labels uses the kept check, and new labels make a new one', async () => {
    labelsAnswer([{ name: 'up-for-grabs', meaning: 'readyForOutsideHelp' }], Infinity);
    const agent = await connectAgent(github, MAINTAINER);

    await propose(agent);
    const again = await propose(agent);
    expect(checks()).toBe(1);
    expect(again.structuredContent?.settings?.tags).toEqual(['up-for-grabs']);

    github.state.repos[HARBOR]?.labels.push({ id: 8_000_002, name: 'pr-welcome', color: 'ededed', description: null, default: false });
    await propose(agent);
    expect(checks()).toBe(2);
  });

  test('falls back to meansReady with no key, and says the labels were read by name', async () => {
    restore();
    restore = setEnv({ POLICY_READER: 'model', MODEL_DAILY_BUDGET_USD: '20', ANTHROPIC_API_KEY: '' });

    const result = await propose();

    expect(checks()).toBe(0);
    expect(result.structuredContent?.settings?.tags).toEqual(['help wanted']);
    expect(tagReason(result)).toBe('a label the repo has for outside help, read by name, since the model reader has no key');
  });

  test('falls back to meansReady when the call fails, after the SDK tries twice more', async () => {
    anthropic.fail('messages', { status: 500, type: 'api_error' }, { times: Infinity });

    const result = await propose();

    expect(anthropic.calls.filter((call) => call.endpoint === 'messages')).toHaveLength(3);
    expect(result.structuredContent?.settings?.tags).toEqual(['help wanted']);
    expect(tagReason(result)).toContain("read by name, since the model reader's check of the labels failed");
    expect((await daySpend(db, utcDay(Date.now()))).reserved).toBe(0);
  });

  test('falls back to meansReady when the call hangs past its timeout', async () => {
    LABEL_CHECK.timeoutMs = 200;
    anthropic.answer({ kind: 'labels', via: 'messages' }, { hang: true }, { times: Infinity });

    const result = await propose();

    expect(result.structuredContent?.settings?.tags).toEqual(['help wanted']);
    expect(tagReason(result)).toContain("the model reader's check of the labels failed");
    // A call cut off may have been billed, so what it reserved counts as spent.
    expect(await daySpend(db, utcDay(Date.now()))).toMatchObject({ reserved: 0, spent: expect.any(Number) as unknown });
    expect((await daySpend(db, utcDay(Date.now()))).spent).toBeGreaterThan(0);
  });

  test('falls back to meansReady when the model refuses', async () => {
    anthropic.answer({ kind: 'labels', via: 'messages' }, { stop: 'refusal' });

    const result = await propose();

    expect(result.structuredContent?.settings?.tags).toEqual(['help wanted']);
    expect(tagReason(result)).toContain('the model reader gave no verdict on the labels');
  });

  test("falls back to meansReady, with no call, when register_project's share of the day is spent", async () => {
    // A budget whose 10% share can't hold one check.
    restore();
    restore = setEnv({ POLICY_READER: 'model', MODEL_DAILY_BUDGET_USD: '1' });

    const result = await propose();

    expect(checks()).toBe(0);
    expect(result.structuredContent?.settings?.tags).toEqual(['help wanted']);
    expect(tagReason(result)).toContain("spent its share of today's budget for registrations");
  });

  test('reads the labels by name as before while the model decides nothing', async () => {
    restore();
    restore = setEnv({ POLICY_READER: 'shadow', MODEL_DAILY_BUDGET_USD: '20' });

    const result = await propose();

    expect(checks()).toBe(0);
    expect(result.structuredContent?.settings?.tags).toEqual(['help wanted']);
    expect(tagReason(result)).toBe('a label the repo has for outside help');
  });
});

describe('a repo with no labels', () => {
  test('makes no call, and takes none of the limits', async () => {
    expect(await checkLabels(db, { caller: MAINTAINER_ID, repo: HARBOR, labels: [], now: Date.now() })).toEqual({ fallback: 'the repo has no labels to check' });
    expect(checks()).toBe(0);
  });
});

describe('the label check limits', () => {
  const labels = (n: number) => [{ name: `area ${String(n)}`, description: null, openIssues: 0 }];

  test('one repo gets at most 3 checks a day, and then falls back', async () => {
    labelsAnswer([], Infinity);
    const now = Date.UTC(2100, 3, 1, 12);
    const outcomes = [];
    for (let n = 0; n < 4; n++) outcomes.push(await checkLabels(db, { caller: MAINTAINER_ID, repo: HARBOR, labels: labels(n), now }));

    expect(outcomes.slice(0, 3)).toEqual([{ tags: [] }, { tags: [] }, { tags: [] }]);
    expect(outcomes[3]).toMatchObject({ fallback: expect.stringContaining('as many times today') as unknown });
    expect(checks()).toBe(3);
    // The next UTC day starts over.
    expect(await checkLabels(db, { caller: MAINTAINER_ID, repo: HARBOR, labels: labels(9), now: now + 24 * 60 * 60 * 1000 })).toEqual({ tags: [] });
  });

  test('a check its share of the budget turned away takes none of the limits', async () => {
    labelsAnswer([], Infinity);
    const now = Date.UTC(2100, 3, 1, 12);
    restore();
    restore = setEnv({ POLICY_READER: 'model', MODEL_DAILY_BUDGET_USD: '1' });
    for (let n = 0; n < 4; n++) {
      expect(await checkLabels(db, { caller: MAINTAINER_ID, repo: HARBOR, labels: labels(n), now })).toMatchObject({ fallback: expect.stringContaining('share') as unknown });
    }
    restore();
    restore = setEnv({ POLICY_READER: 'model', MODEL_DAILY_BUDGET_USD: '20' });

    expect(await checkLabels(db, { caller: MAINTAINER_ID, repo: HARBOR, labels: labels(5), now })).toEqual({ tags: [] });
    expect((await daySpend(db, utcDay(now))).reserved).toBe(0);
  });

  test('one caller gets at most 10 checks a day, across repos, and then falls back', async () => {
    labelsAnswer([], Infinity);
    const now = Date.UTC(2100, 3, 1, 12);
    const outcomes = [];
    for (let n = 0; n < 11; n++) outcomes.push(await checkLabels(db, { caller: MAINTAINER_ID, repo: `sample-owner/repo-${String(n)}`, labels: labels(n), now }));

    expect(outcomes.filter((o) => o !== null && 'tags' in o)).toHaveLength(10);
    expect(outcomes[10]).toMatchObject({ fallback: expect.stringContaining('as many times today') as unknown });
    expect(await checkLabels(db, { caller: MAINTAINER_ID + 1, repo: 'sample-owner/repo-x', labels: labels(99), now })).toEqual({ tags: [] });
  });
});
