import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig } from 'vitest/config';

// Tests run inside the Workers runtime against the whole Worker, with the
// bindings from wrangler.jsonc. Browser tests are in e2e/ and use Playwright.
export default defineConfig({
  plugins: [tanstackStart(), cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
