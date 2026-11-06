import { sampleData } from '@goodfirsttoken/github-fake/sample-data';
import { expect, test } from 'vitest';
import {
  ABOUTS,
  TIERS,
  labelCheckFor,
  readingFor,
  recordedLabels,
  recordedReadings,
  resolveRecordings,
  type Reading,
} from '../src/recordings.ts';
import { docsOf } from './requests.ts';

const recordings = resolveRecordings();

// The tier the Worker works out from a reading's statements, in the order
// docs/specs/model-policy-reader.md gives under "What the Worker does with
// it". A recorded reading is one where the model agrees with it.
function workedOut(reading: Reading): string {
  const about = new Set(reading.statements.map((statement) => statement.about));
  if (about.has('bansAi') || about.has('refusesOutsidePrs')) return 'bans_or_restricts';
  const conditions = about.has('noAutonomy') || about.has('personInLoop') || about.has('personWrittenDescription');
  if (about.has('welcomesAgents') && !conditions) return 'invites_agents';
  if (about.has('welcomesAgents') || about.has('welcomesAi')) return 'allows_with_conditions';
  return 'no_policy';
}

test.each(recordings.map((recording) => [recording.repo, recording]))(
  "%s's recorded statements quote whole lines of its files, at the lines they name",
  (repo, { reading }) => {
    const sample = sampleData.repos.find((r) => `${r.owner}/${r.name}` === repo);
    for (const statement of reading.statements) {
      const lines = sample?.files[statement.path]?.split('\n') ?? [];
      const cited = lines.slice(statement.startLine - 1, statement.endLine).join('\n');
      expect(cited, `${statement.path}:${String(statement.startLine)}`).toContain(statement.quote);
      expect(ABOUTS).toContain(statement.about);
      if (statement.label !== null) expect(statement.quote).toContain(statement.label);
      if (statement.about === 'disclosureTrailer') expect(statement.quote).toContain(`${statement.value ?? ''}:`);
      if (statement.about === 'cla') expect(statement.quote).toContain(statement.value);
    }
    expect(TIERS).toContain(reading.tier);
    expect(reading.tier).toBe(workedOut(reading));
  },
);

test.each(recordedReadings.map((recorded) => [recorded.repo]))("%s's docs get its own recorded reading", (repo) => {
  const found = readingFor(docsOf(repo), recordings);

  expect(found.repo).toBe(repo);
  expect(found.reading).toEqual(recordings.find((recording) => recording.repo === repo)?.reading);
});

test('a sample repo with no recording gets a no_policy reading', () => {
  for (const repo of ['sample-policies/silent', 'sample-policies/mentions-ai', 'sample-owner/sample-notes']) {
    expect(readingFor(docsOf(repo), recordings)).toMatchObject({ repo: null, reading: { tier: 'no_policy', statements: [] } });
  }
});

test('a reading of its own is a copy, so changing what the fake gave changes no later answer', () => {
  const first = readingFor(docsOf('sample-policies/bans-ai'), recordings);
  first.reading.statements.length = 0;

  expect(readingFor(docsOf('sample-policies/bans-ai'), recordings).reading.statements).toHaveLength(1);
});

test('a recording whose quote the sample data lacks fails, so the recordings follow the sample data', () => {
  const broken = [{ repo: 'sample-policies/bans-ai', tier: 'bans_or_restricts' as const, summary: '', statements: [{ path: 'CONTRIBUTING.md', quote: 'Nothing like this.', about: 'bansAi' as const, why: '' }] }];

  expect(() => resolveRecordings(broken)).toThrow(/quotes "Nothing like this\."/);
  expect(() => resolveRecordings(broken.map((recorded) => ({ ...recorded, repo: 'nobody/nothing' })))).toThrow(/sample data doesn't have/);
});

test("every label a recording names is one of the sample repos' labels", () => {
  const names = new Set(sampleData.repos.flatMap((repo) => repo.labels.map((label) => label.name)));

  for (const name of Object.keys(recordedLabels)) expect(names, name).toContain(name);
});

test('a label check reads whole label names, so ready is not read out of agent ready', () => {
  expect(labelCheckFor('- agent ready: Ready for an agent').labels.map((label) => label.name)).toEqual(['agent ready']);
  expect(labelCheckFor('- ready\n- agent ready').labels.map((label) => label.name).sort()).toEqual(['agent ready', 'ready']);
  expect(labelCheckFor('- already done\n- unready').labels).toEqual([]);
});
