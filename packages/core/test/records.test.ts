import { describe, expect, test } from 'vitest';
import {
  changedSettings,
  crawlCandidateSchema,
  mustParse,
  parseProjectSettings,
  prRecordSchema,
  projectRecordSchema,
  settingKeys,
  validate,
  type ProjectSettings,
  type Validated,
} from '../src/index';

// The records the database stores, which it checks on the way in and out.

const at = Date.UTC(2026, 8, 26, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function fields(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.problems.map((p) => p.field);
}

function settings(input: unknown): ProjectSettings {
  const result = parseProjectSettings(input);
  if (!result.ok) throw new Error('The sample settings are invalid.');
  return result.value;
}

describe('changed settings', () => {
  const before = settings({ tags: ['help wanted'], disclosure: { trailer: 'Assisted-by', prBody: null } });

  test('only the settings whose value changed are listed, in the order of the settings table', () => {
    const after = settings({
      ...before,
      claimsPerIssue: 5,
      prMode: 'automatic',
      disclosure: { trailer: 'Assisted-by', prBody: 'Written with an agent.' },
    });

    expect(changedSettings(before, after)).toEqual(['prMode', 'disclosure', 'claimsPerIssue']);
    expect(changedSettings(before, before)).toEqual([]);
  });

  test('a change to the order or the case of the tags is a change', () => {
    const two = settings({ tags: ['help wanted', 'ready'] });

    expect(changedSettings(two, settings({ tags: ['ready', 'help wanted'] }))).toEqual(['tags']);
    expect(changedSettings(two, settings({ tags: ['Help Wanted', 'ready'] }))).toEqual(['tags']);
  });

  test('an object setting with its fields in another order has not changed', () => {
    const { trailer, prBody } = before.disclosure;

    expect(changedSettings(before, { ...before, disclosure: { prBody, trailer } })).toEqual([]);
  });

  test('the first save of a project sets every setting', () => {
    expect(changedSettings(null, before)).toEqual(settingKeys);
  });
});

describe('stored projects', () => {
  const project = {
    repo: 'sample-owner/sample-app',
    status: 'approved',
    statusReason: null,
    statusChangedBy: 2001,
    statusChangedAt: at,
    source: 'registered',
    policy: null,
    addedBy: 2001,
    addedAt: at,
    settings: { tags: ['help wanted'] },
    settingsVersion: 1,
  };
  const policy = {
    quote: 'Agents may open pull requests on issues labeled ready for help.',
    url: 'https://github.com/sample-owner/sample-app/blob/main/AI_POLICY.md',
    tier: 'invites_agents',
  };

  test('a project listed from its policy carries the policy, and a registered one carries none', () => {
    expect(fields(validate(projectRecordSchema, { ...project, source: 'policy', policy }))).toEqual([]);
    expect(fields(validate(projectRecordSchema, { ...project, source: 'policy' }))).toEqual(['policy']);
    expect(fields(validate(projectRecordSchema, { ...project, policy }))).toEqual(['policy']);
  });

  test('a rejected project needs a reason, and a pending or approved one has none', () => {
    const reason = 'The notes ask agents to skip tests.';
    expect(fields(validate(projectRecordSchema, { ...project, status: 'rejected' }))).toEqual(['statusReason']);
    expect(fields(validate(projectRecordSchema, { ...project, status: 'rejected', statusReason: reason }))).toEqual([]);
    expect(fields(validate(projectRecordSchema, { ...project, statusReason: reason }))).toEqual(['statusReason']);
    expect(fields(validate(projectRecordSchema, { ...project, status: 'pending', statusReason: reason }))).toEqual([
      'statusReason',
    ]);
  });

  test('a maintainer may pause a project with or without a reason', () => {
    expect(fields(validate(projectRecordSchema, { ...project, status: 'paused' }))).toEqual([]);
    expect(fields(validate(projectRecordSchema, { ...project, status: 'paused', statusReason: 'Busy week.' }))).toEqual([]);
  });

  test('a person is named by numeric GitHub ID', () => {
    expect(fields(validate(projectRecordSchema, { ...project, addedBy: 'sample-maintainer' }))).toEqual(['addedBy']);
  });
});

describe('stored PRs', () => {
  const pr = {
    claimId: 'c_1',
    pr: { repo: 'sample-owner/sample-app', number: 57, url: 'https://github.com/sample-owner/sample-app/pull/57' },
    state: 'open',
    openedAt: at,
    mergedAt: null,
    closedAt: null,
  };

  test('an open PR has no merge or close time', () => {
    expect(fields(validate(prRecordSchema, pr))).toEqual([]);
    expect(fields(validate(prRecordSchema, { ...pr, closedAt: at + DAY }))).toEqual(['closedAt']);
    expect(fields(validate(prRecordSchema, { ...pr, mergedAt: at + DAY }))).toEqual(['mergedAt']);
  });

  test('a merged PR records when it merged and when it closed, as GitHub does', () => {
    const merged = { ...pr, state: 'merged', mergedAt: at + DAY, closedAt: at + DAY };
    expect(fields(validate(prRecordSchema, merged))).toEqual([]);
    expect(fields(validate(prRecordSchema, { ...merged, closedAt: null }))).toEqual(['closedAt']);
    expect(fields(validate(prRecordSchema, { ...merged, mergedAt: null }))).toEqual(['mergedAt']);
  });

  test('a PR closed without merging has a close time and no merge time', () => {
    const closed = { ...pr, state: 'closed', closedAt: at + DAY };
    expect(fields(validate(prRecordSchema, closed))).toEqual([]);
    expect(fields(validate(prRecordSchema, { ...closed, mergedAt: at + DAY }))).toEqual(['mergedAt']);
  });

  test('a PR never merges or closes before it opened', () => {
    const early = { ...pr, state: 'merged', mergedAt: at - 1, closedAt: at - 1 };
    expect(fields(validate(prRecordSchema, early))).toEqual(['mergedAt', 'closedAt']);
  });
});

describe('crawl candidates', () => {
  const candidate = {
    id: 'cand_1',
    repo: 'sample-owner/sample-app',
    foundAt: at,
    facts: { stars: 1200, createdAt: at - 900 * DAY, pushedAt: at - DAY, ownerCreatedAt: at - 2000 * DAY },
    policy: {
      quote: 'Agents may open pull requests on issues labeled ready for help.',
      url: 'https://github.com/sample-owner/sample-app/blob/main/AI_POLICY.md',
      tier: 'invites_agents',
    },
    settings: { prMode: 'automatic' },
    suggestedTags: [{ name: 'ready for help', openIssues: 8 }],
    status: 'waiting',
    decidedBy: null,
    decidedAt: null,
    reason: null,
  };

  test('a waiting candidate has no decision, and a decided one says who decided and when', () => {
    expect(fields(validate(crawlCandidateSchema, candidate))).toEqual([]);
    expect(fields(validate(crawlCandidateSchema, { ...candidate, decidedBy: 9001 }))).toEqual(['decidedBy']);
    expect(fields(validate(crawlCandidateSchema, { ...candidate, status: 'approved' }))).toEqual([
      'decidedBy',
      'decidedAt',
    ]);
  });

  test('a rejected candidate needs a reason, and only a rejected one has one', () => {
    const decided = { ...candidate, decidedBy: 9001, decidedAt: at + DAY };
    expect(fields(validate(crawlCandidateSchema, { ...decided, status: 'rejected' }))).toEqual(['reason']);
    expect(fields(validate(crawlCandidateSchema, { ...decided, status: 'approved', reason: 'Fine.' }))).toEqual([
      'reason',
    ]);
  });

  test('a crawler may suggest settings without tags, which the admin picks', () => {
    expect(fields(validate(crawlCandidateSchema, { ...candidate, settings: {} }))).toEqual([]);
    expect(fields(validate(crawlCandidateSchema, { ...candidate, settings: { prMode: 'yolo' } }))).toEqual([
      'settings.prMode',
    ]);
  });
});

describe('mustParse', () => {
  test('a value that must be valid throws a TypeError naming each problem', () => {
    expect(() => mustParse(prRecordSchema, { claimId: 'c_1' }, 'PR')).toThrow(
      /^Malformed PR\.\npr: .*\nstate: .*\nopenedAt: .*/,
    );
    expect(() => mustParse(prRecordSchema, {}, 'PR')).toThrow(TypeError);
  });
});
