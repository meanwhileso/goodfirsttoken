import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig } from 'vitest/config';

// Tests run inside the Workers runtime against the whole Worker, with the
// bindings from wrangler.jsonc. ENVIRONMENT is pinned to a value local
// development never uses, so a test can tell a value read from the binding
// from a hard-coded one, and a local .dev.vars can't change the result.
// Browser tests are in e2e/ and use Playwright.
export default defineConfig({
  plugins: [
    tanstackStart(),
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { ENVIRONMENT: 'staging' } },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
