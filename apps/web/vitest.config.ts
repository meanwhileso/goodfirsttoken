import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig } from 'vitest/config';

// Tests run inside the Workers runtime against the whole Worker, with the
// bindings from wrangler.jsonc. ENVIRONMENT is pinned to a value local
// development never uses, so a test can tell a value read from the binding
// from a hard-coded one, and a local .dev.vars can't change the result.
// GitHub's URLs are under .test, a domain that never resolves. Tests answer
// them with the in-process GitHub fake. Browser tests are in e2e/ and use
// Playwright.
export default defineConfig({
  plugins: [
    tanstackStart(),
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ENVIRONMENT: 'staging',
          GH_API_URL: 'https://api.github.test',
          GH_WEB_URL: 'https://github.test',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    // A test file's first request loads the whole Worker, which takes a few
    // seconds, and more when test files run side by side on a busy machine.
    testTimeout: 15_000,
  },
});
