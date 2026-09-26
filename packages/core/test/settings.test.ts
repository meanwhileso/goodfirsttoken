import { describe, expect, test } from 'vitest';
import {
  describeProblems,
  invalidSettings,
  parseProjectSettings,
  toolRefusal,
  updateProjectSettings,
  type ProjectSettings,
  type Validated,
} from '../src/index';

function settings(input: unknown): ProjectSettings {
  const result = parseProjectSettings(input);
  if (!result.ok) throw new Error(describeProblems(result.problems));
  return result.value;
}

function problemFields(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.problems.map((p) => p.field);
}

describe('project settings', () => {
  test('a project with no tag is rejected', () => {
    expect(problemFields(parseProjectSettings({}))).toEqual(['tags']);
    expect(problemFields(parseProjectSettings({ tags: [] }))).toEqual(['tags']);
  });

  test('a project gets reviewed PRs unless it chooses automatic', () => {
    expect(settings({ tags: ['help wanted'] }).prMode).toBe('reviewed');
    expect(settings({ tags: ['help wanted'], prMode: 'automatic' }).prMode).toBe('automatic');
  });

  test('notes for agents that are only spaces are saved as empty', () => {
    expect(settings({ tags: ['help wanted'], agentNotes: '  \n\t ' }).agentNotes).toBe('');
  });

  test('settings a project leaves out take the defaults in the settings table', () => {
    expect(settings({ tags: ['help wanted'] })).toEqual({
      tags: ['help wanted'],
      excludedTags: [],
      issueRepo: null,
      prMode: 'reviewed',
      whoCanClaim: 'anyone',
      disclosure: {
        trailer: 'Assisted-by',
        prBody: 'Written with a coding agent through Good First Token.',
      },
      personWrittenDescription: false,
      claUrl: null,
      agentNotes: '',
      claimsPerIssue: 3,
      openPrsPerDonor: 2,
    });
  });

  test('a project can ask for its own disclosure text in the PR body, with no trailer', () => {
    const disclosure = { trailer: null, prBody: 'Fill in the AI section of the PR template.' };
    expect(settings({ tags: ['help wanted'], disclosure }).disclosure).toEqual(disclosure);
  });

  test.each([
    ['tags', { tags: ['help wanted', 'Help Wanted'] }],
    ['tags', { tags: 'help wanted' }],
    ['tags[0]', { tags: ['x'.repeat(51)] }],
    ['tags', { tags: Array.from({ length: 21 }, (_, i) => `label ${String(i)}`) }],
    ['excludedTags', { excludedTags: ['HELP WANTED'] }],
    ['issueRepo', { issueRepo: 'not a repo' }],
    ['prMode', { prMode: 'yolo' }],
    ['whoCanClaim', { whoCanClaim: 'friends' }],
    ['disclosure', { disclosure: { trailer: null, prBody: null } }],
    ['disclosure.trailer', { disclosure: { trailer: 'Assisted by', prBody: null } }],
    ['disclosure.prBody', { disclosure: { trailer: null, prBody: '   ' } }],
    ['disclosure.prBodyLine', { disclosure: { trailer: 'Assisted-by', prBody: null, prBodyLine: true } }],
    ['personWrittenDescription', { personWrittenDescription: 'yes' }],
    ['claUrl', { claUrl: 'http://example.com/cla' }],
    ['claUrl', { claUrl: 'sign it please' }],
    ['agentNotes', { agentNotes: 'x'.repeat(2001) }],
    ['claimsPerIssue', { claimsPerIssue: 0 }],
    ['claimsPerIssue', { claimsPerIssue: 11 }],
    ['claimsPerIssue', { claimsPerIssue: 2.5 }],
    ['openPrsPerDonor', { openPrsPerDonor: '2' }],
    ['claimsPerIsue', { claimsPerIsue: 4 }],
  ])('invalid settings are rejected with a message that names %s', (field, bad) => {
    const result = parseProjectSettings({ tags: ['help wanted'], ...bad });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((p) => p.field)).toEqual([field]);
    expect(describeProblems(result.problems)).toMatch(new RegExp(`^${field.replace(/[[\]]/g, '\\$&')}: \\S`));
  });

  test('a tool refusal for invalid settings names every field that failed', () => {
    const result = parseProjectSettings({ tags: [], claimsPerIssue: 0, prMode: 'yolo' });
    if (result.ok) throw new Error('bad settings were accepted');
    const text = toolRefusal(invalidSettings(result.problems)).content[0]?.text ?? '';
    expect(text).toMatch(/^Refused \(invalid_settings\): Settings not saved\./);
    for (const field of ['tags', 'claimsPerIssue', 'prMode']) expect(text).toContain(`${field}: `);
  });
});

describe('changing settings', () => {
  const current = settings({
    tags: ['help wanted'],
    prMode: 'automatic',
    claimsPerIssue: 2,
    agentNotes: 'Run pnpm test before submitting.',
  });

  test('a change keeps every setting it leaves out', () => {
    const result = updateProjectSettings(current, { openPrsPerDonor: 4 });
    expect(result).toEqual({ ok: true, value: { ...current, openPrsPerDonor: 4 } });
  });

  test('a change that sends a setting as undefined keeps its value', () => {
    const result = updateProjectSettings(current, { prMode: undefined, openPrsPerDonor: 4 });
    expect(result).toEqual({ ok: true, value: { ...current, openPrsPerDonor: 4 } });
  });

  test('a change can not make a tag also excluded', () => {
    expect(problemFields(updateProjectSettings(current, { excludedTags: ['help wanted'] }))).toEqual([
      'excludedTags',
    ]);
  });

  test('a change with an unknown setting is rejected by name', () => {
    expect(problemFields(updateProjectSettings(current, { prmode: 'reviewed' }))).toEqual(['prmode']);
  });

  test('a change with an invalid value is rejected by name', () => {
    expect(problemFields(updateProjectSettings(current, { claimsPerIssue: 50 }))).toEqual([
      'claimsPerIssue',
    ]);
  });
});
