import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig } from 'vitest/config';

// Tests run inside the Workers runtime against the whole Worker, with the
// bindings from wrangler.jsonc. ENVIRONMENT and the domains are pinned to
// values local development never uses, so a test can tell a value read from
// the binding from a hard-coded one, and a local .dev.vars can't change the
// result. GitHub's URLs are under .test, a domain that never resolves. Tests
// answer them with the in-process GitHub fake. Browser tests are in e2e/ and
// use Playwright.
export default defineConfig({
  plugins: [
    tanstackStart(),
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ENVIRONMENT: 'staging',
          PRIMARY_DOMAIN: 'primary.example',
          REDIRECT_DOMAINS: 'second.example,www.primary.example',
          GH_API_URL: 'https://api.github.test',
          GH_WEB_URL: 'https://github.test',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    // The first request in each test file compiles the Worker's routes, which
    // takes seconds on a busy machine.
    testTimeout: 20_000,
  },
});
