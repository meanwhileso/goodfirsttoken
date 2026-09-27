import { describe, expect, test } from 'vitest';
import { stripSecrets } from '../src/index';

// Every sample key and token here is made up, and built at run time, so no
// string shaped like a real one sits in this file for the leak scan to flag.
function chars(length: number, alphabet = 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z'): string {
  return alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length);
}
const upper = (length: number) => chars(length, 'AB3DE5GH7JK9MN1PQ2RS4TU6VW8XY0Z');
const hex = (length: number) => chars(length, '0123456789abcdef');
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
    ['a GitLab token (glpat-)', `glpat-${chars(20)}`],
    ['a Hugging Face token (hf_)', `hf_${chars(34)}`],
    ['a Slack app token (xapp-)', `xapp-1-${upper(11)}-1234567890-${chars(64)}`],
    ['a Stripe webhook secret (whsec_)', `whsec_${chars(32)}`],
    ['a Google OAuth client secret (GOCSPX-)', `GOCSPX-${chars(28)}`],
    ['a Google OAuth access token (ya29.)', `ya29.${chars(60)}`],
    ['a SendGrid key (SG.)', `SG.${chars(22)}.${chars(43)}`],
  ];

  test.each(cases)('%s', (_, secret) => {
    expect(stripSecrets(`ran the smoke test with ${secret} and it passed`)).toBe(
      'ran the smoke test with [redacted] and it passed',
    );
  });

  test('a private key is cut from its BEGIN line to the end of the text', () => {
    expect(stripSecrets(`pasted ${begin('RSA PRIVATE KEY')} MII${chars(60)}`)).toBe('pasted [redacted]');
    expect(stripSecrets(`key: ${begin('PRIVATE KEY')}${chars(20)}\nand the next line`)).toBe('key: [redacted]');
    expect(stripSecrets(`pasted ${begin('PGP PRIVATE KEY BLOCK')} ${chars(60)}`)).toBe('pasted [redacted]');
  });

  test('the credentials of an Authorization header, keeping the scheme', () => {
    expect(stripSecrets(`curl -H "Authorization: Bearer ${chars(40)}" passed`)).toBe(
      'curl -H "Authorization: Bearer [redacted]" passed',
    );
    expect(stripSecrets(`sent Authorization: Basic ${chars(24)}== to the API`)).toBe(
      'sent Authorization: Basic [redacted] to the API',
    );
    expect(stripSecrets(`Authorization: token ${hex(40)}`)).toBe('Authorization: token [redacted]');
    expect(stripSecrets(`{"authorization": "Bearer ${chars(30)}"}`)).toBe('{"authorization": "Bearer [redacted]"}');
  });

  test('the secret part of a Slack or Discord webhook link, keeping the host', () => {
    expect(stripSecrets(`posted to https://hooks.slack.com/services/${upper(9)}/${upper(11)}/${chars(24)} ok`)).toBe(
      'posted to https://hooks.slack.com/services/[redacted] ok',
    );
    expect(stripSecrets(`https://discord.com/api/webhooks/${'1234567890'.repeat(2)}/${chars(68)}`)).toBe(
      'https://discord.com/api/webhooks/[redacted]',
    );
  });

  test('the password in a link, keeping the user and the host', () => {
    expect(stripSecrets(`pushed to https://deploy:${chars(16)}@git.sample.test/app.git`)).toBe(
      'pushed to https://deploy:[redacted]@git.sample.test/app.git',
    );
  });

  test('a value given to a name for a password, a secret, a token, or a key', () => {
    const value = chars(20);
    const lines: [string, string][] = [
      [`secretKey: "${value}"`, 'secretKey: "[redacted]"'],
      [`secretAccessKey=${value}`, 'secretAccessKey=[redacted]'],
      [`privateKey = '${value}'`, "privateKey = '[redacted]'"],
      [`signingKey: ${value}`, 'signingKey: [redacted]'],
      ['password: hunter2', 'password: [redacted]'],
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

  test('a value after a --password, --secret, or --token flag and a space', () => {
    expect(stripSecrets(`ran deploy --password ${chars(12)} --verbose`)).toBe('ran deploy --password [redacted] --verbose');
    expect(stripSecrets(`ran the CLI with --token ${chars(20)}`)).toBe('ran the CLI with --token [redacted]');
    expect(stripSecrets(`--client-secret\t${chars(10)}`)).toBe('--client-secret\t[redacted]');
  });

  test('a secret value inside another value, like the query of a link, is found too', () => {
    const lines: [string, string][] = [
      [`fetched https://api.test/v1/items?api_key=${chars(24)}`, 'fetched https://api.test/v1/items?api_key=[redacted]'],
      [
        `opened http://localhost:5173/auth/callback?token=${chars(24)}&next=/`,
        'opened http://localhost:5173/auth/callback?token=[redacted]&next=/',
      ],
      [`set url=https://hooks.test/cb?access_token=${chars(24)}`, 'set url=https://hooks.test/cb?access_token=[redacted]'],
      [`env: GITHUB_TOKEN=${hex(40)}`, 'env: GITHUB_TOKEN=[redacted]'],
      [`config: password=${chars(12)}`, 'config: password=[redacted]'],
      [`DATABASE_URL=postgres://db.test/app?password=${chars(12)}`, 'DATABASE_URL=postgres://db.test/app?password=[redacted]'],
    ];
    for (const [line, stripped] of lines) expect(stripSecrets(line)).toBe(stripped);
  });

  test('a long value with a letter and a digit, given to any name that ends in _key, -key, or Key', () => {
    const lines: [string, string][] = [
      [`RAILS_MASTER_KEY=${hex(32)}`, 'RAILS_MASTER_KEY=[redacted]'],
      [`SESSION_KEY=${chars(32)}`, 'SESSION_KEY=[redacted]'],
      [`AUTH_KEY: ${chars(40)}`, 'AUTH_KEY: [redacted]'],
      [`OPENAI_KEY=${chars(40)}`, 'OPENAI_KEY=[redacted]'],
      [`APP_KEY=base64:${chars(43)}=`, 'APP_KEY=[redacted]'],
      [`masterKey: "${chars(24)}"`, 'masterKey: "[redacted]"'],
    ];
    for (const [line, stripped] of lines) expect(stripSecrets(line)).toBe(stripped);
  });

  test('closing punctuation after a replaced value stays', () => {
    const lines: [string, string][] = [
      [`(GITHUB_TOKEN=${hex(40)})`, '(GITHUB_TOKEN=[redacted])'],
      [`set password=${chars(12)}.`, 'set password=[redacted].'],
      [`[api_key: ${chars(24)}]`, '[api_key: [redacted]]'],
      [`{token=${chars(20)}}`, '{token=[redacted]}'],
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
    'added basic src/components/Button.test.tsx coverage',
    'sort_key: created_at_desc',
    'cache-key=build-output-v2',
    'expected token: STRING_LITERAL',
    'apiKey: process.env.API_KEY',
    'added a --password flag to the CLI',
    // A password stuck to -p, as mysql -psecret takes it, is left, since the
    // same form is ordinary in commands like this one.
    'ran mkdir -pv build/output before the tests',
    'primaryKey: user_id_2024',
    'added the --password option to the CLI',
    'the --secret parameter is now optional',
    'validated password: required',
    'form shows secret: missing now',
    'client_secret: optional in the schema',
    'apiKey: config.apiKeyV2',
    'expected token: T_STRING2',
  ])('%s', (line) => {
    expect(stripSecrets(line)).toBe(line);
  });
});
