import { LOCAL_WEB_URL } from '@goodfirsttoken/github-fake/local';
import { defineConfig, devices } from '@playwright/test';
import { SITE, STATIC_HOST } from './e2e/hosts';

// End-to-end tests run against the production build, served by Vite preview
// inside the Workers runtime, with the GitHub fake that wrangler.jsonc
// points the Worker at. The build puts its files on a stand-in for the static
// host, the way a deploy with STATIC_ORIGIN set does. Locally, servers you
// already started are reused, so a preview you built without STATIC_ORIGIN
// fails the static host's tests.
export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: SITE,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @goodfirsttoken/github-fake start',
      url: `${LOCAL_WEB_URL}/_fake/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'node ../../scripts/static-host.mjs dist/client',
      env: { PORT: new URL(STATIC_HOST).port },
      port: Number(new URL(STATIC_HOST).port),
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'pnpm build && pnpm preview',
      env: { STATIC_ORIGIN: STATIC_HOST },
      url: `${SITE}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
