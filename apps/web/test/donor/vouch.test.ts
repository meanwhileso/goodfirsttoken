import { describe, expect, test } from 'vitest';
import { parseVouchFile, vouchStatus } from '../../src/donor/vouch';

// A project's vouch file, in the format github.com/mitchellh/vouch defines.
// Every login here is made up.

const status = (text: string, login: string) => vouchStatus(parseVouchFile(text), login);

describe('the vouch file', () => {
  test('a line vouches for a GitHub login with no platform or the github platform, whatever its case', () => {
    const file = 'Octo-Cat\ngithub:Sample-Donor\n';

    expect(status(file, 'octo-cat')).toBe('vouched');
    expect(status(file, 'SAMPLE-DONOR')).toBe('vouched');
    expect(status(file, 'someone-else')).toBe('unknown');
  });

  test('a line for another platform vouches for no one on GitHub', () => {
    expect(status('gitlab:sample-donor\n', 'sample-donor')).toBe('unknown');
  });

  test('comments, blank lines, and the details after a handle are no entry', () => {
    const file = '# sample-donor is not vouched here\n\n   \nsample-maintainer vouched for sample-donor\n';

    expect(status(file, 'sample-donor')).toBe('unknown');
    expect(status(file, 'sample-maintainer')).toBe('vouched');
  });

  test('a line that starts with - denounces, and counts over a line that vouches for the same person', () => {
    expect(status('-sample-donor opened unreviewed PRs\n', 'sample-donor')).toBe('denounced');
    expect(status('-github:sample-donor\n', 'sample-donor')).toBe('denounced');
    expect(status('sample-donor\n-sample-donor\n', 'sample-donor')).toBe('denounced');
    expect(status('-gitlab:sample-donor\nsample-donor\n', 'sample-donor')).toBe('vouched');
  });

  test('a file with Windows line endings reads the same', () => {
    expect(status('# list\r\nsample-donor\r\n-sample-bot\r\n', 'sample-bot')).toBe('denounced');
  });
});
