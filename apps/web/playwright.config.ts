import { LOCAL_WEB_URL } from '@goodfirsttoken/github-fake/local';
import { defineConfig, devices } from '@playwright/test';
import { SITE, STATIC_HOST } from './e2e/hosts';

// End-to-end tests run against the production build, served by Vite preview
// inside the Workers runtime, with the GitHub fake that wrangler.jsonc
// points the Worker at. The build puts its files on a stand-in for the static
// host, the way a deploy with STATIC_ORIGIN set does. The preview keeps its
// local data in a folder of its own, emptied before each run, so it starts
// from nothing, as in CI, whatever `pnpm dev` holds. The D1 migrations are
// applied to it first, since sign-in reads it. Locally, servers you already
// started are reused, so a preview you built without STATIC_ORIGIN fails
// the static host's tests.
const E2E_STATE = '.wrangler/e2e-state';

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: SITE,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /(issue|projects|admin|skills|mcp-apps-flow)\.spec\.ts$/,
    },
    // The issue page's tests work real issue rooms, and every event they
    // make reaches the homepage's feed. The projects' tests do too, and seed
    // the sample projects, which the homepage lists. So they run once the
    // rest are done.
    {
      name: 'rooms',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /(issue|projects)\.spec\.ts$/,
      dependencies: ['chromium'],
    },
    // The admin pages' tests list projects, which the homepage shows, so
    // they run after those, on their own.
    { name: 'admin', use: { ...devices['Desktop Chrome'] }, testMatch: /admin\.spec\.ts$/, dependencies: ['rooms'] },
    // The skills' steps register a project and approve it from the admin
    // queue, which the admin pages' tests expect to hold only what they
    // seeded. So they run after those.
    { name: 'skills', use: { ...devices['Desktop Chrome'] }, testMatch: /skills\.spec\.ts$/, dependencies: ['admin'] },
    // A donor's agent in a host with MCP Apps claims a sample issue and
    // opens a PR on it, which the homepage and the admin pages would show,
    // so it runs last.
    { name: 'apps', use: { ...devices['Desktop Chrome'] }, testMatch: /mcp-apps-flow\.spec\.ts$/, dependencies: ['skills'] },
  ],
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
      command: 'node scripts/migrate-local.mjs --fresh && pnpm build && pnpm preview',
      env: { STATIC_ORIGIN: STATIC_HOST, LOCAL_STATE_DIR: E2E_STATE },
      url: `${SITE}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
