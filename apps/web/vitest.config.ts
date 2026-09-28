import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { defineConfig } from 'vitest/config';

// Tests run inside the Workers runtime against the whole Worker, with the
// bindings from wrangler.jsonc. ENVIRONMENT, the domains, and the OAuth app
// are pinned to values local development never uses, so a test can tell a
// value read from the binding from a hard-coded one, and a local .dev.vars
// can't change the result. The secrets are set, as a deploy sets them. GitHub's
// URLs are under .test, a domain that never resolves. Tests answer them with
// the in-process GitHub fake. The D1 migrations are read here, in Node, and a
// setup file applies them to the test database. So are the cron triggers in
// wrangler.jsonc, so a test can run each one's job, and the skill sources in
// skill-src/ with the source of the tools' answers, so a test can check what
// the skills name and quote against the MCP server. Browser tests are in e2e/
// and use Playwright.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL('migrations', import.meta.url)));
  const wrangler = ts.parseConfigFileTextToJson('wrangler.jsonc', readFileSync(new URL('wrangler.jsonc', import.meta.url), 'utf8'));
  const crons = (wrangler.config as { triggers?: { crons?: string[] } }).triggers?.crons ?? [];
  const skillSources = new URL('../../skill-src/', import.meta.url);
  const skills = Object.fromEntries(
    readdirSync(skillSources)
      .filter((file) => file.endsWith('.md'))
      .map((file) => [file.slice(0, -'.md'.length), readFileSync(new URL(file, skillSources), 'utf8')]),
  );
  // The source of every tool's answers, so a test can find the sentences a
  // skill quotes from the server. An escaped quote reads as the quote.
  const serverText = ['../../packages/core/src/tools/', 'src/mcp/', 'src/admin/', 'src/projects/']
    .map((dir) => new URL(dir, import.meta.url))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((file) => file.endsWith('.ts'))
        .map((file) => readFileSync(new URL(file, dir), 'utf8')),
    )
    .join('\n')
    .replaceAll("\\'", "'");
  return {
    plugins: [
      tanstackStart(),
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            ENVIRONMENT: 'staging',
            PRIMARY_DOMAIN: 'primary.example',
            REDIRECT_DOMAINS: 'second.example,www.primary.example',
            OAUTH_CLIENT_ID: 'goodfirsttoken-test',
            OAUTH_CLIENT_SECRET: 'test-only-client-secret',
            AUTH_SECRET: 'test-only-auth-secret-that-is-long-enough-for-better-auth',
            GH_SERVICE_TOKEN: 'test-only-service-token',
            ADMIN_GITHUB_IDS: '',
            GH_API_URL: 'https://api.github.test',
            GH_WEB_URL: 'https://github.test',
            TEST_MIGRATIONS: migrations,
            TEST_CRONS: crons,
            TEST_SKILLS: skills,
            TEST_SERVER_TEXT: serverText,
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/apply-migrations.ts'],
      // The first request in each test file compiles the Worker's routes, which
      // takes seconds on a busy machine.
      testTimeout: 20_000,
    },
  };
});
