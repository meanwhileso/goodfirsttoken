import { expect, test } from 'vitest';
import { proposeSettings } from '../../src/projects/proposal';
import { MAX_DOC_BYTES, type RepoDocs } from '../../src/projects/repo';

// The settings register_project proposes. Every label, file, and link here is
// made up.

const none: RepoDocs = { contributing: null, aiPolicy: null, agents: null, prTemplate: null };

function docs(files: Partial<Record<keyof RepoDocs, string>>): RepoDocs {
  const paths = { contributing: 'CONTRIBUTING.md', aiPolicy: 'AI_POLICY.md', agents: 'AGENTS.md', prTemplate: '.github/pull_request_template.md' };
  const result = { ...none };
  for (const [kind, text] of Object.entries(files) as [keyof RepoDocs, string][]) result[kind] = { path: paths[kind], text };
  return result;
}

test('labels that mean ready for outside help are the proposed tags, compared without case', () => {
  const { settings, reasons } = proposeSettings(
    ['bug', 'Help Wanted', 'good first issue', 'Contribution Welcome', '.contrib/easy', 'contributor friendly'],
    none,
  );

  expect(settings.tags).toEqual(['Help Wanted', 'Contribution Welcome', '.contrib/easy', 'contributor friendly']);
  expect(reasons).toContainEqual({ setting: 'tags', reason: 'labels the repo has for outside help' });
});

test('a repo with no label for outside help gets the goodfirsttoken tag, which Good First Token creates if kept', () => {
  const { settings, reasons } = proposeSettings(['bug', 'good first issue'], none);

  expect(settings.tags).toEqual(['goodfirsttoken']);
  expect(reasons.find((r) => r.setting === 'tags')?.reason).toContain('creates goodfirsttoken if you keep it');
});

test('with nothing in the files, every setting but the tags keeps its default', () => {
  const { settings, reasons } = proposeSettings(['help wanted'], docs({ contributing: '# Contributing\n\nRun the tests.\n' }));

  expect(settings).toEqual({ tags: ['help wanted'] });
  expect(reasons.map((r) => r.setting)).toEqual(['tags']);
});

test('an AI trailer the files name, followed by a colon, is the disclosure trailer, as they spell it', () => {
  const { settings, reasons } = proposeSettings(
    ['help wanted'],
    docs({ contributing: 'Sign off with Signed-off-by: and mark AI help with a generated-by: line.' }),
  );

  expect(settings.disclosure).toEqual({
    trailer: 'generated-by',
    prBody: 'Written with a coding agent through Good First Token.',
  });
  expect(reasons).toContainEqual({ setting: 'disclosure', reason: 'CONTRIBUTING.md names the generated-by trailer' });
});

test('a trailer that is part of a longer name, or has no colon, is not taken', () => {
  const { settings } = proposeSettings(
    ['help wanted'],
    docs({ contributing: 'Add an AI-Assisted-by: trailer. Assisted-by trailers are fine too.' }),
  );

  expect(settings.disclosure).toBeUndefined();
});

test('the files are read in order: CONTRIBUTING, the AI policy file, AGENTS.md, then the PR template', () => {
  const { settings, reasons } = proposeSettings(
    ['help wanted'],
    docs({ prTemplate: 'Generated-by: your agent', aiPolicy: 'Use an Assisted-by: trailer.' }),
  );

  expect(settings.disclosure?.trailer).toBe('Assisted-by');
  expect(reasons).toContainEqual({ setting: 'disclosure', reason: 'AI_POLICY.md names the Assisted-by trailer' });
});

test('a file that asks for a PR description the contributor writes turns on person-written descriptions', () => {
  for (const text of [
    'AI help is fine. Write the PR description yourself.',
    'Please write the pull request description by hand.',
    'Put the PR description in your own words, and keep it short.',
  ]) {
    const { settings, reasons } = proposeSettings(['help wanted'], docs({ agents: text }));
    expect(settings.personWrittenDescription, text).toBe(true);
    expect(reasons, text).toContainEqual({
      setting: 'personWrittenDescription',
      reason: 'AGENTS.md asks contributors to write the PR description themselves',
    });
  }
  expect(proposeSettings(['help wanted'], docs({ agents: 'Write it yourself. The PR description can be short.' })).settings)
    .not.toHaveProperty('personWrittenDescription');
});

test('the first https link on a line about the CLA is the CLA link', () => {
  const { settings, reasons } = proposeSettings(
    ['help wanted'],
    docs({
      contributing: [
        'Read https://docs.example.org/style first.',
        'Everyone signs our Contributor License Agreement, at http://cla.example.org/old.',
        'Sign the CLA (https://cla.example.org/sample-app). It takes a minute.',
      ].join('\n'),
    }),
  );

  expect(settings.claUrl).toBe('https://cla.example.org/sample-app');
  expect(reasons).toContainEqual({ setting: 'claUrl', reason: 'CONTRIBUTING.md links it' });
});

test('a CLA line with no https link sets no CLA', () => {
  expect(proposeSettings(['help wanted'], docs({ contributing: 'No CLA is needed.' })).settings).not.toHaveProperty('claUrl');
});

test('a CLA link ending in punctuation loses the punctuation', () => {
  const { settings } = proposeSettings(['help wanted'], docs({ contributing: 'Sign the CLA at https://cla.example.org/sample-app...' }));

  expect(settings.claUrl).toBe('https://cla.example.org/sample-app');
});

test('four files at the size limit, each one long line with no period, are read in time that grows with their length alone', () => {
  // Every file at the size limit: the phrase over and over, with no words
  // after it, and in the PR template a CLA line whose link ends in a run of
  // dots and a letter.
  const phrase = 'PR description ';
  const full = phrase.repeat(Math.floor(MAX_DOC_BYTES / phrase.length));
  const half = phrase.repeat(Math.floor(MAX_DOC_BYTES / phrase.length / 2));
  const start = 'https://cla.example.org/';
  const link = `${start}${'.'.repeat(MAX_DOC_BYTES - half.length - '\nCLA '.length - start.length - 1)}x`;
  const template = `${half}\nCLA ${link}`;
  expect([full.length, template.length].every((n) => n > 0.99 * MAX_DOC_BYTES && n <= MAX_DOC_BYTES)).toBe(true);
  const started = performance.now();

  const { settings } = proposeSettings(
    ['help wanted'],
    docs({ contributing: full, aiPolicy: full, agents: full, prTemplate: template }),
  );

  // Read in one pass, all four take about a millisecond. A pattern that tries
  // every start position again took most of a second for each file.
  expect(performance.now() - started).toBeLessThan(50);
  expect(settings).not.toHaveProperty('personWrittenDescription');
  expect(settings.claUrl).toBe(link);
});
