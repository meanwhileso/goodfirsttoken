import { describe, expect, test } from 'vitest';
import { stripSecrets } from '../src/index';

// Every sample key and token here is made up, and built at run time, so no
// string shaped like a real one sits in this file for the leak scan to flag.
function chars(length: number, alphabet = 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z'): string {
  return alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length);
}
const upper = (length: number) => chars(length, 'AB3DE5GH7JK9MN1PQ2RS4TU6VW8XY0Z');
// A PEM key's BEGIN line, with its dashes added at run time for the same reason.
const begin = (kind: string) => `${'-'.repeat(5)}BEGIN ${kind}${'-'.repeat(5)}`;

describe('keys and tokens in a posted line are replaced with [redacted]', () => {
  const cases: [string, string][] = [
    ['a GitHub classic token (ghp_)', `ghp_${chars(36)}`],
    ['a GitHub OAuth token (gho_)', `gho_${chars(36)}`],
    ['a GitHub user-to-server token (ghu_)', `ghu_${chars(36)}`],
    ['a GitHub server-to-server token (ghs_)', `ghs_${chars(36)}`],
    ['a GitHub refresh token (ghr_)', `ghr_${chars(36)}`],
    ['a GitHub fine-grained token (github_pat_)', `github_pat_11${upper(20)}_${chars(59)}`],
    ['an Anthropic key (sk-ant-)', `sk-ant-api03-${chars(40)}`],
    ['an OpenAI key (sk-proj-)', `sk-proj-${chars(40)}`],
    ['a Stripe secret key (sk_live_)', `sk_live_${chars(24)}`],
    ['a Stripe restricted key (rk_test_)', `rk_test_${chars(24)}`],
    ['an AWS access key ID (AKIA)', `AKIA${upper(16)}`],
    ['an AWS temporary access key ID (ASIA)', `ASIA${upper(16)}`],
    ['a Google API key (AIza)', `AIza${chars(35)}`],
    ['a Slack token (xoxb-)', `xoxb-1234567890-${chars(24)}`],
    ['an npm token (npm_)', `npm_${chars(36)}`],
    ['a JSON Web Token', `eyJ${chars(20)}.eyJ${chars(30)}.${chars(43)}`],
  ];

  test.each(cases)('%s', (_, secret) => {
    expect(stripSecrets(`ran the smoke test with ${secret} and it passed`)).toBe(
      'ran the smoke test with [redacted] and it passed',
    );
  });

  test('a private key is cut from its BEGIN line to the end of the line', () => {
    expect(stripSecrets(`pasted ${begin('RSA PRIVATE KEY')} MII${chars(60)}`)).toBe('pasted [redacted]');
    expect(stripSecrets(`key: ${begin('PRIVATE KEY')}${chars(20)}`)).toBe('key: [redacted]');
  });

  test('the credentials of an Authorization header, keeping the scheme', () => {
    expect(stripSecrets(`curl -H "Authorization: Bearer ${chars(40)}" passed`)).toBe(
      'curl -H "Authorization: Bearer [redacted]" passed',
    );
    expect(stripSecrets(`sent basic ${chars(24)}== to the API`)).toBe('sent basic [redacted] to the API');
  });

  test('the password in a link, keeping the user and the host', () => {
    expect(stripSecrets(`pushed to https://deploy:${chars(16)}@git.sample.test/app.git`)).toBe(
      'pushed to https://deploy:[redacted]@git.sample.test/app.git',
    );
  });

  test('a value given to a name that ends in token, secret, password, api key, or _key', () => {
    const value = chars(20);
    const lines: [string, string][] = [
      [`set GITHUB_TOKEN=${value} in .env`, 'set GITHUB_TOKEN=[redacted] in .env'],
      [`{"password": "${value}"}`, '{"password": "[redacted]"}'],
      [`AWS_SECRET_ACCESS_KEY: ${value}`, 'AWS_SECRET_ACCESS_KEY: [redacted]'],
      [`client_secret=${value}`, 'client_secret=[redacted]'],
      [`apiKey = '${value}'`, "apiKey = '[redacted]'"],
      [`api-key=${value}`, 'api-key=[redacted]'],
      [`DB_PASSWD=${value}`, 'DB_PASSWD=[redacted]'],
      [`called /auth/cb?token=${value}&page=2`, 'called /auth/cb?token=[redacted]&page=2'],
    ];
    for (const [line, stripped] of lines) expect(stripSecrets(line)).toBe(stripped);
  });

  test('every secret in a line is replaced', () => {
    expect(stripSecrets(`ghp_${chars(36)} then sk-ant-${chars(40)}`)).toBe('[redacted] then [redacted]');
  });
});

describe('ordinary lines pass through as they were', () => {
  test.each([
    'fixed off-by-one in parseRange (src/range.ts)',
    'tests: 214 passing',
    'token: 3 failing, all lock-screen',
    'committed 4f2a91c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6 to the fork',
    'renamed tokenEstimate=180000 in src/claims.ts',
    'read the ghp_ prefix check in src/secrets.ts',
    'opened https://github.com/sample-owner/sample-app/pull/57',
    'set password: yes in the fixture',
    'moved the sk- flags into cli.ts',
    'the monkey=bananas123 fixture loads again',
    'Bearer auth now reads the header (src/auth.ts)',
    'cloned https://github.com/sample-owner/sample-app.git',
    'wrote failing test: /live.ndjson returns one JSON object per line',
  ])('%s', (line) => {
    expect(stripSecrets(line)).toBe(line);
  });
});
