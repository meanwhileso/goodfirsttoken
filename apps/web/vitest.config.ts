import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run inside the Workers runtime against the whole Worker, with the
// bindings from wrangler.jsonc. ENVIRONMENT and the domains are pinned to
// values local development never uses, so a test can tell a value read from
// the binding from a hard-coded one, and a local .dev.vars can't change the
// result. The D1 migrations are read here, in Node, and a setup file applies
// them to the test database. Browser tests are in e2e/ and use Playwright.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL('migrations', import.meta.url)));
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
            TEST_MIGRATIONS: migrations,
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
